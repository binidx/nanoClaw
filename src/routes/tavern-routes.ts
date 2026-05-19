import fs from 'fs/promises';
import path from 'path';
import type { Express } from 'express';
import multer from 'multer';

import {
  createTavernPersona,
  deleteTavernPersona,
  getTavernPersonaById,
  getTavernGlobalConfig,
  isProviderVisibleToUser,
  listTavernPersonas,
  setTavernPersonaAvatarPath,
  upsertTavernGlobalConfig,
  updateTavernPersona,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import { getTenantUserId } from '../tenant/tenant-request.js';
import {
  buildTavernPersonaView,
} from '../tavern/tavern-service.js';
import type { ManagedMcpTemplate } from '../assistant/assistant-mcp.js';

interface ManagedSkillCatalogEntry {
  id: string;
  name: string;
  enabled?: boolean;
}

const AVATAR_UPLOAD_LIMIT = 5 * 1024 * 1024;
const TAVERN_AVATAR_ROOT = path.join(DATA_DIR, 'tavern-avatars');

export interface TavernRouteOptions {
  requirePermission: import('../auth/auth-middleware.js').RequirePermissionFn;
  listAvailableManagedSkills: () =>
    | ManagedSkillCatalogEntry[]
    | Promise<ManagedSkillCatalogEntry[]>;
  listAvailableManagedMcpServers: () =>
    | ManagedMcpTemplate[]
    | Promise<ManagedMcpTemplate[]>;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, 64);
}

async function validateTavernGlobalConfigInput(
  input: {
    skillIds: string[];
    mcpServerIds: string[];
    providerId: string | null;
  },
  opts: Pick<
    TavernRouteOptions,
    'listAvailableManagedSkills' | 'listAvailableManagedMcpServers'
  >,
  userId: string,
): Promise<void> {
  const availableSkillIds = new Set(
    (await Promise.resolve(opts.listAvailableManagedSkills()))
      .filter((skill) => skill.enabled !== false)
      .map((skill) => skill.id),
  );
  for (const skillId of input.skillIds) {
    if (!availableSkillIds.has(skillId)) {
      throw new Error(`Unknown skill id: ${skillId}`);
    }
  }

  const availableMcpServerIds = new Set(
    (await Promise.resolve(opts.listAvailableManagedMcpServers()))
      .filter((server) => server.enabled !== false)
      .map((server) => server.id),
  );
  for (const serverId of input.mcpServerIds) {
    if (!availableMcpServerIds.has(serverId)) {
      throw new Error(`Unknown MCP server id: ${serverId}`);
    }
  }

  if (
    input.providerId &&
    !await isProviderVisibleToUser(input.providerId, userId, 'llm')
  ) {
    throw new Error(`Unknown provider id: ${input.providerId}`);
  }
}

function toTavernPersonaResponse(
  persona: Awaited<ReturnType<typeof listTavernPersonas>>[number],
) {
  return {
    ...buildTavernPersonaView(persona),
    conversation_count: Number(persona.conversation_count || 0),
    last_conversation_at: persona.last_conversation_at || null,
  };
}

function extForMime(mimeType: string): string | null {
  switch ((mimeType || '').toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return null;
  }
}

function assertImageUpload(
  file: Express.Multer.File | undefined,
): asserts file is Express.Multer.File {
  if (!file) throw new Error('No avatar file provided');
  if (!file.mimetype.startsWith('image/')) {
    throw new Error(`Unsupported avatar type: ${file.mimetype}`);
  }
  if (!extForMime(file.mimetype)) {
    throw new Error(`Unsupported avatar type: ${file.mimetype}`);
  }
}

function resolveAvatarPath(relativePath: string): string {
  const normalized = relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized) throw new Error('Invalid avatar path');
  const absolutePath = path.resolve(TAVERN_AVATAR_ROOT, normalized);
  const rootPath = path.resolve(TAVERN_AVATAR_ROOT);
  if (
    absolutePath !== rootPath &&
    !absolutePath.startsWith(`${rootPath}${path.sep}`)
  ) {
    throw new Error('Invalid avatar path');
  }
  return absolutePath;
}

