import { readFileSync, writeFileSync } from 'fs';

let code = readFileSync('src/db.ts', 'utf8');
const lines = code.split('\n');

// Phase 1: Wrap return types of async functions in Promise<>
let inAsyncFn = false;
let parenDepth = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (/^export async function/.test(line)) {
    inAsyncFn = true;
    parenDepth = 0;
  }

  if (inAsyncFn) {
    for (const ch of line) {
      if (ch === '(') parenDepth++;
      if (ch === ')') parenDepth--;
    }

    if (parenDepth <= 0) {
      const m = line.match(/^(.*\)):\s*(?!Promise<)(.+?)\s*(\{)\s*$/);
      if (m) {
        const type = m[2].trim();
        lines[i] = `${m[1]}: Promise<${type}> ${m[3]}`;
      }
      inAsyncFn = false;
    }
  }
}

// Phase 2: Make non-exported functions async if they contain "await dba.prepare("
// Find function bodies and check if they contain await
code = lines.join('\n');

// Make private/non-exported functions that use await into async functions
code = code.replace(
  /^(function )(\w+)(\([^)]*\)(?::\s*[^{]+)?)\s*\{/gm,
  (match, prefix, name, rest) => {
    // Check if this function body contains "await dba."
    const fnStart = code.indexOf(match);
    const bodyStart = fnStart + match.length;
    // Simple heuristic: look ahead ~2000 chars for await dba.
    const lookahead = code.slice(bodyStart, bodyStart + 2000);
    if (lookahead.includes('await dba.')) {
      // Also wrap return type in Promise<> if present
      const typeMatch = rest.match(/^(\([^)]*\)):\s*(.+)$/);
      if (typeMatch && !typeMatch[2].startsWith('Promise<')) {
        return `async function ${name}${typeMatch[1]}: Promise<${typeMatch[2].trim()}> {`;
      }
      return `async ${prefix}${name}${rest} {`;
    }
    return match;
  }
);

// Phase 3: Handle migrateJsonState - make it async
code = code.replace(
  /^function migrateJsonState\(\)/gm,
  'async function migrateJsonState()'
);

// Phase 4: Fix calls to now-async functions within transaction callbacks
// Make sure functions called in transactions are awaited
// This is hard to do generically, so we'll fix it with the compiler

writeFileSync('src/db.ts', code);
console.log('Type fixes applied');
