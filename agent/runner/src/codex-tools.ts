/**
 * Tool definitions and execution for Codex mode.
 * Uses Anthropic API format for tool schemas and results.
 */
import { ChildProcess, execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  canReuseApprovedMutation,
  canWhitelistMutationCommand,
  matchesMutationAllowlist,
  requestMutationApproval,
} from './mutation-approval.js';
import { executeCodexMcpTool, listCodexMcpTools } from './codex-mcp-tools.js';
import { askUser } from './ask-user.js';
import { filterBashOutput, estimateTokens } from './bash-output-filter.js';
import {
  isKnowledgeSearchApiConfigured,
  notifyMemoryRecall,
  searchKnowledgeBaseViaApi,
} from './internal-memory-api.js';
import {
  buildMemorySearchResponse,
  getRecentMemorySearchFollowup,
  getMemoryReadDisabledMessage,
  getMemoryRuntimeConfig,
  getMemoryWriteDisabledMessage,
  isMemoryReadAvailable,
  isMemoryWriteAvailable,
  readMemoryFile,
  saveMemoryNote,
  searchMemoryRuntime,
} from './memory-tools.js';
import {
  type AgentRunOutputPayload,
  createSubagentRequestId,
  type PersistedSubagentControlScope,
  type PersistedSubagentMode,
  type PersistedSubagentProvider,
  type PersistedSubagentRequestKind,
  type PersistedSubagentRequestState,
  type PersistedSubagentRole,
  type PersistedSubagentWorkProfile,
  type PersistedSubagentRuntimeRecord,
  type SubagentIpcRequest,
  type SubagentRuntimeStatus,
} from './subagents/protocol.js';
import {
  appendManagedSubagentHistory,
  writeManagedSubagentMetadataFile,
} from './subagents/runtime-store.js';
import {
  checkPermission,
  checkPermissionOrEscalate,
  checkWritePermission,
  checkWritePermissionOrEscalate,
  getAccessMode,
  isReadOnlyShellCommand,
  mapWorkspacePathsInShellCommand,
  precheckBashCommandPaths,
  resolvePath,
} from './workspace-permissions.js';
import { getRuntimeConfig } from './web-tools/shared.js';
import { fetchUrl, searchWeb } from './web-tools.js';

// ── OpenAI Responses API tool definition format ──

export interface ResponsesToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: object;
}

export interface ResponsesNativeWebSearchToolDef {
  type: 'web_search';
  external_web_access?: boolean;
  filters?: {
    allowed_domains?: string[];
  };
}

type CodexResponsesToolDef = ResponsesToolDef | ResponsesNativeWebSearchToolDef;

export interface CodexToolExecutionContext {
  agentInput?: {
    groupFolder: string;
    chatJid: string;
    isMain: boolean;
    toolPolicy?: 'none' | 'readonly' | 'full';
    disableDefaultWebSearch?: boolean;
    assistantName?: string;
    managedSkillIds?: string[];
    managedMcpServerIds?: string[];
    workingDirectory?: string;
  };
  secrets?: Record<string, string>;
}

export interface ChatCompletionsToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const SUBAGENT_RUNTIME_DIR_NAME = '.nanoclaw-subagents';
const SUBAGENT_CLOSE_GRACE_MS = 10_000;
const SUBAGENT_HISTORY_FILE_NAME = 'history.json';

interface ManagedSubagent {
  id: string;
  name: string;
  task: string;
  initialRequestId: string;
  runtimeDir: string;
  ipcInputDir: string;
  metadataPath: string;
  proc: ChildProcess;
  stdoutBuffer: string;
  stderrTail: string;
  completedResults: Map<string, string>;
  failedResults: Map<string, string>;
  waiters: Map<
    string,
    {
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }
  >;
  activeRequestId: string | null;
  requestCount: number;
  exited: boolean;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  stopReason: 'completed' | 'stopped' | null;
  metadata: PersistedSubagentRuntimeRecord;
}

const managedSubagents = new Map<string, ManagedSubagent>();
const pendingSpawnReservations = new Set<string>();

export interface CodexSubagentRuntimeConfig {
  enabled: boolean;
  maxDepth: number;
  currentDepth: number;
  currentRole: PersistedSubagentRole;
  currentControlScope: PersistedSubagentControlScope;
  maxActive: number;
  activeCount: number;
  canSpawn: boolean;
}

export interface CodexToolExecutionOptions {
  onSubagentUpdate?: (update: {
    status: SubagentRuntimeStatus;
    note?: string;
    runtimeId?: string;
    provider?: PersistedSubagentProvider;
    mode?: PersistedSubagentMode;
    runtimeKind?: PersistedSubagentRuntimeRecord['runtimeKind'];
    providerSessionId?: string;
    parentRuntimeId?: string;
    controllerSessionKey?: string;
    requesterSessionKey?: string;
    originTurnId?: string;
    originToolCallId?: string;
    topologyRole?: PersistedSubagentRole;
    workProfile?: PersistedSubagentWorkProfile;
    role?: PersistedSubagentRole;
    controlScope?: PersistedSubagentControlScope;
    depth?: number;
    chatJid?: string;
    requestCount?: number;
    controllable?: boolean;
  }) => void;
  agentInput?: CodexToolExecutionContext['agentInput'];
  secrets?: Record<string, string>;
  originTurnId?: string;
  originToolCallId?: string;
}

export const BASE_CODEX_TOOLS_RESPONSES: ResponsesToolDef[] = [
  {
    type: 'function',
    name: 'bash',
    description:
      'Execute a shell command in the workspace. Returns stdout+stderr.\n' +
      'Use for: running scripts, tests, git operations, installing packages.\n' +
      'For reading files, prefer read_file. For searching, prefer grep.\n' +
      'Commands run with a 30s default timeout (configurable via timeout param).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        workdir: {
          type: 'string',
          description: 'Working directory (optional)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default 30000)',
        },
      },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'read_file',
    description:
      'Read file contents with numbered lines. Supports partial reads via offset/limit.\n' +
      'Binary files are detected and skipped. For files over 500 lines,\n' +
      'consider using offset/limit to read specific sections.\n' +
      'For searching within files, prefer grep.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative path to the file',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading (1-based)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return',
        },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'write_file',
    description:
      'Write content to a file, creating parent directories if needed.\n' +
      'Overwrites existing files entirely. For partial edits to existing files,\n' +
      'prefer edit_file which replaces specific text sections.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative path' },
        content: { type: 'string', description: 'The full content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    type: 'function',
    name: 'edit_file',
    description:
      'Edit a file by replacing an exact string match with new content.\n' +
      'old_string must uniquely identify the target in the file.\n' +
      'Include 3-5 surrounding lines for uniqueness. For full file rewrites, use write_file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to edit' },
        old_string: {
          type: 'string',
          description: 'The exact text to find and replace',
        },
        new_string: { type: 'string', description: 'The replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    type: 'function',
    name: 'glob',
    description:
      'Find files matching a glob pattern. Returns sorted file paths.\n' +
      'Patterns like "*.ts" auto-prepend "**/" for recursive search.\n' +
      'Use sort_by="mtime" to find recently modified files first.\n' +
      'For searching file contents, prefer grep.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.js")',
        },
        dir: {
          type: 'string',
          description: 'Directory to search in (default: cwd)',
        },
        sort_by: {
          type: 'string',
          enum: ['name', 'mtime'],
          description:
            'Sort results by name (default) or modification time (newest first)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 200)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    type: 'function',
    name: 'grep',
    description:
      'Search file contents for a regex pattern using ripgrep.\n' +
      'Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").\n' +
      '- Filter files: use include (glob "*.ts") or type ("ts","py") for efficiency\n' +
      '- output_mode: "content" for lines, "files_only" for paths, "count" for stats\n' +
      '- Use case_insensitive for flexible matching\n' +
      '- Use context_lines (0-5) to see surrounding code\n' +
      '- Results capped at head_limit (default 100)',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'Regex pattern to search for. Escape special chars: \\(, \\), \\{, \\[. ' +
            'For literal text, escape all regex metacharacters or the tool will auto-retry as literal if regex fails.',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in (default: cwd)',
        },
        include: {
          type: 'string',
          description: 'Glob filter, e.g. "*.ts", "*.{ts,tsx}"',
        },
        type: {
          type: 'string',
          description:
            'File type filter, e.g. "ts", "py", "js" — maps to rg --type',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case insensitive search (default false)',
        },
        context_lines: {
          type: 'number',
          description: 'Lines of context around each match, 0-5 (default 0)',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_only', 'count'],
          description:
            'content: matching lines (default); files_only: just file paths; count: match counts per file',
        },
        head_limit: {
          type: 'number',
          description:
            'Maximum number of result lines/files to return (default 100)',
        },
        multiline: {
          type: 'boolean',
          description:
            'Enable multiline matching where . matches newlines (default false)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    type: 'function',
    name: 'list_dir',
    description:
      'List directory contents with file types.\n' +
      'Use depth > 1 for nested listing. For pattern-based file discovery, prefer glob.\n' +
      'For searching file contents, prefer grep.',
    parameters: {
      type: 'object',
      properties: {
        dir_path: {
          type: 'string',
          description: 'Absolute or relative path to the directory',
        },
        depth: { type: 'number', description: 'Maximum depth (default 1)' },
      },
      required: ['dir_path'],
    },
  },
  {
    type: 'function',
    name: 'memory_search',
    description:
      'Search workspace memory files (MEMORY.md and memory/*.md).\n' +
      'Use before answering questions about prior work, decisions, preferences, or dates.\n' +
      'Try scope="all" to search both group and global memory.\n' +
      'Returns ranked snippets with path references for memory_get follow-up.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords to search for (2-6 words work best). Avoid full sentences.',
        },
        scope: {
          type: 'string',
          enum: ['group', 'global', 'all'],
          description:
            'Search scope. all searches both group and global memory.',
        },
        max_results: {
          type: 'number',
          description:
            'Maximum number of snippets to return (default 5, max 8)',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'memory_get',
    description:
      'Read a memory file snippet by explicit path ref, such as group:MEMORY.md or global:memory/2026-03-17.md.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Memory path ref returned by memory_search',
        },
        from: { type: 'number', description: 'Starting line number (1-based)' },
        lines: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  },
  {
    type: 'function',
    name: 'memory_save',
    description:
      "Append a durable note to today's daily memory file memory/YYYY-MM-DD.md. Default scope is group; global writes are reserved for the main session.",
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The memory note to append',
        },
        scope: {
          type: 'string',
          enum: ['group', 'global'],
          description:
            'Write scope. global is only allowed in the main session.',
        },
      },
      required: ['note'],
    },
  },
  {
    type: 'function',
    name: 'ask_user',
    description:
      'Ask the user a question and wait for their answer. Use when you need clarification, ' +
      'confirmation, or a decision from the user before proceeding. Supports free-text answers ' +
      'and structured multiple-choice options.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Option identifier' },
              label: {
                type: 'string',
                description: 'Display text for this option',
              },
            },
            required: ['id', 'label'],
          },
          description: 'Optional structured choices for the user.',
        },
        allow_multiple: {
          type: 'boolean',
          description:
            'If true with options, user can select multiple choices (default false).',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'How long to wait for an answer in seconds (default 300, max 300).',
        },
      },
      required: ['question'],
    },
  },
  {
    type: 'function',
    name: 'search_web',
    description:
      'Search the web. Returns titles, URLs, and snippets.\n' +
      '\n' +
      'QUERY FORMAT (critical for good results):\n' +
      '- Use 2-6 keywords, NOT full sentences\n' +
      '- Good: "webpack 5 typescript react production"\n' +
      '- Bad: "How to configure webpack 5 with TypeScript and React for production build"\n' +
      '- Use quotes for exact phrases: "useEffect cleanup"\n' +
      '- Use OR for alternatives: "pnpm OR yarn workspace"\n' +
      '- Use - to exclude: "python async -asyncio"\n' +
      '- Do NOT put site: in query — use the domains parameter instead\n' +
      '\n' +
      'After finding URLs, use fetch_url to read full content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords (2-6 words). NOT a full sentence.',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Restrict results to these domains. Use instead of site: in query. e.g. ["docs.python.org"]',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'fetch_url',
    description:
      'Fetch a URL and return extracted readable content in Markdown format.\n' +
      'Main content is extracted automatically — navigation, ads, and chrome are stripped.\n' +
      'Use page/page_size for continuing long documents (page is 1-based).\n' +
      'Use search_web first to discover relevant URLs, then fetch_url to read them.\n' +
      'Default max_chars is 12000; increase for comprehensive reading.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL starting with http:// or https:// (no spaces)',
        },
        max_chars: {
          type: 'number',
          description:
            'Maximum number of response characters to include (default 12000)',
        },
        page: {
          type: 'number',
          description: '1-based page number for continuing long documents',
        },
        page_size: {
          type: 'number',
          description: 'Characters per returned page/chunk',
        },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'read_lints',
    description:
      'Run linter diagnostics on one or more files. Auto-detects file type and runs the appropriate linter.\n' +
      'Supported: TypeScript/JavaScript (tsc --noEmit), Python (ruff), Go (go vet), Rust (cargo check).\n' +
      'Returns structured diagnostics with file, line, severity, and message.\n' +
      'Use after editing files to catch type errors, syntax issues, and style violations.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File or directory paths to lint',
        },
        fix: {
          type: 'boolean',
          description: 'Attempt auto-fix where supported (default false)',
        },
      },
      required: ['paths'],
    },
  },
  {
    type: 'function',
    name: 'semantic_search',
    description:
      'Search across knowledge bases and workspace memory using semantic matching.\n' +
      'Combines results from enabled knowledge bases and memory files.\n' +
      'Use when grep is too literal — semantic search finds conceptually related content.\n' +
      'For exact text matching in code files, prefer grep.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        scope: {
          type: 'string',
          enum: ['all', 'knowledge', 'memory'],
          description:
            'Search scope: all (default), knowledge (KB only), memory (memory files only)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default 8, max 15)',
        },
      },
      required: ['query'],
    },
  },
];

