# gitlab-http-api-mcp

MCP (Model Context Protocol) server for **GitLab** that talks directly to the GitLab HTTP API
using `GITLAB_API_URL` and `GITLAB_PERSONAL_ACCESS_TOKEN`. It exposes tools for working with
projects, issues, and merge requests.

## Requirements

- Node.js 18+
- Accessible GitLab HTTP API and a personal access token with sufficient permissions.

## Install

### From source (GitHub)

```bash
git clone https://github.com/rkorablin/gitlab-http-api-mcp.git
cd gitlab-http-api-mcp
npm install
```

### From npm

As a local dependency:

```bash
npm install gitlab-http-api-mcp
```

Or globally (for `npx` / CLI usage):

```bash
npm install -g gitlab-http-api-mcp
```

## Configuration

Environment variables:

- `GITLAB_API_URL` — base API URL, for example `https://gitlab.example.com/api/v4`
- `GITLAB_PERSONAL_ACCESS_TOKEN` — GitLab personal access token

## Usage

### Standalone (stdio)

```bash
export GITLAB_API_URL="https://gitlab.example.com/api/v4"
export GITLAB_PERSONAL_ACCESS_TOKEN="glpat-..."
node server.mjs
```

### Cursor / MCP host

Add the server to your MCP config (for example `.cursor/mcp.json` → `mcpServers`).

#### Option 1: Local clone

```json
"gitlab": {
  "command": "node",
  "args": ["/absolute/path/to/gitlab-http-api-mcp/server.mjs"],
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

#### Option 2: npm / npx

If installed globally:

```json
"gitlab": {
  "command": "gitlab-http-api-mcp",
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

Or via `npx`:

```json
"gitlab": {
  "command": "npx",
  "args": ["-y", "gitlab-http-api-mcp"],
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

## Publishing (maintainers)

This repo is pushed to two remotes:

- **origin** (GitLab, private): branch `main` — full tree including `.cursor` and `ONBOARDING_PROMPT.md`.
- **github** (GitHub, public): branch `main` on GitHub is fed from local branch `public` — same as `main` but without `.cursor` and `ONBOARDING_PROMPT.md`.

**Push to GitLab:** `git push origin main`

**Update GitHub (no .cursor, no ONBOARDING_PROMPT.md):** from repo root, after committing on `main`:

```bash
./scripts/sync-to-github.sh
```

This merges `main` into `public`, strips `.cursor` and `ONBOARDING_PROMPT.md`, and pushes `public` to `github` as `main`.
