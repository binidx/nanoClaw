// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeMapEdge, CodeMapFile } from './code-map-api';
import { CodeMapGraphView, buildNodeCountOptions } from './CodeMapGraphView';

const FILES: CodeMapFile[] = [
  {
    relativePath: 'src/index.ts',
    language: 'typescript',
    lineCount: 40,
    byteSize: 1200,
    symbols: [{ name: 'main', kind: 'function', line: 1, column: 1, signature: 'main()', rank: 0.7 }],
    importCount: 2,
    exportCount: 1,
    rank: 0.28,
  },
  {
    relativePath: 'src/greet.ts',
    language: 'typescript',
    lineCount: 24,
    byteSize: 860,
    symbols: [{ name: 'greet', kind: 'function', line: 1, column: 1, signature: 'greet()', rank: 0.8 }],
    importCount: 1,
    exportCount: 1,
    rank: 0.44,
  },
  {
    relativePath: 'src/format.ts',
    language: 'typescript',
    lineCount: 18,
    byteSize: 620,
    symbols: [{ name: 'format', kind: 'function', line: 1, column: 1, signature: 'format()', rank: 0.9 }],
    importCount: 0,
    exportCount: 1,
    rank: 0.61,
  },
];

const EDGES: CodeMapEdge[] = [
  { fromFile: 'src/index.ts', toFile: 'src/greet.ts', symbols: ['greet'] },
  { fromFile: 'src/index.ts', toFile: 'src/format.ts', symbols: ['format'] },
  { fromFile: 'src/greet.ts', toFile: 'src/format.ts', symbols: ['format'] },
];

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

function getTransform(container: HTMLElement): string {
  const transformGroup = container.querySelector('.codemap-graph-svg g[transform]');
  return transformGroup?.getAttribute('transform') || '';
}

function renderGraph(
  props: Partial<React.ComponentProps<typeof CodeMapGraphView>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const currentProps: React.ComponentProps<typeof CodeMapGraphView> = {
    files: FILES,
    edges: EDGES,
    selectedFile: null,
    onSelectFile: vi.fn(),
    allFiles: FILES,
    allEdges: EDGES,
    viewScope: 'repo-1:main',
    ...props,
  };

  act(() => {
    root.render(React.createElement(CodeMapGraphView, currentProps));
  });

  return {
    container,
    rerender(nextProps: Partial<React.ComponentProps<typeof CodeMapGraphView>>) {
      Object.assign(currentProps, nextProps);
      act(() => {
        root.render(React.createElement(CodeMapGraphView, currentProps));
      });
    },
    zoomIn() {
      const wrapper = container.querySelector('.codemap-graph-wrapper');
      expect(wrapper).toBeTruthy();
      act(() => {
        wrapper!.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120,
          bubbles: true,
          cancelable: true,
        }));
      });
    },
    transform() {
      return getTransform(container);
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('CodeMapGraphView', () => {
  let rendered: ReturnType<typeof renderGraph> | undefined;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('preserves manual zoom and pan when selection changes', () => {
    rendered = renderGraph();

    const initialTransform = rendered.transform();
    expect(initialTransform).toContain('scale(');

    rendered.zoomIn();
    const zoomedTransform = rendered.transform();
    expect(zoomedTransform).not.toEqual(initialTransform);

    rendered.rerender({ selectedFile: 'src/greet.ts' });

    expect(rendered.transform()).toEqual(zoomedTransform);
  });

  it('loads branch-specific saved viewport state when viewScope changes', () => {
    localStorage.setItem(
      'codemap-view:repo-1:feature',
      JSON.stringify({ zoom: 1.7, panX: 55, panY: 66 }),
    );

    rendered = renderGraph({ viewScope: 'repo-1:main' });
    rendered.rerender({ viewScope: 'repo-1:feature' });

    expect(rendered.transform()).toBe('translate(55,66) scale(1.7)');
  });

  it('auto-fits when a saved viewport would hide the graph', () => {
    localStorage.setItem(
      'codemap-view:repo-1:main',
      JSON.stringify({ zoom: 3, panX: 9000, panY: 9000 }),
    );

    rendered = renderGraph();

    expect(rendered.transform()).not.toBe('translate(9000,9000) scale(3)');
    expect(rendered.transform()).toContain('scale(');
  });

  it('offers node count options beyond 200 for larger repositories', () => {
    expect(buildNodeCountOptions(640)).toEqual([30, 50, 80, 120, 200, 300, 500, 640]);
    expect(buildNodeCountOptions(2200)).toContain(2000);
  });
});
