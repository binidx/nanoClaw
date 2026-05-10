import { describe, expect, it } from 'vitest';

import { buildBrowserRoleSnapshot } from './browser/role-snapshot.js';

describe('browser role snapshot', () => {
  it('formats actionable refs into a compact role snapshot', () => {
    const snapshot = buildBrowserRoleSnapshot({
      snapshot: {
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        frames: [],
        nodes: [
          {
            ref: 'ax-root',
            role: 'RootWebArea',
            name: 'Example',
            depth: 0,
            actionable: false,
            frameId: 'frame-top',
            topFrame: true,
          },
          {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            topFrame: true,
          },
          {
            ref: 'ax-submit',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-child',
            frameName: 'embedded-app',
            topFrame: false,
          },
        ],
      },
      resolvedRefs: {
        'ax-search': {
          backendNodeId: 42,
          node: {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
            frameId: 'frame-top',
            topFrame: true,
          },
        },
        'ax-submit': {
          backendNodeId: 43,
          node: {
            ref: 'ax-submit',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
            frameId: 'frame-child',
            frameName: 'embedded-app',
            topFrame: false,
          },
        },
      },
      options: {
        compact: true,
      },
    });

    expect(snapshot).toEqual({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      snapshot:
        '- RootWebArea "Example"\n' +
        '  - textbox "Search" [ref=ax-search]\n' +
        '  - button "Submit" [ref=ax-submit] [frame=embedded-app]',
      refs: {
        'ax-search': {
          role: 'textbox',
          name: 'Search',
          frameId: 'frame-top',
          topFrame: true,
        },
        'ax-submit': {
          role: 'button',
          name: 'Submit',
          frameId: 'frame-child',
          frameName: 'embedded-app',
          topFrame: false,
        },
      },
      stats: {
        lines: 3,
        chars: 117,
        refs: 2,
        interactive: 2,
      },
    });
  });

  it('supports interactive-only filtering', () => {
    const snapshot = buildBrowserRoleSnapshot({
      snapshot: {
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        frames: [],
        nodes: [
          {
            ref: 'ax-root',
            role: 'RootWebArea',
            name: 'Example',
            depth: 0,
            actionable: false,
          },
          {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
          },
        ],
      },
      resolvedRefs: {
        'ax-search': {
          backendNodeId: 42,
          node: {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
          },
        },
      },
      options: {
        interactive: true,
      },
    });

    expect(snapshot.snapshot).toBe('  - textbox "Search" [ref=ax-search]');
    expect(snapshot.refs).toEqual({
      'ax-search': {
        role: 'textbox',
        name: 'Search',
      },
    });
  });

  it('truncates at line boundaries when maxChars is provided', () => {
    const snapshot = buildBrowserRoleSnapshot({
      snapshot: {
        targetId: 'tab-1',
        title: 'Example',
        url: 'https://example.com',
        frames: [],
        nodes: [
          {
            ref: 'ax-root',
            role: 'RootWebArea',
            name: 'Example',
            depth: 0,
            actionable: false,
          },
          {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
          },
          {
            ref: 'ax-submit',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
          },
        ],
      },
      resolvedRefs: {
        'ax-search': {
          backendNodeId: 42,
          node: {
            ref: 'ax-search',
            role: 'textbox',
            name: 'Search',
            depth: 1,
            actionable: true,
          },
        },
        'ax-submit': {
          backendNodeId: 43,
          node: {
            ref: 'ax-submit',
            role: 'button',
            name: 'Submit',
            depth: 1,
            actionable: true,
          },
        },
      },
      maxChars: 70,
    });

    expect(snapshot).toEqual({
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://example.com',
      snapshot:
        '- RootWebArea "Example"\n' +
        '  - textbox "Search" [ref=ax-search]\n' +
        '[...TRUNCATED: 1 more lines omitted]',
      refs: {
        'ax-search': {
          role: 'textbox',
          name: 'Search',
        },
      },
      stats: {
        lines: 3,
        chars: 97,
        refs: 1,
        interactive: 1,
      },
      truncated: true,
    });
  });
});
