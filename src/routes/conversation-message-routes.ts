import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import type { Express } from 'express';
import { getActiveEngine } from '../database/engine.js';

import {
  getConversationList,
  getConversationMessages,
  getConversationTurns,
  getMessageCount,
  getRegisteredGroup,
} from '../db.js';
import {
  assertConversationOwnership,
  ConversationOwnershipError,
} from '../conversation/conversation-ownership.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { sanitizePersistedTurnsForWeb } from '../conversation/conversation-turn-visibility.js';
import { logger } from '../logger.js';
import { getConversationLastEventSeq } from '../runtime/realtime-events.js';
import { getWebChannel } from '../channels/web.js';
import { GROUPS_DIR } from '../config.js';
import { resolveUserGroupsDir } from '../tenant/tenant-paths.js';
import type { AgentUploadedFile } from '../types.js';
import { t } from '../i18n/index.js';

function routePathParam(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

const GENERATED_IMAGE_WORKSPACE_PREFIX = '/workspace/group/';
const GENERATED_IMAGE_EXTENSIONS = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

async function resolveConversationOwnerUserId(jid: string): Promise<string> {
  const row = await getActiveEngine().queryOne<{ user_id?: string }>(
    'SELECT user_id FROM chats WHERE jid = ? AND deleted_at IS NULL LIMIT 1',
    [jid],
  );
  return String(row?.user_id || SYSTEM_USER_ID).trim() || SYSTEM_USER_ID;
}

function getGeneratedImageMimeType(filePath: string): string | null {
  return GENERATED_IMAGE_EXTENSIONS.get(path.extname(filePath).toLowerCase()) || null;
}

function resolveConversationGeneratedFilePath(input: {
  groupFolder: string;
  ownerUserId: string;
  workspacePath: string;
}): { absolutePath: string; mimeType: string } {
  const workspacePath = String(input.workspacePath || '').trim();
  if (!workspacePath.startsWith(GENERATED_IMAGE_WORKSPACE_PREFIX)) {
    throw new Error('workspacePath must point to /workspace/group/');
  }
  const relativePath = workspacePath.slice(GENERATED_IMAGE_WORKSPACE_PREFIX.length);
  if (!relativePath) {
    throw new Error('workspacePath is invalid');
  }
  const groupsRoot =
    !input.ownerUserId || input.ownerUserId === SYSTEM_USER_ID
      ? GROUPS_DIR
      : resolveUserGroupsDir(input.ownerUserId);
  const conversationRoot = path.resolve(groupsRoot, input.groupFolder);
  const absolutePath = path.resolve(conversationRoot, relativePath);
  if (
    absolutePath !== conversationRoot &&
    !absolutePath.startsWith(`${conversationRoot}${path.sep}`)
  ) {
    throw new Error('workspacePath escapes the conversation workspace');
  }
  const mimeType = getGeneratedImageMimeType(absolutePath);
  if (!mimeType) {
    throw new Error('Only image previews are supported');
  }
  return { absolutePath, mimeType };
}

interface UploadedFileRequest {
  name: string;
  mimeType: string;
  contentBase64: string;
}

interface UploadedFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  textExcerpt?: string;
  textTruncated?: boolean;
}

interface UploadedFileContext {
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
  absolutePath: string;
  mountPath: string;
  textExcerpt?: string;
  textTruncated?: boolean;
}

interface SlashCommandResult {
  handled: boolean;
  success: boolean;
  output: string;
}

