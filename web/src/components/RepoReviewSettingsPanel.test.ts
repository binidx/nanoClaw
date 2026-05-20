// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Conversation, RepoReviewRepository } from '../app-types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue || key,
  }),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => undefined,
}));

vi.mock('../pages/CodeMapPage', () => ({
  CodeMapPage: () => React.createElement('div', null, 'codemap-page'),
}));

vi.mock('./repository/RepositoryRelationshipsPanel', () => ({
  RepositoryRelationshipsPanel: () =>
    React.createElement('div', null, 'relationships-panel'),
}));

import { RepoReviewSettingsPanel } from './RepoReviewSettingsPanel';

const repository: RepoReviewRepository = {
  id: 'repo-1',
  name: 'NanoClaw Repo',
  language: 'TypeScript',
  localRepoPath: '/proj/nanoclaw',
  remoteProvider: '',
  remoteRepoSlug: '',
  remoteBaseUrl: '',
  cloneUrl: '',
  defaultTargetBranch: 'main',
  reviewChatJid: 'repo-review:repo-1',
  actorMentionMappings: [],
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 30,
  lastAutoSyncAt: '',
  nextAutoSyncAt: '',
  lastAutoSyncStatus: '',
  lastAutoSyncMessage: '',
  digestDailyEnabled: false,
  digestWeeklyEnabled: false,
  digestDailyHour: 18,
  digestWeeklyDay: 5,
  digestWeeklyHour: 18,
  lastDigestDailyAt: '',
  nextDigestDailyAt: '',
  lastDigestWeeklyAt: '',
  nextDigestWeeklyAt: '',
  enabled: true,
  allowAiFix: false,
  hasWebhookSecret: false,
  hasPlatformToken: false,
  profileCount: 0,
};

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const conversations: Conversation[] = [];
  act(() => {
    root.render(
      React.createElement(RepoReviewSettingsPanel, {
        apiBase: '',
        pickNativeDirectory: async () => null,
        conversations,
        embedded: true,
      }),
    );
  });
  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('RepoReviewSettingsPanel', () => {
  let rendered: ReturnType<typeof renderPanel> | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/repo-reviews/repositories/repo-1')) {
        return new Response(JSON.stringify({ repository, profiles: [] }), {
          status: 200,
        });
      }
      if (url.includes('/api/repo-reviews/repositories')) {
        return new Response(JSON.stringify({ repositories: [repository] }), {
          status: 200,
        });
      }
      if (url.includes('/api/repo-reviews/runs-summary')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
  });

  it('replaces the repository catalog with focused detail in embedded mode', async () => {
    rendered = renderPanel();

    await waitFor(() => {
      expect(rendered?.container.textContent).toContain('NanoClaw Repo');
      expect(
        rendered?.container.querySelector('.repo-review-workspace-list'),
      ).not.toBeNull();
    });

    const repoCard = rendered.container.querySelector<HTMLButtonElement>(
      '.repo-review-repo-card',
    );
    expect(repoCard).not.toBeNull();

    act(() => {
      repoCard?.click();
    });

    await waitFor(() => {
      expect(
        rendered?.container.querySelector('.repo-review-workspace-detail'),
      ).not.toBeNull();
      expect(
        rendered?.container.querySelector('.repo-review-workspace-list'),
      ).toBeNull();
    });

    expect(
      rendered.container.querySelector('.repo-review-workspace-layout')
        ?.className,
    ).toContain('repo-review-workspace-layout--focused');
    expect(
      rendered.container.querySelector('.repo-review-repo-card'),
    ).toBeNull();
    expect(
      rendered.container.querySelector(
        '[aria-label="repoReview.repo.filterPlaceholder"]',
      ),
    ).toBeNull();
    expect(rendered.container.textContent).toContain('返回列表');
  });
});
