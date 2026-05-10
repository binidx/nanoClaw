import { describe, expect, it } from 'vitest';

import { __testing } from './memory/context-assembly.js';
import type {
  ContextCompactionRecord,
  ContextEntryRecord,
} from './types.js';

function createEntry(
  id: string,
  createdAt: string,
  overrides?: Partial<ContextEntryRecord>,
): ContextEntryRecord {
  return {
    id,
    group_folder: 'budget-group',
    chat_jid: 'budget-chat',
    run_id: null,
    provider: 'system',
    role: 'user',
    source_type: 'chat_message',
    source_ref: id,
    content_text: id,
    content_json: null,
    token_estimate: 10,
    created_at: createdAt,
    ...overrides,
  };
}

function createSummary(
  text: string,
): ContextCompactionRecord {
  return {
    id: 'summary-1',
    group_folder: 'budget-group',
    chat_jid: 'budget-chat',
    compacted_until: '2026-03-18T09:59:00.000Z',
    summary_text: text,
    source_entry_ids_json: '[]',
    created_at: '2026-03-18T10:00:00.000Z',
  };
}

describe('context budget assembly helper', () => {
  it('prioritizes summary and recall buckets before recent raw entries', () => {
    const summary = createSummary('summary');
    const recall = createEntry('recall-1', '2026-03-18T10:00:01.000Z', {
      role: 'memory',
      source_type: 'memory_recall',
      token_estimate: 8,
    });
    const rawA = createEntry('raw-a', '2026-03-18T10:00:02.000Z', {
      token_estimate: 11,
    });
    const rawB = createEntry('raw-b', '2026-03-18T10:00:03.000Z', {
      token_estimate: 10,
    });

    const entries = __testing.buildPromptEntriesWithBudget({
      latestSummary: summary,
      recentRecallEntries: [recall],
      recentRawEntries: [rawA, rawB],
      maxSnippets: 4,
      tokenBudget: 30,
      summaryRatio: 40,
      recallRatio: 30,
      recentRatio: 30,
    });

    expect(entries.map((entry) => entry.source_type)).toEqual([
      'compaction_summary',
      'memory_recall',
      'chat_message',
    ]);
    expect(entries.at(-1)?.id).toBe('raw-b');
  });

  it('selects newest raw entries first but preserves chronological output order', () => {
    const rawA = createEntry('raw-a', '2026-03-18T10:00:01.000Z', {
      token_estimate: 10,
    });
    const rawB = createEntry('raw-b', '2026-03-18T10:00:02.000Z', {
      token_estimate: 10,
    });
    const rawC = createEntry('raw-c', '2026-03-18T10:00:03.000Z', {
      token_estimate: 10,
    });

    const entries = __testing.buildPromptEntriesWithBudget({
      recentRecallEntries: [],
      recentRawEntries: [rawA, rawB, rawC],
      maxSnippets: 2,
      tokenBudget: 20,
      summaryRatio: 0,
      recallRatio: 0,
      recentRatio: 100,
    });

    expect(entries.map((entry) => entry.id)).toEqual(['raw-b', 'raw-c']);
  });

  it('returns no entries when the budget is exhausted before any bucket can fit', () => {
    const summary = createSummary('x'.repeat(64));

    const entries = __testing.buildPromptEntriesWithBudget({
      latestSummary: summary,
      recentRecallEntries: [],
      recentRawEntries: [],
      maxSnippets: 3,
      tokenBudget: 10,
      summaryRatio: 50,
      recallRatio: 25,
      recentRatio: 25,
    });

    expect(entries).toEqual([]);
  });
});
