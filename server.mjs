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
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

const server = new Server(
  { name: 'gitlab-http-api-mcp', version: '0.2.4' },
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
      description: 'Trigger a pipeline on a ref (POST /projects/:id/pipeline).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          ref: { type: 'string', description: 'Branch or tag' },
          variables: {
            type: 'array',
            description: 'CI variables: [{ key, value }]',
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

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
