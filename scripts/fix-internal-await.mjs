import { readFileSync, writeFileSync } from 'fs';

let code = readFileSync('src/db.ts', 'utf8');

// Phase 1: Fix functions that were incorrectly made async
// These are pure functions with no DB calls

// shouldPreferParticipantName - pure boolean function
code = code.replace(
  'async function shouldPreferParticipantName(',
  'function shouldPreferParticipantName('
);
code = code.replace(
  /shouldPreferParticipantName\(([^)]+)\):\s*Promise<boolean>/g,
  'shouldPreferParticipantName($1): boolean'
);

// normalizeIdentityAliases - pure transformation
code = code.replace(
  'async function normalizeIdentityAliases(',
  'function normalizeIdentityAliases('
);

// buildDeterministicContextCompactionSummary - if it was incorrectly made async
code = code.replace(
  'async function buildDeterministicContextCompactionSummary(',
  'function buildDeterministicContextCompactionSummary('
);

// normalizeMemoryText - pure function
code = code.replace(
  'async function normalizeMemoryText(',
  'function normalizeMemoryText('
);

// normalizeMemoryNotes - pure function  
code = code.replace(
  'async function normalizeMemoryNotes(',
  'function normalizeMemoryNotes('
);

// createPlaceholders - pure function
code = code.replace(
  'async function createPlaceholders(',
  'function createPlaceholders('
);

// safeParseJson - pure function
code = code.replace(
  'async function safeParseJson(',
  'function safeParseJson('
);
code = code.replace(
  'async function safeParseJson<',
  'function safeParseJson<'
);

// safeParseJsonArray - pure function
code = code.replace(
  'async function safeParseJsonArray(',
  'function safeParseJsonArray('
);

// Phase 2: Add `await` to calls to known async db functions within db.ts
// Pattern: function calls that are now async but called without await

// Look for these patterns and add await:
// "const x = someAsyncFn(" → "const x = await someAsyncFn("
// "someAsyncFn(" at statement start → "await someAsyncFn("

const asyncDbFunctions = [
  'getCompactionEligibleContextEntries',
  'getLatestContextCompaction',
  'storeContextCompaction',
  'getPersonProfile',
  'listIdentityAliases',
  'deleteMemoryDocumentsByPathRefs',
  'deleteMemoryDocumentSyncStates',
  'upsertMemoryDocuments',
  'storeContextEntry',
  'storeContextEntries',
  'storeAssistantTurnSnapshot',
  'storeMessageDirect',
  'hasStoredMessage',
  'storeChatMetadata',
  'getRegisteredGroup',
  'setRegisteredGroup',
  'getConfig',
  'setConfig',
  'getTicketWorkspaceById',
  'deleteTicketCodeIndexSnapshot',
  'getDueTasks',
  'getStockAnalysisConfigState',
  'upsertConversationParticipant',
  'updatePersonProfile',
  'getConversationIdentityBinding',
  'bindConversationIdentity',
];

for (const fn of asyncDbFunctions) {
  // Pattern: "  fn(" at start of line (statement call, not in an expression)
  // These need "await " added
  const stmtPattern = new RegExp(`^(\\s+)(${fn}\\()`, 'gm');
  code = code.replace(stmtPattern, (match, indent, call) => {
    if (match.includes('await ')) return match;
    return `${indent}await ${call}`;
  });

  // Pattern: "= fn(" (assignment)
  // These need "await " added
  const assignPattern = new RegExp(`(=\\s*)(${fn}\\()`, 'g');
  code = code.replace(assignPattern, (match, eq, call) => {
    if (match.includes('await ')) return match;
    return `${eq}await ${call}`;
  });
}

writeFileSync('src/db.ts', code);
console.log('Internal await fixes applied');
