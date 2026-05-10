import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';

const VALID_ASK_ID = /^ask_[A-Za-z0-9_-]+$/;

function validateAskId(askId: string): void {
  if (!VALID_ASK_ID.test(askId)) {
    throw new Error(`Invalid ask ID format: ${askId}`);
  }
}

export interface PendingAskRecord {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allow_multiple?: boolean;
  createdAt: string;
  expiresAt: string;
}

export function readPendingAsksForConversation(
  groupFolder: string,
): PendingAskRecord[] {
  const ipcPath = resolveGroupIpcPath(groupFolder);
  const requestsDir = path.join(ipcPath, 'questions', 'requests');
  const responsesDir = path.join(ipcPath, 'questions', 'responses');

  if (!fs.existsSync(requestsDir)) return [];

  const pending: PendingAskRecord[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(requestsDir);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const id = file.replace('.json', '');
    if (!VALID_ASK_ID.test(id)) continue;
    const responsePath = path.join(responsesDir, file);
    if (fs.existsSync(responsePath)) continue;

    try {
      const raw = fs.readFileSync(path.join(requestsDir, file), 'utf-8');
      const req = JSON.parse(raw) as Record<string, unknown>;
      if (typeof req.question !== 'string') continue;
      const expiresMs = new Date(req.expiresAt as string).getTime();
      if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) continue;
      pending.push({
        id,
        question: req.question,
        options: Array.isArray(req.options) ? req.options as PendingAskRecord['options'] : undefined,
        allow_multiple: req.allow_multiple === true ? true : undefined,
        createdAt: typeof req.createdAt === 'string' ? req.createdAt : '',
        expiresAt: req.expiresAt as string,
      });
    } catch {
      logger.warn({ file }, 'Failed to read pending ask request');
    }
  }

  return pending;
}

export function writeAskResponseForConversation(
  groupFolder: string,
  askId: string,
  answer: string,
  answeredBy: string,
): void {
  validateAskId(askId);
  const ipcPath = resolveGroupIpcPath(groupFolder);
  const responsesDir = path.join(ipcPath, 'questions', 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });

  const payload = {
    answer,
    answered_by: answeredBy,
    resolvedAt: new Date().toISOString(),
  };

  const finalPath = path.join(responsesDir, `${askId}.json`);
  const tmpPath = finalPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, finalPath);
}
