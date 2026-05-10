#!/usr/bin/env node
/**
 * Phase 1.8: Migrate all callers of db.ts to use `await`.
 *
 * Strategy:
 *   1. Parse exported async function names from db.ts
 *   2. For each caller file, find imports from db.js
 *   3. Add `await` before each call to those functions
 *   4. Make enclosing functions `async` if they aren't already
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '..', 'src');

// ── Step 1: Get all exported async function names from db.ts ──────

const dbCode = readFileSync(resolve(srcDir, 'db.ts'), 'utf8');
const exportedAsyncFns = new Set();
const fnRegex = /export\s+async\s+function\s+(\w+)/g;
let m;
while ((m = fnRegex.exec(dbCode)) !== null) {
  exportedAsyncFns.add(m[1]);
}
console.log(`Found ${exportedAsyncFns.size} exported async functions in db.ts`);

// ── Step 2: Parse error output for affected files ─────────────────

const errFile = resolve(__dirname, '..', 'tmp_errors.txt');
const errLines = readFileSync(errFile, 'utf8')
  .split('\n')
  .filter((l) => l.includes('error TS'));

const affectedFiles = new Set();
for (const line of errLines) {
  const fm = line.match(/^(.+?)\(/);
  if (fm) affectedFiles.add(fm[1]);
}

// ── Step 3: Process each affected file ────────────────────────────

let totalFiles = 0;
let totalAwaits = 0;

for (const relPath of affectedFiles) {
  const absPath = resolve(__dirname, '..', relPath);
  if (!existsSync(absPath)) continue;

  let code = readFileSync(absPath, 'utf8');

  // Find imports from db.js
  const importedNames = new Set();
  const importRegex =
    /import\s*\{([^}]+)\}\s*from\s*['"](?:\.\.?\/)*db\.js['"]/g;
  let im;
  while ((im = importRegex.exec(code)) !== null) {
    const names = im[1].split(',').map((n) => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim(); // use alias if renamed
    });
    for (const name of names) {
      if (name && !name.startsWith('type ') && !name.startsWith('type\t')) {
        // skip type-only imports
        const cleanName = name.replace(/^type\s+/, '');
        if (exportedAsyncFns.has(cleanName)) {
          importedNames.add(cleanName);
        }
      }
    }
  }

  // Also check `import type { ... }` separately — skip those entirely
  // Filter out type-only imported names
  const typeImportRegex =
    /import\s+type\s*\{([^}]+)\}\s*from\s*['"](?:\.\.?\/)*db\.js['"]/g;
  while ((im = typeImportRegex.exec(code)) !== null) {
    const names = im[1].split(',').map((n) => n.trim());
    for (const name of names) {
      importedNames.delete(name);
    }
  }

  if (importedNames.size === 0) continue;

  let fileChanges = 0;
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const fnName of importedNames) {
      // Skip if this is an import line
      if (line.includes('from') && line.includes('db.js')) continue;
      // Skip comments
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      const callIdx = line.indexOf(fnName + '(');
      if (callIdx === -1) continue;

      // Check we're not matching a substring of a longer identifier
      if (callIdx > 0) {
        const prevChar = line[callIdx - 1];
        if (/[\w$.]/.test(prevChar)) continue;
      }

      // Check if already has `await` before it
      const beforeCall = line.substring(0, callIdx);
      if (/await\s+$/.test(beforeCall)) continue;

      // Determine the pattern and apply fix
      // Pattern 1: `= fnName(` → `= await fnName(`
      // Pattern 2: `return fnName(` → `return await fnName(`
      // Pattern 3: `fnName(` at expression position → `await fnName(`
      // Pattern 4: `(fnName(` → `(await fnName(`
      // Pattern 5: `, fnName(` → `, await fnName(`
      // Pattern 6: `? fnName(` → `? await fnName(`
      // Pattern 7: `|| fnName(` → `|| await fnName(`
      // Pattern 8: `&& fnName(` → `&& await fnName(`

      // For chained access like `fnName(...).prop`, we'll need to wrap in parens
      // But let's first add the `await` — chained access fixing will need a second pass

      const newLine = line.substring(0, callIdx) + 'await ' + line.substring(callIdx);
      lines[i] = newLine;
      fileChanges++;
      break; // process one change per line at a time, re-process in next iteration
    }
  }

  if (fileChanges > 0) {
    // Now make enclosing functions async if they aren't
    let result = lines.join('\n');

    // Find functions that contain `await` but aren't `async`
    // This is a simplified approach — we look for function declarations
    // and check if they need to be async
    result = makeContainingFunctionsAsync(result);

    writeFileSync(absPath, result, 'utf8');
    totalFiles++;
    totalAwaits += fileChanges;
    console.log(`[${relPath}] +${fileChanges} awaits`);
  }
}

console.log(`\nDone: ${totalAwaits} await insertions across ${totalFiles} files`);

// ── Helper: Make functions containing `await` actually `async` ────

function makeContainingFunctionsAsync(code) {
  const lines = code.split('\n');
  
  // Track function scopes
  // We need to find function declarations that contain `await` in their body
  // but aren't marked `async`
  
  // Simple approach: find all function-like declarations, check if any line
  // in their body has `await`, and add `async` if missing
  
  // Patterns to look for:
  // - `export function name(` → `export async function name(`
  // - `function name(` → `async function name(`
  // - `name(params) {` method syntax
  // - arrow functions are trickier
  
  // First pass: find which line ranges are function bodies
  const fnStarts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match various function declaration patterns
    const patterns = [
      /^(\s*)(export\s+)?function\s+\w+/,
      /^(\s*)(export\s+)?const\s+\w+\s*=\s*(async\s+)?function/,
      /^(\s*)(export\s+)?const\s+\w+\s*=\s*(async\s+)?\(/,
      /^(\s*)(export\s+)?(async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
    ];
    
    for (const pat of patterns) {
      if (pat.test(line)) {
        const hasAsync = /\basync\b/.test(line);
        fnStarts.push({ line: i, hasAsync });
        break;
      }
    }
  }
  
  // For each non-async function, check if any of its body lines has `await`
  for (const fn of fnStarts) {
    if (fn.hasAsync) continue;
    
    // Find the function body by tracking braces
    let braceCount = 0;
    let started = false;
    let hasAwait = false;
    
    for (let i = fn.line; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') { braceCount++; started = true; }
        if (ch === '}') { braceCount--; }
      }
      if (started && i > fn.line && /\bawait\b/.test(line)) {
        hasAwait = true;
      }
      if (started && braceCount === 0) break;
    }
    
    if (hasAwait) {
      // Add `async` to the function declaration
      const line = lines[fn.line];
      
      if (/export\s+function\s/.test(line)) {
        lines[fn.line] = line.replace(/export\s+function\s/, 'export async function ');
      } else if (/^(\s*)function\s/.test(line)) {
        lines[fn.line] = line.replace(/^(\s*)function\s/, '$1async function ');
      } else if (/const\s+\w+\s*=\s*\(/.test(line) && !/async/.test(line)) {
        lines[fn.line] = line.replace(
          /const\s+(\w+)\s*=\s*\(/,
          'const $1 = async (',
        );
      } else if (/const\s+\w+\s*=\s*function/.test(line) && !/async/.test(line)) {
        lines[fn.line] = line.replace(
          /const\s+(\w+)\s*=\s*function/,
          'const $1 = async function',
        );
      }
    }
  }
  
  return lines.join('\n');
}
