import type {
  ConversationTavernBindingRecord,
  TavernPersonaRecord,
} from '../types.js';

export interface TavernPersonaSnapshot {
  id: string;
  name: string;
  avatarPath: string | null;
  summary: string | null;
  personalityPrompt: string | null;
  scenario: string | null;
  firstMessage: string | null;
  alternateGreetings: string[];
  exampleDialogues: string | null;
  systemPrompt: string | null;
  creatorNotes: string | null;
  tags: string[];
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildTavernPersonaSnapshot(
  persona: TavernPersonaRecord,
): TavernPersonaSnapshot {
  return {
    id: persona.id,
    name: persona.name,
    avatarPath: persona.avatar_path,
    summary: persona.summary,
    personalityPrompt: persona.personality_prompt,
    scenario: persona.scenario,
    firstMessage: persona.first_message,
    alternateGreetings: parseJsonStringArray(persona.alternate_greetings_json),
    exampleDialogues: persona.example_dialogues,
    systemPrompt: persona.system_prompt,
    creatorNotes: persona.creator_notes,
    tags: parseJsonStringArray(persona.tags_json),
  };
}

export function parseTavernPersonaSnapshot(
  raw: string | null | undefined,
): TavernPersonaSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TavernPersonaSnapshot>;
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
    if (!id || !name) return null;
    return {
      id,
      name,
      avatarPath:
        typeof parsed.avatarPath === 'string' && parsed.avatarPath.trim()
          ? parsed.avatarPath.trim()
          : null,
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : null,
      personalityPrompt:
        typeof parsed.personalityPrompt === 'string' &&
        parsed.personalityPrompt.trim()
          ? parsed.personalityPrompt.trim()
          : null,
      scenario:
        typeof parsed.scenario === 'string' && parsed.scenario.trim()
          ? parsed.scenario.trim()
          : null,
      firstMessage:
        typeof parsed.firstMessage === 'string' && parsed.firstMessage.trim()
          ? parsed.firstMessage.trim()
          : null,
      alternateGreetings: Array.isArray(parsed.alternateGreetings)
        ? parsed.alternateGreetings
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter(Boolean)
        : [],
      exampleDialogues:
        typeof parsed.exampleDialogues === 'string' &&
        parsed.exampleDialogues.trim()
          ? parsed.exampleDialogues.trim()
          : null,
      systemPrompt:
        typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim()
          ? parsed.systemPrompt.trim()
          : null,
      creatorNotes:
        typeof parsed.creatorNotes === 'string' && parsed.creatorNotes.trim()
          ? parsed.creatorNotes.trim()
          : null,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter(Boolean)
        : [],
    };
  } catch {
    return null;
  }
}

export function serializeTavernPersonaSnapshot(
  snapshot: TavernPersonaSnapshot,
): string {
  return JSON.stringify(snapshot);
}

function pushSection(
  sections: string[],
  title: string,
  value: string | null | undefined,
): void {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return;
  sections.push(`${title}\n${text}`);
}

export function buildTavernSystemPrompt(
  snapshot: TavernPersonaSnapshot | null | undefined,
): string {
  if (!snapshot) return '';
  const sections: string[] = [
    `You are roleplaying as "${snapshot.name}". Stay in character and keep your responses consistent with this persona unless a higher-priority system or safety rule requires otherwise.`,
  ];
  pushSection(sections, '## Character Summary', snapshot.summary);
  pushSection(sections, '## Personality', snapshot.personalityPrompt);
  pushSection(sections, '## Scenario', snapshot.scenario);
  pushSection(sections, '## System Notes', snapshot.systemPrompt);
  pushSection(sections, '## Example Dialogues', snapshot.exampleDialogues);
  if (snapshot.tags.length > 0) {
    sections.push(`## Tags\n${snapshot.tags.join(', ')}`);
  }
  return sections.join('\n\n').trim();
}

export function selectTavernOpeningMessage(
  snapshot: TavernPersonaSnapshot | null | undefined,
): string {
  if (!snapshot) return '';
  return (
    snapshot.firstMessage?.trim() ||
    snapshot.alternateGreetings.find((entry) => entry.trim()) ||
    ''
  );
}

export function buildTavernPersonaView(
  persona: TavernPersonaRecord,
): TavernPersonaRecord & {
  alternate_greetings: string[];
  tags: string[];
  prompt_preview: string;
  opener_preview: string;
} {
  const snapshot = buildTavernPersonaSnapshot(persona);
  return {
    ...persona,
    alternate_greetings: snapshot.alternateGreetings,
    tags: snapshot.tags,
    prompt_preview: buildTavernSystemPrompt(snapshot),
    opener_preview: selectTavernOpeningMessage(snapshot),
  };
}

export function buildTavernSnapshotFromBinding(
  binding: ConversationTavernBindingRecord | undefined | null,
): TavernPersonaSnapshot | null {
  if (!binding?.snapshot_json) return null;
  return parseTavernPersonaSnapshot(binding.snapshot_json);
}