export interface ConversationMessageRouteOptions {
  decorateConversationSummary: (
    conversation: any,
  ) => any | Promise<any>;
  parseBoundedInteger: (
    value: unknown,
    fallback: number,
    options?: { min?: number; max?: number },
  ) => number;
  defaultMessagePageSize: number;
  maxMessagePageSize: number;
  readPendingApprovalsForConversation: (
    jid: string,
  ) => unknown[] | Promise<unknown[]>;
  parseUploadedFileContexts: (
    uploadedFiles: unknown,
    chatJid: string,
    userId?: string,
  ) => UploadedFileContext[];
  buildUploadedFilesDisplayContent: (
    rawText: string,
    files: UploadedFileContext[],
  ) => string;
  toAgentUploadedFiles: (files: UploadedFileContext[]) => AgentUploadedFile[];
  persistWebCommandInboundMessage: (
    jid: string,
    senderName: string,
    content: string,
  ) => void | Promise<void | { id: string; timestamp: string }>;
  executeSlashCommand: (input: {
    jid: string;
    rawText: string;
    refreshTaskSnapshots?: () => void;
  }) => Promise<SlashCommandResult>;
  persistWebCommandAssistantMessage: (
    jid: string,
    content: string,
  ) => void | Promise<void | { id: string; timestamp: string }>;
  formatSlashCommandResultOutput: (
    result: SlashCommandResult,
    options?: { uploadsIgnored?: boolean },
  ) => string;
  refreshTaskSnapshots?: () => void;
  handleWebInput?: (
    jid: string,
    content: string,
    senderName?: string,
    extras?: { uploadedFiles?: AgentUploadedFile[]; clientId?: string },
  ) =>
    | {
        messageId: string;
        serverTimestamp: string;
        runId: string;
        clientId?: string;
        lastEventSeq?: number;
      }
    | Promise<{
        messageId: string;
        serverTimestamp: string;
        runId: string;
        clientId?: string;
        lastEventSeq?: number;
      }>;
  parseUploadRequestFiles: (value: unknown) => UploadedFileRequest[];
  resolveStoredUploadFile: (
    relativePathRaw: string,
    chatJid: string,
    options?: {
      userId?: string;
      allowAnyConversationUser?: boolean;
    },
  ) => {
    relativePath: string;
    absolutePath: string;
    mimeType: string;
  };
  resolveUploadRelativeRoot: (chatJid: string, userId?: string) => string;
  chatUploadsRoot: string;
  maxUploadBytesPerFile: number;
  sanitizeUploadFileName: (input: string) => string;
  buildTextExcerpt: (
    bytes: Buffer,
    fileName: string,
    mimeType: string,
  ) => Pick<UploadedFileMetadata, 'textExcerpt' | 'textTruncated'>;
  selectDirectoryNative: () => Promise<string | null>;
  getAuthenticatedUsername?: (cookie?: string) => string | null | undefined;
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
}

