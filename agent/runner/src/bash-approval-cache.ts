export interface BashApprovalPatchInput {
  command: string;
  expiresAt: string;
  cwd?: string;
}

export interface BashApprovalLookupInput {
  command: string;
  cwd?: string;
}

function normalizeBashApprovalCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function normalizeBashApprovalKey(input: BashApprovalLookupInput): string {
  const command = normalizeBashApprovalCommand(input.command);
  if (!command) return '';
  const cwd = (input.cwd || '').trim();
  return `${cwd}\n${command}`;
}

export function createBashApprovalCache() {
  const entries = new Map<string, number>();

  function prune(now = Date.now()): void {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    has(input: BashApprovalLookupInput, now = Date.now()): boolean {
      prune(now);
      const key = normalizeBashApprovalKey(input);
      if (!key) return false;
      return (entries.get(key) || 0) > now;
    },
    apply(patch: BashApprovalPatchInput, now = Date.now()): void {
      const key = normalizeBashApprovalKey(patch);
      if (!key) return;
      const expiresAt = Date.parse(patch.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
      entries.set(key, expiresAt);
      prune(now);
    },
  };
}
