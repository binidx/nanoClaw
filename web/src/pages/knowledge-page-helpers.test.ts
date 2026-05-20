import { describe, expect, it } from 'vitest';

import {
  resolveKnowledgeContentView,
  resolveKnowledgeDetailTab,
  resolveKnowledgeDrawerTab,
} from './knowledge-page-helpers';

describe('knowledge page tab resolution', () => {
  it('accepts current workbench tab urls', () => {
    expect(
      resolveKnowledgeDetailTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlTab: 'content',
        urlView: null,
      }),
    ).toBe('content');
    expect(
      resolveKnowledgeDetailTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlTab: 'graph',
        urlView: null,
      }),
    ).toBe('graph');
    expect(
      resolveKnowledgeDetailTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlTab: 'settings',
        urlView: null,
      }),
    ).toBe('settings');
  });

  it('keeps legacy drawer tab urls working', () => {
    expect(
      resolveKnowledgeDetailTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlTab: 'docs',
        urlView: null,
      }),
    ).toBe('content');
    expect(
      resolveKnowledgeContentView({ urlContent: null, urlTab: 'tree' }),
    ).toBe('tree');
    expect(
      resolveKnowledgeDetailTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlTab: 'relations',
        urlView: null,
      }),
    ).toBe('graph');
    expect(
      resolveKnowledgeDetailTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlTab: 'config',
        urlView: null,
      }),
    ).toBe('settings');
  });

  it('maps workbench tabs to renderable drawer sections', () => {
    expect(
      resolveKnowledgeDrawerTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlView: null,
        detailTab: 'content',
        contentView: 'docs',
      }),
    ).toBe('docs');
    expect(
      resolveKnowledgeDrawerTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlView: null,
        detailTab: 'graph',
        contentView: 'wiki',
      }),
    ).toBe('relations');
    expect(
      resolveKnowledgeDrawerTab({
        creatingKb: false,
        hasSelectedKb: true,
        urlView: null,
        detailTab: 'settings',
        contentView: 'docs',
      }),
    ).toBe('config');
  });
});