function getConfiguredSubagentMaxDepth(): number {
  return Math.max(
    1,
    Number.parseInt(process.env.NANOCLAW_SUBAGENTS_MAX_DEPTH || '2', 10) || 2,
  );
}

function getCurrentSubagentDepth(): number {
  return Math.max(
    0,
    Number.parseInt(process.env.NANOCLAW_SUBAGENT_DEPTH || '0', 10) || 0,
  );
}

function getConfiguredSubagentMaxActive(): number {
  return Math.max(
    1,
    Number.parseInt(process.env.NANOCLAW_SUBAGENTS_MAX_ACTIVE || '4', 10) || 4,
  );
}

function countActiveManagedSubagents(): number {
  let activeCount = pendingSpawnReservations.size;
  for (const handle of managedSubagents.values()) {
    if (!handle.exited) {
      activeCount += 1;
    }
  }
  return activeCount;
}

function getSubagentToolDefs(): ResponsesToolDef[] {
  const runtime = getCodexSubagentRuntimeConfig();
  if (!runtime.enabled) return [];

  const tools: ResponsesToolDef[] = [];

  if (runtime.canSpawn) {
    tools.push({
      type: 'function',
      name: 'TeamCreate',
      description:
        'Spawn a sub-agent for delegated work. Waits for the first result by default. ' +
        'Use keep_alive=true only when you need follow-up SendMessage calls.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The delegated task for the sub-agent',
          },
          role: {
            type: 'string',
            enum: ['explorer', 'worker'],
            description:
              'Optional sub-agent role. explorer is read-only discovery; worker can implement changes.',
          },
          name: {
            type: 'string',
            description: 'Optional short label for the sub-agent',
          },
          keep_alive: {
            type: 'boolean',
            description:
              'Keep the sub-agent alive after its first result so it can receive SendMessage follow-ups.',
          },
        },
        required: ['prompt'],
      },
    });
  }

  tools.push(
    {
      type: 'function',
      name: 'SendMessage',
      description:
        'Send a follow-up instruction to a running sub-agent and optionally wait for its next result.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The sub-agent id returned by TeamCreate',
          },
          prompt: {
            type: 'string',
            description: 'The follow-up instruction to send',
          },
          wait_for_response: {
            type: 'boolean',
            description:
              'Wait for the next sub-agent result. Defaults to true.',
          },
          close_after_response: {
            type: 'boolean',
            description:
              'Request the sub-agent to stop after returning the next result.',
          },
        },
        required: ['agent_id', 'prompt'],
      },
    },
    {
      type: 'function',
      name: 'TeamDelete',
      description: 'Stop a running sub-agent and clean up its runtime state.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The sub-agent id returned by TeamCreate',
          },
        },
        required: ['agent_id'],
      },
    },
  );

  return tools;
}

function buildAgentToolDef(): ResponsesToolDef {
  return {
    type: 'function',
    name: 'Agent',
    description:
      'Run a focused sub-agent in an isolated session for exploration or bounded implementation. ' +
      'Use multiple Agent calls in one turn for parallel independent subtasks.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Self-contained task for the sub-agent to complete',
        },
        agent_type: {
          type: 'string',
          enum: ['explorer', 'worker'],
          description:
            'explorer for read-only discovery, worker for bounded implementation',
        },
        name: {
          type: 'string',
          description: 'Optional short label for the sub-agent',
        },
        scope: {
          type: 'string',
          description:
            'Optional file or module scope the sub-agent should stay within',
        },
        output: {
          type: 'string',
          description:
            'Optional instruction for the expected output format back to the parent',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout for the sub-agent run in milliseconds',
        },
      },
      required: ['task'],
    },
  };
}

function isDefaultWebSearchEnabled(): boolean {
  return (
    String(process.env.NANOCLAW_WEB_SEARCH_ENABLED || 'true').trim() !== 'false'
  );
}

export function getCodexSubagentRuntimeConfig(): CodexSubagentRuntimeConfig {
  const enabled = process.env.NANOCLAW_SUBAGENTS_ENABLED !== '0';
  const maxDepth = Math.max(
    1,
    Number.parseInt(process.env.NANOCLAW_SUBAGENTS_MAX_DEPTH || '2', 10) || 2,
  );
  const currentDepth = Math.max(
    0,
    Number.parseInt(process.env.NANOCLAW_SUBAGENT_DEPTH || '0', 10) || 0,
  );
  const maxActive = getConfiguredSubagentMaxActive();
  const activeCount = countActiveManagedSubagents();
  const currentRole = resolveCurrentPersistedSubagentRole();
  const currentControlScope = resolveCurrentPersistedControlScope();
  return {
    enabled,
    maxDepth,
    currentDepth,
    currentRole,
    currentControlScope,
    maxActive,
    activeCount,
    canSpawn:
      enabled &&
      currentControlScope === 'children' &&
      currentDepth < maxDepth &&
      activeCount < maxActive,
  };
}

function isCodexNativeWebSearchPreferred(): boolean {
  if (!isDefaultWebSearchEnabled()) return false;
  return getRuntimeConfig().provider === 'auto';
}

function buildNativeWebSearchTool(): ResponsesNativeWebSearchToolDef | null {
  if (!isCodexNativeWebSearchPreferred()) return null;
  const config = getRuntimeConfig();
  return {
    type: 'web_search',
    external_web_access: true,
    ...(config.allowedDomains.length > 0
      ? {
          filters: {
            allowed_domains: config.allowedDomains,
          },
        }
      : {}),
  };
}

function isEnabledBaseTool(name: string): boolean {
  const memoryConfig = getMemoryRuntimeConfig();
  if (name === 'memory_search' || name === 'memory_get') {
    return isMemoryReadAvailable(memoryConfig);
  }
  if (name === 'memory_save') {
    return isMemoryWriteAvailable(memoryConfig);
  }
  if (name === 'semantic_search') {
    return (
      isMemoryReadAvailable(memoryConfig) || isKnowledgeSearchApiConfigured()
    );
  }
  return true;
}

type CodexToolPolicy = 'none' | 'readonly' | 'full';

function resolveCodexToolPolicy(value: unknown): CodexToolPolicy {
  return value === 'none' || value === 'readonly' || value === 'full'
    ? value
    : 'full';
}

const READONLY_CODEX_TOOL_NAMES = new Set([
  'bash',
  'read_file',
  'glob',
  'grep',
  'list_dir',
  'search_web',
  'fetch_url',
  'read_lints',
  'semantic_search',
  'memory_search',
  'memory_get',
]);

function isCodexToolAllowedByPolicy(
  name: string,
  policy: CodexToolPolicy,
): boolean {
  if (policy === 'full') return true;
  if (policy === 'none') return false;
  return READONLY_CODEX_TOOL_NAMES.has(name);
}

async function buildCodexFunctionTools(options?: {
  omitLocalSearchWeb?: boolean;
  toolPolicy?: CodexToolPolicy;
}): Promise<ResponsesToolDef[]> {
  const toolPolicy = resolveCodexToolPolicy(options?.toolPolicy);
  if (toolPolicy === 'none') return [];
  const mcpTools = await listCodexMcpTools();
  const subagentRuntime = getCodexSubagentRuntimeConfig();
  const webConfig = getRuntimeConfig();
  const baseTools = BASE_CODEX_TOOLS_RESPONSES.filter((tool) => {
    if (!isCodexToolAllowedByPolicy(tool.name, toolPolicy)) return false;
    if (!isEnabledBaseTool(tool.name)) return false;
    if (options?.omitLocalSearchWeb && tool.name === 'search_web') return false;
    if (!isDefaultWebSearchEnabled() && tool.name === 'search_web')
      return false;
    if (!webConfig.fetchEnabled && tool.name === 'fetch_url') return false;
    return true;
  });
  return [
    ...baseTools,
    ...(toolPolicy === 'full' ? getSubagentToolDefs() : []),
    ...(toolPolicy === 'full' && subagentRuntime.canSpawn
      ? [buildAgentToolDef()]
      : []),
    ...(toolPolicy === 'full'
      ? mcpTools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }))
      : []),
  ];
}

export async function buildCodexResponsesTools(options?: {
  toolPolicy?: CodexToolPolicy;
}): Promise<CodexResponsesToolDef[]> {
  const toolPolicy = resolveCodexToolPolicy(options?.toolPolicy);
  const tools = await buildCodexFunctionTools({
    omitLocalSearchWeb: isCodexNativeWebSearchPreferred(),
    toolPolicy,
  });
  const nativeWebSearchTool =
    toolPolicy === 'none' ? null : buildNativeWebSearchTool();
  return nativeWebSearchTool ? [nativeWebSearchTool, ...tools] : tools;
}

export async function buildCodexOpenAiTools(options?: {
  toolPolicy?: CodexToolPolicy;
}): Promise<ChatCompletionsToolDef[]> {
  const tools = await buildCodexFunctionTools({
    toolPolicy: resolveCodexToolPolicy(options?.toolPolicy),
  });
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export const BASE_CODEX_TOOLS_OPENAI: ChatCompletionsToolDef[] =
  BASE_CODEX_TOOLS_RESPONSES.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

export const __testing = {
  buildNativeWebSearchTool,
  isCodexNativeWebSearchPreferred,
  getSubagentToolDefs,
  getCodexSubagentRuntimeConfig,
  resetManagedSubagentsForTests: () => {
    managedSubagents.clear();
    pendingSpawnReservations.clear();
  },
  isCodexToolAllowedByPolicy,
};

// ── Tool execution ──

function log(msg: string): void {
  console.error(`[codex-tools] ${msg}`);
}

const TOOL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  bash: 25_000,
  read_file: 62_500,
  grep: 25_000,
  glob: 12_500,
  list_dir: 12_500,
  search_web: 7_500,
  fetch_url: 20_000,
  read_lints: 12_500,
  semantic_search: 7_500,
  memory_search: 7_500,
};
const DEFAULT_MAX_OUTPUT_TOKENS = 62_500;
const SUBAGENT_TOOL_NAMES = new Set([
  'Agent',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
]);
const SUBAGENT_FAILURE_PREFIX = 'Sub-agent failed:';

