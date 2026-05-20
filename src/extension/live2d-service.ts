import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  getLive2DModels,
  getLive2DModelMeta,
  getLive2DModelData,
  getLive2DModelThumbnail,
  insertLive2DModel,
  updateLive2DModel,
  updateLive2DModelThumbnail,
  deleteLive2DModel,
  getLive2DEmotionMappings,
  setLive2DEmotionMappings,
  getLive2DUserPreferences,
  upsertLive2DUserPreferences,
  type Live2DModelRecord,
  type Live2DEmotionMappingRecord,
  type Live2DUserPreferencesRecord,
} from '../db.js';

const LIVE2D_CACHE_DIR = path.join(DATA_DIR, 'live2d', 'cache');
const LIVE2D_CACHE_VERSION = 'v2';
const ZIP_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ZIP_GBK_DECODER = new TextDecoder('gbk');

function getCacheDir(modelId: string): string {
  return path.join(LIVE2D_CACHE_DIR, modelId);
}

function getCacheMarkerPath(cacheDir: string): string {
  return path.join(cacheDir, `.extracted-${LIVE2D_CACHE_VERSION}`);
}

function ensureCacheDir(modelId: string): string {
  const dir = getCacheDir(modelId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function decodeZipEntryName(rawEntryName: Buffer | Uint8Array): string {
  const bytes = Buffer.from(rawEntryName);
  try {
    return ZIP_UTF8_DECODER.decode(bytes);
  } catch {
    return ZIP_GBK_DECODER.decode(bytes);
  }
}

async function extractZipToCache(
  modelId: string,
  zipBuffer: Buffer,
): Promise<string> {
  const cacheDir = ensureCacheDir(modelId);
  const markerPath = getCacheMarkerPath(cacheDir);
  if (fs.existsSync(markerPath)) return cacheDir;

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const { default: AdmZip } = await import('adm-zip');
  const zipDecoderOptions = {
    decoder: {
      efs: true,
      encode: (value: string) => Buffer.from(value, 'utf8'),
      decode: decodeZipEntryName,
    },
  } as any;
  const zip = new AdmZip(zipBuffer, zipDecoderOptions);
  zip.extractAllTo(cacheDir, true);
  fs.writeFileSync(markerPath, new Date().toISOString());
  return cacheDir;
}

function detectEntryFile(dir: string): string | null {
  const candidates: string[] = [];
  function walk(current: string, prefix: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(
          path.join(current, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
        );
      } else if (
        entry.name.endsWith('.model3.json') ||
        entry.name.endsWith('.model.json')
      ) {
        candidates.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  walk(dir, '');
  if (candidates.length === 0) return null;
  const model3 = candidates.find((c) => c.endsWith('.model3.json'));
  return model3 || candidates[0]!;
}

export async function ensureModelCache(
  modelId: string,
): Promise<string | null> {
  const cacheDir = getCacheDir(modelId);
  const markerPath = getCacheMarkerPath(cacheDir);
  if (fs.existsSync(markerPath)) return cacheDir;

  const data = await getLive2DModelData(modelId);
  if (!data) return null;
  return extractZipToCache(modelId, data);
}

export function getModelFilePath(
  modelId: string,
  relativePath: string,
): string | null {
  const cacheDir = getCacheDir(modelId);
  const resolved = path.resolve(cacheDir, relativePath);
  const boundary = path.relative(cacheDir, resolved);
  if (
    boundary === '..' ||
    boundary.startsWith(`..${path.sep}`) ||
    path.isAbsolute(boundary)
  ) {
    return null;
  }
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

export interface Live2DModelInfo {
  id: string;
  name: string;
  description: string | null;
  userId: string;
  visibility: string;
  format: string;
  fileSize: number;
  entryFile: string | null;
  createdAt: string;
  updatedAt: string;
}

function toModelInfo(
  r:
    | Omit<Live2DModelRecord, 'model_data'>
    | Omit<Live2DModelRecord, 'model_data' | 'thumbnail'>,
): Live2DModelInfo {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    userId: r.user_id,
    visibility: r.visibility,
    format: r.format,
    fileSize: r.file_size,
    entryFile: r.entry_file,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listModels(userId: string): Promise<Live2DModelInfo[]> {
  const rows = await getLive2DModels(userId);
  return rows.map(toModelInfo);
}

export async function getModelInfo(
  id: string,
): Promise<Live2DModelInfo | null> {
  const row = await getLive2DModelMeta(id);
  return row ? toModelInfo(row) : null;
}

export async function uploadModel(input: {
  name: string;
  description?: string;
  userId: string;
  visibility: string;
  format: string;
  zipBuffer: Buffer;
  thumbnail?: Buffer;
}): Promise<Live2DModelInfo> {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const now = new Date().toISOString();

  const cacheDir = await extractZipToCache(id, input.zipBuffer);
  const entryFile = detectEntryFile(cacheDir);

  const record: Live2DModelRecord = {
    id,
    name: input.name,
    description: input.description || null,
    user_id: input.userId,
    visibility: input.visibility,
    format: input.format,
    model_data: input.zipBuffer,
    thumbnail: input.thumbnail || null,
    file_size: input.zipBuffer.length,
    entry_file: entryFile,
    created_by: input.userId,
    updated_by: input.userId,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };

  await insertLive2DModel(record);

  return toModelInfo(record);
}

export async function removeModel(
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<boolean> {
  const model = await getLive2DModelMeta(id);
  if (!model) return false;
  if (model.user_id !== userId && !isAdmin) return false;

  await deleteLive2DModel(id);

  const cacheDir = path.join(LIVE2D_CACHE_DIR, id);
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  return true;
}

export async function patchModel(
  id: string,
  userId: string,
  isAdmin: boolean,
  updates: {
    name?: string;
    description?: string;
    visibility?: string;
    thumbnail?: Buffer;
  },
): Promise<boolean> {
  const model = await getLive2DModelMeta(id);
  if (!model) return false;
  if (model.user_id !== userId && !isAdmin) return false;
  const { thumbnail, ...metaUpdates } = updates;
  await updateLive2DModel(id, metaUpdates);
  if (thumbnail) {
    await updateLive2DModelThumbnail(id, thumbnail);
  }
  return true;
}

export async function getEmotionMappings(modelId: string) {
  return getLive2DEmotionMappings(modelId);
}

export async function saveEmotionMappings(
  modelId: string,
  mappings: Omit<Live2DEmotionMappingRecord, 'id'>[],
) {
  await setLive2DEmotionMappings(modelId, mappings);
}

export interface Live2DPreferences {
  enabled: boolean;
  selectedModelId: string | null;
  position: string;
  panelWidth: number;
  opacity: number;
  emotionProviderId: string | null;
  modelScale: number;
  modelOffsetY: number;
}

export async function getUserPreferences(
  userId: string,
): Promise<Live2DPreferences> {
  const row = await getLive2DUserPreferences(userId);
  return {
    enabled: row ? row.enabled === 1 : false,
    selectedModelId: row?.selected_model_id ?? null,
    position: row?.position ?? 'right',
    panelWidth: row?.panel_width ?? 280,
    opacity: row?.opacity ?? 100,
    emotionProviderId: row?.emotion_provider_id ?? null,
    modelScale: row?.model_scale ?? 1.0,
    modelOffsetY: row?.model_offset_y ?? 0,
  };
}

export async function saveUserPreferences(
  userId: string,
  prefs: Partial<Live2DPreferences>,
): Promise<void> {
  await upsertLive2DUserPreferences(userId, {
    enabled: prefs.enabled !== undefined ? (prefs.enabled ? 1 : 0) : undefined,
    selected_model_id: prefs.selectedModelId,
    position: prefs.position,
    panel_width: prefs.panelWidth,
    opacity: prefs.opacity,
    emotion_provider_id: prefs.emotionProviderId,
    model_scale: prefs.modelScale,
    model_offset_y: prefs.modelOffsetY,
  });
}

export function getThumbnail(id: string) {
  return getLive2DModelThumbnail(id);
}
