import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<any>;
};

const registeredTools: RegisteredTool[] = [];
const connectMock = vi.fn(async () => undefined);
const originalCwd = process.cwd();

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class FakeMcpServer {
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<any>,
    ) {
      registeredTools.push({ name, description, schema, handler });
    }

    connect = connectMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class FakeStdioServerTransport {},
}));

async function loadModule() {
  const moduleUrl = pathToFileURL(
    path.resolve(
      originalCwd,
      'src',
      'mcp',
      'image-openai-compatible-server.ts',
    ),
  ).href;
  return import(moduleUrl);
}

describe('image openai compatible mcp server', () => {
  let tempDir = '';

  beforeEach(() => {
    registeredTools.length = 0;
    connectMock.mockClear();
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-image-mcp-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers generate_image and writes decoded png output into the workspace', async () => {
    vi.stubEnv('IMAGE_API_BASE_URL', 'https://gateway.example.com');
    vi.stubEnv('IMAGE_API_KEY', 'secret-key');
    vi.stubEnv('IMAGE_MODEL', 'gpt-image-1');
    vi.stubEnv('IMAGE_OUTPUT_DIR', '.nanoclaw/generated-images');

    const imageBuffer = Buffer.from('fake-png-binary');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ b64_json: imageBuffer.toString('base64') }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await loadModule();

    const tool = registeredTools.find((entry) => entry.name === 'generate_image');
    expect(tool).toBeDefined();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(tool!.schema).toEqual(
      expect.objectContaining({
        prompt: expect.anything(),
        n: expect.anything(),
        size: expect.anything(),
      }),
    );

    const result = await tool!.handler({
      prompt: 'cyberpunk cat',
      n: 1,
      size: '1024x1024',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          model: 'gpt-image-1',
          prompt: 'cyberpunk cat',
          n: 1,
          size: '1024x1024',
          quality: 'high',
          output_format: 'png',
        }),
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('Generated 1 image');
    const payload = result.structuredContent as {
      ok: true;
      provider: { baseUrl: string; model: string };
      images: Array<{ path: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.provider).toEqual({
      baseUrl: 'https://gateway.example.com/v1',
      model: 'gpt-image-1',
    });
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]!.path).toContain(
      `${path.sep}.nanoclaw${path.sep}generated-images${path.sep}`,
    );
    expect(fs.existsSync(payload.images[0]!.path)).toBe(true);
    expect(fs.readFileSync(payload.images[0]!.path)).toEqual(imageBuffer);
  });

  it('returns a sanitized auth failure when the upstream rejects credentials', async () => {
    vi.stubEnv('IMAGE_API_BASE_URL', 'https://gateway.example.com/v1');
    vi.stubEnv('IMAGE_API_KEY', 'bad-key');

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await loadModule();

    const tool = registeredTools.find((entry) => entry.name === 'generate_image');
    const result = await tool!.handler({
      prompt: 'cat',
      n: 1,
      size: '1024x1024',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('auth_failed');
    expect(result.structuredContent).toEqual({
      ok: false,
      error: {
        code: 'auth_failed',
        message: 'invalid api key',
      },
    });
  });

  it('marks missing b64_json payloads as invalid_response', async () => {
    vi.stubEnv('IMAGE_API_BASE_URL', 'https://gateway.example.com');

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{}],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await loadModule();

    const tool = registeredTools.find((entry) => entry.name === 'generate_image');
    const result = await tool!.handler({
      prompt: 'cat',
      size: '1024x1024',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('invalid_response');
    expect(result.structuredContent).toEqual({
      ok: false,
      error: {
        code: 'invalid_response',
        message: 'Image payload 1 is missing b64_json',
      },
    });
  });
});
