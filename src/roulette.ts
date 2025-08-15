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
import { HttpsProxyAgent } from 'https-proxy-agent'

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
}

// Config
const config = {
    reviewerDataFile: process.env.REVIEWER_CONFIG!, // '../../.reviewers.json'
    usernameOfBot: process.env.REVIEWER_BOT_USERNAME!,
    slackToken: process.env.REVIEWER_BOT_SLACK_TOKEN!,
}
// End Config

const getAllSlackUsers = async () => {
    const maybeHttpsProxy = process.env.HTTPS_PROXY
    const clientOpts: WebClientOptions = maybeHttpsProxy ? { agent: new HttpsProxyAgent(maybeHttpsProxy) } : {}

    const slackClient = new WebClient(config.slackToken, clientOpts)
    const slackListUsers: UsersListResponse = await slackClient.users.list({})

    return slackListUsers.members!
}

const filterReviewersBasedOnSlackHoliday = (reviewers: Reviewer[], slackUsers: Member[]) => {
    const slackUsersFilteredToReviewers = slackUsers.filter(slackUser => {
        return slackUser.id && reviewers.map(reviewer => reviewer.slackUserId).includes(slackUser.id)
    })

    const slackUserIdsOnHolidayOrSick = slackUsersFilteredToReviewers
        .filter(
            slackUser => slackUser.profile?.status_emoji == ':palm_tree:' || slackUser.profile?.status_emoji == ':holiday:' || slackUser.profile?.status_emoji == ':face_with_thermometer'
        )
        .map(slackUser => slackUser.id)

    // Remove anyone with the holiday emoji in Slack
    const reviewersWithoutAuthorAndPeopleOnHoliday = reviewers.filter(
        reviewer => !slackUserIdsOnHolidayOrSick.includes(reviewer.slackUserId)
    )

    console.log(
        `Eligible reviewers after removing holiday/sick, author and filtering by chance: ${JSON.stringify(
            reviewersWithoutAuthorAndPeopleOnHoliday.map(reviewer => reviewer.name)
        )}`
    )

    return reviewersWithoutAuthorAndPeopleOnHoliday
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

    const reviewersWithoutAuthorAndPeopleOnHoliday = filterReviewersBasedOnSlackHoliday(
        reviewersSelectedBasedOnChance,
        slackMembers
    )

    // Don't include the pipeline/MR creator in the list of possible reviewers
    const maintainers = reviewersWithoutAuthorAndPeopleOnHoliday.filter(item => item.roles.includes('maintainer'))

    const allDevelopers = reviewersWithoutAuthorAndPeopleOnHoliday

    const randomMaintainer = getRandomReviewer(maintainers)

    // Remove the chosen maintainer from the list of all devs and pick a random one
    const randomAllDeveloper = getRandomReviewer(allDevelopers.filter(item => item.userId !== randomMaintainer.userId))

    console.log(`Rand Maintainer = ${JSON.stringify(randomMaintainer)}`)
    console.log(`Rand All Dev = ${JSON.stringify(randomAllDeveloper)}`)

    const gitlabCommentBody = `
## :wheel_of_dharma: Reviewer Roulette

To spread load more evenly across eligible reviewers and to enable speedy review the Roulette Bot has randomly selected two reviewers for this MR.

You can make different choices if you think someone else would be better-suited or if someone is on holiday (the bot checks for the :palm_tree: and :face_with_thermometer: emojis on Slack). Other people are free to review if they'd like to as well. 

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
