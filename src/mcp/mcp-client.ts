import type { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport as SdkStdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createModuleLogger } from '../logger.js';
import { getManagedMcpServersForResponse } from '../runtime/runtime-customization-service.js';

const logger = createModuleLogger('mcp');

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

export interface ManagedMcpToolCallResult {
  serverId: string;
  toolName: string;
  text: string;
  data: unknown | null;
}

function buildSpawnEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      base[key] = value;
    }
  }
  return {
    ...base,
    ...overrides,
  };
}

function extractToolText(result: unknown): string {
  const payload =
    result && typeof result === 'object'
      ? (result as {
          content?: Array<Record<string, unknown>>;
          structuredContent?: unknown;
          toolResult?: unknown;
          isError?: boolean;
        })
      : {};
  const parts: string[] = [];

  for (const item of payload.content || []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
      continue;
    }
    if (item.type === 'resource' && item.resource) {
      parts.push(JSON.stringify(item.resource, null, 2));
      continue;
    }
    parts.push(JSON.stringify(item, null, 2));
  }

  if (parts.length === 0 && payload.structuredContent !== undefined) {
    parts.push(JSON.stringify(payload.structuredContent, null, 2));
  }
  if (parts.length === 0 && payload.toolResult !== undefined) {
    parts.push(JSON.stringify(payload.toolResult, null, 2));
  }
  if (parts.length === 0) {
    parts.push(payload.isError ? 'MCP tool returned an error.' : '(no output)');
  }

  return parts.join('\n\n').trim();
}

function parseToolData(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
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

async function withManagedMcpClient<T>(
  serverId: string,
  fn: (client: SdkClient) => Promise<T>,
): Promise<T> {
  const server = (await getManagedMcpServersForResponse()).find(
    (entry) => entry.id === serverId && entry.enabled,
  );
  if (!server) {
    throw new Error(`Managed MCP server is not available: ${serverId}`);
  }

  const { Client, StdioClientTransport } = await loadMcpSdk();
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: buildSpawnEnv(server.env),
    cwd: process.cwd(),
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'nanoclaw-managed-mcp',
    version: '1.0.0',
  });

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch((err) => {
      logger.debug({ err }, 'MCP client close failed (non-critical)');
    });
    await transport.close().catch((err) => {
      logger.debug({ err }, 'MCP transport close failed (non-critical)');
    });
  }
}

export async function callManagedMcpTool(
  serverId: string,
  toolName: string,
  argumentsInput: Record<string, unknown> = {},
): Promise<ManagedMcpToolCallResult> {
  return withManagedMcpClient(serverId, async (client) => {
    const result = await client.callTool({
      name: toolName,
      arguments: argumentsInput,
    });
    const text = extractToolText(result);
    const isError =
      result && typeof result === 'object' && (result as { isError?: boolean }).isError;
    if (isError) {
      throw new Error(text || `Managed MCP tool failed: ${serverId}/${toolName}`);
    }
    return {
      serverId,
      toolName,
      text,
      data: parseToolData(text),
    };
  });
}
