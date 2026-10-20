import { WORKSPACE_VAR } from '~/lib/mcp';

/**
 * Quick starts for a stdio MCP server: each fills in the Add server form,
 * which people can still change. `env` lists variables the server needs
 * (their values are typed in, and kept in the keychain).
 */
export interface McpPreset {
  id: string;
  name: string;
  slug: string;
  description: string;
  command: string;
  args: string[];
  env: string[];
  /** What to know before adding it. */
  note?: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    slug: 'filesystem',
    description: 'Read, write and search files in the agent’s workspace.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', WORKSPACE_VAR],
    env: [],
    note: 'Needs Node.js (npx).',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    slug: 'fetch',
    description: 'Fetch web pages and turn them into Markdown.',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    note: 'Needs uv (uvx), the Python package runner.',
  },
  {
    id: 'memory',
    name: 'Memory',
    slug: 'memory',
    description: 'A knowledge graph the agent keeps between conversations.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    note: 'Needs Node.js (npx).',
  },
  {
    id: 'everything',
    name: 'Everything (test)',
    slug: 'everything',
    description: 'A test server with one of every kind of tool. Good for trying MCP out.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    env: [],
    note: 'Needs Node.js (npx).',
  },
  {
    id: 'github',
    name: 'GitHub',
    slug: 'github',
    description: 'Issues, pull requests and files on GitHub.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    note: 'Needs Node.js (npx) and a GitHub personal access token.',
  },
];
