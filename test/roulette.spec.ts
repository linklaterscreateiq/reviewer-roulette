/**
 * End-to-end tests for the bundled CLI (`dist/roulette.js`).
 *
 * Stub Slack and GitLab servers stand in for the real APIs, so these exercise
 * the published artifact — HTTP calls, request shapes and comment body
 * included — without credentials or network access. Run `npm run bundle`
 * first; `npm run smoke` does both.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const AUTHOR_USER_ID = 1
const PROJECT_ID = '4242'
const MERGE_REQUEST_IID = '7'

const ROULETTE_COMMENT = 'wheel_of_dharma: Reviewer Roulette'
const notesPath = `/gitlab/api/v4/projects/${PROJECT_ID}/merge_requests/${MERGE_REQUEST_IID}/notes`

type SlackMember = {
  id: string
  profile: {
    status_emoji: string
    status_emoji_display_info?: { emoji_name?: string; display_alias?: string }[]
  }
}

type StubRequest = { method: string; path: string; body: string | null }

const REVIEWERS = {
  reviewers: [
    {
      name: 'Ada Author',
      email: 'ada@example.com',
      userId: AUTHOR_USER_ID,
      slackUserId: 'U_ADA',
      roles: ['maintainer', 'contributor'],
    },
    { name: 'Grace Onholiday', email: 'grace@example.com', userId: 2, slackUserId: 'U_GRACE', roles: ['maintainer'] },
    { name: 'Linus Maintainer', email: 'linus@example.com', userId: 3, slackUserId: 'U_LINUS', roles: ['maintainer'] },
    {
      name: 'Barbara Contributor',
      email: 'barbara@example.com',
      userId: 4,
      slackUserId: 'U_BARBARA',
      roles: ['contributor'],
    },
  ],
}

/** Everyone available: only Grace's `:palm_tree:` should exclude her. */
const SLACK_MEMBERS: SlackMember[] = [
  { id: 'U_ADA', profile: { status_emoji: '' } },
  { id: 'U_GRACE', profile: { status_emoji: ':palm_tree:' } },
  { id: 'U_LINUS', profile: { status_emoji: ':coffee:' } },
  { id: 'U_BARBARA', profile: { status_emoji: '' } },
]

/** The same roster with Grace's status swapped, which is all most cases vary. */
const membersWithGraceStatus = (profile: SlackMember['profile']): SlackMember[] =>
  SLACK_MEMBERS.map(member => (member.id === 'U_GRACE' ? { ...member, profile } : member))

const startStubServer = async (existingNotes: object[], slackMembers: SlackMember[], noteWriteStatus: number) => {
  const requests: StubRequest[] = []

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method ?? '', path: url.pathname, body: url.searchParams.get('body') })
    req.resume()

    const respond = (payload: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    const respondToWrite = () =>
      noteWriteStatus === 200 ? respond({ id: 'stub-note-id' }) : respond({ message: '403 Forbidden' }, noteWriteStatus)

    if (url.pathname === '/slack/users.list') return respond({ ok: true, members: slackMembers })
    if (url.pathname === notesPath) return req.method === 'GET' ? respond(existingNotes) : respondToWrite()
    if (url.pathname.startsWith(notesPath)) return respondToWrite()

    res.writeHead(404).end('{}')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))

  return {
    requests,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

type RunOptions = {
  configPath: string
  existingNotes?: object[]
  slackMembers?: SlackMember[]
  omitEnv?: string[]
  noteWriteStatus?: number
}

/** Runs the bundled CLI against a stub server and reports what it did. */
const runRoulette = async ({
  configPath,
  existingNotes = [],
  slackMembers = SLACK_MEMBERS,
  omitEnv = [],
  noteWriteStatus = 200,
}: RunOptions) => {
  const stub = await startStubServer(existingNotes, slackMembers, noteWriteStatus)
  const baseUrl = `http://127.0.0.1:${stub.port}`

  try {
    const env: NodeJS.ProcessEnv = {
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
    }

    for (const name of omitEnv) delete env[name]

    const child = spawn(process.execPath, ['dist/roulette.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })

    const writes = stub.requests.filter(
      request => request.path.startsWith(notesPath) && (request.method === 'POST' || request.method === 'PUT')
    )
    const posted = writes.filter(request => request.method === 'POST')

    return {
      exitCode,
      output: `${stdout}${stderr}`,
      requests: stub.requests,
      writes,
      posted,
      /** The comment body of the single POST, or '' if there was not exactly one. */
      body: posted.length === 1 ? decodeURIComponent(posted[0].body ?? '') : '',
    }
  } finally {
    await stub.close()
  }
}

const noteFromBot = (checkbox: '[ ]' | '[x]') => [
  {
    id: '99',
    author: { username: 'roulette-bot' },
    body: `${ROULETTE_COMMENT}\n- ${checkbox} Give me two new approvers`,
  },
]

let configPath: string
let fixtureDir: string

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'roulette-smoke-'))
  configPath = path.join(fixtureDir, 'reviewers.json')
  await writeFile(configPath, JSON.stringify(REVIEWERS))
})

