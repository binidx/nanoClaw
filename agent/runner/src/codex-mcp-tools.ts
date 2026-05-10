import type { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport as SdkStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { collectForwardedMemoryEnv } from './memory-tools.js';
import { formatStructuredPromptValue } from './model-serialization.js';

interface ExternalMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface DynamicFunctionTool {
  name: string;
  description: string;
  parameters: object;
}

interface CachedServerTools {
  signature: string;
  expiresAt: number;
  tools: DynamicFunctionTool[];
}

type McpClientCtor = new (input: {
  name: string;
  version: string;
}) => SdkClient;

type McpTransportCtor = new (input: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  stderr: 'pipe';
}) => SdkStdioClientTransport;

const TOOL_LIST_CACHE_TTL_MS = 30000;
const toolListCache = new Map<string, CachedServerTools>();
const BUILT_IN_MCP_SERVER_ID = 'nanoclaw';
const CODEX_LOCAL_TOOL_NAMES = new Set([
  'memory_search',
  'memory_get',
  'memory_save',
]);

function log(message: string): void {
  console.error(`[codex-mcp] ${message}`);
}

function parseExternalMcpServers(): Record<string, ExternalMcpServer> {
  const raw = process.env.NANOCLAW_EXTRA_MCP_SERVERS;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const output: Record<string, ExternalMcpServer> = {};
    for (const [name, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.command !== 'string' || !entry.command.trim()) continue;
      output[name] = {
        command: entry.command.trim(),
        args: Array.isArray(entry.args)
          ? entry.args.filter(
              (item): item is string => typeof item === 'string',
            )
          : [],
        env:
          entry.env &&
          typeof entry.env === 'object' &&
          !Array.isArray(entry.env)
            ? Object.fromEntries(
                Object.entries(entry.env as Record<string, unknown>).filter(
                  (pair): pair is [string, string] =>
                    typeof pair[1] === 'string',
                ),
              )
            : undefined,
      };
    }
    return output;
  } catch (error) {
    log(
      `Failed to parse external MCP servers: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

function getBuiltInMcpServer(): ExternalMcpServer {
  const entryPath = fileURLToPath(
    new URL('./ipc-mcp-stdio.js', import.meta.url),
  );
  return {
    command: process.execPath,
    args: [entryPath],
    env: {
      NANOCLAW_CHAT_JID: process.env.NANOCLAW_CHAT_JID || '',
      NANOCLAW_GROUP_FOLDER: process.env.NANOCLAW_GROUP_FOLDER || '',
      NANOCLAW_IS_MAIN: process.env.NANOCLAW_IS_MAIN || '0',
      NANOCLAW_GROUP_DIR: process.env.NANOCLAW_GROUP_DIR || '',
      NANOCLAW_GLOBAL_DIR: process.env.NANOCLAW_GLOBAL_DIR || '',
      NANOCLAW_INTERNAL_API_BASE: process.env.NANOCLAW_INTERNAL_API_BASE || '',
      NANOCLAW_INTERNAL_API_TOKEN:
        process.env.NANOCLAW_INTERNAL_API_TOKEN || '',
      NANOCLAW_USER_ID: process.env.NANOCLAW_USER_ID || '',
      NANOCLAW_AVAILABLE_KB_META: process.env.NANOCLAW_AVAILABLE_KB_META || '',
      ...collectForwardedMemoryEnv(),
    },
  };
}

function getConfiguredMcpServers(): Record<string, ExternalMcpServer> {
  const external = parseExternalMcpServers();
  if (BUILT_IN_MCP_SERVER_ID in external) {
    log(
      `Ignoring external MCP server override for reserved id "${BUILT_IN_MCP_SERVER_ID}"`,
    );
    delete external[BUILT_IN_MCP_SERVER_ID];
  }
  const builtIn = getBuiltInMcpServer();
  return {
    ...external,
    [BUILT_IN_MCP_SERVER_ID]: builtIn,
  };
}

function sanitizeToolSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function buildToolAlias(serverId: string, toolName: string): string {
  return `mcp__${sanitizeToolSegment(serverId)}__${sanitizeToolSegment(toolName)}`;
}

function buildToolAliasPrefix(serverId: string): string {
  return `mcp__${sanitizeToolSegment(serverId)}__`;
}

function normalizeToolSchema(schema: unknown): object {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as object;
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function getServerSignature(server: ExternalMcpServer): string {
  return JSON.stringify({
    command: server.command,
    args: server.args || [],
    env: server.env || {},
  });
}

async function loadMcpSdk(): Promise<{
  Client: McpClientCtor;
  StdioClientTransport: McpTransportCtor;
}> {
  const [clientModule, transportModule] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  return {
    Client: clientModule.Client as McpClientCtor,
    StdioClientTransport:
      transportModule.StdioClientTransport as McpTransportCtor,
  };
}

async function withMcpClient<T>(
  serverId: string,
  server: ExternalMcpServer,
  fn: (client: SdkClient) => Promise<T>,
): Promise<T> {
  const { Client, StdioClientTransport } = await loadMcpSdk();
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: process.env.NANOCLAW_GROUP_DIR || process.cwd(),
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'nanoclaw-codex',
    version: '1.0.0',
  });

  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) log(`${serverId}: ${text}`);
    });
  }

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function formatMcpCallResult(result: unknown): string {
  const payload =
    result && typeof result === 'object'
      ? (result as {
          content?: Array<Record<string, unknown>>;
          structuredContent?: unknown;
          isError?: boolean;
          toolResult?: unknown;
        })
      : {};
  const segments: string[] = [];
  for (const item of payload.content || []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      segments.push(item.text);
      continue;
    }
    if (item.type === 'resource' && item.resource) {
      segments.push(
        formatStructuredPromptValue(item.resource, { surface: 'mcp_result' }),
      );
      continue;
    }
    segments.push(formatStructuredPromptValue(item, { surface: 'mcp_result' }));
  }
  if (segments.length === 0 && payload.structuredContent !== undefined) {
    segments.push(
      formatStructuredPromptValue(payload.structuredContent, {
        surface: 'mcp_result',
      }),
    );
  }
  if (segments.length === 0 && payload.toolResult !== undefined) {
    segments.push(
      formatStructuredPromptValue(payload.toolResult, {
        surface: 'mcp_result',
      }),
    );
  }
  if (segments.length === 0) {
    segments.push(
      payload.isError ? 'MCP tool returned an error.' : '(no output)',
    );
  }
  return segments.join('\n\n');
}

export async function listCodexMcpTools(): Promise<DynamicFunctionTool[]> {
  const servers = getConfiguredMcpServers();
  const tools: DynamicFunctionTool[] = [];
  const now = Date.now();

  for (const [serverId, server] of Object.entries(servers)) {
    const signature = getServerSignature(server);
    const cached = toolListCache.get(serverId);
    if (cached && cached.signature === signature && cached.expiresAt > now) {
      tools.push(...cached.tools);
      continue;
    }
    try {
      const result = await withMcpClient(serverId, server, (client) =>
        client.listTools(),
      );
      const serverTools: DynamicFunctionTool[] = [];
      for (const tool of result.tools || []) {
        if (
          serverId === BUILT_IN_MCP_SERVER_ID &&
          CODEX_LOCAL_TOOL_NAMES.has(tool.name)
        ) {
          continue;
        }
        const alias = buildToolAlias(serverId, tool.name);
        if (!alias || tools.some((entry) => entry.name === alias)) continue;
        const mapped = {
          name: alias,
          description: `[MCP:${serverId}] ${tool.description || tool.name}`,
          parameters: normalizeToolSchema(tool.inputSchema),
        };
        tools.push(mapped);
        serverTools.push(mapped);
      }
      toolListCache.set(serverId, {
        signature,
        expiresAt: now + TOOL_LIST_CACHE_TTL_MS,
        tools: serverTools,
      });
    } catch (error) {
      log(
        `Failed to load tools from ${serverId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      toolListCache.delete(serverId);
    }
  }

  return tools;
}

