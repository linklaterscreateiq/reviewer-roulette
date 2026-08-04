#!/usr/bin/env node

/**
 * End-to-end smoke test for the bundled CLI (`dist/roulette.js`).
 *
 * Stub Slack and GitLab servers stand in for the real APIs, so this exercises
 * the published artifact — HTTP calls, request shapes and comment body
 * included — without credentials or network access. Run `npm run bundle` first.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const AUTHOR_USER_ID = 1
const PROJECT_ID = '4242'
const MERGE_REQUEST_IID = '7'

const REVIEWERS = {
    reviewers: [
        { name: 'Ada Author', email: 'ada@example.com', userId: AUTHOR_USER_ID, slackUserId: 'U_ADA', roles: ['maintainer', 'contributor'] },
        { name: 'Grace Onholiday', email: 'grace@example.com', userId: 2, slackUserId: 'U_GRACE', roles: ['maintainer'] },
        { name: 'Linus Maintainer', email: 'linus@example.com', userId: 3, slackUserId: 'U_LINUS', roles: ['maintainer'] },
        { name: 'Barbara Contributor', email: 'barbara@example.com', userId: 4, slackUserId: 'U_BARBARA', roles: ['contributor'] },
    ],
}

const SLACK_MEMBERS = [
    { id: 'U_ADA', profile: { status_emoji: '' } },
    { id: 'U_GRACE', profile: { status_emoji: ':palm_tree:' } },
    { id: 'U_LINUS', profile: { status_emoji: ':coffee:' } },
    { id: 'U_BARBARA', profile: { status_emoji: '' } },
]

const notesPath = `/gitlab/api/v4/projects/${PROJECT_ID}/merge_requests/${MERGE_REQUEST_IID}/notes`

/**
 * @param {object[]} existingNotes notes the stub GitLab returns from the GET
 * @returns {Promise<{requests: {method: string, path: string, body: string|null}[], close: () => Promise<void>, port: number}>}
 */
const startStubServer = async existingNotes => {
    const requests = []

    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        requests.push({ method: req.method, path: url.pathname, body: url.searchParams.get('body') })

        const respond = payload => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(payload))
        }

        if (url.pathname === '/slack/users.list') {
            req.resume()
            return respond({ ok: true, members: SLACK_MEMBERS })
        }

        if (url.pathname === notesPath) {
            req.resume()
            if (req.method === 'GET') return respond(existingNotes)
            return respond({ id: 'stub-note-id' })
        }

        if (url.pathname.startsWith(notesPath)) {
            req.resume()
            return respond({ id: 'stub-note-id' })
        }

        req.resume()
        res.writeHead(404).end('{}')
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

    return {
        requests,
        port: server.address().port,
        close: () => new Promise(resolve => server.close(resolve)),
    }
}

/**
 * Runs the bundled CLI against the stub server and returns what it did.
 *
 * @param {object} options
 * @param {object[]} options.existingNotes notes already on the stub merge request
 * @param {string} options.configPath path to the reviewer JSON fixture
 */
