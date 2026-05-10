import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
};

const registeredTools: RegisteredTool[] = [];
const connectMock = vi.fn(async () => undefined);

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class FakeMcpServer {
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: any) => Promise<any>,
    ) {
      registeredTools.push({ name, description, schema, handler });
    }

    connect = connectMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class FakeStdioServerTransport {},
}));

vi.mock('./memory-tools.js', () => ({
  buildMemorySearchResponse: vi.fn(() => ({ renderedText: '' })),
  getRecentMemorySearchFollowup: vi.fn(() => ({})),
  getMemoryRuntimeConfig: vi.fn(() => ({})),
  getMemoryWriteDisabledMessage: vi.fn(() => null),
  isMemoryReadAvailable: vi.fn(() => false),
  isMemoryWriteAvailable: vi.fn(() => false),
  readMemoryFile: vi.fn(),
  saveMemoryNote: vi.fn(),
  searchMemoryRuntime: vi.fn(),
}));

vi.mock('./internal-memory-api.js', () => ({
  notifyMemoryRecall: vi.fn(async () => undefined),
}));

vi.mock('./web-tools.js', () => ({
  fetchUrl: vi.fn(async () => ''),
  searchWeb: vi.fn(async () => ''),
}));

describe('ipc mcp stdio create_feishu_cloud_doc tool', () => {
  beforeEach(() => {
    registeredTools.length = 0;
    connectMock.mockClear();
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('NANOCLAW_INTERNAL_API_BASE', 'http://127.0.0.1:3000');
    vi.stubEnv('NANOCLAW_INTERNAL_API_TOKEN', 'secret-token');
    vi.stubEnv('NANOCLAW_CHAT_JID', 'feishu:oc_review_chat');
    vi.stubEnv('NANOCLAW_GROUP_FOLDER', 'group-1');
    vi.stubEnv('NANOCLAW_IS_MAIN', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('registers the Feishu cloud doc tool and posts plain text to the current chat route', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          documentId: 'doccn123',
          url: 'https://tenant.feishu.cn/docx/doccn123',
          resultStatus: 'success',
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await import('./ipc-mcp-stdio.ts');

    const tool = registeredTools.find(
      (entry) => entry.name === 'create_feishu_cloud_doc',
    );
    expect(tool).toBeDefined();
    expect(connectMock).toHaveBeenCalledTimes(1);

    const result = await tool!.handler({
      title: '排查记录',
      text: '把今天的讨论整理成云文档',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/conversations/feishu%3Aoc_review_chat/feishu-docs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-nanoclaw-internal-api-token': 'secret-token',
        }),
        body: JSON.stringify({
          title: '排查记录',
          text: '把今天的讨论整理成云文档',
        }),
      }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('https://tenant.feishu.cn/docx/doccn123'),
        },
      ],
    });
  });

  it('posts structured sections to the current chat route', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          documentId: 'doccn456',
          url: 'https://tenant.feishu.cn/docx/doccn456',
          resultStatus: 'success_with_authorization_warnings',
          authorizationWarnings: ['chat grant failed'],
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await import('./ipc-mcp-stdio.ts');

    const tool = registeredTools.find(
      (entry) => entry.name === 'create_feishu_cloud_doc',
    );
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      title: 'CR 明细',
      sections: [
        { kind: 'heading', level: 1, text: 'Overview' },
        { kind: 'paragraph', text: 'Summary' },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/conversations/feishu%3Aoc_review_chat/feishu-docs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'CR 明细',
          sections: [
            { kind: 'heading', level: 1, text: 'Overview' },
            { kind: 'paragraph', text: 'Summary' },
          ],
        }),
      }),
    );
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('success_with_authorization_warnings'),
        },
      ],
    });
  });

  it('renders an explicit failure response when the Feishu cloud doc route reports a failed result', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: false,
          documentId: 'doccn789',
          url: '',
          resultStatus: 'content_population_failed',
          message: 'Feishu cloud doc content population failed.',
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await import('./ipc-mcp-stdio.ts');

    const tool = registeredTools.find(
      (entry) => entry.name === 'create_feishu_cloud_doc',
    );
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      title: 'CR 明细',
      text: '请整理成云文档',
    });

    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining(
            'Feishu cloud doc creation did not complete successfully.',
          ),
        },
      ],
    });
  });
});
