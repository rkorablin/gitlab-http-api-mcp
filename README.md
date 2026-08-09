# gitlab-http-api-mcp

MCP (Model Context Protocol) server for **GitLab** that talks directly to the GitLab HTTP API
using `GITLAB_API_URL` and `GITLAB_PERSONAL_ACCESS_TOKEN`. Tools cover projects (including
default branch updates), repository and protected branches, CI job token scope / inbound
allowlists, issues (including notes), merge requests (create/update/merge/diffs), and CI
pipelines & jobs.

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

Or via `npx` (рекомендуется для автоподтягивания новых версий):

```json
"gitlab": {
  "command": "npx",
  "args": ["--yes", "--prefer-online", "gitlab-http-api-mcp@latest"],
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

**Почему `@latest` и `--prefer-online`:** без тега версии npx может долго использовать старый кэш. Явный `@latest` + опрос registry при старте даёт актуальный патч после публикации в npm. Флаги нужно передавать **до** имени пакета (см. `npm help npx`).

## Tools (summary)

| Area | Tools |
|------|--------|
| User | `gitlab_get_current_user` |
| Projects | `gitlab_list_projects`, `gitlab_get_project`, `gitlab_update_project` |
| Branches | `gitlab_list_repository_branches`, `gitlab_create_repository_branch` |
| Protected branches | `gitlab_list_protected_branches`, `gitlab_protect_branch`, `gitlab_unprotect_branch` |
| Job token scope | `gitlab_get_job_token_scope`, `gitlab_list_job_token_allowlist`, `gitlab_add_job_token_allowlist`, `gitlab_remove_job_token_allowlist`, `gitlab_list_job_token_groups_allowlist`, `gitlab_add_job_token_groups_allowlist`, `gitlab_remove_job_token_groups_allowlist` |
| Issues | `gitlab_list_issues`, `gitlab_get_issue`, `gitlab_create_issue`, `gitlab_update_issue`, `gitlab_list_issue_notes`, `gitlab_create_issue_note` |
| Merge requests | `gitlab_list_merge_requests`, `gitlab_get_merge_request`, `gitlab_create_merge_request`, `gitlab_update_merge_request`, `gitlab_merge_merge_request`, `gitlab_get_merge_request_changes`, `gitlab_list_merge_request_notes`, `gitlab_list_merge_request_discussions` |
| Pipelines | `gitlab_list_pipelines`, `gitlab_get_pipeline`, `gitlab_create_pipeline`, `gitlab_retry_pipeline`, `gitlab_cancel_pipeline` |
| Jobs | `gitlab_list_pipeline_jobs`, `gitlab_get_job_trace`, `gitlab_retry_job`, `gitlab_play_job` |

Pipeline and job IDs are numeric (from the API). MR and issue identifiers are **IID** (per-project internal id).

### Job token allowlist notes

- `project_id` — allowlist **owner** (the project being accessed, e.g. a deployable with a container registry). Path or id; **always resolved to numeric id** before API calls (some GitLab builds reject path ids on allowlist POST/DELETE).
- `target_project_id` / `target_group_id` — source of `CI_JOB_TOKEN`; may be a **numeric id or path** (path is resolved via Projects/Groups API).
- **Add** and **remove** are **idempotent**: already present → `{ already_present: true }`; already absent → `{ ok: true, already_absent: true }` (GitLab often returns HTTP 400 for these cases; the tools normalize them).
- Scope flags (`inbound_enabled` / `outbound_enabled`) are read-only via `gitlab_get_job_token_scope` (no patch tool).
