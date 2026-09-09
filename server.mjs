#!/usr/bin/env node
/**
 * MCP server for GitLab over HTTP API.
 *
 * Goal: feature set close to @modelcontextprotocol/server-gitlab, but implemented
 * via direct HTTP calls to GitLab API (no official MCP server dependency).
 *
 * Env:
 * - GITLAB_API_URL  (e.g. https://gitlab.greenworm.ru/api/v4)
 * - GITLAB_PERSONAL_ACCESS_TOKEN  (e.g. glpat-...)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const baseApi = (process.env.GITLAB_API_URL || '').replace(/\/$/, '');
const token = process.env.GITLAB_PERSONAL_ACCESS_TOKEN || process.env.GITLAB_TOKEN;

function authHeaders() {
  if (!baseApi) throw new Error('GITLAB_API_URL is required');
  if (!token) throw new Error('GITLAB_PERSONAL_ACCESS_TOKEN (or GITLAB_TOKEN) is required');
  return {
    'Private-Token': token,
    'Content-Type': 'application/json'
  };
}

function projPath(id) {
  return `/projects/${encodeURIComponent(String(id))}`;
}

function groupPath(id) {
  return `/groups/${encodeURIComponent(String(id))}`;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function glFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${baseApi}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return parseBody(text);
}

/** Like glFetch, but returns { status, data } and does not throw for allowStatuses. */
async function glFetchStatus(path, opts = {}, allowStatuses = []) {
  const url = path.startsWith('http') ? path : `${baseApi}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) }
  });
  const text = await res.text();
  if (!res.ok && !allowStatuses.includes(res.status)) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return { status: res.status, data: parseBody(text) };
}

function isNumericId(value) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isFinite(n);
}

/** Resolve project ID or path → numeric id. */
async function resolveProjectNumericId(idOrPath) {
  if (idOrPath == null || idOrPath === '') {
    throw new Error('project id/path is required');
  }
  if (isNumericId(idOrPath)) return Number(String(idOrPath).trim());
  const data = await glFetch(`/projects/${encodeProjectId(idOrPath)}`);
  if (!data || data.id == null) {
    throw new Error(`Could not resolve project: ${idOrPath}`);
  }
  return Number(data.id);
}

/** Resolve group ID or path → numeric id. */
async function resolveGroupNumericId(idOrPath) {
  if (idOrPath == null || idOrPath === '') {
    throw new Error('group id/path is required');
  }
  if (isNumericId(idOrPath)) return Number(String(idOrPath).trim());
  const data = await glFetch(`/groups/${encodeURIComponent(String(idOrPath))}`);
  if (!data || data.id == null) {
    throw new Error(`Could not resolve group: ${idOrPath}`);
  }
  return Number(data.id);
}

function summarizeApiError(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.slice(0, 400);
  if (typeof data === 'object') {
    if (data.message != null) return String(data.message).slice(0, 400);
    if (data.error != null) return String(data.error).slice(0, 400);
    try {
      return JSON.stringify(data).slice(0, 400);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

/** GitLab often returns 400 (not 409) when the allowlist entry already exists. */
function isAlreadyPresentAllowlistError(status, data, kind) {
  if (status !== 400 && status !== 409) return false;
  const msg = summarizeApiError(data).toLowerCase();
  if (status === 409) return true;
  if (kind === 'group') {
    return msg.includes('already in the job token allowlist') || msg.includes('already');
  }
  return msg.includes('already in the job token allowlist') || msg.includes('already');
}

/** GitLab often returns 400 (not 404) when the allowlist entry is missing. */
function isAlreadyAbsentAllowlistError(status, data, kind) {
  if (status === 404) return true;
  if (status !== 400) return false;
  const msg = summarizeApiError(data).toLowerCase();
  if (kind === 'group') {
    return msg.includes('not in the job token scope') || msg.includes('not found');
  }
  return msg.includes('not in the job token scope') || msg.includes('not found');
}

/** Job log trace is plain text */
async function glFetchText(path) {
  const url = path.startsWith('http') ? path : `${baseApi}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, { headers: { 'Private-Token': token } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return text;
}

function jsonContent(value) {
  return [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }
  ];
}

function encodeProjectId(projectId) {
  return encodeURIComponent(String(projectId));
}

/** Drop `value` from a CI/CD variable object (list responses / secret hygiene). */
function variableMetadata(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const { value: _omit, ...meta } = v;
  return meta;
}

function stripVariableValues(list) {
  return (Array.isArray(list) ? list : []).map(variableMetadata);
}

/** Map tool arg → GitLab `filter[environment_scope]` query. */
function appendEnvScopeFilter(params, a) {
  const scope = a.filter_environment_scope;
  if (scope != null && String(scope) !== '') {
    params.set('filter[environment_scope]', String(scope));
  }
}

function buildVariableWriteBody(a, { requireKey = false, requireValue = false } = {}) {
  const body = {};
  if (a.key != null && a.key !== '') body.key = String(a.key);
  else if (requireKey) throw new Error('key is required');
  if (a.value !== undefined) body.value = String(a.value);
  else if (requireValue) throw new Error('value is required');
  if (a.variable_type != null) body.variable_type = String(a.variable_type);
  if (a.protected !== undefined) body.protected = Boolean(a.protected);
  if (a.masked !== undefined) body.masked = Boolean(a.masked);
  if (a.raw !== undefined) body.raw = Boolean(a.raw);
  if (a.environment_scope != null) body.environment_scope = String(a.environment_scope);
  if (a.description != null) body.description = String(a.description);
  return body;
}

function isVariableAlreadyExistsError(status, data) {
  if (status !== 400 && status !== 409) return false;
  const msg = summarizeApiError(data).toLowerCase();
  return (
    status === 409 ||
    msg.includes('has already been taken') ||
    msg.includes('already exists') ||
    msg.includes('duplicate')
  );
}

const VARIABLE_WRITE_PROPS = {
  variable_type: {
    type: 'string',
    description: 'env_var (default) | file'
  },
  protected: {
    type: 'boolean',
    description: 'Only available on protected branches/tags'
  },
  masked: {
    type: 'boolean',
    description: 'Masked in job logs (GitLab charset/length rules apply)'
  },
  raw: {
    type: 'boolean',
    description: 'If true, do not expand $variables in value'
  },
  environment_scope: {
    type: 'string',
    description: 'Environment scope (default *)'
  },
  description: {
    type: 'string',
    description: 'Optional description (if GitLab instance supports it)'
  }
};

