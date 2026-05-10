export interface MemoryIdentityAlias {
  channel: string | null;
  externalUserId: string | null;
  displayName: string | null;
}

export interface MemoryIdentityProfile {
  id: string;
  displayName: string;
  notes: string[];
  aliases: MemoryIdentityAlias[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationIdentityBinding {
  chatJid: string;
  groupFolder: string;
  personId: string;
  boundAt: string;
}

export interface MemoryIdentityDetail {
  profile: MemoryIdentityProfile;
  bindings: ConversationIdentityBinding[];
}

export interface CreateMemoryIdentityInput {
  id?: string;
  displayName: string;
  notes?: string[];
  aliases?: Array<Partial<MemoryIdentityAlias> | null | undefined>;
}

export interface BindConversationIdentityInput {
  chatJid: string;
  groupFolder: string;
  personId: string;
}

export interface MemoryIdentityRepository {
  listProfiles(): Promise<MemoryIdentityProfile[]>;
  getProfile(id: string): Promise<MemoryIdentityProfile | null>;
  createProfile(input: {
    id: string;
    displayName: string;
    notes: string[];
    aliases: MemoryIdentityAlias[];
  }): Promise<MemoryIdentityProfile>;
  bindConversation(
    input: BindConversationIdentityInput,
  ): Promise<ConversationIdentityBinding>;
  listBindingsForPerson(
    personId: string,
  ): Promise<ConversationIdentityBinding[]>;
}

export interface MemoryIdentityService {
  listProfiles(): Promise<MemoryIdentityProfile[]>;
  getIdentityDetail(id: string): Promise<MemoryIdentityDetail | null>;
  createProfile(input: CreateMemoryIdentityInput): Promise<MemoryIdentityProfile>;
  bindConversation(
    input: BindConversationIdentityInput,
  ): Promise<ConversationIdentityBinding>;
}

function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeAlias(
  input: Partial<MemoryIdentityAlias> | null | undefined,
): MemoryIdentityAlias | null {
  if (!input) return null;
  const channel = normalizeWhitespace(String(input.channel || '')).toLowerCase();
  const externalUserId = normalizeWhitespace(String(input.externalUserId || ''));
  const displayName = normalizeWhitespace(String(input.displayName || ''));
  if (!channel && !externalUserId && !displayName) {
    return null;
  }
  return {
    channel: channel || null,
    externalUserId: externalUserId || null,
    displayName: displayName || null,
  };
}

function dedupeAliases(
  aliases: Array<Partial<MemoryIdentityAlias> | null | undefined>,
): MemoryIdentityAlias[] {
  const seen = new Set<string>();
  const result: MemoryIdentityAlias[] = [];
  for (const rawAlias of aliases) {
    const alias = normalizeAlias(rawAlias);
    if (!alias) continue;
    const key = JSON.stringify(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(alias);
  }
  return result;
}

export function normalizeMemoryIdentityId(
  value: unknown,
  fallbackDisplayName = '',
): string {
  const raw = normalizeWhitespace(
    typeof value === 'string' && value ? value : fallbackDisplayName,
  ).toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized;
}

export function createMemoryIdentityService(
  repository: MemoryIdentityRepository,
): MemoryIdentityService {
  return {
    async listProfiles(): Promise<MemoryIdentityProfile[]> {
      return repository.listProfiles();
    },

    async getIdentityDetail(id: string): Promise<MemoryIdentityDetail | null> {
      const normalizedId = normalizeMemoryIdentityId(id);
      if (!normalizedId) return null;
      const profile = await repository.getProfile(normalizedId);
      if (!profile) return null;
      return {
        profile,
        bindings: await repository.listBindingsForPerson(profile.id),
      };
    },

    async createProfile(
      input: CreateMemoryIdentityInput,
    ): Promise<MemoryIdentityProfile> {
      const displayName = normalizeWhitespace(input.displayName);
      if (!displayName) {
        throw new Error('displayName is required');
      }
      const id = normalizeMemoryIdentityId(input.id, displayName);
      if (!id) {
        throw new Error('id is required');
      }
      return repository.createProfile({
        id,
        displayName,
        notes: uniqueStrings(input.notes || []),
        aliases: dedupeAliases(input.aliases || []),
      });
    },

    async bindConversation(
      input: BindConversationIdentityInput,
    ): Promise<ConversationIdentityBinding> {
      const chatJid = normalizeWhitespace(input.chatJid);
      const groupFolder = normalizeWhitespace(input.groupFolder);
      const personId = normalizeMemoryIdentityId(input.personId);
      if (!chatJid) {
        throw new Error('chatJid is required');
      }
      if (!groupFolder) {
        throw new Error('groupFolder is required');
      }
      if (!personId) {
        throw new Error('personId is required');
      }
      if (!(await repository.getProfile(personId))) {
        throw new Error(`Identity not found: ${personId}`);
      }
      return repository.bindConversation({
        chatJid,
        groupFolder,
        personId,
      });
    },
  };
}
