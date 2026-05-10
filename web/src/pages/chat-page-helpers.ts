import type { ChatTimelineEntry } from '../app-types';
import { isOptimisticThinkingItem } from '../app-helpers';

const GENERATED_IMAGE_PATH_RE =
  /\/workspace\/group\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)/gi;

function hasVisibleLiveAssistantTimelineEntry(
  entries: ChatTimelineEntry[],
): boolean {
  return entries.some((entry) => {
    if (entry.kind === 'assistant_message') {
      return entry.status === 'in_progress';
    }
    if (entry.kind === 'tool_call') {
      return entry.item.status === 'in_progress';
    }
    if (entry.kind === 'approval') {
      return true;
    }
    if (entry.kind === 'reasoning') {
      return (
        entry.item.status === 'in_progress' &&
        !isOptimisticThinkingItem(entry.item.id)
      );
    }
    return false;
  });
}

export function shouldShowInlineAssistantLoading(input: {
  timelineEntries: ChatTimelineEntry[];
  typing: boolean;
  streaming: boolean;
}): boolean {
  const { timelineEntries, typing, streaming } = input;
  return (
    typing &&
    !streaming &&
    !hasVisibleLiveAssistantTimelineEntry(timelineEntries)
  );
}

export function extractGeneratedImageWorkspacePaths(
  output: string | undefined,
): string[] {
  if (!output) return [];
  const matches = output.match(GENERATED_IMAGE_PATH_RE) || [];
  return Array.from(new Set(matches.map((entry) => entry.trim())));
}

export function getLatestRegeneratableAssistantTurnId(
  entries: ChatTimelineEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === 'assistant_message' &&
      entry.status === 'completed' &&
      entry.turnId
    ) {
      return entry.turnId;
    }
  }
  return null;
}
