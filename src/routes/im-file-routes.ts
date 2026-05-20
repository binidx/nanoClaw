import crypto from 'crypto';
import type { Express } from 'express';
import multer from 'multer';

import { dba } from '../db/engine-access.js';
import type { FileStorageAdapter } from '../im/im-file-storage.js';
import { isActiveMember } from '../im/im-membership-service.js';
import { fetchLinkPreview } from '../im/im-link-preview.js';
import { isRoomEncrypted } from '../im/im-social-service.js';
import { getTenantUserId } from '../tenant/tenant-request.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'application/pdf',
  'application/zip',
  'application/x-zip',
  'application/msword',
  'application/vnd.openxmlformats',
  'application/vnd.ms-',
  'application/octet-stream',
  'text/plain',
  'text/csv',
];

function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.\./g, '_')
    .slice(0, 200);
}

export interface ImFileRouteOptions {
  storage: FileStorageAdapter;
  fileTtlMs: number;
  requirePermission?: import('../auth/auth-middleware.js').RequirePermissionFn;
}

export function registerImFileRoutes(
  app: Express,
  opts: ImFileRouteOptions,
): void {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  });

  const guard = opts.requirePermission
    ? opts.requirePermission('im.send', 'conversation.send')
    : (
        _req: import('express').Request,
        _res: import('express').Response,
        next: import('express').NextFunction,
      ) => next();

  app.post(
    '/api/im/files/upload',
    guard,
    upload.single('file'),
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const chatJid =
          typeof req.body?.chatJid === 'string' ? req.body.chatJid : '';
        if (!chatJid) {
          res.status(400).json({ ok: false, error: 'chatJid is required' });
          return;
        }

        if (!(await isActiveMember(chatJid, userId))) {
          res
            .status(403)
            .json({ ok: false, error: 'Not a member of this conversation' });
          return;
        }

        const file = req.file;
        if (!file) {
          res.status(400).json({ ok: false, error: 'No file provided' });
          return;
        }

        if (!isAllowedMime(file.mimetype)) {
          res.status(400).json({
            ok: false,
            error: `Unsupported file type: ${file.mimetype}`,
          });
          return;
        }

        const id = crypto.randomUUID();
        const safeName = sanitizeFileName(file.originalname || 'file');
        const ts = Date.now().toString(36);
        const storageKey = `im/${chatJid}/${ts}_${id.slice(0, 8)}_${safeName}`;
        const now = new Date().toISOString();
        const expiresAt =
          opts.fileTtlMs > 0
            ? new Date(Date.now() + opts.fileTtlMs).toISOString()
            : null;

        await opts.storage.save(storageKey, file.buffer, file.mimetype);

        await dba
          .prepare(
            `INSERT INTO im_attachments (id, chat_jid, message_id, file_name, mime_type, size, storage_key, uploaded_by, expires_at, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            chatJid,
            safeName,
            file.mimetype,
            file.size,
            storageKey,
            userId,
            expiresAt,
            now,
          );

        res.json({
          ok: true,
          attachment: {
            id,
            fileName: safeName,
            mimeType: file.mimetype,
            size: file.size,
            url: `/api/im/files/${id}`,
          },
        });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  const viewGuard = opts.requirePermission
    ? opts.requirePermission('im.view', 'conversation.view')
    : (
        _req: import('express').Request,
        _res: import('express').Response,
        next: import('express').NextFunction,
      ) => next();

  app.get('/api/im/files/:fileId', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const raw = req.params.fileId;
      const fileId = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

      const row = (await dba
        .prepare(
          `SELECT id, chat_jid, file_name, mime_type, storage_key, expires_at FROM im_attachments WHERE id = ? LIMIT 1`,
        )
        .get(fileId)) as
        | {
            id: string;
            chat_jid: string;
            file_name: string;
            mime_type: string;
            storage_key: string;
            expires_at: string | null;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ ok: false, error: 'File not found' });
        return;
      }

      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        res.status(410).json({ ok: false, error: 'File has expired' });
        return;
      }

      if (!(await isActiveMember(row.chat_jid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }

      const { data } = await opts.storage.read(row.storage_key);
      res.setHeader('Content-Type', row.mime_type);
      res.setHeader('Content-Length', data.length);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(row.file_name)}"`,
      );
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(data);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('not found') || msg.includes('File not found')) {
        res.status(404).json({ ok: false, error: 'File not found on storage' });
        return;
      }
      res.status(500).json({ ok: false, error: msg });
    }
  });

  app.get('/api/im/link-preview', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const chatJid =
        typeof req.query.chatJid === 'string' ? req.query.chatJid : '';
      const url = typeof req.query.url === 'string' ? req.query.url : '';
      if (!chatJid) {
        res
          .status(400)
          .json({ ok: false, error: 'chatJid parameter is required' });
        return;
      }
      if (!url) {
        res.status(400).json({ ok: false, error: 'url parameter is required' });
        return;
      }
      if (!(await isActiveMember(chatJid, userId))) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return;
      }
      if (await isRoomEncrypted(chatJid)) {
        res.status(403).json({
          ok: false,
          error: 'Link previews are disabled for E2EE rooms',
        });
        return;
      }

      const preview = await fetchLinkPreview(url);
      res.json({ ok: true, preview });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });
}
