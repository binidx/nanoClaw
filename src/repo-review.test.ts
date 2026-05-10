import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('repo review', () => {
  beforeEach(async () => {
    vi.resetModules();
    const db = await import('./db.js');
    db._initTestDatabase();
  });

  it('installs and uninstalls managed git hook snippets', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-review-'));
    const hooksDir = path.join(tempDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommit = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(preCommit, '#!/bin/sh\necho "existing"\n', 'utf8');

    const { saveReviewRepository } = await import('./db.js');
    saveReviewRepository({
      id: 'repo-1',
      name: 'Repo One',
      local_repo_path: tempDir,
      remote_provider: null,
      remote_repo_slug: null,
      remote_base_url: null,
      clone_url: null,
      default_target_branch: null,
      review_chat_jid: null,
      local_hook_secret: null,
      webhook_secret: null,
      platform_token: null,
      enabled: true,
      language: null,
    });
    const { installRepoReviewHooks, uninstallRepoReviewHooks } =
      await import('./repo-review/repo-review-service.js');

    installRepoReviewHooks({
      repositoryId: 'repo-1',
      nanoclawRoot: '/tmp/nanoclaw',
    });
    const installed = fs.readFileSync(preCommit, 'utf8');
    const normalizedNanoclawRoot = path.resolve('/tmp/nanoclaw');
    expect(installed).toContain('--repository-id "repo-1" --stage commit');
    expect(installed).toContain(
      `--nanoclaw-root "${normalizedNanoclawRoot}"`,
    );
    expect(installed).toContain('# >>> nanoclaw repo review >>>');
    expect(installed).toContain('echo "existing"');

    uninstallRepoReviewHooks({ repositoryId: 'repo-1' });
    const removed = fs.readFileSync(preCommit, 'utf8');
    expect(removed).toContain('echo "existing"');
    expect(removed).not.toContain('nanoclaw review-trigger');
    expect(removed).not.toContain('# >>> nanoclaw repo review >>>');
  });

  it('verifies github webhook signatures safely', async () => {
    const { saveReviewRepository } = await import('./db.js');
    saveReviewRepository({
      id: 'repo-1',
      name: 'Repo One',
      local_repo_path: null,
      remote_provider: 'github',
      remote_repo_slug: 'owner/repo',
      remote_base_url: null,
      clone_url: null,
      default_target_branch: null,
      review_chat_jid: null,
      local_hook_secret: null,
      webhook_secret: 'secret-1',
      platform_token: null,
      enabled: true,
      language: null,
    });

    const { verifyRepoReviewWebhook } =
      await import('./repo-review/repo-review-service.js');
    const repository = (await import('./db.js')).getReviewRepositoryById(
      'repo-1',
    );
    expect(repository).toBeTruthy();
    const rawBody = JSON.stringify({ hello: 'world' });
    const digest =
      'sha256=' +
      (await import('crypto'))
        .createHmac('sha256', 'secret-1')
        .update(rawBody)
        .digest('hex');

    expect(
      verifyRepoReviewWebhook({
        provider: 'github',
        repository: repository!,
        headers: { 'x-hub-signature-256': digest },
        rawBody,
      }),
    ).toBe(true);
    expect(
      verifyRepoReviewWebhook({
        provider: 'github',
        repository: repository!,
        headers: { 'x-hub-signature-256': 'sha256=short' },
        rawBody,
      }),
    ).toBe(false);
  });
});