function getToolTruncationStrategy(
  toolName: string,
): 'head-heavy' | 'balanced' | 'smart-content' | 'default' {
  switch (toolName) {
    case 'grep':
    case 'glob':
    case 'list_dir':
    case 'read_lints':
      return 'head-heavy';
    case 'read_file':
    case 'bash':
      return 'balanced';
    case 'fetch_url':
      return 'smart-content';
    default:
      return 'default';
  }
}

function truncateToolOutput(name: string, output: string): string {
  const maxTokens = TOOL_MAX_OUTPUT_TOKENS[name] ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const inputTokens = estimateTokens(output);
  if (inputTokens <= maxTokens) return output;

  const strategy = getToolTruncationStrategy(name);
  const notice = `\n...[${name} output truncated: ~${inputTokens} tokens → ~${maxTokens} tokens]...\n`;
  const maxChars = maxTokens * 4;
  const budget = Math.max(0, maxChars - notice.length);

  switch (strategy) {
    case 'head-heavy': {
      const head = Math.ceil(budget * 0.9);
      const tail = Math.max(0, budget - head);
      return `${output.slice(0, head)}${notice}${tail > 0 ? output.slice(-tail) : ''}`;
    }
    case 'balanced': {
      const head = Math.ceil(budget * 0.6);
      const tail = Math.max(0, budget - head);
      return `${output.slice(0, head)}${notice}${tail > 0 ? output.slice(-tail) : ''}`;
    }
    case 'smart-content': {
      let cutPoint = output.lastIndexOf('\n\n', budget);
      if (cutPoint < budget * 0.5) cutPoint = budget;
      const hint =
        output.length > budget
          ? `\n\n---\n_Content truncated. Use \`fetch_url\` with \`page=2\` to read more._`
          : '';
      return output.slice(0, cutPoint) + notice + hint;
    }
    default: {
      const head = Math.ceil(budget * 0.8);
      const tail = Math.max(0, budget - head);
      return `${output.slice(0, head)}${notice}${tail > 0 ? output.slice(-tail) : ''}`;
    }
  }
}

export function compactOldToolResults(
  toolName: string,
  output: string,
  maxChars: number = 800,
): string {
  if (output.length <= maxChars) return output;

  if (toolName === 'search_web' || toolName === 'semantic_search') {
    const lines = output.split('\n');
    const kept: string[] = [];
    let chars = 0;
    for (const line of lines) {
      if (chars + line.length > maxChars) break;
      kept.push(line);
      chars += line.length + 1;
    }
    return `${kept.join('\n')}\n...(${lines.length - kept.length} more lines)`;
  }

  if (toolName === 'read_file' || toolName === 'fetch_url') {
    const head = Math.ceil(maxChars * 0.7);
    const tail = Math.max(0, maxChars - head - 30);
    return `${output.slice(0, head)}\n...(truncated)...\n${tail > 0 ? output.slice(-tail) : ''}`;
  }

  if (toolName === 'grep' || toolName === 'glob' || toolName === 'list_dir') {
    const lines = output.split('\n');
    const kept: string[] = [];
    let chars = 0;
    for (const line of lines) {
      if (chars + line.length > maxChars) break;
      kept.push(line);
      chars += line.length + 1;
    }
    return (
      kept.join('\n') +
      (kept.length < lines.length
        ? `\n...(${lines.length - kept.length} more)`
        : '')
    );
  }

  return `${output.slice(0, maxChars)}\n...(truncated)`;
}

function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

function formatSubagentToolFailure(name: string, message: string): string {
  return [
    `${SUBAGENT_FAILURE_PREFIX} ${message}`,
    `Tool: ${name}`,
    'Continue the parent task without this sub-agent unless its result is required for correctness.',
  ].join('\n');
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  try {
    const toolPolicy = resolveCodexToolPolicy(options?.agentInput?.toolPolicy);
    if (!isCodexToolAllowedByPolicy(name, toolPolicy)) {
      return `Error: Tool "${name}" is disabled by the current tool policy (${toolPolicy})`;
    }
    const mcpResult = await executeCodexMcpTool(name, input);
    if (mcpResult !== null) return truncateToolOutput(name, mcpResult);

    let output: string;
    switch (name) {
      case 'bash':
        output = await executeBash(input, cwd, options);
        break;
      case 'read_file':
        output = await executeRead(input, cwd, options);
        break;
      case 'write_file':
        output = await executeWrite(input, cwd, options);
        break;
      case 'edit_file':
        output = await executeEdit(input, cwd, options);
        break;
      case 'glob':
        output = await executeGlob(input, cwd, options);
        break;
      case 'grep':
        output = await executeGrep(input, cwd, options);
        break;
      case 'list_dir':
        output = await executeListDir(input, cwd, options);
        break;
      case 'memory_search':
        output = await executeMemorySearch(input);
        break;
      case 'memory_get':
        output = await executeMemoryGet(input);
        break;
      case 'memory_save':
        output = executeMemorySave(input);
        break;
      case 'ask_user':
        output = await executeAskUser(input);
        break;
      case 'search_web':
        output = await executeSearchWeb(input);
        break;
      case 'fetch_url':
        output = await executeFetchUrl(input);
        break;
      case 'read_lints':
        output = await executeReadLints(input, cwd);
        break;
      case 'semantic_search':
        output = await executeSemanticSearch(input);
        break;
      case 'TeamCreate':
        output = await executeTeamCreate(input, cwd, options);
        break;
      case 'SendMessage':
        output = await executeSendMessage(input, options);
        break;
      case 'TeamDelete':
        output = await executeTeamDelete(input);
        break;
      case 'Agent':
        output = await executeAgentSubagent(input, cwd, options);
        break;
      default:
        output = `Error: Unknown tool "${name}"`;
        break;
    }
    return truncateToolOutput(name, output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Tool "${name}" error: ${msg}`);
    const output = isSubagentToolName(name)
      ? formatSubagentToolFailure(name, msg)
      : `Error: ${msg}`;
    return truncateToolOutput(name, output);
  }
}

async function executeBash(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const command = mapWorkspacePathsInShellCommand(input.command as string);
  const requestedWorkdir = (input.workdir as string) || cwd;
  const workdir = resolvePath(requestedWorkdir, cwd);
  const timeout = (input.timeout as number) || 30000;

  const perm = await checkPermissionOrEscalate(
    workdir,
    options?.originToolCallId || `bash_${Date.now()}`,
    'Bash',
  );
  if (perm) return perm;
  const readOnlyCommand = isReadOnlyShellCommand(command);
  if (getAccessMode() === 'readonly' && !readOnlyCommand) {
    return 'Permission denied: bash is read-only in the current access policy';
  }
  const commandPerm = precheckBashCommandPaths(command, workdir);
  if (commandPerm) return commandPerm;
  if (
    !readOnlyCommand &&
    !matchesMutationAllowlist(command) &&
    !canReuseApprovedMutation({ command, cwd: workdir })
  ) {
    const decision = await requestMutationApproval({
      toolCallId:
        options?.originToolCallId ||
        `bash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      toolName: 'Bash',
      command,
      cwd: workdir,
      canWhitelist: canWhitelistMutationCommand(command),
    });
    if (decision !== 'allow-once') {
      return decision === 'expired'
        ? 'Permission denied: bash command approval timed out'
        : 'Permission denied: bash command denied by user';
    }
  }

  log(`bash: ${command.slice(0, 200)}`);

  try {
    const result = execSync(command, {
      cwd: workdir,
      timeout,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const raw = result || '(no output)';
    const filtered = filterBashOutput(command, raw);
    if (filtered !== raw) {
      const saved = estimateTokens(raw) - estimateTokens(filtered);
      log(
        `bash filter saved ~${saved} tokens (${raw.length} → ${filtered.length} chars)`,
      );
    }
    return filtered;
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message?: string;
    };
    const raw = (e.stdout || '') + (e.stderr || '');
    const out =
      raw || `Command failed with exit code ${e.status}: ${e.message}`;
    return filterBashOutput(command, out);
  }
}

