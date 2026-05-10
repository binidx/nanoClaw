#!/usr/bin/env node
/**
 * Fix cascading async/await issues across the codebase.
 *
 * Strategy:
 *  1. Build a set of ALL async function names across all src files
 *  2. For each error line, find calls to async functions and add `await`
 *  3. Fix TS2304 (bad async placement) by removing misplaced `async`
 *  4. Fix TS1308 by making containing functions `async`
 *  5. Wrap return types in Promise<>
 *  6. Iterate until convergence
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function runTsc() {
  try {
    const out = execSync('npx tsc --noEmit 2>&1', {
      cwd: root,
      encoding: 'utf8',
      shell: 'cmd.exe',
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024,
    });
    return out.split('\n').filter((l) => l.includes('error TS'));
  } catch (e) {
    const combined = (e.stdout || '') + '\n' + (e.stderr || '');
    return combined.split('\n').filter((l) => l.includes('error TS'));
  }
}

// ── Collect all async function names across the project ───────────

function findTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (extname(entry) === '.ts' && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

const asyncFnNames = new Set();
const tsFiles = findTsFiles(resolve(root, 'src'));
for (const f of tsFiles) {
  const code = readFileSync(f, 'utf8');
  const regex = /(?:export\s+)?async\s+function\s+(\w+)/g;
  let m;
  while ((m = regex.exec(code)) !== null) {
    asyncFnNames.add(m[1]);
  }
  // Also catch `const name = async (` arrow functions
  const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*async\s*[\(<]/g;
  while ((m = arrowRegex.exec(code)) !== null) {
    asyncFnNames.add(m[1]);
  }
}
console.log(`Found ${asyncFnNames.size} async function names across project`);

// ── Fix functions ─────────────────────────────────────────────────

function fixFile(absPath, errorLines, errorTypes) {
  if (!existsSync(absPath)) return 0;
  let code = readFileSync(absPath, 'utf8');
  let lines = code.split('\n');
  let changes = 0;

  // Fix TS2304: Remove incorrectly placed `async`
  const ts2304Lines = errorLines.filter((_, i) => errorTypes[i] === 'TS2304');
  for (const lineNum of ts2304Lines) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const line = lines[idx];
    // Pattern: `= async (expression` where it's not a function
    if (/=\s*async\s+\((?!\s*\)|\s*\w+[,:)]|\s*\.\.\.)/.test(line)) {
      // Check it's not an arrow function (no => on this or next few lines)
      let isArrow = false;
      for (let k = idx; k < Math.min(lines.length, idx + 5); k++) {
        if (lines[k].includes('=>')) { isArrow = true; break; }
        if (k > idx && /^\s*\)\s*=>/.test(lines[k])) { isArrow = true; break; }
        if (k > idx && lines[k].includes('{') && !lines[k].includes('=>')) break;
      }
      if (!isArrow) {
        lines[idx] = line.replace(/=\s*async\s+\(/, '= (');
        changes++;
      }
    }
  }

  // Fix TS2339/TS2345/TS2488/TS2801: Add `await` before async function calls
  const awaitErrorLines = new Set(
    errorLines.filter((_, i) =>
      ['TS2339', 'TS2345', 'TS2488', 'TS2801', 'TS2322', 'TS2740', 'TS7006',
       'TS2367', 'TS2559', 'TS18046', 'TS18048', 'TS2352', 'TS2741'].includes(errorTypes[i])
    )
  );

  for (const lineNum of awaitErrorLines) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) continue;
    let line = lines[idx];

    // Find async function calls on this line
    for (const fnName of asyncFnNames) {
      const callPattern = new RegExp(`(?<!\\w)(?<!await\\s)${fnName}\\(`, 'g');
      let match;
      while ((match = callPattern.exec(line)) !== null) {
        const pos = match.index;
        // Verify it's not already awaited
        const before = line.substring(0, pos);
        if (/await\s+$/.test(before)) continue;

        // Add `await` before the function call
        line = line.substring(0, pos) + 'await ' + line.substring(pos);
        lines[idx] = line;
        changes++;
        break; // process one per line per pass
      }
      if (line !== lines[idx]) break;
    }
  }

  // Fix TS1308: Make functions with `await` async
  const ts1308Lines = errorLines.filter((_, i) => errorTypes[i] === 'TS1308');
  const madeAsync = new Set();

  for (const lineNum of ts1308Lines) {
    const idx = lineNum - 1;

    // Scan backwards to find containing function
    let depth = 0;
    let foundFn = -1;
    outer:
    for (let i = idx; i >= 0; i--) {
      for (let c = lines[i].length - 1; c >= 0; c--) {
        if (lines[i][c] === '}') depth++;
        if (lines[i][c] === '{') {
          depth--;
          if (depth < 0) {
            for (let j = i; j >= Math.max(0, i - 10); j--) {
              if (/\basync\b/.test(lines[j])) break;
              if (/\bfunction\s/.test(lines[j]) && !madeAsync.has(j)) {
                foundFn = j;
                break;
              }
              if (/(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/.test(lines[j]) && !madeAsync.has(j)) {
                foundFn = j;
                break;
              }
            }
            break outer;
          }
        }
      }
    }

    if (foundFn >= 0 && !/\basync\b/.test(lines[foundFn])) {
      if (/export\s+function\s/.test(lines[foundFn])) {
        lines[foundFn] = lines[foundFn].replace(/export\s+function\s/, 'export async function ');
        changes++;
        madeAsync.add(foundFn);
      } else if (/^\s*function\s/.test(lines[foundFn])) {
        lines[foundFn] = lines[foundFn].replace(/function\s/, 'async function ');
        changes++;
        madeAsync.add(foundFn);
      } else if (/=\s*\(/.test(lines[foundFn]) && !/async/.test(lines[foundFn])) {
        lines[foundFn] = lines[foundFn].replace(/=\s*\(/, '= async (');
        changes++;
        madeAsync.add(foundFn);
      }
    }
  }

  // Fix TS1064: Wrap return types
  const ts1064Lines = errorLines.filter((_, i) => errorTypes[i] === 'TS1064');
  for (const lineNum of ts1064Lines) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const line = lines[idx];

    // Find the suggested Promise type from the error
    const errIdx = errorLines.indexOf(lineNum);
    // We don't have the error message here... skip for now
  }

  if (changes > 0) {
    writeFileSync(absPath, lines.join('\n'), 'utf8');
  }
  return changes;
}

// ── Main loop ─────────────────────────────────────────────────────

for (let iteration = 1; iteration <= 8; iteration++) {
  console.log(`\n======== ITERATION ${iteration} ========`);
  console.log('Running tsc...');
  const errors = runTsc();
  console.log(`Errors: ${errors.length}`);

  if (errors.length === 0) {
    console.log('All errors fixed!');
    break;
  }

  // Group errors by file
  const byFile = {};
  for (const err of errors) {
    const m = err.match(/^(.+?)\((\d+),\d+\).*error (TS\d+)/);
    if (!m) continue;
    const relPath = m[1].replace(/^\uFEFF/, '');
    const lineNum = parseInt(m[2], 10);
    const code = m[3];
    if (!byFile[relPath]) byFile[relPath] = { lines: [], types: [] };
    byFile[relPath].lines.push(lineNum);
    byFile[relPath].types.push(code);
  }

  let totalChanges = 0;
  for (const [relPath, { lines: errLines, types: errTypes }] of Object.entries(byFile)) {
    const absPath = resolve(root, relPath);
    const changes = fixFile(absPath, errLines, errTypes);
    if (changes > 0) {
      totalChanges += changes;
      console.log(`  [${relPath}] +${changes} fixes`);
    }
  }

  if (totalChanges === 0) {
    console.log('No automatic fixes applied. Remaining errors need manual attention.');

    // Show summary
    const byCode = {};
    errors.forEach((l) => {
      const m = l.match(/error (TS\d+)/);
      if (m) byCode[m[1]] = (byCode[m[1]] || 0) + 1;
    });
    console.log('\nRemaining errors by type:');
    Object.entries(byCode)
      .sort((a, b) => b[1] - a[1])
      .forEach(([c, n]) => console.log(`  ${n} ${c}`));
    break;
  }

  console.log(`Applied ${totalChanges} fixes total`);
}
