#!/usr/bin/env node

/**
 * Reviewer Roulette
 * Goal: Randomly select one senior developer and one developer to review an MR
 * Author: Linklaters CreateiQ
 * License: MIT
 */
import { type UsersListResponse, WebClient, type WebClientOptions } from '@slack/web-api'
import type { Member } from '@slack/web-api/dist/types/response/UsersListResponse'
import fs from 'node:fs/promises'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

type Role = 'maintainer' | 'contributor'

type Reviewer = {
    name: string
    email: string
    userId: number
    slackUserId: string
    selectionChance?: number // Percentage chance of this user being included in the list of possible reviewers
    roles: Role[]
}

type ReviewerData = {
    reviewers: Reviewer[]
    awayEmojis?: string[]
}

// Slack's own "Out of Office" emoji category, as the client shows it. It has to be copied here:
// `emoji.list?include_categories=true` returns only the nine Unicode groups, and these arrive as
// ordinary workspace custom emoji, so nothing in the API distinguishes them from any other.
const slackOutOfOfficeEmojis = [
    'at-the-beach',
    'catching-up',
    'computer-sleep',
    'out-of-office',
    'pto-soon',
    'relaxing',
    'sleeping-potato',
    'touch-grass',
    'travel-time',
]

// Away statuses from Slack's "Hybrid Work" and "Remote Work" categories. Both categories are mostly
// still-working statuses (`working-from-home`, `hot-desking`, `here`), so only these four count.
const slackAwayWorkEmojis = ['ooo', 'pto', 'self-care', 'away']

// Statuses that predate the categories and are still in use. `:no_entry:` is what Slack's built-in
// out-of-office status sets, including when it is synced from Google or Outlook Calendar.
const defaultAwayEmojis = [
    ...slackOutOfOfficeEmojis,
    ...slackAwayWorkEmojis,
    'palm_tree',
    'holiday',
    'desert_island',
    'face_with_thermometer',
    'hospital',
    'no_entry',
]

// Slack accepts a status emoji with or without colons, and appends a skin tone as a second
// `::`-delimited name, so both config and profile values are reduced to a bare name before matching.
const normaliseEmojiName = (emoji: string) => emoji.trim().toLowerCase().replace(/^:|:$/g, '').split('::')[0]

// A workspace alias resolves to a different name than the one on the profile, so every name Slack
// reports for the status counts as a candidate.
const emojiNamesForStatus = (slackUser: Member) =>
    [
        slackUser.profile?.status_emoji,
        ...(slackUser.profile?.status_emoji_display_info ?? []).flatMap(info => [
            info.emoji_name,
            info.display_alias,
        ]),
    ]
        .filter((name): name is string => !!name)
        .map(normaliseEmojiName)

// Config
const config = {
    reviewerDataFile: process.env.REVIEWER_CONFIG!, // '../../.reviewers.json'
    usernameOfBot: process.env.REVIEWER_BOT_USERNAME!,
    slackToken: process.env.REVIEWER_BOT_SLACK_TOKEN!,
}
// End Config

// Slack's client dropped its `agent` option when it moved from axios to fetch, so
// proxying now means handing it a fetch that dispatches through the proxy.
const proxiedFetch = (proxyUrl: string): WebClientOptions['fetch'] => {
    const dispatcher = new ProxyAgent(proxyUrl)

    // undici and the global fetch declare structurally identical but nominally
    // distinct FormData, so init has to be re-asserted across the boundary.
    return (url, init) =>
        undiciFetch(url, { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1]) as ReturnType<
            NonNullable<WebClientOptions['fetch']>
        >
}

const getAllSlackUsers = async () => {
    const maybeHttpsProxy = process.env.HTTPS_PROXY
    const clientOpts: WebClientOptions = {
        ...(maybeHttpsProxy ? { fetch: proxiedFetch(maybeHttpsProxy) } : {}),
        ...(process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : {}),
    }

    const slackClient = new WebClient(config.slackToken, clientOpts)
    const slackListUsers: UsersListResponse = await slackClient.users.list({})

    return slackListUsers.members!
}