const runRoulette = async ({ existingNotes, configPath }) => {
    const stub = await startStubServer(existingNotes)
    const baseUrl = `http://127.0.0.1:${stub.port}`

    try {
        const child = spawn(process.execPath, ['dist/roulette.js'], {
            env: {
                ...process.env,
                REVIEWER_CONFIG: configPath,
                REVIEWER_BOT_USERNAME: 'roulette-bot',
                REVIEWER_BOT_SLACK_TOKEN: 'xoxb-stub-token',
                PROJECT_REVIEWER_BOT_PAT: 'stub-pat',
                SLACK_API_URL: `${baseUrl}/slack/`,
                GITLAB_API_URL: `${baseUrl}/gitlab`,
                GITLAB_USER_ID: String(AUTHOR_USER_ID),
                CI_PROJECT_ID: PROJECT_ID,
                CI_MERGE_REQUEST_IID: MERGE_REQUEST_IID,
                CI_JOB_URL: 'https://gitlab.example.com/job/1',
                HTTPS_PROXY: '',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => (stdout += chunk))
        child.stderr.on('data', chunk => (stderr += chunk))

        const exitCode = await new Promise((resolve, reject) => {
            child.on('error', reject)
            child.on('close', resolve)
            setTimeout(() => {
                child.kill('SIGKILL')
                reject(new Error('Timed out after 30s waiting for the CLI to exit'))
            }, 30_000).unref()
        })

        // The CLI does not await its final write, so give the socket a tick to land.
        await new Promise(resolve => setTimeout(resolve, 250))

        return { exitCode, stdout, stderr, requests: stub.requests }
    } finally {
        await stub.close()
    }
}

const failures = []

/**
 * @param {string} description what the assertion proves
 * @param {boolean} condition
 * @param {string} [detail] context printed when the assertion fails
 */
const check = (description, condition, detail = '') => {
    if (condition) {
        console.log(`  ok   ${description}`)
    } else {
        failures.push(description)
        console.log(`  FAIL ${description}${detail ? `\n       ${detail}` : ''}`)
    }
}

const rouletteComment = 'wheel_of_dharma: Reviewer Roulette'

const main = async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'roulette-smoke-'))
    const configPath = path.join(fixtureDir, 'reviewers.json')
    await writeFile(configPath, JSON.stringify(REVIEWERS))

    console.log('\nposts a comment naming one eligible maintainer and one other developer')
    {
        const { exitCode, stdout, stderr, requests } = await runRoulette({ existingNotes: [], configPath })
        const posted = requests.filter(r => r.method === 'POST' && r.path.startsWith(notesPath))

        check('the CLI exits successfully', exitCode === 0, `exit=${exitCode}\n${stderr || stdout}`)
        check('it creates exactly one note', posted.length === 1, `posted ${posted.length} note(s)`)

        const body = posted.length === 1 ? decodeURIComponent(posted[0].body ?? '') : ''
        check('the note is the roulette comment', body.includes(rouletteComment))
        check('the only eligible maintainer is named', body.includes('Linus Maintainer (linus@example.com)'), body)
        check('the remaining developer is named', body.includes('Barbara Contributor (barbara@example.com)'), body)
        check('the merge request author is excluded', !body.includes('Ada Author'), body)
        check('the reviewer on holiday is excluded', !body.includes('Grace Onholiday'), body)
        check('the job URL is linked', body.includes('https://gitlab.example.com/job/1'))
    }

    console.log('\nleaves an existing comment alone when a re-roll was not requested')
    {
        const existing = [{ id: '99', author: { username: 'roulette-bot' }, body: `${rouletteComment}\n- [ ] Give me two new approvers` }]
        const { exitCode, requests } = await runRoulette({ existingNotes: existing, configPath })
        const writes = requests.filter(r => r.path.startsWith(notesPath) && (r.method === 'POST' || r.method === 'PUT'))

        check('the CLI exits successfully', exitCode === 0)
        check('it does not write to the merge request', writes.length === 0, `wrote ${writes.length} time(s)`)
    }

    console.log('\nreplaces the existing comment when a re-roll was requested')
    {
        const existing = [{ id: '99', author: { username: 'roulette-bot' }, body: `${rouletteComment}\n- [x] Give me two new approvers` }]
        const { exitCode, requests } = await runRoulette({ existingNotes: existing, configPath })
        const updates = requests.filter(r => r.method === 'PUT')

        check('the CLI exits successfully', exitCode === 0)
        check('it updates the existing note in place', updates.length === 1 && updates[0].path === `${notesPath}/99`, JSON.stringify(updates))
    }

    console.log('')
    if (failures.length > 0) {
        console.error(`Smoke test failed: ${failures.length} assertion(s) did not hold.`)
        process.exit(1)
    }
    console.log('Smoke test passed.')
}

main().catch(error => {
    console.error(error)
    process.exit(1)
})
