import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  setRegisteredGroup,
  storeMessage,
  storeAssistantTurnSnapshot,
  storeChatMetadata,
  storeMessageDirectWithTurn,
} from './db.js';
import { GROUPS_DIR } from './config.js';
import { registerConversationMessageRoutes } from './routes/conversation-message-routes.js';
import { createUploadedFileSupport } from './web/uploaded-files.js';

const allowAllRequirePermission: import('./auth-middleware.js').RequirePermissionFn =
  () => async (_req, _res, next) => {
    next();
  };

function createApp() {
  const app = express();
  app.use(express.json());
  registerConversationMessageRoutes(app, {
    requirePermission: allowAllRequirePermission,
    decorateConversationSummary: (conversation) => conversation,
    parseBoundedInteger: (value, fallback, options) => {
      const parsed = Number.parseInt(String(value ?? ''), 10);
      if (!Number.isFinite(parsed)) return fallback;
      const min = options?.min ?? Number.MIN_SAFE_INTEGER;
      const max = options?.max ?? Number.MAX_SAFE_INTEGER;
      return Math.max(min, Math.min(max, parsed));
    },
    defaultMessagePageSize: 50,
    maxMessagePageSize: 200,
    readPendingApprovalsForConversation: () => [],
    parseUploadedFileContexts: () => [],
    buildUploadedFilesDisplayContent: (rawText) => rawText,
    toAgentUploadedFiles: () => [],
    persistWebCommandInboundMessage: vi.fn(),
    executeSlashCommand: vi.fn(async () => ({
      handled: false,
      success: false,
      output: '',
    })),
    persistWebCommandAssistantMessage: vi.fn(),
    formatSlashCommandResultOutput: (result) => result.output,
    handleWebInput: vi.fn(),
    parseUploadRequestFiles: () => [],
    resolveStoredUploadFile: (relativePath) => ({
      relativePath,
      absolutePath: path.join('/tmp', relativePath),
      mimeType: 'application/octet-stream',
    }),
    resolveUploadRelativeRoot: (chatJid, userId) =>
      userId ? `${userId}/${chatJid}` : chatJid,
    chatUploadsRoot: '/tmp',
    maxUploadBytesPerFile: 1024,
    sanitizeUploadFileName: (input) => input,
    buildTextExcerpt: () => ({}),
    selectDirectoryNative: async () => null,
  });
  return app;
}

