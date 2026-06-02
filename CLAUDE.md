# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reviewer Roulette is a CLI tool, published to npm as `@createiq/reviewer-roulette`, intended to run as a step in GitLab CI/CD pipelines. On each run it randomly selects two reviewers for the current merge request (one `maintainer`, one from the wider developer pool), skips anyone marked as on holiday/sick in Slack, and posts or updates a GitLab MR comment naming them.

## Architecture

All logic lives in a single self-executing script: `src/roulette.ts`. It has no exports — the bottom of the file calls `runReviewRoulette()`. There is no module structure to navigate; read that one file end to end.

The end-to-end flow inside `runReviewRoulette()` is the part worth understanding before changing anything:

1. Fetch all Slack users (`getAllSlackUsers`), honouring `HTTPS_PROXY` if set.
2. Load the reviewer roster from the JSON file at `REVIEWER_CONFIG`.
3. Drop the MR author from the pool (matched by `GITLAB_USER_ID` vs each reviewer's `userId`).
4. Apply per-reviewer `selectionChance` (`selectReviewersBasedOnChance`) — a probabilistic filter that is *bypassed entirely* if it would leave fewer than one maintainer or one contributor.
5. Remove anyone whose Slack `status_emoji` marks them as on holiday/sick (`filterReviewersBasedOnSlackHoliday`).
6. Split the survivors by role, pick a random `maintainer`, then pick a second reviewer from the whole remaining pool excluding that maintainer.
7. Build a Markdown comment body and reconcile it with GitLab via the Notes API.

The GitLab comment is idempotent across pipeline reruns: the script finds an existing note authored by `REVIEWER_BOT_USERNAME`. If none exists it POSTs a new one. If one exists, it only re-rolls (PUT) when the user has ticked the `- [x] Give me two new approvers` checkbox in that comment; otherwise it does nothing. This retry-via-checkbox mechanism is the only way to force a re-selection.

External integrations are the Slack Web API (`@slack/web-api`) for status/holiday detection and the GitLab REST API (plain `fetch`) for reading and writing MR notes.

## Build, Run and Test

- `npm run build` / `npm run tsc` — runs `tsc -p tsconfig.json`. This is effectively a **type-check**; note `tsconfig.json` sets no `outDir`, so any emitted JS lands next to the source. It is *not* what gets published.
- `npm run bundle` — runs `tsup`, producing the real artifact: a minified CommonJS bundle at `dist/roulette.js`. This is what `bin`/`main` point to and what consumers actually execute.
- `npm run upload` — bundles then `npm publish --access public`. Requires npm auth. Bump `version` in `package.json` first (see `PUBLISHING.md`).

There is **no test suite and no linter** configured — don't go looking for one or assume a `test`/`lint` script exists. Verification before publishing is a clean `npm run build` (type-check) plus a successful `npm run bundle`. CI (`.github/workflows/build-node.yml`) only runs `npm ci` + `npm run build` on Node 20.x; Node is pinned to 20.11.0 (`.node-version`).

## Runtime Configuration (environment variables)

The script reads everything from the environment and will throw on missing required values (they are dereferenced with `!`). Provided by the operator:
- `REVIEWER_CONFIG` — path to the reviewer JSON file (format below)
- `REVIEWER_BOT_USERNAME` — GitLab username the bot's comments are authored as (used to find the existing note)
- `REVIEWER_BOT_SLACK_TOKEN` — Slack API token for `users.list`
- `PROJECT_REVIEWER_BOT_PAT` — GitLab PAT sent as the `PRIVATE-TOKEN` header
- `HTTPS_PROXY` — optional; wraps the Slack client in an `HttpsProxyAgent`

Supplied automatically by GitLab CI:
- `GITLAB_USER_ID` — author of the MR/pipeline (excluded from selection)
- `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID` — identify the MR for the Notes API
- `GITLAB_API_URL` — base URL for the GitLab instance
- `CI_JOB_URL` — linked in the comment so users can find the job to rerun

## Reviewer Config File Format

The JSON file at `REVIEWER_CONFIG`:
```json
{
  "reviewers": [
    {
      "name": "John Doe",
      "email": "john@company.com",
      "userId": 123,
      "slackUserId": "U123ABC",
      "selectionChance": 80,
      "roles": ["maintainer", "contributor"]
    }
  ]
}
```
`roles` is an array of `"maintainer"` and/or `"contributor"`. `selectionChance` is an optional 0–100 percentage; omit it to always include the reviewer. A reviewer can hold both roles.

## Holiday/Sick Detection

A reviewer is filtered out when their Slack profile `status_emoji` is `:palm_tree:`, `:holiday:`, `:face_with_thermometer:`, or `:hospital:`. Matching is exact-string against the Slack emoji name, so the literals in `filterReviewersBasedOnSlackHoliday` must match Slack precisely (including surrounding colons).