const filterReviewersWhoAreAway = (reviewers: Reviewer[], slackUsers: Member[], awayEmojis: Set<string>) => {
    const slackUsersFilteredToReviewers = slackUsers.filter(slackUser => {
        return slackUser.id && reviewers.map(reviewer => reviewer.slackUserId).includes(slackUser.id)
    })

    const slackUserIdsWhoAreAway = slackUsersFilteredToReviewers
        .filter(slackUser => emojiNamesForStatus(slackUser).some(name => awayEmojis.has(name)))
        .map(slackUser => slackUser.id)

    // Remove anyone whose Slack status marks them as away
    const reviewersWithoutAuthorAndPeopleAway = reviewers.filter(
        reviewer => !slackUserIdsWhoAreAway.includes(reviewer.slackUserId)
    )

    console.log(
        `Eligible reviewers after removing away, author and filtering by chance: ${JSON.stringify(
            reviewersWithoutAuthorAndPeopleAway.map(reviewer => reviewer.name)
        )}`
    )

    return reviewersWithoutAuthorAndPeopleAway
}

const selectReviewersBasedOnChance = (reviewers: Reviewer[]) => {
    const reviewersPostChanceCalculations = reviewers.filter(reviewer => {
        if (!reviewer.selectionChance) {
            return true
        } else {
            const between0And1 = reviewer.selectionChance / 100
            const randomChanceOfInclusion = Math.random()

            console.log(`Dice of fate for ${reviewer.name}. Calc: ${randomChanceOfInclusion} >= ${between0And1}`)

            if (randomChanceOfInclusion <= between0And1) {
                return true
            }
        }

        return false
    })

    const remainingMaintainers = reviewersPostChanceCalculations.filter(reviewer => reviewer.roles.includes('maintainer'))
    const remainingContributors = reviewersPostChanceCalculations.filter(reviewer =>
        reviewer.roles.includes('contributor')
    )

    // If we've whittled down the list too much, disregard chance
    if (remainingMaintainers.length < 1 || remainingContributors.length < 1) {
        console.log("Disregarding dice of fate: There aren't enough reviewers in the pool!")
        return reviewers
    }

    return reviewersPostChanceCalculations
}

const getRandomReviewer = (array: Reviewer[]) => {
    return array[Math.floor(Math.random() * array.length)]
}