async function executeRead(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const filePath = resolvePath(input.file_path as string, cwd);
  const perm = await checkPermissionOrEscalate(
    filePath,
    options?.originToolCallId || `read_${Date.now()}`,
    'Read',
  );
  if (perm) return perm;
  const hasExplicitOffset = typeof input.offset === 'number';
  const hasExplicitLimit = typeof input.limit === 'number';
  const offset = hasExplicitOffset ? (input.offset as number) : 1;
  const limit = hasExplicitLimit ? (input.limit as number) : undefined;

  if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    const sample = buf.subarray(0, bytesRead);
    if (sample.includes(0)) {
      const st = fs.fstatSync(fd);
      const name = path.basename(filePath);
      return `(binary file: ${name}, ${st.size} bytes — not displayed)`;
    }
  } finally {
    fs.closeSync(fd);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const start = Math.max(0, offset - 1);
  const end = limit ? Math.min(lines.length, start + limit) : lines.length;
  const slice = lines.slice(start, end);

  let out = slice
    .map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`)
    .join('\n');

  if (!hasExplicitOffset && !hasExplicitLimit && lines.length > 500) {
    out += `\n[File has ${lines.length} lines total. Consider using offset/limit for targeted reading.]`;
  }

  return out;
}

function getChildRunnerEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentFile), 'index.js');
}

function normalizeSubagentWorkProfile(
  value: unknown,
): PersistedSubagentWorkProfile {
  return value === 'explorer' ? 'explorer' : 'worker';
}

function collectChildSecretsFromEnv(
  options?: CodexToolExecutionOptions,
): Record<string, string> {
  if (options?.secrets && Object.keys(options.secrets).length > 0) {
    return { ...options.secrets };
  }
  const keys = [
    'AI_PROVIDER',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'CODEX_API_KEY',
    'CODEX_BASE_URL',
    'CODEX_MODEL',
    'CODEX_MAX_TOOL_ITERATIONS',
  ];
  const secrets: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') {
      secrets[key] = value;
    }
  }
  return secrets;
}

function buildChildAgentInput(
  prompt: string,
  cwd: string,
  requestId: string,
  options?: CodexToolExecutionOptions,
) {
  return {
    prompt,
    requestId,
    groupFolder:
      options?.agentInput?.groupFolder ||
      process.env.NANOCLAW_GROUP_FOLDER ||
      'subagent',
    chatJid:
      options?.agentInput?.chatJid ||
      process.env.NANOCLAW_CHAT_JID ||
      'subagent',
    isMain: false,
    disableDefaultWebSearch: options?.agentInput?.disableDefaultWebSearch,
    assistantName: options?.agentInput?.assistantName,
    managedSkillIds: options?.agentInput?.managedSkillIds,
    managedMcpServerIds: options?.agentInput?.managedMcpServerIds,
    workingDirectory: options?.agentInput?.workingDirectory || cwd,
    toolPolicy: options?.agentInput?.toolPolicy,
    secrets: collectChildSecretsFromEnv(options),
  };
}

function buildSubagentPrompt(
  input: Record<string, unknown>,
  runtime: CodexSubagentRuntimeConfig,
): string {
  const task = String(input.task || '').trim();
  const workProfile = normalizeSubagentWorkProfile(input.agent_type);
  const name = String(input.name || '').trim() || 'Subagent';
  const scope = String(input.scope || '').trim();
  const output = String(input.output || '').trim();
  const lines = [
    `You are ${name}, a NanoClaw sub-agent.`,
    `Work profile: ${workProfile}.`,
    `Delegation depth: ${runtime.currentDepth + 1}/${runtime.maxDepth}.`,
    '',
    'Task:',
    task,
    '',
    'Operating rules:',
    workProfile === 'explorer'
      ? '- Read-only exploration only. Do not modify files.'
      : '- You may implement changes, but stay within the assigned scope and keep edits minimal.',
    scope
      ? `- Scope: ${scope}`
      : '- Scope: only what is necessary for this task.',
    '- Do not spawn more sub-agents if you have already reached the configured depth limit.',
    '- Return a concise result for the parent agent, including concrete file references when relevant.',
  ];
  if (output) {
    lines.push(`- Expected output: ${output}`);
  }
  return lines.join('\n');
}

function summarizeChildFailure(stdout: string, stderr: string): string {
  const excerpt = [stderr.trim(), stdout.trim()]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);
  return excerpt || 'sub-agent exited without a structured result';
}

function buildManagedSubagentRuntime(
  cwd: string,
  childId: string,
): {
  runtimeDir: string;
  groupDir: string;
  ipcDir: string;
  ipcInputDir: string;
  metadataPath: string;
} {
  const groupRoot = process.env.NANOCLAW_GROUP_DIR?.trim() || cwd;
  const runtimeDir = path.join(groupRoot, SUBAGENT_RUNTIME_DIR_NAME, childId);
  return {
    runtimeDir,
    groupDir: path.join(runtimeDir, 'group'),
    ipcDir: path.join(runtimeDir, 'ipc'),
    ipcInputDir: path.join(runtimeDir, 'ipc', 'input'),
    metadataPath: path.join(runtimeDir, 'runtime.json'),
  };
}

function buildGroupSessionKey(groupFolder: string, chatJid: string): string {
  return `group:${groupFolder}:${chatJid}`;
}

function resolveRequesterSessionKey(
  groupFolder: string,
  chatJid: string,
): string {
  return (
    process.env.NANOCLAW_CURRENT_SUBAGENT_SESSION_KEY?.trim() ||
    buildGroupSessionKey(groupFolder, chatJid)
  );
}

function resolveCurrentPersistedSubagentRole(): PersistedSubagentRole {
  const value = process.env.NANOCLAW_SUBAGENT_ROLE?.trim();
  return value === 'orchestrator' || value === 'leaf' ? value : 'main';
}

function resolveCurrentPersistedControlScope(): PersistedSubagentControlScope {
  return process.env.NANOCLAW_SUBAGENT_CONTROL_SCOPE?.trim() === 'none'
    ? 'none'
    : 'children';
}

function resolveTopologyRole(
  depth: number,
  maxDepth: number,
): PersistedSubagentRole {
  if (depth <= 0) return 'main';
  return depth < maxDepth ? 'orchestrator' : 'leaf';
}

function resolveControlScope(
  topologyRole: PersistedSubagentRole,
): PersistedSubagentControlScope {
  return topologyRole === 'leaf' ? 'none' : 'children';
}

function writeManagedSubagentMetadata(
  handle: ManagedSubagent,
  patch: Partial<PersistedSubagentRuntimeRecord>,
): void {
  handle.metadata = {
    ...handle.metadata,
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  writeManagedSubagentMetadataFile(handle.metadataPath, handle.metadata);
}

function cleanupManagedSubagent(handle: ManagedSubagent): void {
  managedSubagents.delete(handle.id);
  try {
    const historyPath = path.join(
      path.dirname(handle.runtimeDir),
      SUBAGENT_HISTORY_FILE_NAME,
    );
    appendManagedSubagentHistory(historyPath, handle.metadata);
  } catch {
    // ignore archive errors
  }
  try {
    fs.rmSync(handle.runtimeDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function updateManagedSubagentState(
  handle: ManagedSubagent,
  status: SubagentRuntimeStatus,
  patch?: Partial<PersistedSubagentRuntimeRecord>,
): void {
  writeManagedSubagentMetadata(handle, {
    status,
    activeRequestId: handle.activeRequestId || undefined,
    requestCount: handle.requestCount,
    ...patch,
  });
}

function buildManagedSubagentUpdate(
  handle: ManagedSubagent,
  status: SubagentRuntimeStatus,
  note?: string,
): {
  status: SubagentRuntimeStatus;
  note?: string;
  runtimeId: string;
  provider: PersistedSubagentProvider;
  mode: PersistedSubagentMode;
  runtimeKind?: PersistedSubagentRuntimeRecord['runtimeKind'];
  providerSessionId?: string;
  parentRuntimeId?: string;
  controllerSessionKey?: string;
  requesterSessionKey?: string;
  originTurnId?: string;
  originToolCallId?: string;
  topologyRole?: PersistedSubagentRole;
  workProfile?: PersistedSubagentWorkProfile;
  role?: PersistedSubagentRole;
  controlScope?: PersistedSubagentControlScope;
  depth: number;
  chatJid: string;
  requestCount: number;
  controllable: boolean;
} {
  return {
    status,
    ...(note ? { note } : {}),
    runtimeId: handle.id,
    provider: handle.metadata.provider,
    mode: handle.metadata.mode,
    runtimeKind: handle.metadata.runtimeKind,
    providerSessionId: handle.metadata.providerSessionId,
    parentRuntimeId: handle.metadata.parentRuntimeId,
    controllerSessionKey: handle.metadata.controllerSessionKey,
    requesterSessionKey: handle.metadata.requesterSessionKey,
    originTurnId: handle.metadata.originTurnId,
    originToolCallId: handle.metadata.originToolCallId,
    topologyRole: handle.metadata.topologyRole || handle.metadata.role,
    workProfile: handle.metadata.workProfile,
    role: handle.metadata.role,
    controlScope: handle.metadata.controlScope,
    depth: handle.metadata.depth,
    chatJid: handle.metadata.chatJid,
    requestCount: handle.requestCount,
    controllable: true,
  };
}

function rejectManagedSubagentWaiter(
  handle: ManagedSubagent,
  requestId: string,
  message: string,
): void {
  const waiter = handle.waiters.get(requestId);
  if (waiter) {
    handle.waiters.delete(requestId);
    waiter.reject(new Error(message));
    return;
  }
  handle.failedResults.set(requestId, message);
}

function resolveManagedSubagent(agentId: string): ManagedSubagent {
  const handle = managedSubagents.get(agentId.trim());
  if (!handle) {
    throw new Error(`Unknown sub-agent: ${agentId}`);
  }
  return handle;
}

function rejectAllManagedSubagentWaiters(
  handle: ManagedSubagent,
  message: string,
): void {
  for (const requestId of handle.waiters.keys()) {
    rejectManagedSubagentWaiter(handle, requestId, message);
  }
}

function resolveManagedSubagentRequestId(
  handle: ManagedSubagent,
  payload: AgentRunOutputPayload,
): string | null {
  const requestId = String(
    payload.requestId || handle.activeRequestId || '',
  ).trim();
  return requestId || null;
}

function enqueueManagedSubagentResult(
  handle: ManagedSubagent,
  requestId: string,
  result: string,
): void {
  handle.failedResults.delete(requestId);
  const waiter = handle.waiters.get(requestId);
  if (waiter) {
    handle.waiters.delete(requestId);
    waiter.resolve(result);
    return;
  }
  handle.completedResults.set(requestId, result);
}

function parseManagedSubagentOutput(
  handle: ManagedSubagent,
  chunk: string,
): void {
  handle.stdoutBuffer += chunk;

  while (true) {
    const start = handle.stdoutBuffer.indexOf(OUTPUT_START_MARKER);
    if (start === -1) {
      if (handle.stdoutBuffer.length > 16_000) {
        handle.stdoutBuffer = handle.stdoutBuffer.slice(-4_000);
      }
      return;
    }
    const end = handle.stdoutBuffer.indexOf(
      OUTPUT_END_MARKER,
      start + OUTPUT_START_MARKER.length,
    );
    if (end === -1) {
      if (start > 0) {
        handle.stdoutBuffer = handle.stdoutBuffer.slice(start);
      }
      return;
    }

    const jsonText = handle.stdoutBuffer
      .slice(start + OUTPUT_START_MARKER.length, end)
      .trim();
    handle.stdoutBuffer = handle.stdoutBuffer.slice(
      end + OUTPUT_END_MARKER.length,
    );
    if (!jsonText) continue;

    try {
      const payload = JSON.parse(jsonText) as AgentRunOutputPayload;
      const requestId = resolveManagedSubagentRequestId(handle, payload);
      const requestKind = payload.requestKind === 'steer' ? 'steer' : 'message';
      if (payload.status === 'accepted' && requestId) {
        if (handle.activeRequestId !== requestId) {
          handle.activeRequestId = requestId;
          handle.requestCount += 1;
        }
        updateManagedSubagentState(handle, 'running', {
          activeRequestId: requestId,
          lastAcceptedRequestId: requestId,
          lastAcceptedRequestAt: new Date().toISOString(),
          lastAcceptedRequestKind: requestKind,
        });
      }
      if (payload.status === 'success' && typeof payload.result === 'string') {
        if (requestId && handle.activeRequestId === requestId) {
          handle.activeRequestId = null;
        }
        updateManagedSubagentState(
          handle,
          handle.metadata.mode === 'team' && handle.stopReason === null
            ? 'idle'
            : 'running',
          {
            activeRequestId: handle.activeRequestId || undefined,
            lastCompletedRequestId: requestId || undefined,
            lastCompletedRequestAt: requestId
              ? new Date().toISOString()
              : undefined,
            lastCompletedRequestKind: requestId ? requestKind : undefined,
            lastCompletedRequestState: requestId ? 'completed' : undefined,
            lastResultPreview: payload.result.slice(0, 400),
          },
        );
        if (requestId) {
          enqueueManagedSubagentResult(handle, requestId, payload.result);
        }
      }
      if (payload.status === 'error' && payload.error) {
        if (requestId && handle.activeRequestId === requestId) {
          handle.activeRequestId = null;
        }
        updateManagedSubagentState(handle, 'failed', {
          activeRequestId: handle.activeRequestId || undefined,
          lastCompletedRequestId: requestId || undefined,
          lastCompletedRequestAt: requestId
            ? new Date().toISOString()
            : undefined,
          lastCompletedRequestKind: requestId ? requestKind : undefined,
          lastCompletedRequestState: requestId ? 'failed' : undefined,
          lastError: payload.error,
        });
        if (requestId) {
          rejectManagedSubagentWaiter(handle, requestId, payload.error);
        } else {
          rejectAllManagedSubagentWaiters(handle, payload.error);
        }
      }
    } catch {
      // ignore malformed intermediate payloads
    }
  }
}

function writeManagedSubagentPrompt(
  handle: ManagedSubagent,
  prompt: string,
  requestId: string,
): void {
  if (handle.activeRequestId) {
    throw new Error(`Sub-agent ${handle.name} already has an active request.`);
  }
  handle.activeRequestId = requestId;
  handle.requestCount += 1;
  updateManagedSubagentState(handle, 'running', {
    task: handle.metadata.task,
    activeRequestId: requestId,
  });
  fs.mkdirSync(handle.ipcInputDir, { recursive: true });
  const filePath = path.join(
    handle.ipcInputDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  const tempPath = `${filePath}.tmp`;
  const payload: SubagentIpcRequest = {
    type: 'message',
    requestId,
    prompt,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(tempPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function requestManagedSubagentClose(
  handle: ManagedSubagent,
  reason?: string,
): void {
  updateManagedSubagentState(handle, 'stopping', {
    stopRequestedAt: new Date().toISOString(),
    lastError: reason ? undefined : handle.metadata.lastError,
  });
  fs.mkdirSync(handle.ipcInputDir, { recursive: true });
  fs.writeFileSync(path.join(handle.ipcInputDir, '_close'), '', 'utf8');
}

function waitForManagedSubagentResult(
  handle: ManagedSubagent,
  requestId: string,
): Promise<string> {
  if (handle.completedResults.has(requestId)) {
    const result = handle.completedResults.get(requestId) || '';
    handle.completedResults.delete(requestId);
    return Promise.resolve(result);
  }
  if (handle.failedResults.has(requestId)) {
    const message =
      handle.failedResults.get(requestId) || 'Sub-agent request failed.';
    handle.failedResults.delete(requestId);
    return Promise.reject(new Error(message));
  }
  if (handle.exited) {
    return Promise.reject(
      new Error(`Sub-agent ${handle.name} is no longer running.`),
    );
  }
  return new Promise((resolve, reject) => {
    handle.waiters.set(requestId, { resolve, reject });
  });
}

async function waitForManagedSubagentExit(
  handle: ManagedSubagent,
  timeoutMs = SUBAGENT_CLOSE_GRACE_MS,
): Promise<boolean> {
  if (handle.exited) return true;

  const waitFor = (ms: number) =>
    new Promise<boolean>((resolve) => {
      let timeoutId: NodeJS.Timeout | undefined;
      const onExit = () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(true);
      };
      handle.exitPromise.then(onExit);
      timeoutId = setTimeout(() => {
        resolve(false);
      }, ms);
      timeoutId.unref();
    });

  if (await waitFor(timeoutMs)) return true;
  try {
    handle.proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  if (await waitFor(timeoutMs)) return true;
  try {
    handle.proc.kill('SIGKILL');
  } catch {
    // ignore
  }
  const exited = await waitFor(timeoutMs);
  if (!exited) {
    updateManagedSubagentState(handle, 'failed', {
      lastError: `Timed out stopping sub-agent ${handle.name}.`,
    });
  }
  return exited;
}

function installManagedSubagentCleanup(): void {
  if ((installManagedSubagentCleanup as { installed?: boolean }).installed) {
    return;
  }
  (installManagedSubagentCleanup as { installed?: boolean }).installed = true;

  process.on('exit', () => {
    for (const handle of managedSubagents.values()) {
      try {
        requestManagedSubagentClose(handle, 'parent_exit');
      } catch {
        // ignore
      }
      try {
        handle.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  });
}

async function startManagedSubagent(
  prompt: string,
  runtime: CodexSubagentRuntimeConfig,
  cwd: string,
  meta: {
    mode: PersistedSubagentMode;
    name: string;
    task: string;
    workProfile: PersistedSubagentWorkProfile;
  },
  options?: CodexToolExecutionOptions,
): Promise<ManagedSubagent> {
  const childId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingSpawnReservations.add(childId);
  try {
    const runtimePaths = buildManagedSubagentRuntime(cwd, childId);
    fs.mkdirSync(runtimePaths.groupDir, { recursive: true });
    fs.mkdirSync(runtimePaths.ipcInputDir, { recursive: true });
    const groupFolder =
      options?.agentInput?.groupFolder ||
      process.env.NANOCLAW_GROUP_FOLDER ||
      'subagent';
    const chatJid =
      options?.agentInput?.chatJid ||
      process.env.NANOCLAW_CHAT_JID ||
      'subagent';
    const now = new Date().toISOString();
    const initialRequestId = createSubagentRequestId();
    const depth = runtime.currentDepth + 1;
    const requesterSessionKey = resolveRequesterSessionKey(
      groupFolder,
      chatJid,
    );
    const topologyRole = resolveTopologyRole(depth, runtime.maxDepth);
    const controlScope = resolveControlScope(topologyRole);
    const providerSessionId = `codex:${childId}`;

    const child = spawn(process.execPath, [getChildRunnerEntryPath()], {
      cwd,
      env: {
        ...process.env,
        NANOCLAW_GROUP_DIR: runtimePaths.groupDir,
        NANOCLAW_IPC_DIR: runtimePaths.ipcDir,
        NANOCLAW_SUBAGENT_DEPTH: String(depth),
        NANOCLAW_SUBAGENT_ROLE: topologyRole,
        NANOCLAW_SUBAGENT_CONTROL_SCOPE: controlScope,
        NANOCLAW_CURRENT_SUBAGENT_RUNTIME_ID: childId,
        NANOCLAW_CURRENT_SUBAGENT_SESSION_KEY: providerSessionId,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolveExit = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const handle: ManagedSubagent = {
      id: childId,
      name: meta.name,
      task: meta.task,
      initialRequestId,
      runtimeDir: runtimePaths.runtimeDir,
      ipcInputDir: runtimePaths.ipcInputDir,
      metadataPath: runtimePaths.metadataPath,
      proc: child,
      stdoutBuffer: '',
      stderrTail: '',
      completedResults: new Map(),
      failedResults: new Map(),
      waiters: new Map(),
      activeRequestId: initialRequestId,
      requestCount: 1,
      exited: false,
      exitPromise,
      resolveExit,
      stopReason: null,
      metadata: {
        id: childId,
        provider: 'codex',
        mode: meta.mode,
        runtimeKind: meta.mode === 'team' ? 'managed_session' : 'managed_run',
        providerSessionId,
        parentRuntimeId:
          process.env.NANOCLAW_CURRENT_SUBAGENT_RUNTIME_ID?.trim() || undefined,
        controllerSessionKey: requesterSessionKey,
        requesterSessionKey,
        originTurnId: options?.originTurnId?.trim() || undefined,
        originToolCallId: options?.originToolCallId?.trim() || undefined,
        topologyRole,
        workProfile: meta.workProfile,
        role: topologyRole,
        controlScope,
        groupFolder,
        chatJid,
        name: meta.name,
        task: meta.task,
        status: 'spawning',
        depth,
        activeRequestId: initialRequestId,
        requestCount: 1,
        lastAcceptedRequestId: initialRequestId,
        lastAcceptedRequestAt: now,
        lastAcceptedRequestKind: 'message',
        createdAt: now,
        updatedAt: now,
      },
    };
    writeManagedSubagentMetadata(handle, {});
    options?.onSubagentUpdate?.(
      buildManagedSubagentUpdate(
        handle,
        'spawning',
        `starting sub-agent at depth ${runtime.currentDepth + 1}`,
      ),
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      parseManagedSubagentOutput(handle, chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      handle.stderrTail = `${handle.stderrTail}${chunk}`.slice(-4_000);
    });
    child.once('spawn', () => {
      updateManagedSubagentState(handle, 'running', {
        pid: child.pid,
      });
      options?.onSubagentUpdate?.(
        buildManagedSubagentUpdate(handle, 'running'),
      );
      child.stdin.end(
        JSON.stringify(
          buildChildAgentInput(prompt, cwd, initialRequestId, options),
        ),
      );
    });
    child.once('error', (error) => {
      handle.exited = true;
      handle.resolveExit();
      updateManagedSubagentState(handle, 'failed', {
        completedAt: new Date().toISOString(),
        lastError: error.message,
      });
      options?.onSubagentUpdate?.(
        buildManagedSubagentUpdate(handle, 'failed', error.message),
      );
      rejectAllManagedSubagentWaiters(handle, error.message);
      cleanupManagedSubagent(handle);
    });
    child.once('close', (code) => {
      handle.exited = true;
      handle.resolveExit();
      handle.activeRequestId = null;
      const success = code === 0;
      const finalStatus: SubagentRuntimeStatus = success
        ? handle.stopReason === 'stopped'
          ? 'stopped'
          : 'completed'
        : 'failed';
      updateManagedSubagentState(handle, finalStatus, {
        status: finalStatus,
        completedAt: new Date().toISOString(),
        stoppedAt:
          finalStatus === 'stopped' ? new Date().toISOString() : undefined,
        exitCode: code,
        activeRequestId: undefined,
        ...(finalStatus === 'failed'
          ? {
              lastError: summarizeChildFailure('', handle.stderrTail),
            }
          : {}),
      });
      rejectAllManagedSubagentWaiters(
        handle,
        summarizeChildFailure('', handle.stderrTail),
      );
      cleanupManagedSubagent(handle);
    });

    pendingSpawnReservations.delete(childId);
    managedSubagents.set(handle.id, handle);
    installManagedSubagentCleanup();
    return handle;
  } catch (err) {
    pendingSpawnReservations.delete(childId);
    throw err;
  }
}

async function executeTeamCreate(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const runtime = getCodexSubagentRuntimeConfig();
  if (!runtime.enabled) {
    throw new Error('Sub-agents are disabled in the current NanoClaw runtime.');
  }
  if (runtime.currentDepth >= runtime.maxDepth) {
    throw new Error(
      `Sub-agent depth limit reached (${runtime.currentDepth}/${runtime.maxDepth}).`,
    );
  }
  if (runtime.activeCount >= runtime.maxActive) {
    throw new Error(
      `Maximum active sub-agent limit reached (${runtime.activeCount}/${runtime.maxActive}).`,
    );
  }

  const task = String(
    input.prompt || input.task || input.description || '',
  ).trim();
  if (!task) {
    throw new Error('TeamCreate requires a non-empty prompt.');
  }
  const keepAlive = input.keep_alive === true;
  const name =
    String(input.name || input.label || 'Subagent').trim() || 'Subagent';
  const workProfile = normalizeSubagentWorkProfile(input.role);
  const prompt = [
    `You are ${name}, a NanoClaw sub-agent.`,
    `Work profile: ${workProfile}.`,
    `Delegation depth: ${runtime.currentDepth + 1}/${runtime.maxDepth}.`,
    '',
    task,
  ].join('\n');

  const handle = await startManagedSubagent(
    prompt,
    runtime,
    cwd,
    { mode: 'team', name, task, workProfile },
    options,
  );
  const firstResult = await waitForManagedSubagentResult(
    handle,
    handle.initialRequestId,
  );

  if (!keepAlive) {
    handle.stopReason = 'completed';
    requestManagedSubagentClose(handle);
    void waitForManagedSubagentExit(handle);
  }

  return [
    `Sub-agent ${handle.name} (${handle.id}) ${keepAlive ? 'started and returned its first result.' : 'completed.'}`,
    '',
    firstResult.trim() || '(empty result)',
  ].join('\n');
}

async function executeSendMessage(
  input: Record<string, unknown>,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const agentId = String(input.agent_id || '').trim();
  if (!agentId) {
    throw new Error('SendMessage requires agent_id.');
  }
  const prompt = String(
    input.prompt || input.message || input.text || '',
  ).trim();
  if (!prompt) {
    throw new Error('SendMessage requires a non-empty prompt.');
  }

  const handle = resolveManagedSubagent(agentId);
  if (handle.exited) {
    throw new Error(`Sub-agent ${handle.name} is no longer running.`);
  }
  if (handle.activeRequestId) {
    throw new Error(`Sub-agent ${handle.name} already has an active request.`);
  }

  options?.onSubagentUpdate?.(
    buildManagedSubagentUpdate(handle, 'running', `messaging ${handle.name}`),
  );
  const requestId = createSubagentRequestId();
  writeManagedSubagentPrompt(handle, prompt, requestId);

  if (input.wait_for_response === false) {
    return `Sent message to sub-agent ${handle.name} (${handle.id}).`;
  }

  const result = await waitForManagedSubagentResult(handle, requestId);
  if (input.close_after_response === true) {
    handle.stopReason = 'completed';
    requestManagedSubagentClose(handle);
    void waitForManagedSubagentExit(handle);
  }
  return [
    `Sub-agent ${handle.name} (${handle.id}) replied.`,
    '',
    result.trim() || '(empty result)',
  ].join('\n');
}

async function executeTeamDelete(
  input: Record<string, unknown>,
): Promise<string> {
  const agentId = String(input.agent_id || '').trim();
  if (!agentId) {
    throw new Error('TeamDelete requires agent_id.');
  }

  const handle = managedSubagents.get(agentId);
  if (!handle) {
    return `Sub-agent ${agentId} is already stopped.`;
  }
  handle.stopReason = 'stopped';
  requestManagedSubagentClose(handle);
  const stopped = await waitForManagedSubagentExit(handle);
  return stopped
    ? `Sub-agent ${handle.name} (${handle.id}) stopped.`
    : `Sub-agent ${handle.name} (${handle.id}) stop timed out.`;
}

async function executeAgentSubagent(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const runtime = getCodexSubagentRuntimeConfig();
  if (!runtime.enabled) {
    throw new Error('Sub-agents are disabled in the current NanoClaw runtime.');
  }
  if (runtime.currentDepth >= runtime.maxDepth) {
    throw new Error(
      `Sub-agent depth limit reached (${runtime.currentDepth}/${runtime.maxDepth}).`,
    );
  }
  if (runtime.activeCount >= runtime.maxActive) {
    throw new Error(
      `Maximum active sub-agent limit reached (${runtime.activeCount}/${runtime.maxActive}).`,
    );
  }

  const task = String(input.task || '').trim();
  if (!task) {
    throw new Error('Agent tool requires a non-empty task.');
  }
  const handle = await startManagedSubagent(
    buildSubagentPrompt(input, runtime),
    runtime,
    cwd,
    {
      mode: 'agent',
      name: String(input.name || '').trim() || 'Subagent',
      task,
      workProfile: normalizeSubagentWorkProfile(input.agent_type),
    },
    options,
  );
  const requestId = handle.initialRequestId;
  const waitP = waitForManagedSubagentResult(handle, requestId);
  void waitP.catch(() => {
    /* absorb late rejection when timeout wins Promise.race */
  });

  let result: string;
  // Models routinely call the Agent tool without a timeout_ms, or with a
  // lowballed value (e.g. 60_000) that expires mid-review. To keep delegation
  // robust without leaking hung subagents, we enforce:
  //   - a default of 15 minutes when the model does not supply timeout_ms
  //   - a floor of 5 minutes when the model does supply a smaller value
  //   - a hard ceiling of 60 minutes (was 1 hour previously too)
  const SUBAGENT_DEFAULT_TIMEOUT_MS = 15 * 60_000;
  const SUBAGENT_MIN_TIMEOUT_MS = 5 * 60_000;
  const SUBAGENT_MAX_TIMEOUT_MS = 60 * 60_000;
  const rawTimeout = input.timeout_ms;
  const requestedTimeout =
    typeof rawTimeout === 'number' &&
    Number.isFinite(rawTimeout) &&
    rawTimeout > 0
      ? Math.floor(rawTimeout)
      : SUBAGENT_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(
    SUBAGENT_MAX_TIMEOUT_MS,
    Math.max(SUBAGENT_MIN_TIMEOUT_MS, requestedTimeout),
  );
  let timeoutId: NodeJS.Timeout | undefined;
  let timeoutFired = false;
  try {
    result = await Promise.race([
      waitP,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutFired = true;
          reject(new Error(`Agent sub-agent timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (timeoutFired) {
      const msg =
        err instanceof Error
          ? err.message
          : `Agent sub-agent timed out after ${timeoutMs}ms`;
      rejectManagedSubagentWaiter(handle, requestId, msg);
      handle.stopReason = 'stopped';
      requestManagedSubagentClose(handle);
      void waitForManagedSubagentExit(handle);
      options?.onSubagentUpdate?.(
        buildManagedSubagentUpdate(handle, 'failed', msg),
      );
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  handle.stopReason = 'completed';
  requestManagedSubagentClose(handle);
  void waitForManagedSubagentExit(handle);
  options?.onSubagentUpdate?.(buildManagedSubagentUpdate(handle, 'completed'));
  return result || '(no output)';
}

async function requestFileMutationApproval(input: {
  toolCallId: string;
  toolName: 'Write' | 'Edit';
  filePath: string;
}): Promise<string | null> {
  const decision = await requestMutationApproval({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    command: `${input.toolName} ${input.filePath}`,
    cwd: path.dirname(input.filePath),
    canWhitelist: false,
  });
  if (decision === 'allow-once') return null;
  return decision === 'expired'
    ? `Permission denied: ${input.toolName.toLowerCase()} approval timed out`
    : `Permission denied: ${input.toolName.toLowerCase()} denied by user`;
}

async function executeWrite(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const filePath = resolvePath(input.file_path as string, cwd);
  const perm = await checkWritePermissionOrEscalate(
    filePath,
    options?.originToolCallId || `write_${Date.now()}`,
    'Write',
  );
  if (perm) return perm;
  const approvalError = await requestFileMutationApproval({
    toolCallId:
      options?.originToolCallId ||
      `write_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'Write',
    filePath,
  });
  if (approvalError) return approvalError;
  const content = input.content as string;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return `File written: ${filePath} (${content.length} bytes)`;
}

async function executeEdit(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const filePath = resolvePath(input.file_path as string, cwd);
  const perm = await checkWritePermissionOrEscalate(
    filePath,
    options?.originToolCallId || `edit_${Date.now()}`,
    'Edit',
  );
  if (perm) return perm;
  const approvalError = await requestFileMutationApproval({
    toolCallId:
      options?.originToolCallId ||
      `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'Edit',
    filePath,
  });
  if (approvalError) return approvalError;
  const oldStr = input.old_string as string;
  const newStr = input.new_string as string;

  if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

  const content = fs.readFileSync(filePath, 'utf-8');
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    const preview = oldStr.length > 80 ? oldStr.slice(0, 80) + '...' : oldStr;
    return (
      `Error: old_string not found in ${filePath}.\n` +
      `Searched for: ${JSON.stringify(preview)}\n` +
      'Hint: Use read_file to verify exact content including whitespace and indentation, then copy the exact text.'
    );
  }

  const lastIdx = content.lastIndexOf(oldStr);
  if (idx !== lastIdx) {
    return (
      `Error: old_string matches multiple locations in ${filePath}.\n` +
      'Hint: Include 3-5 surrounding lines to make the match unique.'
    );
  }

  const updated =
    content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  fs.writeFileSync(filePath, updated, 'utf-8');
  return `File edited: ${filePath}`;
}

