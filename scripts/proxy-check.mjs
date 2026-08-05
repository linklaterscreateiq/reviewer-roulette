// Proves HTTPS_PROXY is actually honoured by the migrated Slack client.
//
// Slack is stubbed on a live local port. With the proxy pointed at a dead port
// the stub must NOT be reached; with no proxy set it MUST be. Running both is
// the point — "it failed" alone would also be true if the client were simply broken.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const runWith = async proxyUrl => {
    let reachedStub = false

    const stub = createServer((req, res) => {
        reachedStub = true
        req.resume()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, members: [] }))
    })
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))

    const child = spawn(process.execPath, ['dist/roulette.js'], {
        env: {
            ...process.env,
            REVIEWER_CONFIG: '/dev/null',
            REVIEWER_BOT_USERNAME: 'bot',
            REVIEWER_BOT_SLACK_TOKEN: 'xoxb-stub',
            SLACK_API_URL: `http://127.0.0.1:${stub.address().port}/`,
            GITLAB_USER_ID: '1',
            ...(proxyUrl ? { HTTPS_PROXY: proxyUrl } : { HTTPS_PROXY: '' }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    // The Slack client retries a failed connection for about thirty minutes.
    await new Promise(resolve => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
        }, 6000)
        child.on('close', () => {
            clearTimeout(timer)
            resolve()
        })
    })

    stub.close()
    return reachedStub
}

const withDeadProxy = await runWith('http://127.0.0.1:9')
const withoutProxy = await runWith(null)

console.log(`HTTPS_PROXY set to a dead port -> reached Slack directly: ${withDeadProxy}`)
console.log(`HTTPS_PROXY unset             -> reached Slack directly: ${withoutProxy}`)

if (withDeadProxy) {
    console.error('FAIL: HTTPS_PROXY was ignored — traffic bypassed the proxy.')
    process.exit(1)
}
if (!withoutProxy) {
    console.error('FAIL: the control run never reached Slack, so the check proves nothing.')
    process.exit(1)
}
console.log('PASS: traffic goes through the proxy when one is configured, and direct when not.')