const runReviewRoulette = async () => {
    const slackMembers: Member[] = await getAllSlackUsers()

    const reviewerDataRaw = await fs.readFile(config.reviewerDataFile, 'utf-8')
    const reviewerData: ReviewerData = JSON.parse(reviewerDataRaw)

    const startedPipelineUserId = parseInt(process.env.GITLAB_USER_ID!)

    const reviewersWithoutAuthor = reviewerData.reviewers.filter(item => item.userId !== startedPipelineUserId)

    const reviewersSelectedBasedOnChance = selectReviewersBasedOnChance(reviewersWithoutAuthor)

    const awayEmojis = new Set((reviewerData.awayEmojis ?? defaultAwayEmojis).map(normaliseEmojiName))

    console.log(`Away emojis: ${JSON.stringify([...awayEmojis])}`)

    const reviewersWithoutAuthorAndPeopleAway = filterReviewersWhoAreAway(
        reviewersSelectedBasedOnChance,
        slackMembers,
        awayEmojis
    )

    // Don't include the pipeline/MR creator in the list of possible reviewers
    const maintainers = reviewersWithoutAuthorAndPeopleAway.filter(item => item.roles.includes('maintainer'))

    const allDevelopers = reviewersWithoutAuthorAndPeopleAway

    const randomMaintainer = getRandomReviewer(maintainers)

    // Remove the chosen maintainer from the list of all devs and pick a random one
    const randomAllDeveloper = getRandomReviewer(allDevelopers.filter(item => item.userId !== randomMaintainer.userId))

    console.log(`Rand Maintainer = ${JSON.stringify(randomMaintainer)}`)
    console.log(`Rand All Dev = ${JSON.stringify(randomAllDeveloper)}`)

    // The away set is mostly Slack custom emoji, which GitLab renders as literal `:name:` text, so
    // the comment describes the rule rather than listing them.
    const awayEmojiSentence =
        awayEmojis.size > 0 ? ' (the bot skips anyone whose Slack status marks them as out of office)' : ''

    const gitlabCommentBody = `
## :wheel_of_dharma: Reviewer Roulette

To spread load more evenly across eligible reviewers and to enable speedy review the Roulette Bot has randomly selected two reviewers for this MR.

You can make different choices if you think someone else would be better-suited or if someone is away${awayEmojiSentence}. Other people are free to review if they'd like to as well.

Once you've decided who will review this merge request **please assign them as a reviewer!** Roulette Bot does not do this automatically.

| Reviewer Category | Name |
| ------ | ------ |
| Senior Developers | ${randomMaintainer.name} (${randomMaintainer.email}) |
| All Developers | ${randomAllDeveloper.name} (${randomAllDeveloper.email}) |

If you'd like the [reviewer roulette job](${process.env.CI_JOB_URL}) that generated this message to get two new random approvers check the box below and rerun it in the pipeline.
- [ ] Give me two new approvers on the next push / job retry

How do I review / What do I do if I've been named as a reviewer? An official guide is coming very soon, in the mean time pair up with the Senior Developer reviewer and ask for some tips if you'd like some guidance.
`

    const gitlabAuthHeaders: Record<string, string> = { 'PRIVATE-TOKEN': process.env.PROJECT_REVIEWER_BOT_PAT! }

    const gitlabApiUrl = process.env.GITLAB_API_URL
    const ciProjectId = process.env.CI_PROJECT_ID
    const ciMergeRequestIId = process.env.CI_MERGE_REQUEST_IID

    type NotesResponse = NoteResponse[]

    type NoteResponse = {
        author: {
            username: string
        }
        body: string
        id: string
    }

    const notesResponse = await fetch(`${gitlabApiUrl}/api/v4/projects/${ciProjectId}/merge_requests/${ciMergeRequestIId}/notes?sort=asc`, {
        headers: gitlabAuthHeaders,
        method: 'GET',
    })

    if (!notesResponse.ok) {
        console.error(`GitLab API error: ${notesResponse.status} ${notesResponse.statusText}`)
        if (notesResponse.status === 401) {
            console.error('Authentication failed. Check PROJECT_REVIEWER_BOT_PAT token.')
        } else if (notesResponse.status === 403) {
            console.error('Permission denied. Bot needs Developer/Maintainer access to this project.')
        } else if (notesResponse.status === 404) {
            console.error('Project or merge request not found. Check CI_PROJECT_ID and CI_MERGE_REQUEST_IID.')
        }
        process.exit(1)
    }

    const existingMRNotes = await notesResponse.json()

    if (!Array.isArray(existingMRNotes)) {
        console.error('GitLab API returned unexpected response:', JSON.stringify(existingMRNotes))
        console.error('Expected an array of notes but received:', typeof existingMRNotes)
        process.exit(1)
    }

    const previousNote: NoteResponse | undefined = existingMRNotes.find(
        item => item.author.username === config.usernameOfBot
    )

    console.log(`Previous Comment Id = ${previousNote?.id}`)

    const replaceNote = !!(previousNote && previousNote.body.includes('- [x] Give me two'))

    if (!previousNote || replaceNote) {
        const createOrUpdateNote = async (replace: Boolean) => {
            const urlEncodedBody = encodeURIComponent(gitlabCommentBody)

            const validReplace = previousNote && replace

            const { present: actionPresentTense, past: actionPastTense } = validReplace
                ? {
                    present: 'Replacing',
                    past: 'Replaced',
                }
                : { present: 'Creating new', past: 'Created new' }

            console.log(`${actionPresentTense} note...`)

            const method = validReplace ? 'PUT' : 'POST'
            const urlPrefix = validReplace
                ? `${gitlabApiUrl}/api/v4/projects/${ciProjectId}/merge_requests/${ciMergeRequestIId}/notes/${previousNote.id}`
                : `${gitlabApiUrl}/api/v4/projects/${ciProjectId}/merge_requests/${ciMergeRequestIId}/notes`

            fetch(`${urlPrefix}?body=${urlEncodedBody}`, { headers: gitlabAuthHeaders, method: method })
                .then(response => response.json())
                .then((jsonData: NoteResponse) => {
                    console.log(`${actionPastTense} new comment id = ${jsonData.id}`)
                })
        }

        await createOrUpdateNote(!!previousNote && replaceNote)
    } else {
        console.log(`Previous note exists (ID: ${previousNote.id}) and retry wasn't ticked. Doing nothing.`)
    }
}

runReviewRoulette()
