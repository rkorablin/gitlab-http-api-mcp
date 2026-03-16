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

async function glFetch(path, opts = {}) {
  const url = path.startsWith('http') ? path : `${baseApi}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

function jsonContent(value) {
  return [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }
  ];
}

const server = new Server(
  { name: 'gitlab-http-api-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Basic info
    {
      name: 'gitlab_get_current_user',
      description: 'Get the current GitLab user (GET /user).',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },

    // Projects / repositories
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
          per_page: {
            type: 'number',
            description: 'Items per page (max 100)',
            default: 50
          }
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

    // Issues
    {
      name: 'gitlab_list_issues',
      description:
        'List issues for a project. Mirrors basic fields from GitLab issues API (GET /projects/:id/issues).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID or URL-encoded path (e.g. ai%2Fhome-network)'
          },
          state: {
            type: 'string',
            description: 'Issue state: opened, closed, all',
            default: 'opened'
          },
          search: { type: 'string', description: 'Search term for title/description' },
          labels: {
            type: 'string',
            description: 'Comma-separated list of labels to filter by'
          },
          page: { type: 'number', description: 'Page number (1-based)', default: 1 },
          per_page: { type: 'number', description: 'Items per page (max 100)', default: 50 }
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
          project_id: {
            type: 'string',
            description: 'Project ID or URL-encoded path'
          },
          issue_iid: {
            type: 'number',
            description: 'Issue internal ID (IID)'
          }
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
          project_id: {
            type: 'string',
            description: 'Project ID or URL-encoded path'
          },
          title: { type: 'string', description: 'Issue title' },
          description: {
            type: 'string',
            description: 'Issue description (Markdown)',
            default: ''
          },
          labels: {
            type: 'string',
            description: 'Comma-separated labels',
            default: ''
          }
        },
        required: ['project_id', 'title']
      }
    },

    // Merge requests
    {
      name: 'gitlab_list_merge_requests',
      description:
        'List merge requests for a project. Mirrors basic fields from GitLab MRs API (GET /projects/:id/merge_requests).',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project ID or URL-encoded path'
          },
          state: {
            type: 'string',
            description: 'MR state: opened, closed, merged, all',
            default: 'opened'
          },
          search: { type: 'string', description: 'Search term for title' },
          page: { type: 'number', description: 'Page number (1-based)', default: 1 },
          per_page: { type: 'number', description: 'Items per page (max 100)', default: 50 }
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
          project_id: {
            type: 'string',
            description: 'Project ID or URL-encoded path'
          },
          mr_iid: {
            type: 'number',
            description: 'Merge request internal ID (IID)'
          }
        },
        required: ['project_id', 'mr_iid']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args || {};

  try {
    // Basic info
    if (name === 'gitlab_get_current_user') {
      const data = await glFetch('/user');
      return { content: jsonContent(data) };
    }

    // Projects
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
      const id = a.id;
      if (!id) throw new Error('id is required');
      const data = await glFetch(`/projects/${encodeURIComponent(String(id))}`);
      return { content: jsonContent(data) };
    }

    // Issues
    if (name === 'gitlab_list_issues') {
      const projectId = a.project_id;
      if (!projectId) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.state) params.set('state', String(a.state));
      if (a.search) params.set('search', String(a.search));
      if (a.labels) params.set('labels', String(a.labels));
      const data = await glFetch(
        `/projects/${encodeURIComponent(String(projectId))}/issues?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_issue') {
      const projectId = a.project_id;
      const issueIid = Number(a.issue_iid);
      if (!projectId || !Number.isFinite(issueIid)) {
        throw new Error('project_id and numeric issue_iid are required');
      }
      const data = await glFetch(
        `/projects/${encodeURIComponent(String(projectId))}/issues/${issueIid}`
      );
      return { content: jsonContent(data) };
    }

    if (name === 'gitlab_create_issue') {
      const projectId = a.project_id;
      const title = a.title;
      if (!projectId || !title) {
        throw new Error('project_id and title are required');
      }
      const body = {
        title: String(title),
        description: a.description != null ? String(a.description) : '',
        labels: a.labels != null ? String(a.labels) : undefined
      };
      const data = await glFetch(
        `/projects/${encodeURIComponent(String(projectId))}/issues`,
        {
          method: 'POST',
          body: JSON.stringify(body)
        }
      );
      return { content: jsonContent(data) };
    }

    // Merge requests
    if (name === 'gitlab_list_merge_requests') {
      const projectId = a.project_id;
      if (!projectId) throw new Error('project_id is required');
      const page = Math.max(1, Number(a.page) || 1);
      const perPage = Math.max(1, Math.min(100, Number(a.per_page) || 50));
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per_page', String(perPage));
      if (a.state) params.set('state', String(a.state));
      if (a.search) params.set('search', String(a.search));
      const data = await glFetch(
        `/projects/${encodeURIComponent(String(projectId))}/merge_requests?${params.toString()}`
      );
      return { content: jsonContent(Array.isArray(data) ? data : []) };
    }

    if (name === 'gitlab_get_merge_request') {
      const projectId = a.project_id;
      const mrIid = Number(a.mr_iid);
      if (!projectId || !Number.isFinite(mrIid)) {
        throw new Error('project_id and numeric mr_iid are required');
      }
      const data = await glFetch(
        `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${mrIid}`
      );
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

