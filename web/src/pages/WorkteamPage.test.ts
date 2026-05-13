// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        pageTitle: '工作流',
        'workteam.连接节点构建自动化流程': '连接节点，构建自动化流程',
        'workteam.新建': '新建',
        'workteam.返回工作流': '返回工作流',
        'workteam.配置': '配置',
        'workteam.删除': '删除',
        'workteam.无描述': '无描述',
        'workteam.节点': '节点',
        'workteam.连线': '连线',
        'workteam.未运行': '未运行',
        'workteam.个工作流': '个工作流',
        'workteam.先选择或创建一个工作流': '先选择或创建一个工作流。',
      })[key] || key,
  }),
}));

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    subscribeAll: () => {},
  }),
}));

vi.mock('../components/repository/WorkflowRepositoryPanel', () => ({
  WorkflowRepositoryPanel: () => React.createElement('div', null, 'repo-panel'),
}));

import { WorkteamPage } from './WorkteamPage';

function mockFetchSequence() {
  const workflow = {
    id: 'wf-1',
    name: 'Alpha Flow',
    description: '',
    user_id: 'u1',
    status: 'draft',
    workflow_config: JSON.stringify({ editorMode: 'fixed_pipeline_v1' }),
    created_at: '2026-05-13T00:00:00.000Z',
    updated_at: '2026-05-13T00:00:00.000Z',
  };
  const snapshot = {
    workflow,
    nodes: [],
    edges: [],
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/workflows/wf-1/runs')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (url.endsWith('/api/workflows/wf-1')) {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    if (url.endsWith('/api/workflows')) {
      return new Response(JSON.stringify([workflow]), { status: 200 });
    }
    if (url.endsWith('/api/assistants')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  }) as typeof fetch;
}

function renderPage(initialPath = '/workteam') {
  mockFetchSequence();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        React.createElement(WorkteamPage, {
          apiBase: '',
          canManage: true,
          canCreateWorkflow: true,
        }),
      ),
    );
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('WorkteamPage', () => {
  let rendered: ReturnType<typeof renderPage> | undefined;

  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it('renders workflow library header and primary create action', async () => {
    rendered = renderPage('/workteam');
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain('工作流');
    expect(rendered.container.textContent).toContain('连接节点，构建自动化流程');
    expect(rendered.container.textContent).toContain('新建');
  });

  it('renders workflow detail actions when a workflow is selected', async () => {
    rendered = renderPage('/workteam/wf-1');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain('返回工作流');
    expect(rendered.container.textContent).toContain('配置');
    expect(rendered.container.textContent).toContain('删除');
  });
});
