import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import type { MemoryDocumentRecord } from '../types.js';

export interface IdentityDocumentAlias {
  channel?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
}

export interface IdentityDocumentProfileInput {
  personId: string;
  displayName: string;
  notes: string[];
  aliases: IdentityDocumentAlias[];
  updatedAt?: string;
}

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getGlobalMemoryRoot(): string {
  return process.env.NANOCLAW_GLOBAL_DIR || path.join(GROUPS_DIR, 'global');
}

export function buildIdentityMemoryRelativePath(personId: string): string {
  return `memory/identity/${String(personId || '').trim()}.md`;
}

export function buildIdentityMemoryPathRef(personId: string): string {
  return `global:${buildIdentityMemoryRelativePath(personId)}`;
}

export function buildIdentityMemoryAbsolutePath(personId: string): string {
  return path.join(getGlobalMemoryRoot(), 'memory', 'identity', `${personId}.md`);
}

function renderAliasLine(alias: IdentityDocumentAlias): string | null {
  const parts = [
    alias.displayName ? `display=${normalizeWhitespace(alias.displayName)}` : '',
    alias.channel ? `channel=${normalizeWhitespace(alias.channel)}` : '',
    alias.externalUserId
      ? `external=${normalizeWhitespace(alias.externalUserId)}`
      : '',
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `- ${parts.join(' · ')}`;
}

export function buildIdentityMemoryBody(
  input: IdentityDocumentProfileInput,
): string {
  const personId = normalizeWhitespace(input.personId);
  const displayName = normalizeWhitespace(input.displayName) || personId;
  const notes = normalizeList(input.notes || []);
  const aliasLines = (input.aliases || [])
    .map((alias) => renderAliasLine(alias))
    .filter((value): value is string => Boolean(value));

  const lines = [
    `# Identity Memory ${displayName}`,
    '',
    `Person ID: ${personId}`,
    `Display name: ${displayName}`,
  ];

  if (aliasLines.length > 0) {
    lines.push('', 'Aliases:', ...aliasLines);
  }

  lines.push('', 'Durable facts:');
  if (notes.length === 0) {
    lines.push('- none');
  } else {
    lines.push(...notes.map((note) => `- ${note}`));
  }

  return `${lines.join('\n')}\n`;
}

export function writeIdentityMemoryFile(
  input: IdentityDocumentProfileInput,
): {
  pathRef: string;
  absolutePath: string;
  body: string;
} {
  const absolutePath = buildIdentityMemoryAbsolutePath(input.personId);
  const body = buildIdentityMemoryBody(input);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, body, 'utf8');
  return {
    pathRef: buildIdentityMemoryPathRef(input.personId),
    absolutePath,
    body,
  };
}

export function buildIdentityMemoryDocumentRecord(
  input: IdentityDocumentProfileInput,
): MemoryDocumentRecord {
  const rendered = writeIdentityMemoryFile(input);
  return {
    doc_id: `identity-memory:${input.personId}`,
    scope: 'global',
    owner_type: 'person',
    owner_id: input.personId,
    path_ref: rendered.pathRef,
    source_type: 'identity_memory',
    title: buildIdentityMemoryRelativePath(input.personId),
    body: rendered.body,
    metadata_json: JSON.stringify({
      personId: input.personId,
      displayName: input.displayName,
      noteCount: normalizeList(input.notes || []).length,
      aliasCount: (input.aliases || []).length,
      memoryClass: 'identity',
    }),
    updated_at: input.updatedAt || new Date().toISOString(),
  };
}