const server = new Server(
  { name: 'gitlab-http-api-mcp', version: '0.2.6' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'gitlab_get_current_user',
      description: 'Get the current GitLab user (GET /user).',
      inputSchema: { type: 'object', properties: {} }
    },

    {
      name: 'gitlab_list_projects',
      description:
        'List GitLab projects accessible with this token. Supports simple search and pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Search string for project name or path' },
          membership: {
            type: 'boolean',
            description: 'Only projects the user is a member of',
            default: true
          },
          simple: {
            type: 'boolean',
            description: 'Return only simple fields (GitLab simple=true)',
            default: true
          },
          page: { type: 'number', description: 'Page number (1-based)', default: 1 },
          per_page: { type: 'number', description: 'Items per page (max 100)', default: 50 }
        }
      }
    },
    {
      name: 'gitlab_get_project',
      description: 'Get a single project by ID or full path.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Project ID or URL-encoded path (e.g. ai%2Fhome-network)'
          }
        },
        required: ['id']
      }
    },
    {
      name: 'gitlab_update_project',
      description:
        'Update a project (PUT /projects/:id). Optional fields only — omit to leave unchanged. At least one of default_branch, description, name required. Branch for default_branch must already exist.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Project ID or path (e.g. ai/gitlab-http-api-mcp)'
          },
          default_branch: {
            type: 'string',
            description: 'New default branch name (must already exist in the repository)'
          },
          description: { type: 'string', description: 'Project description' },
          name: { type: 'string', description: 'Project name (use carefully)' }
        },
        required: ['id']
      }
    },
    {
      name: 'gitlab_create_repository_branch',
      description:
        'Create a repository branch (POST /projects/:id/repository/branches). Fails if the branch already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or path' },
          branch: { type: 'string', description: 'Name of the new branch' },
          ref: {
            type: 'string',
            description: 'Source branch name, tag, or commit SHA'
          }
        },
        required: ['project_id', 'branch', 'ref']
      }
    },
    {
      name: 'gitlab_list_repository_branches',
      description:
        'List repository branches (GET /projects/:id/repository/branches). Optional search and pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or path' },
          search: { type: 'string', description: 'Filter branches by name' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_list_protected_branches',
      description:
        'List protected branches (GET /projects/:id/protected_branches). Optional name search.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or path' },
          search: { type: 'string', description: 'Filter protected branches by name' }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_protect_branch',
      description:
        'Protect a repository branch (POST /projects/:id/protected_branches). Fails if already protected. Access levels: 0=No one, 30=Developers+Maintainers, 40=Maintainers (default).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or path' },
          name: {
            type: 'string',
            description: 'Branch name or wildcard (e.g. develop, main, release/*)'
          },
          push_access_level: {
            type: 'number',
            description: 'Who can push (default 40 Maintainers)',
            default: 40
          },
          merge_access_level: {
            type: 'number',
            description: 'Who can merge (default 40 Maintainers)',
            default: 40
          },
          allow_force_push: {
            type: 'boolean',
            description: 'Allow force push (default false)',
            default: false
          },
          code_owner_approval_required: {
            type: 'boolean',
            description: 'Require code owner approval (if instance supports it)'
          }
        },
        required: ['project_id', 'name']
      }
    },
    {
      name: 'gitlab_unprotect_branch',
      description:
        'Unprotect a repository branch (DELETE /projects/:id/protected_branches/:name). Returns { ok: true, name } on success.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or path' },
          name: { type: 'string', description: 'Protected branch name to remove' }
        },
        required: ['project_id', 'name']
      }
    },

    {
      name: 'gitlab_list_issues',
      description:
        'List issues for a project. Mirrors basic fields from GitLab issues API (GET /projects/:id/issues).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or URL-encoded path' },
          state: {
            type: 'string',
            description: 'Issue state: opened, closed, all',
            default: 'opened'
          },
          search: { type: 'string', description: 'Search term for title/description' },
          labels: { type: 'string', description: 'Comma-separated labels to filter by' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_get_issue',
      description: 'Get a single issue by project and issue IID.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          issue_iid: { type: 'number', description: 'Issue internal ID (IID)' }
        },
        required: ['project_id', 'issue_iid']
      }
    },
    {
      name: 'gitlab_create_issue',
      description: 'Create a new issue in a project.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', default: '' },
          labels: { type: 'string', default: '' }
        },
        required: ['project_id', 'title']
      }
    },
    {
      name: 'gitlab_update_issue',
      description:
        'Update an issue (PUT /projects/:id/issues/:iid). Optional fields only — omit to leave unchanged.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          issue_iid: { type: 'number' },
          title: { type: 'string' },
          description: { type: 'string' },
          state_event: {
            type: 'string',
            description: 'Optional: close or reopen'
          },
          labels: { type: 'string', description: 'Comma-separated labels (replaces set if provided)' }
        },
        required: ['project_id', 'issue_iid']
      }
    },
    {
      name: 'gitlab_list_issue_notes',
      description: 'List comments/notes on an issue (GET /projects/:id/issues/:iid/notes).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          issue_iid: { type: 'number' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id', 'issue_iid']
      }
    },
    {
      name: 'gitlab_create_issue_note',
      description: 'Add a comment to an issue (POST note).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          issue_iid: { type: 'number' },
          body: { type: 'string', description: 'Comment text (Markdown)' }
        },
        required: ['project_id', 'issue_iid', 'body']
      }
    },

    {
      name: 'gitlab_list_merge_requests',
      description: 'List merge requests for a project.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          state: {
            type: 'string',
            description: 'opened, closed, merged, all',
            default: 'opened'
          },
          search: { type: 'string' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_get_merge_request',
      description: 'Get a single merge request by project and IID.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          mr_iid: { type: 'number' }
        },
        required: ['project_id', 'mr_iid']
      }
    },
    {
      name: 'gitlab_create_merge_request',
      description: 'Open a new MR (POST /projects/:id/merge_requests).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          source_branch: { type: 'string' },
          target_branch: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', default: '' },
          remove_source_branch: { type: 'boolean', description: 'Delete source branch after merge' },
          draft: { type: 'boolean', description: 'Create as draft/WIP' }
        },
        required: ['project_id', 'source_branch', 'target_branch', 'title']
      }
    },
    {
      name: 'gitlab_update_merge_request',
      description:
        'Update MR metadata (PUT). Use state_event: close, reopen, or merge (merge may fail if not mergeable).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          mr_iid: { type: 'number' },
          title: { type: 'string' },
          description: { type: 'string' },
          target_branch: { type: 'string' },
          state_event: {
            type: 'string',
            description: 'Optional: close, reopen, merge (prefer gitlab_merge_merge_request for merge)'
          }
        },
        required: ['project_id', 'mr_iid']
      }
    },
    {
      name: 'gitlab_merge_merge_request',
      description:
        'Merge an MR (PUT .../merge). Prefer this over state_event merge on update. Supports squash and delete source branch.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          mr_iid: { type: 'number' },
          merge_commit_message: { type: 'string' },
          squash_commit_message: { type: 'string' },
          should_remove_source_branch: { type: 'boolean' },
          squash: { type: 'boolean', description: 'Squash commits into one' },
          merge_when_pipeline_succeeds: { type: 'boolean' }
        },
        required: ['project_id', 'mr_iid']
      }
    },
    {
      name: 'gitlab_get_merge_request_changes',
      description:
        'Get MR diffs per file (GET .../merge_requests/:iid/changes). Large; use for review.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          mr_iid: { type: 'number' },
          max_diff_length: {
            type: 'number',
            description: 'Truncate each file diff to this many chars (0 = no truncate)',
            default: 8000
          }
        },
        required: ['project_id', 'mr_iid']
      }
    },
    {
      name: 'gitlab_list_merge_request_notes',
      description:
        'List MR comments/notes, flat chronological list (GET .../merge_requests/:iid/notes). Includes system notes.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          mr_iid: { type: 'number', description: 'Merge request IID' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 },
          sort: { type: 'string', description: 'asc or desc', default: 'desc' },
          order_by: {
            type: 'string',
            description: 'created_at or updated_at',
            default: 'created_at'
          }
        },
        required: ['project_id', 'mr_iid']
      }
    },
    {
      name: 'gitlab_list_merge_request_discussions',
      description:
        'List MR discussions (threads with replies and diff line comments). GET .../merge_requests/:iid/discussions. Prefer over notes for code review.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          mr_iid: { type: 'number', description: 'Merge request IID' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 20 }
        },
        required: ['project_id', 'mr_iid']
      }
    },

    {
      name: 'gitlab_list_pipelines',
      description: 'List CI pipelines for a project (GET /projects/:id/pipelines).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          ref: { type: 'string', description: 'Branch or tag name' },
          status: {
            type: 'string',
            description: 'running, pending, success, failed, canceled, skipped, etc.'
          },
          sha: { type: 'string' },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 20 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_get_pipeline',
      description: 'Get one pipeline by numeric id.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          pipeline_id: { type: 'number' }
        },
        required: ['project_id', 'pipeline_id']
      }
    },
    {
      name: 'gitlab_create_pipeline',
      description:
        'Trigger a pipeline on a ref (POST /projects/:id/pipeline). The `variables` argument is ephemeral (one-shot for this pipeline only). For persistent Settings → CI/CD → Variables use gitlab_*_project_variable / gitlab_*_group_variable.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          ref: { type: 'string', description: 'Branch or tag' },
          variables: {
            type: 'array',
            description:
              'Ephemeral pipeline variables only: [{ key, value }]. Not the same as project/group CI/CD variables CRUD.',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: { type: 'string' }
              },
              required: ['key', 'value']
            }
          }
        },
        required: ['project_id', 'ref']
      }
    },
    {
      name: 'gitlab_retry_pipeline',
      description: 'Retry failed jobs in a pipeline.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          pipeline_id: { type: 'number' }
        },
        required: ['project_id', 'pipeline_id']
      }
    },
    {
      name: 'gitlab_cancel_pipeline',
      description: 'Cancel a pipeline and its jobs.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          pipeline_id: { type: 'number' }
        },
        required: ['project_id', 'pipeline_id']
      }
    },
    {
      name: 'gitlab_list_pipeline_jobs',
      description: 'List jobs for a pipeline.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          pipeline_id: { type: 'number' },
          include_retried: { type: 'boolean', default: false }
        },
        required: ['project_id', 'pipeline_id']
      }
    },
    {
      name: 'gitlab_get_job_trace',
      description: 'Download job log (plain text). Long logs are truncated from the start; tail is kept.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          job_id: { type: 'number' },
          max_chars: {
            type: 'number',
            description: 'Max characters returned (tail preserved)',
            default: 65536
          }
        },
        required: ['project_id', 'job_id']
      }
    },
    {
      name: 'gitlab_retry_job',
      description: 'Retry a single job.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          job_id: { type: 'number' }
        },
        required: ['project_id', 'job_id']
      }
    },
    {
      name: 'gitlab_play_job',
      description: 'Run a manual job (when status is manual).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          job_id: { type: 'number' }
        },
        required: ['project_id', 'job_id']
      }
    },

    {
      name: 'gitlab_get_job_token_scope',
      description:
        'Get CI job token scope settings (GET /projects/:id/job_token_scope). Returns inbound_enabled / outbound_enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Target project ID or path (the project that receives job-token access)'
          }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_list_job_token_allowlist',
      description:
        'List inbound CI job token project allowlist (GET .../job_token_scope/allowlist). Listed projects may use their CI_JOB_TOKEN to access project_id.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Allowlist owner project ID or path (deployable / registry project)'
          },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_add_job_token_allowlist',
      description:
        'Add a project to inbound CI job token allowlist (POST .../allowlist). target_project_id may be numeric id or path (path is resolved). Idempotent: already present → { already_present: true }.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Allowlist owner project ID or path'
          },
          target_project_id: {
            description:
              'Source project whose CI_JOB_TOKEN will be allowed (numeric id or path)',
            oneOf: [{ type: 'number' }, { type: 'string' }]
          }
        },
        required: ['project_id', 'target_project_id']
      }
    },
    {
      name: 'gitlab_remove_job_token_allowlist',
      description:
        'Remove a project from inbound CI job token allowlist (DELETE .../allowlist/:target_project_id). target_project_id may be id or path. Idempotent: missing entry → { ok: true, already_absent: true }.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Allowlist owner project ID or path'
          },
          target_project_id: {
            description: 'Source project to remove (numeric id or path)',
            oneOf: [{ type: 'number' }, { type: 'string' }]
          }
        },
        required: ['project_id', 'target_project_id']
      }
    },
    {
      name: 'gitlab_list_job_token_groups_allowlist',
      description:
        'List inbound CI job token groups allowlist (GET .../job_token_scope/groups_allowlist).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Allowlist owner project ID or path'
          },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_add_job_token_groups_allowlist',
      description:
        'Add a group to inbound CI job token groups allowlist (POST .../groups_allowlist). target_group_id may be numeric id or path. Idempotent if already present.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Allowlist owner project ID or path'
          },
          target_group_id: {
            description: 'Group to allow (numeric id or path)',
            oneOf: [{ type: 'number' }, { type: 'string' }]
          }
        },
        required: ['project_id', 'target_group_id']
      }
    },
    {
      name: 'gitlab_remove_job_token_groups_allowlist',
      description:
        'Remove a group from inbound CI job token groups allowlist (DELETE .../groups_allowlist/:target_group_id). Idempotent if already absent.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Allowlist owner project ID or path'
          },
          target_group_id: {
            description: 'Group to remove (numeric id or path)',
            oneOf: [{ type: 'number' }, { type: 'string' }]
          }
        },
        required: ['project_id', 'target_group_id']
      }
    },

    {
      name: 'gitlab_list_project_variables',
      description:
        'List persistent project CI/CD variables (GET /projects/:id/variables). By default values are omitted (metadata only); set include_values=true to include secrets (avoid dumping into chat). Not the same as gitlab_create_pipeline.variables.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or path' },
          include_values: {
            type: 'boolean',
            description: 'If true, include value fields (secrets). Default false.',
            default: false
          },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['project_id']
      }
    },
    {
      name: 'gitlab_get_project_variable',
      description:
        'Get one persistent project CI/CD variable (GET /projects/:id/variables/:key). Returns value — treat as secret. Use filter_environment_scope when the same key exists under multiple scopes.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          key: { type: 'string' },
          filter_environment_scope: {
            type: 'string',
            description: 'Maps to filter[environment_scope] when key+scope duplicates exist'
          }
        },
        required: ['project_id', 'key']
      }
    },
    {
      name: 'gitlab_create_project_variable',
      description:
        'Create a persistent project CI/CD variable (POST /projects/:id/variables). Prefer gitlab_upsert_project_variable for idempotent agent flows. Masked vars must satisfy GitLab charset/length rules.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string', description: 'Variable value (secret — not logged by this server)' },
          ...VARIABLE_WRITE_PROPS
        },
        required: ['project_id', 'key', 'value']
      }
    },
    {
      name: 'gitlab_update_project_variable',
      description:
        'Update a persistent project CI/CD variable (PUT /projects/:id/variables/:key). Pass value when changing it; flags optional.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string', description: 'New value (omit only if GitLab allows partial update — usually send value)' },
          filter_environment_scope: {
            type: 'string',
            description: 'Maps to filter[environment_scope]'
          },
          ...VARIABLE_WRITE_PROPS
        },
        required: ['project_id', 'key']
      }
    },
    {
      name: 'gitlab_delete_project_variable',
      description:
        'Delete a persistent project CI/CD variable (DELETE /projects/:id/variables/:key). Idempotent: missing → { ok: true, already_absent: true }.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          key: { type: 'string' },
          filter_environment_scope: {
            type: 'string',
            description: 'Maps to filter[environment_scope]'
          }
        },
        required: ['project_id', 'key']
      }
    },
    {
      name: 'gitlab_upsert_project_variable',
      description:
        'Idempotent ensure project CI/CD variable exists with given value/flags: GET → create or update. Preferred for agent workflows.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          ...VARIABLE_WRITE_PROPS
        },
        required: ['project_id', 'key', 'value']
      }
    },

    {
      name: 'gitlab_list_group_variables',
      description:
        'List persistent group CI/CD variables (GET /groups/:id/variables). By default values omitted; set include_values=true to include secrets.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'string', description: 'Group ID or path (e.g. cubekit-v2)' },
          include_values: {
            type: 'boolean',
            description: 'If true, include value fields (secrets). Default false.',
            default: false
          },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 50 }
        },
        required: ['group_id']
      }
    },
    {
      name: 'gitlab_get_group_variable',
      description:
        'Get one persistent group CI/CD variable (GET /groups/:id/variables/:key). Returns value — treat as secret.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          key: { type: 'string' },
          filter_environment_scope: {
            type: 'string',
            description: 'Maps to filter[environment_scope]'
          }
        },
        required: ['group_id', 'key']
      }
    },
    {
      name: 'gitlab_create_group_variable',
      description:
        'Create a persistent group CI/CD variable (POST /groups/:id/variables). Prefer gitlab_upsert_group_variable for idempotent agent flows.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          ...VARIABLE_WRITE_PROPS
        },
        required: ['group_id', 'key', 'value']
      }
    },
    {
      name: 'gitlab_update_group_variable',
      description:
        'Update a persistent group CI/CD variable (PUT /groups/:id/variables/:key).',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          filter_environment_scope: {
            type: 'string',
            description: 'Maps to filter[environment_scope]'
          },
          ...VARIABLE_WRITE_PROPS
        },
        required: ['group_id', 'key']
      }
    },
    {
      name: 'gitlab_delete_group_variable',
      description:
        'Delete a persistent group CI/CD variable (DELETE /groups/:id/variables/:key). Idempotent if already absent.',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          key: { type: 'string' },
          filter_environment_scope: {
            type: 'string',
            description: 'Maps to filter[environment_scope]'
          }
        },
        required: ['group_id', 'key']
      }
    },
    {
      name: 'gitlab_upsert_group_variable',
      description:
        'Idempotent ensure group CI/CD variable exists with given value/flags: GET → create or update. Preferred for agent workflows (e.g. Cubekit group cubekit-v2).',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          ...VARIABLE_WRITE_PROPS
        },
        required: ['group_id', 'key', 'value']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args || {};

  try {
    if (name === 'gitlab_get_current_user') {
      const data = await glFetch('/user');
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_list_projects') {
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.search) params.set('search', String(a.search));
      const membership =
        typeof a.membership === 'boolean' ? a.membership : a.membership !== false;
      const simple = typeof a.simple === 'boolean' ? a.simple : true;
      if (membership) params.set('membership', 'true');
      if (simple) params.set('simple', 'true');
      const data = await glFetch(`/projects?${params.toString()}`);
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_project') {
      if (!a.id) throw new Error('id is required');
      const data = await glFetch(`/projects/${encodeProjectId(a.id)}`);
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_update_project') {
      if (!a.id) throw new Error('id is required');
      const body = {};
      if (a.default_branch != null) body.default_branch = String(a.default_branch);
      if (a.description != null) body.description = String(a.description);
      if (a.name != null) body.name = String(a.name);
      if (Object.keys(body).length === 0) {
        throw new Error('Provide at least one of: default_branch, description, name');
      }
      const data = await glFetch(`/projects/${encodeProjectId(a.id)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_repository_branch') {
      if (!a.project_id || !a.branch || !a.ref) {
        throw new Error('project_id, branch, and ref are required');
      }
      const params = new URLSearchParams();
      params.set('branch', String(a.branch));
      params.set('ref', String(a.ref));
      const data = await glFetch(
        `${projPath(a.project_id)}/repository/branches?${params.toString()}`,
        { method: 'POST' }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_list_repository_branches') {
      if (!a.project_id) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.search) params.set('search', String(a.search));
      const data = await glFetch(
        `${projPath(a.project_id)}/repository/branches?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_list_protected_branches') {
      if (!a.project_id) throw new Error('project_id is required');
      const params = new URLSearchParams();
      if (a.search) params.set('search', String(a.search));
      const q = params.toString();
      const data = await glFetch(
        `${projPath(a.project_id)}/protected_branches${q ? `?${q}` : ''}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_protect_branch') {
      if (!a.project_id || !a.name) {
        throw new Error('project_id and name are required');
      }
      const params = new URLSearchParams();
      params.set('name', String(a.name));
      const pushLevel =
        a.push_access_level != null ? Number(a.push_access_level) : 40;
      const mergeLevel =
        a.merge_access_level != null ? Number(a.merge_access_level) : 40;
      if (!Number.isFinite(pushLevel) || !Number.isFinite(mergeLevel)) {
        throw new Error('push_access_level and merge_access_level must be numbers');
      }
      params.set('push_access_level', String(pushLevel));
      params.set('merge_access_level', String(mergeLevel));
      const allowForce =
        typeof a.allow_force_push === 'boolean' ? a.allow_force_push : false;
      params.set('allow_force_push', allowForce ? 'true' : 'false');
      if (typeof a.code_owner_approval_required === 'boolean') {
        params.set(
          'code_owner_approval_required',
          a.code_owner_approval_required ? 'true' : 'false'
        );
      }
      const data = await glFetch(
        `${projPath(a.project_id)}/protected_branches?${params.toString()}`,
        { method: 'POST' }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_unprotect_branch') {
      if (!a.project_id || !a.name) {
        throw new Error('project_id and name are required');
      }
      const branchName = String(a.name);
      await glFetch(
        `${projPath(a.project_id)}/protected_branches/${encodeURIComponent(branchName)}`,
        { method: 'DELETE' }
      );
      return { content: jsonContent({ ok: true, name: branchName }) };
    }

    if (name === 'gitlab_list_issues') {
      if (!a.project_id) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.state) params.set('state', String(a.state));
      if (a.search) params.set('search', String(a.search));
      if (a.labels) params.set('labels', String(a.labels));
      const data = await glFetch(
        `${projPath(a.project_id)}/issues?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_issue') {
      const issueIid = Number(a.issue_iid);
      if (!a.project_id || !Number.isFinite(issueIid)) {
        throw new Error('project_id and numeric issue_iid are required');
      }
      const data = await glFetch(`${projPath(a.project_id)}/issues/${issueIid}`);
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_issue') {
      if (!a.project_id || !a.title) throw new Error('project_id and title are required');
      const body = {
        title: String(a.title),
        description: a.description != null ? String(a.description) : '',
        labels: a.labels != null ? String(a.labels) : undefined
      };
      const data = await glFetch(`${projPath(a.project_id)}/issues`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_update_issue') {
      const issueIid = Number(a.issue_iid);
      if (!a.project_id || !Number.isFinite(issueIid)) {
        throw new Error('project_id and numeric issue_iid are required');
      }
      const body = {};
      if (a.title != null) body.title = String(a.title);
      if (a.description != null) body.description = String(a.description);
      if (a.state_event) body.state_event = String(a.state_event);
      if (a.labels != null) body.labels = String(a.labels);
      if (Object.keys(body).length === 0) {
        throw new Error('Provide at least one of: title, description, state_event, labels');
      }
      const data = await glFetch(`${projPath(a.project_id)}/issues/${issueIid}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_list_issue_notes') {
      const issueIid = Number(a.issue_iid);
      if (!a.project_id || !Number.isFinite(issueIid)) {
        throw new Error('project_id and numeric issue_iid are required');
      }
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      const data = await glFetch(
        `${projPath(a.project_id)}/issues/${issueIid}/notes?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_create_issue_note') {
      const issueIid = Number(a.issue_iid);
      if (!a.project_id || !Number.isFinite(issueIid) || a.body == null) {
        throw new Error('project_id, issue_iid, and body are required');
      }
      const data = await glFetch(`${projPath(a.project_id)}/issues/${issueIid}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: String(a.body) })
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_list_merge_requests') {
      if (!a.project_id) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.state) params.set('state', String(a.state));
      if (a.search) params.set('search', String(a.search));
      const data = await glFetch(
        `${projPath(a.project_id)}/merge_requests?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_merge_request') {
      const mrIid = Number(a.mr_iid);
      if (!a.project_id || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const data = await glFetch(`${projPath(a.project_id)}/merge_requests/${mrIid}`);
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_merge_request') {
      if (!a.project_id || !a.source_branch || !a.target_branch || !a.title) {
        throw new Error('project_id, source_branch, target_branch, title are required');
      }
      const body = {
        source_branch: String(a.source_branch),
        target_branch: String(a.target_branch),
        title: String(a.title),
        description: a.description != null ? String(a.description) : ''
      };
      if (a.remove_source_branch === true) body.remove_source_branch = true;
      if (a.draft === true) body.draft = true;
      const data = await glFetch(`${projPath(a.project_id)}/merge_requests`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_update_merge_request') {
      const mrIid = Number(a.mr_iid);
      if (!a.project_id || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const body = {};
      if (a.title != null) body.title = String(a.title);
      if (a.description != null) body.description = String(a.description);
      if (a.target_branch != null) body.target_branch = String(a.target_branch);
      if (a.state_event) body.state_event = String(a.state_event);
      if (Object.keys(body).length === 0) {
        throw new Error('Provide at least one of: title, description, target_branch, state_event');
      }
      const data = await glFetch(`${projPath(a.project_id)}/merge_requests/${mrIid}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_merge_merge_request') {
      const mrIid = Number(a.mr_iid);
      if (!a.project_id || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const body = {};
      if (a.merge_commit_message != null) body.merge_commit_message = String(a.merge_commit_message);
      if (a.squash_commit_message != null) {
        body.squash_commit_message = String(a.squash_commit_message);
      }
      if (a.should_remove_source_branch === true) body.should_remove_source_branch = true;
      if (a.squash === true) body.squash = true;
      if (a.merge_when_pipeline_succeeds === true) {
        body.merge_when_pipeline_succeeds = true;
      }
      const data = await glFetch(
        `${projPath(a.project_id)}/merge_requests/${mrIid}/merge`,
        {
          method: 'PUT',
          body: JSON.stringify(body)
        }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_get_merge_request_changes') {
      const mrIid = Number(a.mr_iid);
      if (!a.project_id || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const maxLen = Number(a.max_diff_length);
      const cap = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 0;
      const raw = await glFetch(`${projPath(a.project_id)}/merge_requests/${mrIid}/changes`);
      if (!raw || typeof raw !== 'object') {
        return { content: jsonContent(raw) };
      }
      const changes = Array.isArray(raw.changes) ? raw.changes : [];
      const trimmed = changes.map((c) => {
        const diff = c.diff;
        if (cap && typeof diff === 'string' && diff.length > cap) {
          return {
            ...c,
            diff: `… [truncated ${diff.length - cap} chars]\n` + diff.slice(-cap)
          };
        }
        return c;
      });
      return {
        content: jsonContent({
          ...raw,
          changes: trimmed,
          _truncation_note: cap
            ? `Each diff truncated to last ${cap} chars when longer`
            : undefined
        })
      };
    }

    if (name === 'gitlab_list_merge_request_notes') {
      const mrIid = Number(a.mr_iid);
      if (!a.project_id || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.sort) params.set('sort', String(a.sort));
      if (a.order_by) params.set('order_by', String(a.order_by));
      const data = await glFetch(
        `${projPath(a.project_id)}/merge_requests/${mrIid}/notes?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_list_merge_request_discussions') {
      const mrIid = Number(a.mr_iid);
      if (!a.project_id || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 20));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      const data = await glFetch(
        `${projPath(a.project_id)}/merge_requests/${mrIid}/discussions?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_list_pipelines') {
      if (!a.project_id) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 20));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.ref) params.set('ref', String(a.ref));
      if (a.status) params.set('status', String(a.status));
      if (a.sha) params.set('sha', String(a.sha));
      const data = await glFetch(`${projPath(a.project_id)}/pipelines?${params.toString()}`);
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_pipeline') {
      const pipelineId = Number(a.pipeline_id);
      if (!a.project_id || !Number.isFinite(pipelineId)) {
        throw new Error('project_id and numeric pipeline_id are required');
      }
      const data = await glFetch(`${projPath(a.project_id)}/pipelines/${pipelineId}`);
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_pipeline') {
      if (!a.project_id || !a.ref) throw new Error('project_id and ref are required');
      const body = { ref: String(a.ref) };
      if (Array.isArray(a.variables) && a.variables.length > 0) {
        body.variables = a.variables.map((v) => ({
          key: String(v.key),
          value: String(v.value)
        }));
      }
      const data = await glFetch(`${projPath(a.project_id)}/pipeline`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_retry_pipeline') {
      const pipelineId = Number(a.pipeline_id);
      if (!a.project_id || !Number.isFinite(pipelineId)) {
        throw new Error('project_id and numeric pipeline_id are required');
      }
      const data = await glFetch(
        `${projPath(a.project_id)}/pipelines/${pipelineId}/retry`,
        { method: 'POST', body: '{}' }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_cancel_pipeline') {
      const pipelineId = Number(a.pipeline_id);
      if (!a.project_id || !Number.isFinite(pipelineId)) {
        throw new Error('project_id and numeric pipeline_id are required');
      }
      const data = await glFetch(
        `${projPath(a.project_id)}/pipelines/${pipelineId}/cancel`,
        { method: 'POST', body: '{}' }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_list_pipeline_jobs') {
      const pipelineId = Number(a.pipeline_id);
      if (!a.project_id || !Number.isFinite(pipelineId)) {
        throw new Error('project_id and numeric pipeline_id are required');
      }
      const params = new URLSearchParams();
      if (a.include_retried === true) params.set('include_retried', 'true');
      const q = params.toString();
      const data = await glFetch(
        `${projPath(a.project_id)}/pipelines/${pipelineId}/jobs${q ? `?${q}` : ''}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_job_trace') {
      const jobId = Number(a.job_id);
      if (!a.project_id || !Number.isFinite(jobId)) {
        throw new Error('project_id and numeric job_id are required');
      }
      const maxChars = Math.max(4096, Math.min(512000, Number(a.max_chars) || 65536));
      const fullTrace = await glFetchText(`${projPath(a.project_id)}/jobs/${jobId}/trace`);
      const total = fullTrace.length;
      let trace = fullTrace;
      let note = '';
      if (total > maxChars) {
        const omitted = total - maxChars;
        trace = `… [${omitted} characters omitted from start of log]\n\n` + fullTrace.slice(-maxChars);
        note = `Returned last ${maxChars} chars of ${total} total.`;
      }
      return { content: jsonContent(note ? { _note: note, trace } : trace) };
    }

    if (name === 'gitlab_retry_job') {
      const jobId = Number(a.job_id);
      if (!a.project_id || !Number.isFinite(jobId)) {
        throw new Error('project_id and numeric job_id are required');
      }
      const data = await glFetch(`${projPath(a.project_id)}/jobs/${jobId}/retry`, {
        method: 'POST',
        body: '{}'
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_play_job') {
      const jobId = Number(a.job_id);
      if (!a.project_id || !Number.isFinite(jobId)) {
        throw new Error('project_id and numeric job_id are required');
      }
      const data = await glFetch(`${projPath(a.project_id)}/jobs/${jobId}/play`, {
        method: 'POST',
        body: '{}'
      });
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_get_job_token_scope') {
      if (!a.project_id) throw new Error('project_id is required');
      // Some GitLab builds reject path ids on job_token_scope mutations; resolve always.
      const ownerId = await resolveProjectNumericId(a.project_id);
      const data = await glFetch(`${projPath(ownerId)}/job_token_scope`);
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_list_job_token_allowlist') {
      if (!a.project_id) throw new Error('project_id is required');
      const ownerId = await resolveProjectNumericId(a.project_id);
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      const data = await glFetch(
        `${projPath(ownerId)}/job_token_scope/allowlist?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_add_job_token_allowlist') {
      if (!a.project_id || a.target_project_id == null || a.target_project_id === '') {
        throw new Error('project_id and target_project_id are required');
      }
      const ownerId = await resolveProjectNumericId(a.project_id);
      const targetId = await resolveProjectNumericId(a.target_project_id);
      const { status, data } = await glFetchStatus(
        `${projPath(ownerId)}/job_token_scope/allowlist`,
        {
          method: 'POST',
          body: JSON.stringify({ target_project_id: targetId })
        },
        [400, 409]
      );
      if (status === 409 || isAlreadyPresentAllowlistError(status, data, 'project')) {
        return {
          content: jsonContent({
            already_present: true,
            source_project_id: ownerId,
            target_project_id: targetId,
            message: 'Project already on job token allowlist'
          })
        };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return {
        content: jsonContent(
          data && typeof data === 'object'
            ? data
            : { source_project_id: ownerId, target_project_id: targetId }
        )
      };
    }

    if (name === 'gitlab_remove_job_token_allowlist') {
      if (!a.project_id || a.target_project_id == null || a.target_project_id === '') {
        throw new Error('project_id and target_project_id are required');
      }
      const ownerId = await resolveProjectNumericId(a.project_id);
      const targetId = await resolveProjectNumericId(a.target_project_id);
      const { status, data } = await glFetchStatus(
        `${projPath(ownerId)}/job_token_scope/allowlist/${targetId}`,
        { method: 'DELETE' },
        [400, 404]
      );
      if (status === 404 || isAlreadyAbsentAllowlistError(status, data, 'project')) {
        return {
          content: jsonContent({
            ok: true,
            already_absent: true,
            source_project_id: ownerId,
            target_project_id: targetId
          })
        };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return {
        content: jsonContent({
          ok: true,
          source_project_id: ownerId,
          target_project_id: targetId
        })
      };
    }

    if (name === 'gitlab_list_job_token_groups_allowlist') {
      if (!a.project_id) throw new Error('project_id is required');
      const ownerId = await resolveProjectNumericId(a.project_id);
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      const data = await glFetch(
        `${projPath(ownerId)}/job_token_scope/groups_allowlist?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_add_job_token_groups_allowlist') {
      if (!a.project_id || a.target_group_id == null || a.target_group_id === '') {
        throw new Error('project_id and target_group_id are required');
      }
      const ownerId = await resolveProjectNumericId(a.project_id);
      const targetGroupId = await resolveGroupNumericId(a.target_group_id);
      const { status, data } = await glFetchStatus(
        `${projPath(ownerId)}/job_token_scope/groups_allowlist`,
        {
          method: 'POST',
          body: JSON.stringify({ target_group_id: targetGroupId })
        },
        [400, 409]
      );
      if (status === 409 || isAlreadyPresentAllowlistError(status, data, 'group')) {
        return {
          content: jsonContent({
            already_present: true,
            source_project_id: ownerId,
            target_group_id: targetGroupId,
            message: 'Group already on job token groups allowlist'
          })
        };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return {
        content: jsonContent(
          data && typeof data === 'object'
            ? data
            : { source_project_id: ownerId, target_group_id: targetGroupId }
        )
      };
    }

    if (name === 'gitlab_remove_job_token_groups_allowlist') {
      if (!a.project_id || a.target_group_id == null || a.target_group_id === '') {
        throw new Error('project_id and target_group_id are required');
      }
      const ownerId = await resolveProjectNumericId(a.project_id);
      const targetGroupId = await resolveGroupNumericId(a.target_group_id);
      const { status, data } = await glFetchStatus(
        `${projPath(ownerId)}/job_token_scope/groups_allowlist/${targetGroupId}`,
        { method: 'DELETE' },
        [400, 404]
      );
      if (status === 404 || isAlreadyAbsentAllowlistError(status, data, 'group')) {
        return {
          content: jsonContent({
            ok: true,
            already_absent: true,
            source_project_id: ownerId,
            target_group_id: targetGroupId
          })
        };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return {
        content: jsonContent({
          ok: true,
          source_project_id: ownerId,
          target_group_id: targetGroupId
        })
      };
    }

    // --- Project CI/CD variables (persistent Settings → CI/CD → Variables) ---

    if (name === 'gitlab_list_project_variables') {
      if (!a.project_id) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      const data = await glFetch(`${projPath(a.project_id)}/variables?${params.toString()}`);
      const list = Array.isArray(data) ? data : [];
      return {
        content: jsonContent(a.include_values === true ? list : stripVariableValues(list))
      };
    }

    if (name === 'gitlab_get_project_variable') {
      if (!a.project_id || !a.key) throw new Error('project_id and key are required');
      const params = new URLSearchParams();
      appendEnvScopeFilter(params, a);
      const q = params.toString();
      const data = await glFetch(
        `${projPath(a.project_id)}/variables/${encodeURIComponent(String(a.key))}${q ? `?${q}` : ''}`
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_project_variable') {
      if (!a.project_id) throw new Error('project_id is required');
      const body = buildVariableWriteBody(a, { requireKey: true, requireValue: true });
      const { status, data } = await glFetchStatus(
        `${projPath(a.project_id)}/variables`,
        { method: 'POST', body: JSON.stringify(body) },
        [400, 409]
      );
      if (isVariableAlreadyExistsError(status, data)) {
        return {
          content: jsonContent({
            error: 'variable_already_exists',
            key: body.key,
            environment_scope: body.environment_scope ?? '*',
            message:
              'Variable with this key (and scope) already exists. Use gitlab_update_project_variable or gitlab_upsert_project_variable.',
            gitlab: summarizeApiError(data)
          }),
          isError: true
        };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_update_project_variable') {
      if (!a.project_id || !a.key) throw new Error('project_id and key are required');
      const body = buildVariableWriteBody(a);
      delete body.key;
      const params = new URLSearchParams();
      appendEnvScopeFilter(params, a);
      const q = params.toString();
      const data = await glFetch(
        `${projPath(a.project_id)}/variables/${encodeURIComponent(String(a.key))}${q ? `?${q}` : ''}`,
        { method: 'PUT', body: JSON.stringify(body) }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_delete_project_variable') {
      if (!a.project_id || !a.key) throw new Error('project_id and key are required');
      const key = String(a.key);
      const params = new URLSearchParams();
      appendEnvScopeFilter(params, a);
      const q = params.toString();
      const { status, data } = await glFetchStatus(
        `${projPath(a.project_id)}/variables/${encodeURIComponent(key)}${q ? `?${q}` : ''}`,
        { method: 'DELETE' },
        [404]
      );
      if (status === 404) {
        return { content: jsonContent({ ok: true, already_absent: true, key }) };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return { content: jsonContent({ ok: true, key }) };
    }

    if (name === 'gitlab_upsert_project_variable') {
      if (!a.project_id || !a.key) throw new Error('project_id and key are required');
      const key = String(a.key);
      const params = new URLSearchParams();
      if (a.environment_scope != null && String(a.environment_scope) !== '') {
        params.set('filter[environment_scope]', String(a.environment_scope));
      }
      const q = params.toString();
      const getPath = `${projPath(a.project_id)}/variables/${encodeURIComponent(key)}${q ? `?${q}` : ''}`;
      const { status: getStatus } = await glFetchStatus(getPath, {}, [404]);
      if (getStatus === 404) {
        const body = buildVariableWriteBody(a, { requireKey: true, requireValue: true });
        const created = await glFetch(`${projPath(a.project_id)}/variables`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        return { content: jsonContent({ upserted: 'created', variable: created }) };
      }
      const body = buildVariableWriteBody(a, { requireValue: true });
      delete body.key;
      const updated = await glFetch(getPath, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      return { content: jsonContent({ upserted: 'updated', variable: updated }) };
    }

    // --- Group CI/CD variables ---

    if (name === 'gitlab_list_group_variables') {
      if (!a.group_id) throw new Error('group_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      const data = await glFetch(`${groupPath(a.group_id)}/variables?${params.toString()}`);
      const list = Array.isArray(data) ? data : [];
      return {
        content: jsonContent(a.include_values === true ? list : stripVariableValues(list))
      };
    }

    if (name === 'gitlab_get_group_variable') {
      if (!a.group_id || !a.key) throw new Error('group_id and key are required');
      const params = new URLSearchParams();
      appendEnvScopeFilter(params, a);
      const q = params.toString();
      const data = await glFetch(
        `${groupPath(a.group_id)}/variables/${encodeURIComponent(String(a.key))}${q ? `?${q}` : ''}`
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_group_variable') {
      if (!a.group_id) throw new Error('group_id is required');
      const body = buildVariableWriteBody(a, { requireKey: true, requireValue: true });
      const { status, data } = await glFetchStatus(
        `${groupPath(a.group_id)}/variables`,
        { method: 'POST', body: JSON.stringify(body) },
        [400, 409]
      );
      if (isVariableAlreadyExistsError(status, data)) {
        return {
          content: jsonContent({
            error: 'variable_already_exists',
            key: body.key,
            environment_scope: body.environment_scope ?? '*',
            message:
              'Variable with this key (and scope) already exists. Use gitlab_update_group_variable or gitlab_upsert_group_variable.',
            gitlab: summarizeApiError(data)
          }),
          isError: true
        };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_update_group_variable') {
      if (!a.group_id || !a.key) throw new Error('group_id and key are required');
      const body = buildVariableWriteBody(a);
      delete body.key;
      const params = new URLSearchParams();
      appendEnvScopeFilter(params, a);
      const q = params.toString();
      const data = await glFetch(
        `${groupPath(a.group_id)}/variables/${encodeURIComponent(String(a.key))}${q ? `?${q}` : ''}`,
        { method: 'PUT', body: JSON.stringify(body) }
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_delete_group_variable') {
      if (!a.group_id || !a.key) throw new Error('group_id and key are required');
      const key = String(a.key);
      const params = new URLSearchParams();
      appendEnvScopeFilter(params, a);
      const q = params.toString();
      const { status, data } = await glFetchStatus(
        `${groupPath(a.group_id)}/variables/${encodeURIComponent(key)}${q ? `?${q}` : ''}`,
        { method: 'DELETE' },
        [404]
      );
      if (status === 404) {
        return { content: jsonContent({ ok: true, already_absent: true, key }) };
      }
      if (status >= 400) {
        throw new Error(`${status}: ${summarizeApiError(data)}`);
      }
      return { content: jsonContent({ ok: true, key }) };
    }

    if (name === 'gitlab_upsert_group_variable') {
      if (!a.group_id || !a.key) throw new Error('group_id and key are required');
      const key = String(a.key);
      const params = new URLSearchParams();
      if (a.environment_scope != null && String(a.environment_scope) !== '') {
        params.set('filter[environment_scope]', String(a.environment_scope));
      }
      const q = params.toString();
      const getPath = `${groupPath(a.group_id)}/variables/${encodeURIComponent(key)}${q ? `?${q}` : ''}`;
      const { status: getStatus } = await glFetchStatus(getPath, {}, [404]);
      if (getStatus === 404) {
        const body = buildVariableWriteBody(a, { requireKey: true, requireValue: true });
        const created = await glFetch(`${groupPath(a.group_id)}/variables`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        return { content: jsonContent({ upserted: 'created', variable: created }) };
      }
      const body = buildVariableWriteBody(a, { requireValue: true });
      delete body.key;
      const updated = await glFetch(getPath, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      return { content: jsonContent({ upserted: 'updated', variable: updated }) };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