function finalizeGlobPaths(
  paths: string[],
  sortBy: string,
  limit: number,
): string {
  const unique = [...new Set(paths)];
  let sorted: string[];
  if (sortBy === 'mtime') {
    sorted = unique.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
  } else {
    sorted = unique.sort((a, b) => a.localeCompare(b));
  }
  if (sorted.length > limit) {
    return (
      sorted.slice(0, limit).join('\n') +
      `\n... (${sorted.length - limit} more)`
    );
  }
  return sorted.join('\n') || '(no matches)';
}

async function executeGlob(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const pattern = input.pattern as string;
  const dir = (input.dir as string)
    ? resolvePath(input.dir as string, cwd)
    : cwd;
  const sortByRaw = (input.sort_by as string) || 'name';
  const sortBy = sortByRaw === 'mtime' ? 'mtime' : 'name';
  const limit = Math.min(Math.max(Number(input.limit) || 200, 1), 500);
  const perm = await checkPermissionOrEscalate(
    dir,
    options?.originToolCallId || `glob_${Date.now()}`,
    'Glob',
  );
  if (perm) return perm;

  function nodeFsGlob(): string {
    const results: string[] = [];
    function walk(d: string, depth: number): void {
      if (depth > 8 || results.length > limit * 2) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name.match(globToRegex(pattern))) results.push(full);
      }
    }
    walk(dir, 0);
    return finalizeGlobPaths(results, sortBy, limit);
  }

  try {
    if (!isCommandAvailable('rg')) {
      log('glob: rg not found, using Node.js fallback');
      const result = nodeFsGlob();
      if (result === '(no matches)') return result;
      return (
        '⚠ ripgrep (rg) not installed, using Node.js fallback (slower, max depth 8). Install: https://github.com/BurntSushi/ripgrep#installation\n' +
        result
      );
    }

    const rgArgs = ['--files', '--glob', pattern, dir];
    const spawned = spawnSync('rg', rgArgs, {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 256 * 1024,
    });
    if (spawned.error) {
      log(
        `glob: rg failed (${spawned.error.message}), falling back to Node.js`,
      );
      _cmdCache.set('rg', false);
      const result = nodeFsGlob();
      if (result === '(no matches)') return result;
      return '⚠ ripgrep (rg) failed, using Node.js fallback.\n' + result;
    }
    if (spawned.status === 2) {
      const stderr = String(spawned.stderr || '').slice(0, 300);
      return `glob error: ${stderr || 'unknown ripgrep error'}`;
    }
    if (spawned.status === 1) {
      return '(no matches)';
    }
    if (spawned.status !== 0) {
      const stderr = String(spawned.stderr || '').slice(0, 300);
      return `glob error: ${stderr || `ripgrep exited with code ${spawned.status}`}`;
    }
    const lines = (spawned.stdout || '').trim().split('\n').filter(Boolean);
    return finalizeGlobPaths(lines, sortBy, limit);
  } catch (err: unknown) {
    return `glob error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob: string): RegExp {
  const re = glob
    .replace(/\*\*/g, '<<DSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DSTAR>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(re);
}

const _cmdCache = new Map<string, boolean>();
function isCommandAvailable(cmd: string): boolean {
  if (_cmdCache.has(cmd)) return _cmdCache.get(cmd)!;
  try {
    const r = spawnSync(cmd, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    });
    const ok = !r.error;
    _cmdCache.set(cmd, ok);
    if (!ok) log(`[dep-check] ${cmd} not found: ${r.error?.message}`);
    return ok;
  } catch {
    _cmdCache.set(cmd, false);
    return false;
  }
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  'vendor',
  '.cache',
]);

const FILE_TYPE_EXTS: Record<string, string[]> = {
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  css: ['.css', '.scss', '.less'],
  html: ['.html', '.htm'],
  json: ['.json'],
  yaml: ['.yaml', '.yml'],
  md: ['.md'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
};

function nodeGrepFallback(
  searchPath: string,
  pattern: string,
  opts: {
    include?: string;
    fileType?: string;
    caseInsensitive?: boolean;
    contextLines?: number;
    outputMode?: string;
    headLimit?: number;
  },
): string {
  let re: RegExp;
  let literalFallback = false;
  try {
    re = new RegExp(pattern, opts.caseInsensitive ? 'gi' : 'g');
  } catch {
    re = new RegExp(escapeRegExp(pattern), opts.caseInsensitive ? 'gi' : 'g');
    literalFallback = true;
  }
  const limit = opts.headLimit || 100;
  const ctx = opts.contextLines || 0;
  const mode = opts.outputMode || 'content';

  const includeRe = opts.include ? globToRegex(opts.include) : null;
  const typeExts = opts.fileType ? FILE_TYPE_EXTS[opts.fileType] : null;

  function shouldInclude(filePath: string): boolean {
    if (typeExts && !typeExts.some((e) => filePath.endsWith(e))) return false;
    if (includeRe && !includeRe.test(path.basename(filePath))) return false;
    return true;
  }

  const results: string[] = [];
  const fileCounts = new Map<string, number>();
  let totalMatches = 0;

  function walkAndSearch(dir: string, depth: number): void {
    if (depth > 12 || totalMatches > limit * 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndSearch(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !shouldInclude(full)) continue;
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        let fileMatches = 0;
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            re.lastIndex = 0;
            fileMatches++;
            totalMatches++;
            if (mode === 'content' && results.length < limit) {
              const start = Math.max(0, i - ctx);
              const end = Math.min(lines.length - 1, i + ctx);
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? ':' : '-';
                results.push(`${full}:${j + 1}${prefix}${lines[j]}`);
              }
              if (ctx > 0 && end < lines.length - 1) results.push('--');
            } else if (mode === 'files_only') {
              if (!fileCounts.has(full)) fileCounts.set(full, 0);
            }
          }
        }
        if (fileMatches > 0) fileCounts.set(full, fileMatches);
      } catch {
        /* unreadable file */
      }
    }
  }

  const stat = fs.statSync(searchPath, { throwIfNoEntry: false });
  if (stat?.isFile()) {
    if (shouldInclude(searchPath)) {
      try {
        const content = fs.readFileSync(searchPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            re.lastIndex = 0;
            totalMatches++;
            if (mode === 'content') {
              const start = Math.max(0, i - ctx);
              const end = Math.min(lines.length - 1, i + ctx);
              for (let j = start; j <= end; j++) {
                const prefix = j === i ? ':' : '-';
                results.push(`${searchPath}:${j + 1}${prefix}${lines[j]}`);
              }
              if (ctx > 0) results.push('--');
            }
          }
        }
        fileCounts.set(searchPath, totalMatches);
      } catch {
        /* unreadable */
      }
    }
  } else if (stat?.isDirectory()) {
    walkAndSearch(searchPath, 0);
  }

  if (totalMatches === 0) return '(no matches)';

  const prefix = literalFallback
    ? '(pattern treated as literal text — original regex was invalid)\n'
    : '';

  if (mode === 'files_only')
    return prefix + [...fileCounts.keys()].slice(0, limit).join('\n');
  if (mode === 'count') {
    return (
      prefix +
      [...fileCounts.entries()]
        .slice(0, limit)
        .map(([f, c]) => `${f}:${c}`)
        .join('\n')
    );
  }

  const output = results.slice(0, limit * 2).join('\n');
  if (results.length > limit * 2) {
    return (
      prefix +
      output +
      `\n... (truncated, refine pattern or increase head_limit)`
    );
  }
  return prefix + output;
}

async function executeGrep(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string)
    ? resolvePath(input.path as string, cwd)
    : cwd;
  const perm = await checkPermissionOrEscalate(
    searchPath,
    options?.originToolCallId || `grep_${Date.now()}`,
    'Grep',
  );
  if (perm) return perm;

  const include = input.include as string | undefined;
  const fileType = input.type as string | undefined;
  const caseInsensitive = input.case_insensitive === true;
  const rawContext = input.context_lines;
  const contextLines =
    typeof rawContext === 'number' && rawContext > 0
      ? Math.min(Math.floor(rawContext), 5)
      : 0;
  const outputModeRaw = (input.output_mode as string) || 'content';
  const outputMode = ['content', 'files_only', 'count'].includes(outputModeRaw)
    ? outputModeRaw
    : 'content';
  const headLimit = Math.min(Math.max(Number(input.head_limit) || 100, 1), 500);
  const multiline = input.multiline === true;

  if (!isCommandAvailable('rg')) {
    log('grep: rg not found, using Node.js fallback');
    const fallback = nodeGrepFallback(searchPath, pattern, {
      include,
      fileType,
      caseInsensitive,
      contextLines,
      outputMode,
      headLimit,
    });
    const warn =
      '⚠ ripgrep (rg) not installed, using slower Node.js fallback. Install: https://github.com/BurntSushi/ripgrep#installation\n';
    return fallback === '(no matches)' ? fallback : warn + fallback;
  }

  const rgArgs: string[] = ['-n', '--color=never'];
  if (caseInsensitive) rgArgs.push('-i');
  if (multiline) rgArgs.push('-U', '--multiline-dotall');
  if (fileType) rgArgs.push('--type', fileType);
  if (include) rgArgs.push('--glob', include);
  if (contextLines > 0) {
    rgArgs.push('-C', String(contextLines));
  }
  if (outputMode === 'files_only') rgArgs.push('-l');
  if (outputMode === 'count') rgArgs.push('-c');
  rgArgs.push('--', pattern, searchPath);

  try {
    log(`grep: rg ${rgArgs.map((a) => JSON.stringify(a)).join(' ')}`);
    const spawned = spawnSync('rg', rgArgs, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 512 * 1024,
    });
    if (spawned.error) {
      log(
        `grep: rg failed (${spawned.error.message}), falling back to Node.js`,
      );
      _cmdCache.set('rg', false);
      const fallback = nodeGrepFallback(searchPath, pattern, {
        include,
        fileType,
        caseInsensitive,
        contextLines,
        outputMode,
        headLimit,
      });
      const warn =
        '⚠ ripgrep (rg) failed, using slower Node.js fallback. Install: https://github.com/BurntSushi/ripgrep#installation\n';
      return fallback === '(no matches)' ? fallback : warn + fallback;
    }
    if (spawned.status === 2) {
      const stderr = String(spawned.stderr || '').slice(0, 300);
      const isRegexError = /regex|parse|syntax|unterminated|invalid/i.test(
        stderr,
      );
      if (isRegexError) {
        log(
          `grep: regex error, retrying with --fixed-strings: ${stderr.slice(0, 100)}`,
        );
        const fixedArgs = [
          '-F',
          ...rgArgs.filter((a) => a !== '-U' && a !== '--multiline-dotall'),
        ];
        const fixedSpawned = spawnSync('rg', fixedArgs, {
          cwd,
          encoding: 'utf-8',
          timeout: 15_000,
          maxBuffer: 512 * 1024,
        });
        if (fixedSpawned.status === 0 || fixedSpawned.status === 1) {
          const fixedOut = String(fixedSpawned.stdout || '').trimEnd();
          const prefix =
            '(pattern treated as literal text — original regex was invalid)\n';
          return fixedOut ? prefix + fixedOut : '(no matches)';
        }
      }
      return `grep error: ${stderr || 'unknown ripgrep error'}`;
    }
    if (spawned.status === 1) {
      return '(no matches)';
    }
    const out = String(spawned.stdout || '');
    if (!out.trim()) return '(no matches)';
    const lines = out.split('\n');
    const normalized =
      lines.length > 0 && lines[lines.length - 1] === ''
        ? lines.slice(0, -1)
        : lines;
    if (normalized.length > headLimit) {
      return (
        normalized.slice(0, headLimit).join('\n') +
        `\n... (${normalized.length - headLimit} more lines, refine pattern or increase head_limit)`
      );
    }
    return out.trimEnd() || '(no matches)';
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: Buffer | string };
    if (e.status === 1) return '(no matches)';
    if (e.status === 2) {
      const stderr = (e.stderr?.toString() || '').slice(0, 300);
      return `grep error: ${stderr || 'unknown ripgrep error'}`;
    }
    return `grep error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeListDir(
  input: Record<string, unknown>,
  cwd: string,
  options?: CodexToolExecutionOptions,
): Promise<string> {
  const dirPath = resolvePath(input.dir_path as string, cwd);
  const perm = await checkPermissionOrEscalate(
    dirPath,
    options?.originToolCallId || `listdir_${Date.now()}`,
    'ListDir',
  );
  if (perm) return perm;
  const maxDepth = (input.depth as number) || 1;

  if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;

  const entries: string[] = [];

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth || entries.length > 200) return;
    try {
      const items = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory())
            return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      for (const item of items) {
        const type = item.isDirectory() ? '📁' : '📄';
        entries.push(`${prefix}${type} ${item.name}`);
        if (item.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, item.name), depth + 1, prefix + '  ');
        }
      }
    } catch {
      /* permission error, skip */
    }
  }

  walk(dirPath, 1, '');
  return entries.join('\n') || '(empty directory)';
}

