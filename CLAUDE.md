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
5. Remove anyone whose Slack status marks them as away (`filterReviewersWhoAreAway`).
6. Split the survivors by role, pick a random `maintainer`, then pick a second reviewer from the whole remaining pool excluding that maintainer.
7. Build a Markdown comment body and reconcile it with GitLab via the Notes API.

The GitLab comment is idempotent across pipeline reruns: the script finds an existing note authored by `REVIEWER_BOT_USERNAME`. If none exists it POSTs a new one. If one exists, it only re-rolls (PUT) when the user has ticked the `- [x] Give me two new approvers` checkbox in that comment; otherwise it does nothing. This retry-via-checkbox mechanism is the only way to force a re-selection.

External integrations are the Slack Web API (`@slack/web-api`) for status/holiday detection and the GitLab REST API (plain `fetch`) for reading and writing MR notes.

## Build, Run and Test

- `npm run build` / `npm run tsc` — runs `tsc -p tsconfig.json`. This is a pure **type-check**: `tsconfig.json` sets `noEmit`, so it produces no output files (leave it that way — without it, `tsc` sprays compiled JS next to the source, and nothing here is gitignored except `dist`). It is *not* what gets published.
- `npm run bundle` — runs `tsup`, producing the real artifact: a minified CommonJS bundle at `dist/roulette.js`. This is what `bin`/`main` point to and what consumers actually execute.
- `npm run upload` — bundles then `npm publish --access public`. Requires npm auth. This is the break-glass path only: releases normally go out from `.github/workflows/publish-npm.yml` (see `PUBLISHING.md`).

- `npm run smoke` — bundles, then runs `scripts/smoke-test.mjs`: it executes `dist/roulette.js` against stub Slack and GitLab servers on loopback and asserts on the comment it posts (author excluded, holiday reviewers excluded, one maintainer plus one other developer named) and on the create/no-op/replace behaviour for an existing note. No credentials or network access needed. Because it drives the bundle over real HTTP, it catches runtime breakage from dependency bumps that `tsc` passes clean.

- `node scripts/proxy-check.mjs` — checks `HTTPS_PROXY` is honoured, by running the bundle twice: with the proxy pointed at a dead port it must fail to reach the stubbed Slack, and with no proxy set it must reach it. Both runs matter — a client that is simply broken would also fail the first one. Takes about seven seconds: the proxied run is capped at six because the Slack client would otherwise retry a refused connection for half an hour.

`@types/node` is a direct devDependency and `tsconfig.json` names it in `types` — neither is redundant. TypeScript 7 does not pull `@types` packages in automatically here, so dropping either turns every use of `process` into "Cannot find name". Keep its major aligned with the Node in `mise.toml`, so the type-checker cannot offer APIs the pinned runtime lacks.

There is **no unit-test framework and no linter** configured — don't go looking for one or assume a `test`/`lint` script exists. Verification before publishing is `npm run tsc` (type-check) plus `npm run smoke`. CI (`.github/workflows/build-node.yml`) runs all three on the Node version in `mise.toml` (currently 24), installed there by `mise-action` so the version is declared in one place only.

Merging to `main` needs a pull request with a passing `build` check and one approving review, all enforced by repository rulesets. Dependency bumps are merged by hand; the point of the smoke test is that a green Build is enough to judge one on, without running the tool against real Slack and GitLab first.

Publishing to npm is done by `.github/workflows/publish-npm.yml`, triggered by publishing a GitHub Release. It re-runs the type-check and smoke test, refuses to publish if the release tag does not name the version in `package.json`, and authenticates over OIDC rather than a stored npm token — so the package's trusted publisher on npmjs.com has to name that workflow file.

## Runtime Configuration (environment variables)

The script reads everything from the environment and will throw on missing required values (they are dereferenced with `!`). Provided by the operator:
- `REVIEWER_CONFIG` — path to the reviewer JSON file (format below)
- `REVIEWER_BOT_USERNAME` — GitLab username the bot's comments are authored as (used to find the existing note)
- `REVIEWER_BOT_SLACK_TOKEN` — Slack API token for `users.list`
- `PROJECT_REVIEWER_BOT_PAT` — GitLab PAT sent as the `PRIVATE-TOKEN` header
- `HTTPS_PROXY` — optional; routes the Slack client's requests through an undici `ProxyAgent`

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
  ],
  "awayEmojis": [":palm_tree:", ":no_entry:"]
}
```
`roles` is an array of `"maintainer"` and/or `"contributor"`. `selectionChance` is an optional 0–100 percentage; omit it to always include the reviewer. A reviewer can hold both roles. `awayEmojis` is optional and replaces the built-in away set (see below); omit it to use the defaults.

## Away Detection

A reviewer is filtered out when their Slack status uses one of the away emoji, listed in `defaultAwayEmojis` in `src/roulette.ts` and overridable per-project (see below).

**The list is hardcoded because Slack offers no way to read it.** Don't spend time looking for one — this was checked against the live API, not inferred:
- There is no `is_ooo` or away flag on the user object, and no endpoint returning a workspace's status suggestions.
- `emoji.list` with `include_categories: true` (scope `emoji:read`) returns **only the nine Unicode groups** — `Smileys & People`, `Component`, `Animals & Nature`, `Food & Drink`, `Travel & Places`, `Activities`, `Objects`, `Symbols`, `Flags`. The emoji picker's "Out of Office" section is **not** among them; it is client-side only.
- The Out of Office emoji do appear in that response's `emoji` map, but as ordinary workspace custom emoji among ~1,600 others, with nothing marking them as out-of-office. (They happen to share two `emoji.slack-edge.com` batch hashes, but recovering the set that way needs the names first, so it cannot bootstrap the list.)

`defaultAwayEmojis` is therefore copied by hand, from three sources:
- Slack's **Out of Office** category in full: `at-the-beach`, `catching-up`, `computer-sleep`, `out-of-office`, `pto-soon`, `relaxing`, `sleeping-potato`, `touch-grass`, `travel-time`.
- The away members of Slack's **Hybrid Work** and **Remote Work** categories: `ooo`, `pto`, `self-care`, `away`. Deliberately partial — the rest of those categories are still-working statuses (`working-from-home`, `hot-desking`, `commuting`, `here`, `virtual-meeting`) that must not exclude anyone.
- Statuses that predate all of it: `palm_tree`, `holiday`, `desert_island`, `face_with_thermometer`, `hospital`, `no_entry`. `no_entry` is what Slack's built-in out-of-office status sets, including when synced from Google or Outlook Calendar.

If Slack changes these categories the list has to be updated to match — the smoke test pins every name, so a stale entry is at least visible.

A config file may override the whole set with a top-level `awayEmojis` array; it **replaces** the defaults rather than adding to them.

Two normalisation rules matter when changing this:
- Names are compared bare, so config and profile values may be written with or without colons, and a skin-tone suffix (`:wave::skin-tone-2:`) is stripped.
- A workspace emoji alias means `profile.status_emoji` can be a name the set does not contain while `profile.status_emoji_display_info[].emoji_name` holds the one it does, so every name Slack reports for the status is matched.

The generated MR comment describes the rule rather than listing the emoji: most of the set is Slack custom emoji, which GitLab renders as literal `:name:` text.
