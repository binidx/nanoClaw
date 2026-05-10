import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { searchProjectDocuments } from './document-search.js';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-search-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('searchProjectDocuments', () => {
  it('respects include and exclude globs for project documents', () => {
    const root = createTempRoot();
    writeFile(
      root,
      'docs/inventory-guide.md',
      '# Inventory Guide\nInventory sync troubleshooting notes.\n',
    );
    writeFile(
      root,
      'notes/private.txt',
      'Inventory sync private draft.\n',
    );

    const results = searchProjectDocuments(root, 'inventory sync', {
      includeGlobs: ['docs/**', '**/*.md'],
      excludeGlobs: ['**/private.*'],
      limit: 10,
    });

    expect(results).toEqual([
      expect.objectContaining({
        relativePath: 'docs/inventory-guide.md',
      }),
    ]);
  });

  it('returns the best matching preview and sorts higher scoring hits first', () => {
    const root = createTempRoot();
    writeFile(
      root,
      'README.md',
      '# README\nGeneral inventory sync troubleshooting entry.\n',
    );
    writeFile(
      root,
      'docs/order-sync.md',
      '# Order Sync\nOrder gateway sync troubleshooting and inventory sync linkage.\n',
    );

    const results = searchProjectDocuments(root, 'inventory sync troubleshooting', {
      includeGlobs: ['**/*.md'],
      limit: 10,
    });

    expect(results[0]).toEqual(
      expect.objectContaining({
        relativePath: 'README.md',
        preview: 'General inventory sync troubleshooting entry.',
        matchedTerms: ['inventory', 'sync', 'troubleshooting'],
      }),
    );
    expect(results.map((entry) => entry.relativePath)).toEqual([
      'README.md',
      'docs/order-sync.md',
    ]);
  });
});