async function executeMemorySearch(
  input: Record<string, unknown>,
): Promise<string> {
  if (!isMemoryReadAvailable()) {
    return `Error: ${getMemoryReadDisabledMessage()}`;
  }
  const query = String(input.query || '').trim();
  const scopeRaw =
    typeof input.scope === 'string' ? input.scope.trim().toLowerCase() : '';
  const scope =
    scopeRaw === 'group' || scopeRaw === 'global' || scopeRaw === 'all'
      ? scopeRaw
      : undefined;
  const maxResults =
    typeof input.max_results === 'number' ? input.max_results : undefined;
  return buildMemorySearchResponse(
    query,
    await searchMemoryRuntime(query, {
      scope,
      maxResults,
    }),
  ).renderedText;
}

async function executeMemoryGet(
  input: Record<string, unknown>,
): Promise<string> {
  if (!isMemoryReadAvailable()) {
    return `Error: ${getMemoryReadDisabledMessage()}`;
  }
  const pathRef = String(input.path || '').trim();
  const from = typeof input.from === 'number' ? input.from : undefined;
  const lines = typeof input.lines === 'number' ? input.lines : undefined;
  const result = readMemoryFile(pathRef, { from, lines });
  const followup = getRecentMemorySearchFollowup({
    path: result.path,
    lineStart: result.lineStart,
    lineEnd: result.lineEnd,
  });
  await notifyMemoryRecall({
    path: result.path,
    scope: result.scope,
    lineStart: result.lineStart,
    lineEnd: result.lineEnd,
    text: result.text,
    ...followup,
  });
  return `${result.path}#L${result.lineStart}-L${result.lineEnd}\n${result.text}`;
}

