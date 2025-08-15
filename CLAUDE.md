# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Reviewer Roulette is a CLI tool for GitLab CI/CD pipelines that randomly selects reviewers for merge requests. It integrates with Slack to detect users on holiday and creates/updates GitLab MR comments with selected reviewers.

## Architecture

- **Single TypeScript file**: `src/roulette.ts` contains all application logic
- **Node.js CLI**: Executable script that runs in GitLab CI/CD pipelines
- **External integrations**: Slack Web API for holiday detection, GitLab API for MR comments
- **Configuration**: JSON file with reviewer data (users, roles, selection chances)

## Build and Development Commands

- `npm run build` or `npm run tsc` - Compile TypeScript to JavaScript
- `npm run bundle` - Build optimized bundle using tsup
- `npm run upload` - Bundle and publish to npm (requires authentication)

## Key Environment Variables

The application requires these environment variables to function:
- `REVIEWER_CONFIG` - Path to JSON configuration file with reviewer data
- `REVIEWER_BOT_USERNAME` - GitLab username for the bot
- `REVIEWER_BOT_SLACK_TOKEN` - Slack API token
- `PROJECT_REVIEWER_BOT_PAT` - GitLab Personal Access Token
- `GITLAB_USER_ID` - GitLab user ID of MR author (provided by CI)
- `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID` - GitLab CI variables
- `GITLAB_API_URL`, `CI_JOB_URL` - GitLab instance URLs
- `HTTPS_PROXY` - Optional proxy configuration

## Configuration File Format

The `REVIEWER_CONFIG` JSON file should contain:
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

## Core Functionality

1. **Holiday Detection**: Checks Slack for users with `:palm_tree:`, `:holiday:`, or `:face_with_thermometer:` status emojis
2. **Role-based Selection**: Separates reviewers into `maintainer` and `contributor` roles
3. **Selection Chance**: Supports percentage-based inclusion probability per reviewer
4. **MR Comments**: Creates or updates GitLab merge request comments with selected reviewers
5. **Retry Mechanism**: Supports checkbox-based re-selection via pipeline reruns

## Publishing

To publish a new version:
1. Update version in `package.json`
2. Run `npm run upload` with npm credentials