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

- `npm run build` / `npm run tsc` — runs `tsc -p tsconfig.json`. This is a pure **type-check**: `tsconfig.json` sets `noEmit`, so it produces no output files (leave it that way — without it, `tsc` sprays compiled JS next to the source, and nothing here is gitignored except `dist`). It is *not* what gets published.
- `npm run bundle` — runs `tsup`, producing the real artifact: a minified CommonJS bundle at `dist/roulette.js`. This is what `bin`/`main` point to and what consumers actually execute.
- `npm run upload` — bundles then `npm publish --access public`. Requires npm auth. This is the break-glass path only: releases normally go out from `.github/workflows/publish-npm.yml` (see `PUBLISHING.md`).

- `npm run smoke` — bundles, then runs `scripts/smoke-test.mjs`: it executes `dist/roulette.js` against stub Slack and GitLab servers on loopback and asserts on the comment it posts (author excluded, holiday reviewers excluded, one maintainer plus one other developer named) and on the create/no-op/replace behaviour for an existing note. No credentials or network access needed. Because it drives the bundle over real HTTP, it catches runtime breakage from dependency bumps that `tsc` passes clean.

There is **no unit-test framework and no linter** configured — don't go looking for one or assume a `test`/`lint` script exists. Verification before publishing is `npm run tsc` (type-check) plus `npm run smoke`. CI (`.github/workflows/build-node.yml`) runs all three on the Node version in `mise.toml` (currently 24), installed there by `mise-action` so the version is declared in one place only.

Merging to `main` needs a pull request with a passing `build` check and one approving review, all enforced by repository rulesets. Dependency bumps are merged by hand; the point of the smoke test is that a green Build is enough to judge one on, without running the tool against real Slack and GitLab first.

Publishing to npm is done by `.github/workflows/publish-npm.yml`, triggered by publishing a GitHub Release. It re-runs the type-check and smoke test, refuses to publish if the release tag does not name the version in `package.json`, and authenticates over OIDC rather than a stored npm token — so the package's trusted publisher on npmjs.com has to name that workflow file.

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