function executeMemorySave(input: Record<string, unknown>): string {
  const note = String(input.note || '').trim();
  const scopeRaw = String(input.scope || 'group')
    .trim()
    .toLowerCase();
  const scope = scopeRaw === 'global' ? 'global' : 'group';
  const disabledMessage = getMemoryWriteDisabledMessage(scope);
  if (disabledMessage) {
    return `Error: ${disabledMessage}`;
  }
  const result = saveMemoryNote(note, { scope });
  return [
    `Appended memory note to ${result.path}#L${result.lineStart}-L${result.lineEnd}`,
    result.appendedText,
  ].join('\n');
}

async function executeAskUser(input: Record<string, unknown>): Promise<string> {
  const question = String(input.question || '').trim();
  if (!question) return 'Error: question is required';
  const options = Array.isArray(input.options)
    ? (input.options as Array<{ id?: string; label?: string }>)
        .filter(
          (o) => typeof o?.id === 'string' && typeof o?.label === 'string',
        )
        .map((o) => ({ id: String(o.id), label: String(o.label) }))
    : undefined;
  const allowMultiple = input.allow_multiple === true;
  const timeoutSeconds =
    typeof input.timeout_seconds === 'number'
      ? input.timeout_seconds
      : undefined;
  return askUser({
    question,
    options,
    allow_multiple: allowMultiple,
    timeout_seconds: timeoutSeconds,
  });
}

async function executeSearchWeb(
  input: Record<string, unknown>,
): Promise<string> {
  const rawQuery = String(input.query || '').trim();
  if (rawQuery.split(/\s+/).length > 15) {
    log(
      `search_web: query has ${rawQuery.split(/\s+/).length} words — consider using fewer keywords`,
    );
  }
  return searchWeb({
    query: rawQuery,
    domains: Array.isArray(input.domains)
      ? input.domains
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 8)
      : undefined,
    maxResults:
      typeof input.max_results === 'number' ? input.max_results : undefined,
  });
}

async function executeFetchUrl(
  input: Record<string, unknown>,
): Promise<string> {
  let url = String(input.url || '').trim();
  if (url.startsWith('//')) {
    url = 'https:' + url;
  } else if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return fetchUrl({
    url,
    maxChars: typeof input.max_chars === 'number' ? input.max_chars : undefined,
    page: typeof input.page === 'number' ? input.page : undefined,
    pageSize: typeof input.page_size === 'number' ? input.page_size : undefined,
  });
}

function collectLintFilePaths(
  resolvedPaths: string[],
  extRe: RegExp,
): string[] {
  const out: string[] = [];
  for (const p of resolvedPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile() && extRe.test(p)) {
        out.push(p);
        continue;
      }
      if (st.isDirectory()) {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(p, e.name);
          if (e.isFile() && extRe.test(full)) out.push(full);
        }
      }
    } catch {
      /* skip */
    }
  }
  return [...new Set(out)];
}

