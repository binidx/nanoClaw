import { readFileSync, writeFileSync } from 'fs';

let code = readFileSync('src/db.ts', 'utf8');

// Find the boundary after which all db references should use dba
// The boundary is after the createSchema and init functions
const BOUNDARY_MARKER = 'export async function storeChatMetadata(';
const boundaryIdx = code.indexOf(BOUNDARY_MARKER);

if (boundaryIdx === -1) {
  console.error('Could not find boundary marker');
  process.exit(1);
}

let before = code.slice(0, boundaryIdx);
let after = code.slice(boundaryIdx);

// Replace multi-line patterns:
// "db\n    .prepare(" → "await dba\n    .prepare("
// Various indentation levels

// Pattern: "= db\n" (assignment + newline)
after = after.replace(/= db\n(\s+)\.prepare\(/g, '= await dba\n$1.prepare(');

// Pattern: "return db\n" (return + newline)
after = after.replace(/return db\n(\s+)\.prepare\(/g, 'return await dba\n$1.prepare(');

// Pattern: "(db\n" (in parenthesized expressions)
after = after.replace(/\(db\n(\s+)\.prepare\(/g, '(await dba\n$1.prepare(');

// Pattern: "? db\n" (ternary)
after = after.replace(/\? db\n(\s+)\.prepare\(/g, '? await dba\n$1.prepare(');

// Pattern: ": db\n" (ternary else)
after = after.replace(/: db\n(\s+)\.prepare\(/g, ': await dba\n$1.prepare(');

// Also handle the standalone "db\n    .prepare" at start of line
after = after.replace(/^(\s+)db\n(\s+)\.prepare\(/gm, '$1await dba\n$2.prepare(');

// Handle "db.prepare" on same line (any that were missed)
after = after.replace(/(\s)db\.prepare\(/g, '$1await dba.prepare(');

// Handle the remaining db variable reference for initializeMemorySearchIndex
// This passes the raw db to search-index.ts functions
// For now, we'll keep this working for SQLite mode
// after = after.replace(/initializeMemorySearchIndex\(db\)/g, 'initializeMemorySearchIndex(db)');
// No change needed for now

writeFileSync('src/db.ts', before + after);
console.log('Fixed remaining db references');
