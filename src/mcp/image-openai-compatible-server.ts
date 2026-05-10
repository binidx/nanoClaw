import fs from 'fs';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const DEFAULT_IMAGE_OUTPUT_DIR = '.nanoclaw/generated-images';
const DEFAULT_IMAGE_QUALITY = 'high';
const DEFAULT_IMAGE_FORMAT = 'png';
const ALLOWED_SIZES = ['512x512', '1024x1024', '1536x1024', '1024x1536'] as const;

type AllowedImageSize = (typeof ALLOWED_SIZES)[number];

interface ImageApiGenerateResponse {
  data?: Array<{
    b64_json?: string;
  }>;
}

interface GenerateImageSuccessPayload extends Record<string, unknown> {
  ok: true;
  provider: {
    baseUrl: string;
    model: string;
  };
  images: Array<{
    path: string;
    mimeType: 'image/png';
    size: AllowedImageSize;
  }>;
}

interface GenerateImageFailurePayload extends Record<string, unknown> {
  ok: false;
  error: {
    code:
      | 'auth_failed'
      | 'invalid_request'
      | 'rate_limited'
      | 'upstream_unavailable'
      | 'network_error'
      | 'invalid_response';
    message: string;
  };
}

type GenerateImageResultPayload =
  | GenerateImageSuccessPayload
  | GenerateImageFailurePayload;

function textResult(
  text: string,
  structuredContent?: GenerateImageResultPayload,
  isError = false,
) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function readRequiredStringEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function normalizeImageApiBaseUrl(baseUrl: string): string {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('IMAGE_API_BASE_URL is required');
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function getImageOutputDirectory(cwd = process.cwd()): string {
  const configured = String(
    process.env.IMAGE_OUTPUT_DIR || DEFAULT_IMAGE_OUTPUT_DIR,
  ).trim();
  return path.resolve(cwd, configured || DEFAULT_IMAGE_OUTPUT_DIR);
}

function buildTimestampPrefix(date = new Date()): string {
  const parts = [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
    '-',
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ];
  return parts.join('');
}

function buildOutputFilePaths(
  count: number,
  cwd = process.cwd(),
  now = new Date(),
): string[] {
  const outputDir = getImageOutputDirectory(cwd);
  fs.mkdirSync(outputDir, { recursive: true });
  const prefix = buildTimestampPrefix(now);
  return Array.from({ length: count }, (_, index) =>
    path.join(
      outputDir,
      `${prefix}-${String(index + 1).padStart(3, '0')}.${DEFAULT_IMAGE_FORMAT}`,
    ),
  );
}

async function readResponseTextSafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function buildFailurePayload(
  code: GenerateImageFailurePayload['error']['code'],
  message: string,
): GenerateImageFailurePayload {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

export function mapImageApiError(
  response: Response,
  bodyText: string,
): GenerateImageFailurePayload {
  const trimmedBody = bodyText.trim();
  const fallbackMessage = trimmedBody || `Image API request failed: ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return buildFailurePayload('auth_failed', fallbackMessage);
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return buildFailurePayload('invalid_request', fallbackMessage);
  }
  if (response.status === 429) {
    return buildFailurePayload('rate_limited', fallbackMessage);
  }
  if (response.status >= 500) {
    return buildFailurePayload('upstream_unavailable', fallbackMessage);
  }
  return buildFailurePayload('network_error', fallbackMessage);
}

function renderSuccessText(payload: GenerateImageSuccessPayload): string {
  return [
    `Generated ${payload.images.length} image(s) with ${payload.provider.model}.`,
    ...payload.images.map(
      (image, index) => `${index + 1}. ${image.path} (${image.size})`,
    ),
  ].join('\n');
}

function renderFailureText(payload: GenerateImageFailurePayload): string {
  return `Image generation failed [${payload.error.code}]: ${payload.error.message}`;
}

export async function generateImages(input: {
  prompt: string;
  n: number;
  size: AllowedImageSize;
  cwd?: string;
  now?: Date;
}): Promise<GenerateImageResultPayload> {
  const apiBase = normalizeImageApiBaseUrl(readRequiredStringEnv('IMAGE_API_BASE_URL'));
  const model = String(process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
  const apiKey = String(process.env.IMAGE_API_KEY || '').trim();

  let response: Response;
  try {
    response = await fetch(`${apiBase}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: input.n,
        size: input.size,
        quality: DEFAULT_IMAGE_QUALITY,
        output_format: DEFAULT_IMAGE_FORMAT,
      }),
    });
  } catch (error) {
    return buildFailurePayload(
      'network_error',
      error instanceof Error ? error.message : 'Image API request failed',
    );
  }

  if (!response.ok) {
    return mapImageApiError(response, await readResponseTextSafe(response));
  }

  let payload: ImageApiGenerateResponse;
  try {
    payload = (await response.json()) as ImageApiGenerateResponse;
  } catch (error) {
    return buildFailurePayload(
      'invalid_response',
      error instanceof Error ? error.message : 'Image API returned invalid JSON',
    );
  }

  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    return buildFailurePayload(
      'invalid_response',
      'Image API returned no image payloads',
    );
  }

  const filePaths = buildOutputFilePaths(
    payload.data.length,
    input.cwd,
    input.now,
  );

  try {
    payload.data.forEach((entry, index) => {
      if (typeof entry?.b64_json !== 'string' || !entry.b64_json.trim()) {
        throw new Error(`Image payload ${index + 1} is missing b64_json`);
      }
      const binary = Buffer.from(entry.b64_json, 'base64');
      if (binary.length === 0) {
        throw new Error(`Image payload ${index + 1} decoded to empty content`);
      }
      fs.writeFileSync(filePaths[index]!, binary);
    });
  } catch (error) {
    return buildFailurePayload(
      'invalid_response',
      error instanceof Error ? error.message : 'Failed to decode image response',
    );
  }

  return {
    ok: true,
    provider: {
      baseUrl: apiBase,
      model,
    },
    images: filePaths.map((filePath) => ({
      path: filePath,
      mimeType: 'image/png' as const,
      size: input.size,
    })),
  };
}

const server = new McpServer({
  name: 'image-openai-compatible',
  version: '1.0.0',
});

server.tool(
  'generate_image',
  'Generate one or more PNG images through an OpenAI-compatible Images API using prompt, count, and size.',
  {
    prompt: z.string().min(1).describe('The forward prompt to send to the image model'),
    n: z.number().int().min(1).max(4).default(1).describe('Number of images to generate'),
    size: z
      .enum(ALLOWED_SIZES)
      .default('1024x1024')
      .describe('Requested output resolution'),
  },
  async (args) => {
    try {
      const result = await generateImages({
        prompt: args.prompt,
        n: args.n ?? 1,
        size: (args.size ?? '1024x1024') as AllowedImageSize,
      });
      if (!result.ok) {
        return textResult(renderFailureText(result), result, true);
      }
      return textResult(renderSuccessText(result), result);
    } catch (error) {
      const payload = buildFailurePayload(
        'network_error',
        error instanceof Error ? error.message : 'Unexpected image generation failure',
      );
      return textResult(renderFailureText(payload), payload, true);
    }
  },
);

await server.connect(new StdioServerTransport());
