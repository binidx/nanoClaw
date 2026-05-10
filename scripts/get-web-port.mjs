#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

function readEnvValue(filePath, key) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const currentKey = trimmed.slice(0, eqIndex).trim();
      if (currentKey !== key) continue;
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    return '';
  }
  return '';
}

async function readStoredPort() {
  const dbPath = path.join(projectRoot, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return '';

  try {
    const Database = (await import('better-sqlite3')).default;
    const database = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    const row = database
      .prepare('SELECT value FROM config WHERE key = ?')
      .get('WEB_PORT');
    database.close();
    return typeof row?.value === 'string' ? row.value.trim() : '';
  } catch {
    return '';
  }
}

let port = (process.env.WEB_PORT || '').trim();
if (!port) {
  port = await readStoredPort();
}
if (!port) {
  port = readEnvValue(path.join(projectRoot, '.env'), 'WEB_PORT').trim();
}
if (!/^\d+$/.test(port)) {
  port = '3377';
}

process.stdout.write(port);
