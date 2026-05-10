// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KnowledgeGraph, type KbGraphLink, type KbGraphNode } from './KnowledgeGraph';

const forceGraphMockState = vi.hoisted(() => ({
  currentZoom: 1,
  zoomCalls: [] as Array<{ zoom: number; duration: number }>,
  centerCalls: [] as Array<{ x: number; y: number; duration: number }>,
  zoomToFitCalls: [] as Array<{ duration: number; padding: number }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      switch (key) {
        case 'graph.layout':
          return '布局';
        case 'graph.cluster':
          return '聚簇';
        case 'graph.hierarchy':
          return '层次';
        case 'graph.spacing':
          return '间距';
        case 'graph.zoomIn':
          return '放大';
        case 'graph.zoomOut':
          return '缩小';
        case 'graph.resetView':
          return '重置视图';
        case 'graph.nodes':
          return `${vars?.visible}/${vars?.total} 节点`;
        case 'graph.links':
          return `${vars?.visible}/${vars?.total} 连线`;
        case 'graph.confidence':
          return `置信度 ${vars?.pct}%`;
        case 'graph.hidden':
          return `隐藏 ${String(vars?.summary ?? '')}`;
        case 'graph.unprocessed':
          return `未处理 ${vars?.count}`;
        case 'graph.treeLeaf':
          return `树叶 ${vars?.count}`;
        case 'graph.lowConfidence':
          return `低置信 ${vars?.count}`;
        case 'graph.weakSource':
          return `弱来源 ${vars?.count}`;
        case 'graph.maxNodes':
          return `裁剪 ${vars?.count}`;
        case 'tooltip.wiki':
          return `Wiki ${String(vars?.type ?? '')}`;
        case 'tooltip.doc':
          return `文档 ${String(vars?.status ?? '')}`;
        case 'tooltip.degree':
          return `度 ${String(vars?.count ?? 0)}`;
        default:
          return key;
      }
    },
  }),
}));

vi.mock('./KnowledgeGraphCanvas', async () => {
  const ReactModule = await import('react');
  const MockForceGraph = ReactModule.forwardRef((props: Record<string, unknown>, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({
      d3Force: () => ({
        strength: vi.fn(),
        distance: vi.fn(),
      }),
      d3ReheatSimulation: vi.fn(),
      zoom: (value?: number, duration = 0) => {
        if (typeof value === 'number') {
          forceGraphMockState.currentZoom = value;
          forceGraphMockState.zoomCalls.push({ zoom: value, duration });
        }
        return forceGraphMockState.currentZoom;
      },
      centerAt: (x: number, y: number, duration = 0) => {
        forceGraphMockState.centerCalls.push({ x, y, duration });
      },
      zoomToFit: (duration = 0, padding = 0) => {
        forceGraphMockState.zoomToFitCalls.push({ duration, padding });
      },
    }));

    return ReactModule.createElement('div', {
      className: 'force-graph-mock',
      'data-node-count': String(((props.graphData as { nodes?: unknown[] } | undefined)?.nodes ?? []).length),
    });
  });

  return { KnowledgeGraphCanvas: MockForceGraph };
});

class ResizeObserverMock {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: 960, height: 640 } as DOMRectReadOnly,
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}

  unobserve() {}
}

const NODES: KbGraphNode[] = [
  { id: 'doc-a', label: 'Doc A', type: 'document', status: 'indexed', processed: true, degree: 2, depth: 0 },
  { id: 'wiki-a', label: 'Wiki A', type: 'wiki', status: 'ready', processed: true, degree: 1, pageType: 'entity' },
];

const LINKS: KbGraphLink[] = [
  { source: 'doc-a', target: 'wiki-a', type: 'wiki_source', confidence: 0.8 },
];

function renderGraph(
  props: Partial<React.ComponentProps<typeof KnowledgeGraph>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const currentProps: React.ComponentProps<typeof KnowledgeGraph> = {
    graphData: { nodes: NODES, links: LINKS },
    stats: {
      view: 'overview',
      max_nodes: 80,
      min_confidence: 0.6,
      focus_id: null,
      total_nodes: 2,
      total_links: 1,
      visible_nodes: 2,
      visible_links: 1,
      documents: 1,
      wiki_pages: 1,
      tree_edges: 0,
      relation_edges: 0,
      wiki_source_edges: 1,
      include: ['wiki_source'],
    },
    hiddenCounts: {
      nodes: 0,
      links: 0,
      unprocessed_nodes: 1,
      tree_leaf_nodes: 2,
      low_confidence_relations: 2,
      excluded_by_include: 0,
      max_nodes: 3,
      weak_wiki_source_edges: 1,
    },
    height: 480,
    viewScope: 'kb-1:overview:none',
    ...props,
  };

  act(() => {
    root.render(React.createElement(KnowledgeGraph, currentProps));
  });
  act(() => {
    vi.runAllTimers();
  });

  return {
    container,
    rerender(nextProps: Partial<React.ComponentProps<typeof KnowledgeGraph>>) {
      Object.assign(currentProps, nextProps);
      act(() => {
        root.render(React.createElement(KnowledgeGraph, currentProps));
      });
      act(() => {
        vi.runAllTimers();
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('KnowledgeGraph', () => {
  let rendered: ReturnType<typeof renderGraph> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    forceGraphMockState.currentZoom = 1;
    forceGraphMockState.zoomCalls = [];
    forceGraphMockState.centerCalls = [];
    forceGraphMockState.zoomToFitCalls = [];
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('persists selected layout mode to localStorage', () => {
    rendered = renderGraph();

    const hierarchyButton = Array.from(rendered.container.querySelectorAll('button')).find(
      (button) => button.textContent === '层次',
    );
    expect(hierarchyButton).toBeTruthy();

    act(() => {
      hierarchyButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(localStorage.getItem('knowledge-graph-display-prefs')).toBe(JSON.stringify({ layoutMode: 'hierarchy' }));
  });

  it('restores saved viewport state for the active view scope', () => {
    localStorage.setItem(
      'knowledge-graph-view:kb-1:focus:doc-a',
      JSON.stringify({ zoom: 1.75, x: 48, y: 96 }),
    );

    rendered = renderGraph({ viewScope: 'kb-1:focus:doc-a' });

    expect(forceGraphMockState.centerCalls).toContainEqual({ x: 48, y: 96, duration: 0 });
    expect(forceGraphMockState.zoomCalls).toContainEqual({ zoom: 1.75, duration: 0 });
  });

  it('renders graph stats and hidden-summary text', () => {
    rendered = renderGraph();

    expect(rendered.container.textContent).toContain('2/2 节点');
    expect(rendered.container.textContent).toContain('1/1 连线');
    expect(rendered.container.textContent).toContain('置信度 60%');
    expect(rendered.container.textContent).toContain('隐藏 未处理 1 · 树叶 2 · 低置信 2 · 弱来源 1 · 裁剪 3');
  });
});
