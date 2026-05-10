#!/usr/bin/env node
/**
 * Pass 2: Fix remaining issues after caller migration.
 *
 * Handles:
 *   1. TS2304: Incorrectly placed `async` keywords (5 errors)
 *   2. TS1064: Return types need Promise<> wrapping (185 errors)
 *   3. TS1308: `await` in non-async functions (131 errors)
 *   4. TS2339/TS2345: Remaining missing awaits (re-run insertion)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const errFile = resolve(__dirname, '..', 'tmp_build2.txt');
const errText = readFileSync(errFile, 'utf8');
const allErrors = errText.split('\n').filter((l) => l.includes('error TS'));

// ── Fix 1: Remove incorrectly placed `async` (TS2304) ────────────

const ts2304Errors = allErrors.filter((l) => l.includes('TS2304'));
const fixedFiles = new Set();

for (const err of ts2304Errors) {
  const m = err.match(/^(.+?)\((\d+),(\d+)\)/);
  if (!m) continue;
  const [, relPath, lineStr] = m;
  const line = parseInt(lineStr, 10);
  const absPath = resolve(__dirname, '..', relPath.replace(/^\uFEFF/, ''));
  if (!existsSync(absPath)) continue;

  const code = readFileSync(absPath, 'utf8');
  const lines = code.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) continue;

  const src = lines[idx];
  // Pattern: `const/let/var name = async (expression`
  // Check if this is an IIFE `async (() => {` → `(async () => {`
  if (/=\s*async\s+\(\(\)\s*=>/.test(src)) {
    lines[idx] = src.replace(/=\s*async\s+\(\(\)\s*=>/, '= (async () =>');
  } else if (/=\s*async\s+\(async\s+\(\)\s*=>/.test(src)) {
    // Double async? Remove one
    lines[idx] = src.replace(/=\s*async\s+\(async\s+\(\)\s*=>/, '= (async () =>');
  } else if (/=\s*async\s+\(/.test(src)) {
    // Not a function — just remove `async `
    lines[idx] = src.replace(/=\s*async\s+\(/, '= (');
  }

  writeFileSync(absPath, lines.join('\n'), 'utf8');
  fixedFiles.add(relPath);
}
console.log(`[Fix1] Fixed ${ts2304Errors.length} incorrectly placed async in ${fixedFiles.size} files`);

// ── Fix 2: Wrap return types in Promise<> for TS1064 ──────────────

const ts1064Errors = allErrors.filter((l) => l.includes('TS1064'));
// Group by file
const ts1064ByFile = {};
for (const err of ts1064Errors) {
  const m = err.match(/^(.+?)\((\d+),(\d+)\)/);
  if (!m) continue;
  const [, relPath, lineStr] = m;
  const line = parseInt(lineStr, 10);
  if (!ts1064ByFile[relPath]) ts1064ByFile[relPath] = [];
  ts1064ByFile[relPath].push(line);
}

let ts1064Fixed = 0;
for (const [relPath, errorLines] of Object.entries(ts1064ByFile)) {
  const absPath = resolve(__dirname, '..', relPath.replace(/^\uFEFF/, ''));
  if (!existsSync(absPath)) continue;
  
  let code = readFileSync(absPath, 'utf8');
  const lines = code.split('\n');
  
  // Sort in reverse order so line modifications don't affect other line indices
  const sortedLines = [...new Set(errorLines)].sort((a, b) => b - a);
  
  for (const lineNum of sortedLines) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) continue;
    
    const line = lines[idx];
    // This line has a return type annotation that needs Promise<> wrapping
    // Patterns:
    //   `): ReturnType {` → `): Promise<ReturnType> {`
    //   `): ReturnType[] {` → `): Promise<ReturnType[]> {`
    //   `}: ReturnType {` → ... (object destructuring params)
    
    // Look for ): Type { or ): Type => pattern
    // The return type could span multiple lines, so check this line and previous lines
    
    // Simple case: return type is on this line
    const retTypeMatch = line.match(/\):\s*(.+?)\s*\{$/);
    if (retTypeMatch) {
      const retType = retTypeMatch[1].trim();
      if (!retType.startsWith('Promise<')) {
        const wrapped = `Promise<${retType}>`;
        lines[idx] = line.replace(/\):\s*.+?\s*\{$/, `): ${wrapped} {`);
        ts1064Fixed++;
        continue;
      }
    }
    
    // Could also be a multi-line return type — check if the return type is
    // on this line but the opening brace is on a later line
    const retTypeMatch2 = line.match(/\):\s*(.+)$/);
    if (retTypeMatch2 && !retTypeMatch2[1].includes('{') && !retTypeMatch2[1].includes('=>')) {
      const retType = retTypeMatch2[1].trim();
      if (!retType.startsWith('Promise<') && retType.length > 0) {
        const wrapped = `Promise<${retType}>`;
        lines[idx] = line.replace(/\):\s*.+$/, `): ${wrapped}`);
        ts1064Fixed++;
        continue;
      }
    }

    // Return type on the PREVIOUS line(s) — check for standalone type annotation
    // Pattern: previous line ends with `)` or has ): Type
    if (idx > 0) {
      const prevLine = lines[idx - 1];
      const prevRetMatch = prevLine.match(/\):\s*(.+)$/);
      if (prevRetMatch) {
        const retType = prevRetMatch[1].trim();
        if (!retType.startsWith('Promise<') && retType.length > 0) {
          const wrapped = `Promise<${retType}>`;
          lines[idx - 1] = prevLine.replace(/\):\s*.+$/, `): ${wrapped}`);
          ts1064Fixed++;
          continue;
        }
      }
    }
  }
  
  writeFileSync(absPath, lines.join('\n'), 'utf8');
}
console.log(`[Fix2] Wrapped ${ts1064Fixed} return types in Promise<>`);

// ── Fix 3: Make functions with `await` async (TS1308) ─────────────

const ts1308Errors = allErrors.filter((l) => l.includes('TS1308'));
const ts1308ByFile = {};
for (const err of ts1308Errors) {
  const m = err.match(/^(.+?)\((\d+),(\d+)\)/);
  if (!m) continue;
  const [, relPath, lineStr] = m;
  const line = parseInt(lineStr, 10);
  if (!ts1308ByFile[relPath]) ts1308ByFile[relPath] = [];
  ts1308ByFile[relPath].push(line);
}

let ts1308Fixed = 0;
for (const [relPath, awaitLines] of Object.entries(ts1308ByFile)) {
  const absPath = resolve(__dirname, '..', relPath.replace(/^\uFEFF/, ''));
  if (!existsSync(absPath)) continue;
  
  let code = readFileSync(absPath, 'utf8');
  const lines = code.split('\n');
  
  for (const awaitLine of awaitLines) {
    const awaitIdx = awaitLine - 1;
    
    // Find the containing function by scanning backwards
    let braceCount = 0;
    let foundFnLine = -1;
    
    for (let i = awaitIdx; i >= 0; i--) {
      const line = lines[i];
      for (let c = line.length - 1; c >= 0; c--) {
        if (line[c] === '}') braceCount++;
        if (line[c] === '{') {
          braceCount--;
          if (braceCount < 0) {
            // We've gone one level up — this opening brace starts the function body
            // Find the function declaration — it's on this line or a previous one
            for (let j = i; j >= Math.max(0, i - 5); j--) {
              const decl = lines[j];
              if (/\basync\b/.test(decl)) {
                // Already async
                foundFnLine = -1;
                break;
              }
              if (/\bfunction\b/.test(decl)) {
                foundFnLine = j;
                break;
              }
              // Arrow function: look for `=>` or `= (`
              if (/=>\s*\{?\s*$/.test(decl) || /=>\s*$/.test(decl)) {
                // Find the variable declaration line
                for (let k = j; k >= Math.max(0, j - 3); k--) {
                  if (/\bconst\b|\blet\b|\bvar\b/.test(lines[k]) || /^\s*\(/.test(lines[k])) {
                    foundFnLine = k;
                    break;
                  }
                }
                break;
              }
              // Method syntax: `name(params) {`
              if (/\w+\s*\([^)]*\)\s*\{?\s*$/.test(decl) && !decl.includes('if') && !decl.includes('for') && !decl.includes('while') && !decl.includes('switch') && !decl.includes('catch')) {
                foundFnLine = j;
                break;
              }
            }
            break;
          }
        }
      }
      if (braceCount < 0) break;
    }
    
    if (foundFnLine >= 0 && !/\basync\b/.test(lines[foundFnLine])) {
      const fnLine = lines[foundFnLine];
      
      if (/export\s+function\s/.test(fnLine)) {
        lines[foundFnLine] = fnLine.replace(/export\s+function\s/, 'export async function ');
        ts1308Fixed++;
      } else if (/^\s*function\s/.test(fnLine)) {
        lines[foundFnLine] = fnLine.replace(/function\s/, 'async function ');
        ts1308Fixed++;
      } else if (/\bconst\s+\w+\s*=\s*\(/.test(fnLine) && !fnLine.includes('async')) {
        // Arrow function — but be careful not to match non-function patterns
        // Check if there's a `=>` on this line or the next few lines
        let isArrow = false;
        for (let k = foundFnLine; k < Math.min(lines.length, foundFnLine + 5); k++) {
          if (lines[k].includes('=>')) { isArrow = true; break; }
          if (lines[k].includes('{') && !lines[k].includes('=>')) break;
        }
        if (isArrow) {
          lines[foundFnLine] = fnLine.replace(
            /(\bconst\s+\w+\s*=\s*)/,
            '$1async ',
          );
          ts1308Fixed++;
        }
      }
    }
  }
  
  writeFileSync(absPath, lines.join('\n'), 'utf8');
}
console.log(`[Fix3] Made ${ts1308Fixed} containing functions async`);

console.log('\nPass 2 complete. Re-run tsc to check progress.');