export async function executeCodexMcpTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!toolName.startsWith('mcp__')) return null;

  const configuredServers = getConfiguredMcpServers();
  for (const [serverId, server] of Object.entries(configuredServers)) {
    try {
      const signature = getServerSignature(server);
      const now = Date.now();
      let serverTools =
        toolListCache.get(serverId)?.signature === signature &&
        (toolListCache.get(serverId)?.expiresAt || 0) > now
          ? toolListCache.get(serverId)?.tools || []
          : [];
      if (!serverTools.some((entry) => entry.name === toolName)) {
        serverTools = await listCodexMcpTools().then((tools) =>
          tools.filter((entry) =>
            entry.name.startsWith(buildToolAliasPrefix(serverId)),
          ),
        );
      }
      if (!serverTools.some((entry) => entry.name === toolName)) continue;

      const result = await withMcpClient(serverId, server, async (client) => {
        const listed = await client.listTools();
        const target = (listed.tools || []).find(
          (tool) => buildToolAlias(serverId, tool.name) === toolName,
        );
        if (!target) return null;
        return client.callTool({
          name: target.name,
          arguments: input,
        });
      });
      if (result) {
        return formatMcpCallResult(result);
      }
    } catch (error) {
      return `Error: MCP tool failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  return null;
}

export const __testing = {
  getConfiguredMcpServers,
  formatMcpCallResult,
};
