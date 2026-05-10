// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Conversation } from '../app-types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      ({
        'auto.c270fc6f': '仓库',
        'auto.c83b1969': '仓库页直接复用成熟的代码审查工作台，避免维护分叉的仓库专用界面。',
      })[key] || options?.defaultValue || key,
  }),
}));

vi.mock('../components/RepoReviewSettingsPanel', () => ({
  RepoReviewSettingsPanel: () =>
    React.createElement('div', null, 'repo-review-settings-panel'),
}));

import RepositoryPage from './RepositoryPage';

function renderRepositoryPage(initialPath = '/repos/repo-1') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const conversations: Conversation[] = [];
  act(() => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        React.createElement(RepositoryPage, {
          apiBase: '/api-base',
          pickNativeDirectory: async () => null,
          conversations,
        }),
      ),
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

describe('RepositoryPage', () => {
  let rendered: ReturnType<typeof renderRepositoryPage> | undefined;

  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
  });

  it('renders the shared repository settings workspace', () => {
    rendered = renderRepositoryPage();
    expect(rendered.container.textContent).toContain('仓库');
    expect(rendered.container.textContent).toContain('repo-review-settings-panel');
  });
});
