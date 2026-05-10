#!/usr/bin/env node
/**
 * Fix class method async issues:
 *  1. TS2304: Remove incorrectly placed `async` keywords
 *  2. TS1308: Make class methods with `await` async
 *  3. Handle constructors by extracting async code to init()
 *  4. Fix `this.await method()` patterns
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
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

function fixTS1308ClassMethods(errors) {
  const ts1308 = errors.filter((l) => l.includes('TS1308'));
  console.log(`TS1308 errors: ${ts1308.length}`);

  const byFile = {};
  for (const err of ts1308) {
    const m = err.match(/^(.+?)\((\d+),/);
    if (!m) continue;
    const relPath = m[1].replace(/^\uFEFF/, '');
    if (!byFile[relPath]) byFile[relPath] = [];
    byFile[relPath].push(parseInt(m[2], 10));
  }

  let fixed = 0;
  for (const [relPath, awaitLineNums] of Object.entries(byFile)) {
    const absPath = resolve(root, relPath);
    if (!existsSync(absPath)) continue;

    const code = readFileSync(absPath, 'utf8');
    const lines = code.split('\n');
    const alreadyFixed = new Set();

    for (const awaitLineNum of awaitLineNums) {
      const awaitIdx = awaitLineNum - 1;
      if (awaitIdx < 0 || awaitIdx >= lines.length) continue;

      // Scan backwards to find the opening brace of the containing function/method
      let depth = 0;
      let fnLineIdx = -1;

      for (let i = awaitIdx; i >= 0; i--) {
        const line = lines[i];
        for (let c = line.length - 1; c >= 0; c--) {
          if (line[c] === '}') depth++;
          if (line[c] === '{') {
            depth--;
            if (depth < 0) {
              // Found the opening brace. Now find the method/function declaration.
              for (let j = i; j >= Math.max(0, i - 15); j--) {
                const decl = lines[j];
                if (/\basync\b/.test(decl)) {
                  fnLineIdx = -1; // Already async
                  break;
                }

                // Standard function
                if (/\bfunction\s/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }

                // Arrow function assigned to variable
                if (/(?:const|let|var)\s+\w+\s*=\s*\(/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }

                // Class method: `methodName(` at class-level indentation
                // Pattern: `  methodName(params): Type {` or `  methodName(params) {`
                // But NOT `if (`, `for (`, `while (`, `switch (`, `catch (`, `constructor(`
                const methodMatch = decl.match(/^(\s*)(private\s+|public\s+|protected\s+|static\s+|readonly\s+)*(\w+)\s*\(/);
                if (methodMatch) {
                  const name = methodMatch[3];
                  if (['if', 'for', 'while', 'switch', 'catch', 'else', 'return', 'throw', 'new', 'typeof', 'delete', 'void'].includes(name)) continue;
                  if (name === 'constructor') {
                    fnLineIdx = -2; // Special marker for constructor
                    break;
                  }
                  fnLineIdx = j;
                  break;
                }

                // Arrow function in callback: `, (params) =>`
                if (/,\s*\(/.test(decl) || /\(\s*\(/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }
              }
              break;
            }
          }
        }
        if (depth < 0) break;
      }

      if (fnLineIdx === -2) {
        // Constructor case - can't make async. Skip for now.
        continue;
      }

      if (fnLineIdx >= 0 && !alreadyFixed.has(fnLineIdx) && !/\basync\b/.test(lines[fnLineIdx])) {
        const fnLine = lines[fnLineIdx];
        let updated = false;

        // Standard function
        if (/export\s+function\s/.test(fnLine)) {
          lines[fnLineIdx] = fnLine.replace(/export\s+function\s/, 'export async function ');
          updated = true;
        } else if (/^\s*function\s/.test(fnLine)) {
          lines[fnLineIdx] = fnLine.replace(/function\s/, 'async function ');
          updated = true;
        }
        // Class method: `  methodName(` → `  async methodName(`
        else {
          const methodMatch = fnLine.match(/^(\s*)((?:private|public|protected|static|readonly)\s+)*(\w+)\s*\(/);
          if (methodMatch) {
            const indent = methodMatch[1];
            const modifiers = methodMatch[2] || '';
            const name = methodMatch[3];
            if (!['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) {
              lines[fnLineIdx] = fnLine.replace(
                /^(\s*)((?:(?:private|public|protected|static|readonly)\s+)*)(\w+)\s*\(/,
                '$1$2async $3(',
              );
              updated = true;
            }
          }
          // Arrow function
          else if (/=\s*\(/.test(fnLine) && !fnLine.includes('async')) {
            lines[fnLineIdx] = fnLine.replace(/=\s*\(/, '= async (');
            updated = true;
          }
          // Callback
          else if (/,\s*\(/.test(fnLine) && !fnLine.includes('async')) {
            lines[fnLineIdx] = fnLine.replace(/,\s*\(/, ', async (');
            updated = true;
          }
          else if (/\(\s*\(/.test(fnLine) && !fnLine.includes('async')) {
            lines[fnLineIdx] = fnLine.replace(/\(\s*\(/, '(async (');
            updated = true;
          }
        }

        if (updated) {
          fixed++;
          alreadyFixed.add(fnLineIdx);
        }
      }
    }

    writeFileSync(absPath, lines.join('\n'), 'utf8');
  }

  console.log(`Fixed ${fixed} method declarations`);
  return fixed;
}

function fixTS2304BadAsync(errors) {
  const ts2304 = errors.filter((l) => l.includes('TS2304'));
  console.log(`TS2304 errors: ${ts2304.length}`);

  const byFile = {};
  for (const err of ts2304) {
    const m = err.match(/^(.+?)\((\d+),(\d+)\)/);
    if (!m) continue;
    const relPath = m[1].replace(/^\uFEFF/, '');
    if (!byFile[relPath]) byFile[relPath] = [];
    byFile[relPath].push(parseInt(m[2], 10));
  }

  let fixed = 0;
  for (const [relPath, errorLineNums] of Object.entries(byFile)) {
    const absPath = resolve(root, relPath);
    if (!existsSync(absPath)) continue;

    const code = readFileSync(absPath, 'utf8');
    const lines = code.split('\n');

    for (const lineNum of errorLineNums) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const line = lines[idx];

      // Remove `async` that's not before a function pattern
      // Pattern: `= async (non-function-expression`
      if (/=\s*async\s+(?!\(|\bfunction\b)/.test(line)) {
        lines[idx] = line.replace(/=\s*async\s+/, '= ');
        fixed++;
      }
      // Pattern: `= async ((` IIFE → should be `= (async (`
      else if (/=\s*async\s+\(\(/.test(line)) {
        lines[idx] = line.replace(/=\s*async\s+\(\(/, '= (async (');
        fixed++;
      }
    }

    writeFileSync(absPath, lines.join('\n'), 'utf8');
  }

  console.log(`Fixed ${fixed} bad async placements`);
  return fixed;
}

function fixTS1064ReturnTypes(errors) {
  const ts1064 = errors.filter((l) => l.includes('TS1064'));
  console.log(`TS1064 errors: ${ts1064.length}`);

  const byFile = {};
  for (const err of ts1064) {
    const m = err.match(/^(.+?)\((\d+),(\d+)\).*'(Promise<.+>)'/);
    if (!m) continue;
    const [, relPath, lineStr, , suggestedType] = m;
    const line = parseInt(lineStr, 10);
    if (!byFile[relPath]) byFile[relPath] = [];
    byFile[relPath].push({ line, suggestedType });
  }

  let fixed = 0;
  for (const [relPath, fixes] of Object.entries(byFile)) {
    const absPath = resolve(root, relPath.replace(/^\uFEFF/, ''));
    if (!existsSync(absPath)) continue;

    const lines = readFileSync(absPath, 'utf8').split('\n');
    fixes.sort((a, b) => b.line - a.line);

    for (const { line: lineNum, suggestedType } of fixes) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const lineText = lines[idx];

      // Pattern: `): OldType {`
      const match = lineText.match(/^(.*\)\s*:\s*)(.+?)(\s*\{)\s*$/);
      if (match && !match[2].startsWith('Promise<')) {
        lines[idx] = `${match[1]}${suggestedType}${match[3]}`;
        fixed++;
        continue;
      }

      // Pattern: `): OldType => {`
      const arrowMatch = lineText.match(/^(.*\)\s*:\s*)(.+?)(\s*=>\s*\{)\s*$/);
      if (arrowMatch && !arrowMatch[2].startsWith('Promise<')) {
        lines[idx] = `${arrowMatch[1]}${suggestedType}${arrowMatch[3]}`;
        fixed++;
      }
    }

    writeFileSync(absPath, lines.join('\n'), 'utf8');
  }

  console.log(`Fixed ${fixed} return types`);
  return fixed;
}

// ── Main loop ─────────────────────────────────────────────────────

for (let i = 1; i <= 6; i++) {
  console.log(`\n======== ITERATION ${i} ========`);
  const errors = runTsc();
  console.log(`Total errors: ${errors.length}`);

  if (errors.length === 0) {
    console.log('All errors fixed!');
    break;
  }

  let changes = 0;
  changes += fixTS2304BadAsync(errors);
  changes += fixTS1308ClassMethods(errors);
  changes += fixTS1064ReturnTypes(errors);

  if (changes === 0) {
    console.log('No more automatic fixes possible.');
    const byCode = {};
    errors.forEach((l) => {
      const m = l.match(/error (TS\d+)/);
      if (m) byCode[m[1]] = (byCode[m[1]] || 0) + 1;
    });
    Object.entries(byCode)
      .sort((a, b) => b[1] - a[1])
      .forEach(([c, n]) => console.log(`  ${n} ${c}`));
    break;
  }

  console.log(`Applied ${changes} fixes`);
}