export function registerConversationMessageRoutes(
  app: Express,
  opts: ConversationMessageRouteOptions,
): void {
  const viewGuard = opts.requirePermission('conversation.view');
  const sendGuard = opts.requirePermission('conversation.send');

  app.get('/api/conversations', viewGuard, async (req, res) => {
    try {
      const tenantUid = getTenantUserId(req);
      const rawList = await getConversationList(tenantUid);
      const list = await Promise.all(
        rawList.map((c) => opts.decorateConversationSummary(c)),
      );
      res.json(list);
    } catch (err) {
      logger.error({ err }, 'Failed to list conversations');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/conversations/:jid/messages', viewGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      const limit = opts.parseBoundedInteger(
        req.query.limit,
        opts.defaultMessagePageSize,
        { min: 1, max: opts.maxMessagePageSize },
      );
      const msgTenantUid = getTenantUserId(req);
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const hasExplicitOffset = req.query.offset !== undefined;

      let messages: Awaited<ReturnType<typeof getConversationMessages>>;
      let turns: Awaited<ReturnType<typeof sanitizePersistedTurnsForWeb>>;

      if (hasExplicitOffset) {
        const offset = opts.parseBoundedInteger(req.query.offset, 0, { min: 0 });
        messages = await getConversationMessages(jid, limit, offset, msgTenantUid);
        turns = sanitizePersistedTurnsForWeb(
          await getConversationTurns(jid, limit, offset),
        );
      } else {
        const cursor = before ? { before } : {};
        const rawMessages = await getConversationMessages(jid, limit, 0, msgTenantUid, cursor);
        rawMessages.reverse();
        messages = rawMessages;
        const rawTurns = await getConversationTurns(jid, limit, 0, cursor);
        rawTurns.reverse();
        turns = sanitizePersistedTurnsForWeb(rawTurns);
      }

      const total = await getMessageCount(jid);
      const approvals = await Promise.resolve(
        opts.readPendingApprovalsForConversation(jid),
      );
      res.json({
        messages,
        turns,
        approvals,
        total,
        last_event_seq: getConversationLastEventSeq(jid),
      });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to get messages');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/conversations/:jid/generated-file', viewGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      const group = await getRegisteredGroup(jid);
      if (!group?.folder) {
        res.status(404).json({ error: 'Conversation workspace not found' });
        return;
      }
      const workspacePath =
        typeof req.query.path === 'string' ? req.query.path : '';
      if (!workspacePath.trim()) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const ownerUserId = await resolveConversationOwnerUserId(jid);
      const { absolutePath, mimeType } = resolveConversationGeneratedFilePath({
        groupFolder: group.folder,
        ownerUserId,
        workspacePath,
      });
      let stat;
      try {
        stat = await fsp.stat(absolutePath);
      } catch {
        res.status(404).json({ error: 'Generated file not found' });
        return;
      }
      if (!stat.isFile()) {
        res.status(404).json({ error: 'Generated file not found' });
        return;
      }
      const bytes = await fsp.readFile(absolutePath);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.send(bytes);
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal error';
      if (
        /workspacePath|image previews|escapes the conversation workspace/i.test(
          message,
        )
      ) {
        res.status(400).json({ error: message });
        return;
      }
      logger.error({ err }, 'Failed to read generated conversation file');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/api/conversations/:jid/uploaded-file', viewGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      const relativePath =
        typeof req.query.path === 'string' ? req.query.path : '';
      if (!relativePath.trim()) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const resolved = opts.resolveStoredUploadFile(relativePath, jid, {
        allowAnyConversationUser: true,
      });
      let stat;
      try {
        stat = await fsp.stat(resolved.absolutePath);
      } catch {
        res.status(404).json({ error: 'Uploaded file not found' });
        return;
      }
      if (!stat.isFile()) {
        res.status(404).json({ error: 'Uploaded file not found' });
        return;
      }
      const bytes = await fsp.readFile(resolved.absolutePath);
      const isImage = resolved.mimeType.startsWith('image/');
      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader(
        'Content-Disposition',
        `${isImage ? 'inline' : 'attachment'}; filename="${path.basename(resolved.relativePath)}"`,
      );
      res.send(bytes);
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Internal error';
      if (/uploadedFiles|different conversation|path is required/i.test(message)) {
        res.status(400).json({ error: message });
        return;
      }
      logger.error({ err }, 'Failed to read uploaded conversation file');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/conversations/:jid/messages', sendGuard, async (req, res) => {
    try {
      const jid = decodeURIComponent(routePathParam(req.params.jid));
      await assertConversationOwnership(jid, getTenantUserId(req));
      const body = (req.body || {}) as {
        content?: unknown;
        senderName?: unknown;
        uploadedFiles?: unknown;
        clientId?: unknown;
      };
      const rawContent =
        typeof body.content === 'string'
          ? body.content
          : String(body.content || '');
      const authUsername = opts.getAuthenticatedUsername?.(req.headers.cookie ?? undefined);
      const senderName = authUsername
        || (typeof body.senderName === 'string' && body.senderName.trim()
          ? body.senderName.trim()
          : 'Web User');
      const clientId =
        typeof body.clientId === 'string' && body.clientId.trim()
          ? body.clientId.trim()
          : undefined;
      const uploadedFiles = opts.parseUploadedFileContexts(
        body.uploadedFiles,
        jid,
        getTenantUserId(req),
      );
      if (!rawContent.trim() && uploadedFiles.length === 0) {
        res.status(400).json({ error: 'content or uploadedFiles is required' });
        return;
      }

      const trimmedContent = rawContent.trim();
      if (trimmedContent.startsWith('/')) {
        const inboundCommandContent =
          uploadedFiles.length > 0
            ? t(
              'errors.commandWithUploads',
              {
                command: trimmedContent,
                files: uploadedFiles.map((file) => file.name).join(
                  t('errors.listDelimiter', {}, req.locale),
                ),
              },
              req.locale,
            )
            : trimmedContent;
        await Promise.resolve(
          opts.persistWebCommandInboundMessage(
            jid,
            senderName,
            inboundCommandContent,
          ),
        );
        const commandResult = await opts.executeSlashCommand({
          jid,
          rawText: trimmedContent,
          refreshTaskSnapshots: opts.refreshTaskSnapshots,
        });
        if (commandResult.handled) {
          await Promise.resolve(
            opts.persistWebCommandAssistantMessage(
              jid,
              opts.formatSlashCommandResultOutput(commandResult, {
                uploadsIgnored: uploadedFiles.length > 0,
              }),
            ),
          );
          res.json({
            ok: true,
            command: true,
            success: commandResult.success,
            clientId,
            serverTimestamp: new Date().toISOString(),
            last_event_seq: getConversationLastEventSeq(jid),
          });
          return;
        }
      }

      const displayContent = opts.buildUploadedFilesDisplayContent(
        rawContent.trim(),
        uploadedFiles,
      );
      const agentUploadedFiles = opts.toAgentUploadedFiles(uploadedFiles);
      const fallbackAcceptedAt = new Date().toISOString();
      let accepted:
        | {
            messageId: string;
            serverTimestamp: string;
            runId: string;
            clientId?: string;
            lastEventSeq?: number;
          }
        | undefined;
      if (!opts.handleWebInput) {
        const webChannel = getWebChannel();
        if (!webChannel) {
          res.status(503).json({ error: 'Web channel not available' });
          return;
        }
        accepted = await webChannel.handleInboundMessage(
          jid,
          displayContent,
          senderName,
          {
            uploadedFiles:
              agentUploadedFiles.length > 0 ? agentUploadedFiles : undefined,
            clientId,
          },
        );
      } else {
        accepted = await Promise.resolve(
          opts.handleWebInput(jid, displayContent, senderName, {
            uploadedFiles:
              agentUploadedFiles.length > 0 ? agentUploadedFiles : undefined,
            clientId,
          }),
        );
      }
      res.json({
        ok: true,
        accepted: true,
        clientId: accepted?.clientId || clientId,
        runId: accepted?.runId,
        serverTimestamp: accepted?.serverTimestamp || fallbackAcceptedAt,
        last_event_seq:
          accepted?.lastEventSeq ?? getConversationLastEventSeq(jid),
      });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to send message');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/api/files/upload', sendGuard, async (req, res) => {
    try {
      const body = (req.body || {}) as {
        chatJid?: unknown;
        files?: unknown;
      };
      const chatJid =
        typeof body.chatJid === 'string'
          ? decodeURIComponent(body.chatJid).trim()
          : '';
      if (!chatJid) {
        res.status(400).json({ error: 'chatJid is required' });
        return;
      }
      await assertConversationOwnership(chatJid, getTenantUserId(req));
      const files = opts.parseUploadRequestFiles(body.files);
      if (!await getRegisteredGroup(chatJid)) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const userId = getTenantUserId(req);
      const uploadRelativeRoot = opts.resolveUploadRelativeRoot(chatJid, userId);
      const chatUploadDir = path.join(
        opts.chatUploadsRoot,
        ...uploadRelativeRoot.split('/'),
      );
      await fsp.mkdir(chatUploadDir, { recursive: true });

      const uploaded: UploadedFileMetadata[] = [];
      for (const file of files) {
        const bytes = Buffer.from(file.contentBase64, 'base64');
        if (!bytes.length) {
          throw new Error(
            t(
              'errors.uploadFileEmptyOrInvalid',
              { filename: file.name },
              req.locale,
            ),
          );
        }
        if (bytes.length > opts.maxUploadBytesPerFile) {
          throw new Error(
            t(
              'errors.uploadFileTooLarge',
              {
                filename: file.name,
                maxSizeMb: Math.round(
                  opts.maxUploadBytesPerFile / 1024 / 1024,
                ),
              },
              req.locale,
            ),
          );
        }

        const safeName = opts.sanitizeUploadFileName(file.name);
        const id = crypto.randomUUID();
        const persistedName = `${Date.now().toString(36)}_${id.slice(0, 8)}_${safeName}`;
        const absolutePath = path.join(chatUploadDir, persistedName);
        await fsp.writeFile(absolutePath, bytes);

        const relativePath = path.posix.join(
          uploadRelativeRoot,
          persistedName,
        );
        uploaded.push({
          id,
          name: safeName,
          mimeType: file.mimeType,
          size: bytes.length,
          relativePath,
          absolutePath,
          ...opts.buildTextExcerpt(bytes, safeName, file.mimeType),
        });
      }

      res.json({ files: uploaded });
    } catch (err) {
      if (err instanceof ConversationOwnershipError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err }, 'Failed to upload files');
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  app.post('/api/native/select-directory', sendGuard, async (_req, res) => {
    try {
      const selectedPath = await opts.selectDirectoryNative();
      res.json({
        path: selectedPath,
        cancelled: !selectedPath,
      });
    } catch (err) {
      const isNoNativePickerError = (err as any)?.code === 'NO_NATIVE_PICKER';
      if (isNoNativePickerError) {
        logger.info('Native directory picker not available (server environment)');
        res.status(501).json({
          error: 'Native directory picker not available in this environment',
          notAvailable: true,
        });
      } else {
        logger.error({ err }, 'Failed to open native directory picker');
        res.status(500).json({ error: 'Internal error' });
      }
    }
  });
}