describe.concurrent('posting the reviewer comment', () => {
  it('names one eligible maintainer and one other developer', async () => {
    const { exitCode, posted, body } = await runRoulette({ configPath })

    expect(exitCode).toBe(0)
    expect(posted).toHaveLength(1)
    expect(body).toContain(ROULETTE_COMMENT)
    expect(body).toContain('Linus Maintainer (linus@example.com)')
    expect(body).toContain('Barbara Contributor (barbara@example.com)')
    expect(body).toContain('https://gitlab.example.com/job/1')
    expect(body).toContain('marks them as out of office')
  })

  it('excludes the merge request author and anyone away', async () => {
    const { body } = await runRoulette({ configPath })

    expect(body).not.toContain('Ada Author')
    expect(body).not.toContain('Grace Onholiday')
  })
})

describe.concurrent('away detection', () => {
  // Every name in `defaultAwayEmojis` that comes from a Slack category, pinned
  // individually so a stale entry shows up as a named failure.
  it.for([
    // "Out of Office" category
    'at-the-beach',
    'catching-up',
    'computer-sleep',
    'out-of-office',
    'pto-soon',
    'relaxing',
    'sleeping-potato',
    'touch-grass',
    'travel-time',
    // "Hybrid Work" and "Remote Work" categories
    'ooo',
    'pto',
    'self-care',
    'away',
  ])('excludes a reviewer whose status is :%s:', async (emoji, { expect }) => {
    const { body } = await runRoulette({
      configPath,
      slackMembers: membersWithGraceStatus({ status_emoji: `:${emoji}:` }),
    })

    expect(body).not.toContain('Grace Onholiday')
    expect(body).toContain('Linus Maintainer')
  })

  it("excludes a reviewer using Slack's own out of office status", async () => {
    const { exitCode, body } = await runRoulette({
      configPath,
      slackMembers: membersWithGraceStatus({ status_emoji: ':no_entry:' }),
    })

    expect(exitCode).toBe(0)
    expect(body).not.toContain('Grace Onholiday')
    expect(body).toContain('Linus Maintainer')
  })

  it('excludes a reviewer whose away status is a workspace emoji alias', async () => {
    const { exitCode, body } = await runRoulette({
      configPath,
      slackMembers: membersWithGraceStatus({
        status_emoji: ':annual-leave:',
        status_emoji_display_info: [{ emoji_name: 'palm_tree', display_alias: ':annual-leave:' }],
      }),
    })

    expect(exitCode).toBe(0)
    expect(body).not.toContain('Grace Onholiday')
    expect(body).toContain('Linus Maintainer')
  })

  it('uses the away emojis from the reviewer config in place of the defaults', async () => {
    const customConfigPath = path.join(fixtureDir, 'reviewers-custom-away.json')
    await writeFile(customConfigPath, JSON.stringify({ ...REVIEWERS, awayEmojis: [':coffee:'] }))

    const { exitCode, body } = await runRoulette({ configPath: customConfigPath })

    expect(exitCode).toBe(0)
    expect(body).not.toContain('Linus Maintainer')
    expect(body).toContain('Grace Onholiday')
  })
})

describe.concurrent('reconciling with an existing comment', () => {
  it('leaves it alone when a re-roll was not requested', async () => {
    const { exitCode, writes } = await runRoulette({ configPath, existingNotes: noteFromBot('[ ]') })

    expect(exitCode).toBe(0)
    expect(writes).toHaveLength(0)
  })

  it('replaces it in place when a re-roll was requested', async () => {
    const { exitCode, requests } = await runRoulette({ configPath, existingNotes: noteFromBot('[x]') })
    const updates = requests.filter(request => request.method === 'PUT')

    expect(exitCode).toBe(0)
    expect(updates).toHaveLength(1)
    expect(updates[0].path).toBe(`${notesPath}/99`)
  })
})

describe.concurrent('failing loudly rather than silently', () => {
  it('refuses to run when a required environment variable is missing', async () => {
    const { exitCode, output, writes } = await runRoulette({ configPath, omitEnv: ['REVIEWER_BOT_USERNAME'] })

    expect(exitCode).not.toBe(0)
    expect(output).toContain('REVIEWER_BOT_USERNAME')
    expect(writes).toHaveLength(0)
  })

  it('fails the run when GitLab rejects the note it tries to post', async () => {
    const { exitCode, output } = await runRoulette({ configPath, noteWriteStatus: 403 })

    expect(exitCode).not.toBe(0)
    expect(output).toContain('403')
    expect(output).not.toContain('comment id =')
  })
})
