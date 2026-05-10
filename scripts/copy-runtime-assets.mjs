#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

const assetsToCopy = [
  {
    from: path.join(projectRoot, 'src', 'i18n', 'locales'),
    to: path.join(projectRoot, 'dist', 'i18n', 'locales'),
  },
  {
    from: path.join(projectRoot, 'src', 'extension', 'marketplaces'),
    to: path.join(projectRoot, 'dist', 'src', 'extension', 'marketplaces'),
  },
];

for (const asset of assetsToCopy) {
  if (!fs.existsSync(asset.from)) {
    console.warn(`Skipping missing runtime asset: ${path.relative(projectRoot, asset.from)}`);
    continue;
  }
  fs.mkdirSync(path.dirname(asset.to), { recursive: true });
  fs.cpSync(asset.from, asset.to, { recursive: true, force: true });
}
