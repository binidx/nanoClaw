import { readFileSync, writeFileSync } from 'fs';

let code = readFileSync('src/db.ts', 'utf8');

// Functions to keep as sync
const SKIP_ASYNC = new Set([
  'initDatabaseSync',
  '_initTestDatabase',
  '_applySchemaToDatabaseForTest',
  'initDatabase', // already async
]);

// 1. Convert "export function" to "export async function" (skip known sync ones)
code = code.replace(
  /^(export function )(\w+)/gm,
  (match, prefix, name) => {
    if (SKIP_ASYNC.has(name)) return match;
    return `export async function ${name}`;
  }
);

// 2. Fix transaction assignments: remove await from dba.transaction() definition
//    Pattern: "const tx = await dba.transaction(" → "const tx = dba.transaction("
code = code.replace(/const tx = await dba\.transaction\(/g, 'const tx = dba.transaction(');

// 3. Fix transaction invocations: add await to tx() calls
code = code.replace(/^(\s+)tx\(/gm, '$1await tx(');

// 4. Fix transaction callbacks: make them async
//    Pattern: "dba.transaction((args) => {" → "dba.transaction(async (args) => {"
code = code.replace(
  /dba\.transaction\((\([^)]*\))\s*=>\s*\{/g,
  'dba.transaction(async $1 => {'
);

// 5. Fix storeMessage/storeContextEntry calls inside transaction lambdas 
//    that now need await (they call dba.prepare internally)
//    Pattern: "    storeContextEntry(entry);" inside transaction
//    These will be caught by the compiler since the functions are now async

writeFileSync('src/db.ts', code);
console.log('Conversion complete');