function collectLintExtensions(resolvedPaths: string[]): Set<string> {
  const exts = new Set<string>();
  for (const p of resolvedPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) {
        exts.add(path.extname(p).toLowerCase());
        continue;
      }
      if (st.isDirectory()) {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile()) {
            exts.add(path.extname(e.name).toLowerCase());
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  return exts;
}

function diagnosticMatchesRequestedPaths(
  diagnosticFile: string,
  requestedAbs: string[],
): boolean {
  const norm = path.resolve(diagnosticFile);
  for (const req of requestedAbs) {
    if (!fs.existsSync(req)) continue;
    try {
      const st = fs.statSync(req);
      if (st.isFile()) {
        if (path.resolve(req) === norm) return true;
        if (
          path.basename(norm) === path.basename(req) &&
          norm.endsWith(path.sep + path.basename(req))
        ) {
          return true;
        }
      }
      if (st.isDirectory()) {
        const rel = path.relative(req, norm);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          return true;
        }
      }
    } catch {
      /* skip */
    }
  }
  return false;
}

async function executeReadLints(
  input: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((p): p is string => typeof p === 'string')
    : [];
  if (paths.length === 0) return 'Error: No file paths provided.';
  const shouldFix = input.fix === true;

  const resolvedPaths = paths.map((p) => resolvePath(p, cwd));
  const extensions = collectLintExtensions(resolvedPaths);

  interface LintDiagnostic {
    file: string;
    line: number;
    col: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
    rule?: string;
  }

  const diagnostics: LintDiagnostic[] = [];
  const errors: string[] = [];

  if (
    extensions.has('.ts') ||
    extensions.has('.tsx') ||
    extensions.has('.js') ||
    extensions.has('.jsx')
  ) {
    const tscPaths = collectLintFilePaths(resolvedPaths, /\.[tj]sx?$/i);
    if (tscPaths.length > 0) {
      if (!isCommandAvailable('npx')) {
        errors.push(
          '⚠ npx not found — TypeScript checking unavailable. Install Node.js to enable.',
        );
      } else {
        try {
          let tsconfigPath = '';
          let dir = path.dirname(tscPaths[0]);
          for (;;) {
            const candidate = path.join(dir, 'tsconfig.json');
            if (fs.existsSync(candidate)) {
              tsconfigPath = candidate;
              break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
          }
          const tscArgs = tsconfigPath
            ? [
                'tsc',
                '--project',
                tsconfigPath,
                '--noEmit',
                '--pretty',
                'false',
              ]
            : ['tsc', '--noEmit', '--pretty', 'false', ...tscPaths];
          const spawned = spawnSync('npx', tscArgs, {
            cwd,
            timeout: 30_000,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            shell: false,
          });
          if (spawned.error) {
            errors.push(`⚠ npx tsc failed: ${spawned.error.message}`);
          } else {
            const result = `${spawned.stdout || ''}${spawned.stderr || ''}`;
            const tscLineRe =
              /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
            let match: RegExpExecArray | null;
            while ((match = tscLineRe.exec(result)) !== null) {
              const filePath = match[1];
              if (diagnosticMatchesRequestedPaths(filePath, resolvedPaths)) {
                diagnostics.push({
                  file: filePath,
                  line: parseInt(match[2], 10),
                  col: parseInt(match[3], 10),
                  severity: match[4] as 'error' | 'warning',
                  message: match[5].trim(),
                });
              }
            }
          }
        } catch (err) {
          errors.push(
            `TypeScript lint error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  if (extensions.has('.py')) {
    const pyPaths = collectLintFilePaths(resolvedPaths, /\.py$/i);
    if (pyPaths.length > 0) {
      if (!isCommandAvailable('ruff')) {
        errors.push(
          '⚠ ruff not found — Python linting unavailable. Install: pip install ruff',
        );
      } else {
        try {
          const ruffArgs = [
            'check',
            ...(shouldFix ? ['--fix'] : []),
            '--output-format',
            'json',
            ...pyPaths,
          ];
          const spawned = spawnSync('ruff', ruffArgs, {
            cwd,
            timeout: 30_000,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            shell: false,
          });
          if (spawned.error) {
            errors.push(`⚠ ruff failed: ${spawned.error.message}`);
          } else {
            const result = `${spawned.stdout || ''}${spawned.stderr || ''}`;
            const jsonStart = result.indexOf('[');
            const jsonSlice =
              jsonStart >= 0 ? result.slice(jsonStart) : result.trim();
            try {
              const ruffResults = JSON.parse(jsonSlice) as Array<{
                filename: string;
                location: { row: number; column: number };
                code: string;
                message: string;
              }>;
              if (Array.isArray(ruffResults)) {
                for (const r of ruffResults) {
                  diagnostics.push({
                    file: r.filename,
                    line: r.location.row,
                    col: r.location.column,
                    severity: 'warning',
                    message: r.message,
                    rule: r.code,
                  });
                }
              }
            } catch {
              /* output not JSON */
            }
          }
        } catch (err) {
          errors.push(
            `Python lint error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  if (extensions.has('.go')) {
    const goFiles = collectLintFilePaths(resolvedPaths, /\.go$/i);
    if (goFiles.length > 0) {
      if (!isCommandAvailable('go')) {
        errors.push(
          '⚠ go not found — Go linting unavailable. Install: https://go.dev/dl/',
        );
      } else {
        try {
          const goSpawned = spawnSync('go', ['vet', ...goFiles], {
            cwd,
            timeout: 30_000,
            encoding: 'utf-8',
            maxBuffer: 2 * 1024 * 1024,
            shell: false,
          });
          if (goSpawned.error) {
            errors.push(`⚠ go vet failed: ${goSpawned.error.message}`);
          } else {
            const result = `${goSpawned.stdout || ''}${goSpawned.stderr || ''}`;
            const vetRe = /^vet:\s*(.+)$/gm;
            let m: RegExpExecArray | null;
            while ((m = vetRe.exec(result)) !== null) {
              diagnostics.push({
                file: goFiles[0],
                line: 1,
                col: 1,
                severity: 'warning',
                message: m[1].trim(),
              });
            }
            const fileLineRe = /^(.+\.go):(\d+):\s*(.+)$/gm;
            while ((m = fileLineRe.exec(result)) !== null) {
              if (diagnosticMatchesRequestedPaths(m[1], resolvedPaths)) {
                diagnostics.push({
                  file: m[1],
                  line: parseInt(m[2], 10),
                  col: 1,
                  severity: 'warning',
                  message: m[3].trim(),
                });
              }
            }
          }
        } catch (err) {
          errors.push(
            `Go lint error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  if (extensions.has('.rs')) {
    const rsFiles = collectLintFilePaths(resolvedPaths, /\.rs$/i);
    if (rsFiles.length > 0) {
      if (!isCommandAvailable('cargo')) {
        errors.push(
          '⚠ cargo not found — Rust checking unavailable. Install: https://rustup.rs/',
        );
      } else {
        try {
          let cargoDir = path.dirname(rsFiles[0]);
          for (;;) {
            if (fs.existsSync(path.join(cargoDir, 'Cargo.toml'))) break;
            const parent = path.dirname(cargoDir);
            if (parent === cargoDir) {
              cargoDir = cwd;
              break;
            }
            cargoDir = parent;
          }
          const cargoSpawned = spawnSync(
            'cargo',
            ['check', '--message-format=short'],
            {
              cwd: cargoDir,
              timeout: 120_000,
              encoding: 'utf-8',
              maxBuffer: 2 * 1024 * 1024,
              shell: false,
            },
          );
          if (cargoSpawned.error) {
            errors.push(`⚠ cargo check failed: ${cargoSpawned.error.message}`);
          } else {
            const result = `${cargoSpawned.stdout || ''}${cargoSpawned.stderr || ''}`;
            const cargoRe = /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/gm;
            let m: RegExpExecArray | null;
            while ((m = cargoRe.exec(result)) !== null) {
              if (diagnosticMatchesRequestedPaths(m[1], resolvedPaths)) {
                diagnostics.push({
                  file: m[1],
                  line: parseInt(m[2], 10),
                  col: parseInt(m[3], 10),
                  severity: m[4] as 'error' | 'warning',
                  message: m[5].trim(),
                });
              }
            }
          }
        } catch (err) {
          errors.push(
            `Rust lint error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  if (diagnostics.length === 0 && errors.length === 0) {
    return `No lint issues found in ${paths.length} file(s). ✓`;
  }

  const lines: string[] = [];
  if (diagnostics.length > 0) {
    lines.push(`Found ${diagnostics.length} diagnostic(s):\n`);
    for (const d of diagnostics.slice(0, 50)) {
      const ruleTag = d.rule ? ` [${d.rule}]` : '';
      lines.push(
        `${d.file}:${d.line}:${d.col} ${d.severity}${ruleTag}: ${d.message}`,
      );
    }
    if (diagnostics.length > 50) {
      lines.push(`\n... and ${diagnostics.length - 50} more diagnostic(s)`);
    }
  }
  if (errors.length > 0) {
    lines.push(`\nLinter errors:\n${errors.join('\n')}`);
  }
  return lines.join('\n');
}

async function executeSemanticSearch(
  input: Record<string, unknown>,
): Promise<string> {
  const query = String(input.query || '').trim();
  if (!query) return 'Error: query is required.';
  const scopeRaw = String(input.scope || 'all')
    .trim()
    .toLowerCase();
  const scope =
    scopeRaw === 'knowledge' || scopeRaw === 'memory' ? scopeRaw : 'all';
  const maxResults = Math.max(
    1,
    Math.min(typeof input.max_results === 'number' ? input.max_results : 8, 15),
  );

  const sections: string[] = [];

  if (scope === 'all' || scope === 'knowledge') {
    try {
      const kbResults = await searchKnowledgeBaseViaApi(
        query,
        Math.ceil(maxResults * 0.6),
      );
      if (kbResults && kbResults.length > 0) {
        sections.push('## Knowledge Base Results\n');
        for (const [i, r] of kbResults.entries()) {
          const source = r.filename ? ` — _${r.filename}_` : '';
          const typeLabel = r.kind === 'wiki' ? 'Wiki' : 'Chunk';
          const staleLabel = r.kind === 'wiki' && r.isStale ? ' · stale' : '';
          sections.push(
            `${i + 1}. **${r.kbName || 'KB'}** · ${typeLabel}${staleLabel}${source} (score: ${r.score.toFixed(2)})`,
          );
          sections.push(
            `   ${r.content.slice(0, 300)}${r.content.length > 300 ? '...' : ''}\n`,
          );
          if (
            r.kind === 'wiki' &&
            Array.isArray(r.evidenceChunks) &&
            r.evidenceChunks.length > 0
          ) {
            sections.push('   Evidence:');
            for (const [evidenceIndex, chunk] of r.evidenceChunks.entries()) {
              sections.push(
                `   - [${i + 1}.${evidenceIndex + 1}] ${chunk.filename || 'unknown'}#${chunk.chunkIndex + 1} (${chunk.score.toFixed(2)})`,
              );
              sections.push(
                `     ${chunk.content.slice(0, 220)}${chunk.content.length > 220 ? '...' : ''}`,
              );
            }
            sections.push('');
          }
        }
      }
    } catch {
      sections.push('_Knowledge base search unavailable_\n');
    }
  }

  if (scope === 'all' || scope === 'memory') {
    if (isMemoryReadAvailable()) {
      try {
        const memResults = await searchMemoryRuntime(query, {
          scope: 'all',
          maxResults: Math.ceil(maxResults * 0.4),
        });
        const rendered = buildMemorySearchResponse(query, memResults);
        if (rendered.resultCount > 0) {
          sections.push('## Memory Results\n');
          sections.push(rendered.renderedText);
        }
      } catch {
        sections.push('_Memory search error_\n');
      }
    }
  }

  if (sections.length === 0) {
    return `No semantic search results for: "${query}"\nTip: Use grep for exact text matching in code files.`;
  }

  return sections.join('\n');
}