describe('conversation message routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('hides internal memory tool calls from conversation history responses', async () => {
    await storeChatMetadata(
      'web:test',
      '2026-03-19T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );

    await storeAssistantTurnSnapshot('web:test', {
      id: 'turn-hidden',
      clientKey: 'turn-hidden',
      timestamp: '2026-03-19T10:00:01.000Z',
      isLive: false,
      isCompleted: true,
      items: [
        {
          id: 'tool-memory-only',
          type: 'tool_call',
          status: 'completed',
          title: 'memory_get',
          argumentsText: '{"path":"group:memory/2026-03-19.md"}',
          resultText: 'content',
          timestamp: '2026-03-19T10:00:01.000Z',
        },
      ],
    });

    await storeMessageDirectWithTurn(
      {
        id: 'bot-1',
        chat_jid: 'web:test',
        sender: 'NanoClaw',
        sender_name: 'NanoClaw',
        content: '已整理结果。',
        timestamp: '2026-03-19T10:00:05.000Z',
        is_from_me: true,
        is_bot_message: true,
      },
      {
        id: 'turn-visible',
        clientKey: 'turn-visible',
        timestamp: '2026-03-19T10:00:05.000Z',
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-1',
        items: [
          {
            id: 'tool-memory',
            type: 'tool_call',
            status: 'completed',
            title: 'memory_search',
            argumentsText: '{"query":"deadline"}',
            resultText: '[]',
            timestamp: '2026-03-19T10:00:02.000Z',
          },
          {
            id: 'tool-visible',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"README.md"}',
            resultText: 'ok',
            timestamp: '2026-03-19T10:00:03.000Z',
          },
          {
            id: 'msg-1',
            type: 'assistant_message',
            status: 'completed',
            text: '已整理结果。',
            timestamp: '2026-03-19T10:00:05.000Z',
          },
        ],
      },
    );

    const response = await inject(createApp(), {
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent('web:test')}/messages`,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.turns).toEqual([
      {
        id: 'turn-visible',
        clientKey: 'turn-visible',
        timestamp: '2026-03-19T10:00:05.000Z',
        isLive: false,
        isCompleted: true,
        persistedMessageId: 'bot-1',
        items: [
          {
            id: 'tool-visible',
            type: 'tool_call',
            status: 'completed',
            title: 'read_file',
            argumentsText: '{"path":"README.md"}',
            resultText: 'ok',
            timestamp: '2026-03-19T10:00:03.000Z',
          },
          {
            id: 'msg-1',
            type: 'assistant_message',
            status: 'completed',
            text: '已整理结果。',
            timestamp: '2026-03-19T10:00:05.000Z',
          },
        ],
      },
    ]);
  });

  it('passes uploaded files through to handleWebInput for web chat sends', async () => {
    const handleWebInput = vi.fn(async () => ({
      messageId: 'msg-1',
      serverTimestamp: '2026-03-28T10:00:00.000Z',
      runId: 'run-1',
      clientId: 'client-1',
      lastEventSeq: 7,
    }));
    const app = express();
    app.use(express.json());
    registerConversationMessageRoutes(app, {
      requirePermission: allowAllRequirePermission,
      decorateConversationSummary: (conversation) => conversation,
      parseBoundedInteger: (value, fallback, options) => {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed)) return fallback;
        const min = options?.min ?? Number.MIN_SAFE_INTEGER;
        const max = options?.max ?? Number.MAX_SAFE_INTEGER;
        return Math.max(min, Math.min(max, parsed));
      },
      defaultMessagePageSize: 50,
      maxMessagePageSize: 200,
      readPendingApprovalsForConversation: () => [],
      parseUploadedFileContexts: () => [
        {
          name: 'spec.txt',
          mimeType: 'text/plain',
          size: 123,
          relativePath: 'web_test/spec.txt',
          absolutePath: '/tmp/spec.txt',
          mountPath: '/workspace/uploads/web_test/spec.txt',
        },
      ],
      buildUploadedFilesDisplayContent: (rawText, files) =>
        [rawText, `[上传文件] ${files.map((file) => file.name).join('、')}`]
          .filter(Boolean)
          .join('\n\n'),
      toAgentUploadedFiles: (files) =>
        files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          relativePath: file.relativePath,
        })),
      persistWebCommandInboundMessage: vi.fn(),
      executeSlashCommand: vi.fn(async () => ({
        handled: false,
        success: false,
        output: '',
      })),
      persistWebCommandAssistantMessage: vi.fn(),
      formatSlashCommandResultOutput: (result) => result.output,
      handleWebInput,
      parseUploadRequestFiles: () => [],
      resolveStoredUploadFile: (relativePath) => ({
        relativePath,
        absolutePath: path.join('/tmp', relativePath),
        mimeType: 'application/octet-stream',
      }),
      resolveUploadRelativeRoot: (chatJid, userId) =>
        userId ? `${userId}/${chatJid}` : chatJid,
      chatUploadsRoot: '/tmp',
      maxUploadBytesPerFile: 1024,
      sanitizeUploadFileName: (input) => input,
      buildTextExcerpt: () => ({}),
      selectDirectoryNative: async () => null,
    });

    const response = await inject(app, {
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent('web:test')}/messages`,
      headers: { 'Content-Type': 'application/json' },
      payload: {
        content: '请看附件',
        uploadedFiles: [{ relativePath: 'web_test/spec.txt' }],
        clientId: 'client-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(handleWebInput).toHaveBeenCalledWith(
      'web:test',
      '请看附件\n\n[上传文件] spec.txt',
      'Web User',
      {
        uploadedFiles: [
          {
            name: 'spec.txt',
            mimeType: 'text/plain',
            size: 123,
            relativePath: 'web_test/spec.txt',
          },
        ],
        clientId: 'client-1',
      },
    );
  });

  it('returns uploaded files in conversation history responses', async () => {
    await storeChatMetadata(
      'web:test-uploads',
      '2026-05-06T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );
    await storeMessage({
      id: 'msg-upload-1',
      chat_jid: 'web:test-uploads',
      sender: 'web_user',
      sender_name: 'Web User',
      content: '[上传文件] cat.png',
      timestamp: '2026-05-06T10:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
      uploaded_files: [
        {
          name: 'cat.png',
          mimeType: 'image/png',
          size: 123,
          relativePath: 'chat_uploads/cat.png',
        },
      ],
    });

    const response = await inject(createApp(), {
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent('web:test-uploads')}/messages`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().messages).toEqual([
      expect.objectContaining({
        id: 'msg-upload-1',
        uploaded_files: [
          expect.objectContaining({
            name: 'cat.png',
            relativePath: 'chat_uploads/cat.png',
          }),
        ],
      }),
    ]);
  });

  it('serves uploaded image previews from the conversation uploads root', async () => {
    const uploadsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-conversation-uploads-'),
    );
    const uploadedFileSupport = createUploadedFileSupport({
      chatUploadsRoot: uploadsRoot,
      maxUploadFilesPerRequest: 5,
      maxUploadTextExcerptBytes: 1024,
      maxUploadTextExcerptChars: 1024,
    });
    const chatJid = 'web:test-upload-preview';
    await storeChatMetadata(
      chatJid,
      '2026-05-06T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );
    const relativeRoot = uploadedFileSupport.resolveUploadRelativeRoot(
      chatJid,
      'user-123',
    );
    const relativePath = path.posix.join(relativeRoot, 'cat.png');
    const absolutePath = path.join(uploadsRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, Buffer.from('fake-png'));

    const app = express();
    app.use(express.json());
    registerConversationMessageRoutes(app, {
      requirePermission: allowAllRequirePermission,
      decorateConversationSummary: (conversation) => conversation,
      parseBoundedInteger: (value, fallback, options) => {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed)) return fallback;
        const min = options?.min ?? Number.MIN_SAFE_INTEGER;
        const max = options?.max ?? Number.MAX_SAFE_INTEGER;
        return Math.max(min, Math.min(max, parsed));
      },
      defaultMessagePageSize: 50,
      maxMessagePageSize: 200,
      readPendingApprovalsForConversation: () => [],
      parseUploadedFileContexts: uploadedFileSupport.parseUploadedFileContexts,
      buildUploadedFilesDisplayContent:
        uploadedFileSupport.buildUploadedFilesDisplayContent,
      toAgentUploadedFiles: uploadedFileSupport.toAgentUploadedFiles,
      persistWebCommandInboundMessage: vi.fn(),
      executeSlashCommand: vi.fn(async () => ({
        handled: false,
        success: false,
        output: '',
      })),
      persistWebCommandAssistantMessage: vi.fn(),
      formatSlashCommandResultOutput: (result) => result.output,
      handleWebInput: vi.fn(),
      parseUploadRequestFiles: uploadedFileSupport.parseUploadRequestFiles,
      resolveStoredUploadFile: uploadedFileSupport.resolveStoredUploadFile,
      resolveUploadRelativeRoot: uploadedFileSupport.resolveUploadRelativeRoot,
      chatUploadsRoot: uploadsRoot,
      maxUploadBytesPerFile: 1024,
      sanitizeUploadFileName: uploadedFileSupport.sanitizeUploadFileName,
      buildTextExcerpt: uploadedFileSupport.buildTextExcerpt,
      selectDirectoryNative: async () => null,
    });

    const response = await inject(app, {
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent(chatJid)}/uploaded-file?path=${encodeURIComponent(relativePath)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload).toEqual(Buffer.from('fake-png'));
  });

  it('removes files already written when a multi-file upload later fails', async () => {
    const uploadsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-conversation-upload-rollback-'),
    );
    const uploadedFileSupport = createUploadedFileSupport({
      chatUploadsRoot: uploadsRoot,
      maxUploadFilesPerRequest: 5,
      maxUploadTextExcerptBytes: 1024,
      maxUploadTextExcerptChars: 1024,
    });
    const chatJid = 'web:test-upload-rollback';
    await storeChatMetadata(
      chatJid,
      '2026-05-06T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );
    await setRegisteredGroup(chatJid, {
      name: 'Upload Rollback',
      folder: 'test-upload-rollback',
      trigger: '@Andy',
      added_at: '2026-05-06T10:00:00.000Z',
    });

    const app = express();
    app.use(express.json());
    registerConversationMessageRoutes(app, {
      requirePermission: allowAllRequirePermission,
      decorateConversationSummary: (conversation) => conversation,
      parseBoundedInteger: (value, fallback, options) => {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed)) return fallback;
        const min = options?.min ?? Number.MIN_SAFE_INTEGER;
        const max = options?.max ?? Number.MAX_SAFE_INTEGER;
        return Math.max(min, Math.min(max, parsed));
      },
      defaultMessagePageSize: 50,
      maxMessagePageSize: 200,
      readPendingApprovalsForConversation: () => [],
      parseUploadedFileContexts: uploadedFileSupport.parseUploadedFileContexts,
      buildUploadedFilesDisplayContent:
        uploadedFileSupport.buildUploadedFilesDisplayContent,
      toAgentUploadedFiles: uploadedFileSupport.toAgentUploadedFiles,
      persistWebCommandInboundMessage: vi.fn(),
      executeSlashCommand: vi.fn(async () => ({
        handled: false,
        success: false,
        output: '',
      })),
      persistWebCommandAssistantMessage: vi.fn(),
      formatSlashCommandResultOutput: (result) => result.output,
      handleWebInput: vi.fn(),
      parseUploadRequestFiles: uploadedFileSupport.parseUploadRequestFiles,
      resolveStoredUploadFile: uploadedFileSupport.resolveStoredUploadFile,
      resolveUploadRelativeRoot: uploadedFileSupport.resolveUploadRelativeRoot,
      chatUploadsRoot: uploadsRoot,
      maxUploadBytesPerFile: 4,
      sanitizeUploadFileName: uploadedFileSupport.sanitizeUploadFileName,
      buildTextExcerpt: uploadedFileSupport.buildTextExcerpt,
      selectDirectoryNative: async () => null,
    });

    const response = await inject(app, {
      method: 'POST',
      url: '/api/files/upload',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        chatJid,
        files: [
          {
            name: 'small.txt',
            mimeType: 'text/plain',
            contentBase64: Buffer.from('ok').toString('base64'),
          },
          {
            name: 'large.txt',
            mimeType: 'text/plain',
            contentBase64: Buffer.from('too-large').toString('base64'),
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const writtenFiles = fs.readdirSync(uploadsRoot, {
      recursive: true,
    });
    expect(writtenFiles.filter((entry) => String(entry).endsWith('.txt'))).toEqual(
      [],
    );
  });

  it('serves generated image previews from the conversation workspace', async () => {
    await storeChatMetadata(
      'web:test-image',
      '2026-04-25T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );
    await setRegisteredGroup('web:test-image', {
      name: 'Image Chat',
      folder: 'test-image-chat',
      trigger: '@Andy',
      added_at: '2026-04-25T10:00:00.000Z',
    });
    const workspaceDir = path.join(GROUPS_DIR, 'test-image-chat', '.nanoclaw', 'generated-images');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, 'cat.png');
    fs.writeFileSync(filePath, Buffer.from('fake-png'));

    const response = await inject(createApp(), {
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent('web:test-image')}/generated-file?path=${encodeURIComponent('/workspace/group/.nanoclaw/generated-images/cat.png')}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload).toEqual(Buffer.from('fake-png'));
  });

  it('rejects generated image paths that escape the conversation workspace', async () => {
    await storeChatMetadata(
      'web:test-image-escape',
      '2026-04-25T10:00:00.000Z',
      'Web User',
      'web',
      false,
    );
    await setRegisteredGroup('web:test-image-escape', {
      name: 'Image Chat',
      folder: 'test-image-chat-escape',
      trigger: '@Andy',
      added_at: '2026-04-25T10:00:00.000Z',
    });

    const response = await inject(createApp(), {
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent('web:test-image-escape')}/generated-file?path=${encodeURIComponent('/workspace/group/../../secret.png')}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'workspacePath escapes the conversation workspace',
    });
  });
});