export function registerTavernRoutes(
  app: Express,
  opts: TavernRouteOptions,
): void {
  const viewGuard = opts.requirePermission('soul.view');
  const manageGuard = opts.requirePermission('soul.manage');
  const avatarGuard = opts.requirePermission('conversation.view', 'soul.view');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_UPLOAD_LIMIT, files: 1 },
  });

  app.get('/api/tavern/personas', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const personas = await listTavernPersonas(userId);
      res.json({
        ok: true,
        personas: personas.map((persona) => toTavernPersonaResponse(persona)),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.get('/api/tavern/config', viewGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const config = await getTavernGlobalConfig(userId);
      res.json({ ok: true, config });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/tavern/config', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const configInput = {
        skillIds: cleanStringArray(req.body?.skillIds),
        mcpServerIds: cleanStringArray(req.body?.mcpServerIds),
        providerId: cleanString(req.body?.providerId),
        model: cleanString(req.body?.model),
      };
      await validateTavernGlobalConfigInput(configInput, opts, userId);
      const config = await upsertTavernGlobalConfig(userId, configInput);
      res.json({ ok: true, config });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/tavern/personas', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const name = cleanString(req.body?.name);
      if (!name) {
        res.status(400).json({ ok: false, error: 'name is required' });
        return;
      }
      const persona = await createTavernPersona(userId, {
        name,
        summary: cleanString(req.body?.summary),
        personalityPrompt: cleanString(req.body?.personalityPrompt),
        scenario: cleanString(req.body?.scenario),
        firstMessage: cleanString(req.body?.firstMessage),
        alternateGreetingsJson: JSON.stringify(
          cleanStringArray(req.body?.alternateGreetings),
        ),
        exampleDialogues: cleanString(req.body?.exampleDialogues),
        systemPrompt: cleanString(req.body?.systemPrompt),
        creatorNotes: cleanString(req.body?.creatorNotes),
        tagsJson: JSON.stringify(cleanStringArray(req.body?.tags)),
        enabled: req.body?.enabled !== false,
      });
      res.json({ ok: true, persona: buildTavernPersonaView(persona) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.put('/api/tavern/personas/:id', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const id = String(req.params.id || '').trim();
      const name = cleanString(req.body?.name);
      if (!id || !name) {
        res.status(400).json({ ok: false, error: 'id and name are required' });
        return;
      }
      const persona = await updateTavernPersona(id, userId, {
        name,
        summary: cleanString(req.body?.summary),
        personalityPrompt: cleanString(req.body?.personalityPrompt),
        scenario: cleanString(req.body?.scenario),
        firstMessage: cleanString(req.body?.firstMessage),
        alternateGreetingsJson: JSON.stringify(
          cleanStringArray(req.body?.alternateGreetings),
        ),
        exampleDialogues: cleanString(req.body?.exampleDialogues),
        systemPrompt: cleanString(req.body?.systemPrompt),
        creatorNotes: cleanString(req.body?.creatorNotes),
        tagsJson: JSON.stringify(cleanStringArray(req.body?.tags)),
        enabled: req.body?.enabled !== false,
      });
      if (!persona) {
        res.status(404).json({ ok: false, error: 'Persona not found' });
        return;
      }
      res.json({ ok: true, persona: buildTavernPersonaView(persona) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.delete('/api/tavern/personas/:id', manageGuard, async (req, res) => {
    try {
      const userId = getTenantUserId(req);
      const id = String(req.params.id || '').trim();
      if (!id) {
        res.status(400).json({ ok: false, error: 'id is required' });
        return;
      }
      const deleted = await deleteTavernPersona(id, userId);
      if (!deleted) {
        res.status(404).json({ ok: false, error: 'Persona not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post(
    '/api/tavern/personas/:id/avatar',
    manageGuard,
    upload.single('file'),
    async (req, res) => {
      try {
        const userId = getTenantUserId(req);
        const id = String(req.params.id || '').trim();
        const persona = await getTavernPersonaById(id, userId);
        if (!persona) {
          res.status(404).json({ ok: false, error: 'Persona not found' });
          return;
        }
        assertImageUpload(req.file);
        const ext = extForMime(req.file.mimetype);
        if (!ext) {
          res.status(400).json({ ok: false, error: 'Unsupported avatar type' });
          return;
        }
        const relativePath = path.posix.join(userId, `${id}${ext}`);
        const absolutePath = resolveAvatarPath(relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, req.file.buffer);
        const updated = await setTavernPersonaAvatarPath(id, userId, relativePath);
        res.json({
          ok: true,
          persona: updated ? buildTavernPersonaView(updated) : null,
        });
      } catch (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ ok: false, error: 'Avatar file too large' });
          return;
        }
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  app.get('/api/tavern/avatar-file', avatarGuard, async (req, res) => {
    try {
      const rawPath =
        typeof req.query.path === 'string' ? req.query.path.trim() : '';
      if (!rawPath) {
        res.status(400).json({ ok: false, error: 'path is required' });
        return;
      }
      const absolutePath = resolveAvatarPath(rawPath);
      const bytes = await fs.readFile(absolutePath);
      const ext = path.extname(absolutePath).toLowerCase();
      const mimeType =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(bytes);
    } catch (err) {
      res.status(404).json({ ok: false, error: String(err) });
    }
  });
}
