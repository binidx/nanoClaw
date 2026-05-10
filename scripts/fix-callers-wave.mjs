#!/usr/bin/env node
/**
 * Wave-based fixer for caller migration.
 * Reads tsc error output and applies targeted fixes in waves.
 *
 * Wave 1: TS1064 - Wrap return types with Promise<> using the compiler's suggestion
 * Wave 2: TS1308 - Make functions with `await` async
 * Wave 3: Re-run await insertion for missed calls (TS2339/TS2345)
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
    });
    return out.split('\n').filter((l) => l.includes('error TS'));
  } catch (e) {
    const combined = (e.stdout || '') + '\n' + (e.stderr || '');
    return combined.split('\n').filter((l) => l.includes('error TS'));
  }
}

function readFile(relPath) {
  const p = resolve(root, relPath.replace(/^\uFEFF/, ''));
  if (!existsSync(p)) return null;
  return { path: p, content: readFileSync(p, 'utf8') };
}

// ── Wave 1: Fix TS1064 (return types need Promise<> wrapping) ─────

function fixTS1064(errors) {
  const ts1064 = errors.filter((l) => l.includes('TS1064'));
  console.log(`\n=== Wave 1: TS1064 (${ts1064.length} errors) ===`);
  
  // Group by file
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
    const file = readFile(relPath);
    if (!file) continue;
    
    const lines = file.content.split('\n');
    // Sort by line number descending to avoid index shifting
    fixes.sort((a, b) => b.line - a.line);
    
    for (const { line: lineNum, suggestedType } of fixes) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      
      const lineText = lines[idx];
      
      // Pattern 1: `): OldType {` at end of line
      const p1 = lineText.match(/^(.*\)\s*:\s*)(.+?)(\s*\{)\s*$/);
      if (p1 && !p1[2].startsWith('Promise<')) {
        lines[idx] = `${p1[1]}${suggestedType}${p1[3]}`;
        fixed++;
        continue;
      }
      
      // Pattern 2: `): OldType => {` (arrow function return type)
      const p2 = lineText.match(/^(.*\)\s*:\s*)(.+?)(\s*=>\s*\{)\s*$/);
      if (p2 && !p2[2].startsWith('Promise<')) {
        lines[idx] = `${p2[1]}${suggestedType}${p2[3]}`;
        fixed++;
        continue;
      }
      
      // Pattern 3: Standalone return type line (no closing paren)
      // e.g., `): OldType {` where `)` is at the start
      const p3 = lineText.match(/^(\s*\)\s*:\s*)(.+?)(\s*\{)\s*$/);
      if (p3 && !p3[2].startsWith('Promise<')) {
        lines[idx] = `${p3[1]}${suggestedType}${p3[3]}`;
        fixed++;
        continue;
      }
      
      // Pattern 4: Same-line function `async function name(params): OldType {`
      const p4 = lineText.match(/^(.*\basync\b.*\)\s*:\s*)(.+?)(\s*\{)\s*$/);
      if (p4 && !p4[2].startsWith('Promise<')) {
        lines[idx] = `${p4[1]}${suggestedType}${p4[3]}`;
        fixed++;
        continue;
      }
      
      // Pattern 5: Inline function `(): OldType {` (no paren prefix)
      const p5 = lineText.match(/^(.+:\s*)(.+?)(\s*\{)\s*$/);
      if (p5 && !p5[2].startsWith('Promise<') && p5[2].trim().length > 0) {
        // Be more conservative here — only fix if the current return type
        // is the same as what's inside the suggested Promise<>
        const inner = suggestedType.match(/^Promise<(.+)>$/);
        if (inner && lineText.includes(inner[1])) {
          lines[idx] = lineText.replace(inner[1], suggestedType);
          fixed++;
          continue;
        }
      }
      
      // Pattern 6: Arrow function return type `): OldType =>`
      const p6 = lineText.match(/^(.*\)\s*:\s*)(.+?)(\s*=>)\s*$/);
      if (p6 && !p6[2].startsWith('Promise<')) {
        lines[idx] = `${p6[1]}${suggestedType}${p6[3]}`;
        fixed++;
        continue;
      }
    }
    
    writeFileSync(file.path, lines.join('\n'), 'utf8');
  }
  
  console.log(`Fixed ${fixed}/${ts1064.length} return types`);
  return fixed;
}

// ── Wave 2: Fix TS1308 (await in non-async function) ──────────────

function fixTS1308(errors) {
  const ts1308 = errors.filter((l) => l.includes('TS1308'));
  console.log(`\n=== Wave 2: TS1308 (${ts1308.length} errors) ===`);
  
  const byFile = {};
  for (const err of ts1308) {
    const m = err.match(/^(.+?)\((\d+),/);
    if (!m) continue;
    if (!byFile[m[1]]) byFile[m[1]] = [];
    byFile[m[1]].push(parseInt(m[2], 10));
  }
  
  let fixed = 0;
  for (const [relPath, awaitLines] of Object.entries(byFile)) {
    const file = readFile(relPath);
    if (!file) continue;
    
    const lines = file.content.split('\n');
    const alreadyFixed = new Set();
    
    for (const awaitLineNum of awaitLines) {
      const awaitIdx = awaitLineNum - 1;
      
      // Find the containing function by scanning backwards and tracking braces
      let depth = 0;
      let foundOpenBrace = false;
      let fnLineIdx = -1;
      
      for (let i = awaitIdx; i >= 0; i--) {
        const line = lines[i];
        for (let c = line.length - 1; c >= 0; c--) {
          if (line[c] === '}') depth++;
          if (line[c] === '{') {
            depth--;
            if (depth < 0) {
              foundOpenBrace = true;
              // This brace starts the block. Find the function declaration.
              for (let j = i; j >= Math.max(0, i - 10); j--) {
                const decl = lines[j];
                if (/\basync\b/.test(decl)) {
                  fnLineIdx = -1; // Already async
                  break;
                }
                // Standard function declaration
                if (/\bfunction\s+\w+/.test(decl) || /\bfunction\s*\(/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }
                // Arrow function: `const name = (` or `= (params) =>`
                if (/\b(const|let|var)\s+\w+\s*=\s*\(/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }
                // Router handler: `app.get('/path', (req, res) => {`
                // or `.get(`, `.post(`, etc.
                if (/\.\w+\([^)]*,\s*\(/.test(decl) || /\.\w+\(\s*\(/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }
                // Callback in method call: `xxx((params) => {`
                if (/\(\s*\(/.test(decl) || /,\s*\(/.test(decl)) {
                  fnLineIdx = j;
                  break;
                }
              }
              break;
            }
          }
        }
        if (foundOpenBrace) break;
      }
      
      if (fnLineIdx >= 0 && !alreadyFixed.has(fnLineIdx) && !/\basync\b/.test(lines[fnLineIdx])) {
        const fnLine = lines[fnLineIdx];
        
        // Try different patterns to add `async`
        if (/export\s+function\s/.test(fnLine)) {
          lines[fnLineIdx] = fnLine.replace(/export\s+function\s/, 'export async function ');
          fixed++;
        } else if (/^\s*function\s/.test(fnLine)) {
          lines[fnLineIdx] = fnLine.replace(/function\s/, 'async function ');
          fixed++;
        } else if (/=\s*\(/.test(fnLine) && !fnLine.includes('async')) {
          // Arrow function: add `async` before the `(`
          lines[fnLineIdx] = fnLine.replace(/=\s*\(/, '= async (');
          fixed++;
        } else if (/,\s*\(/.test(fnLine)) {
          // Callback: add `async` before the `(`
          lines[fnLineIdx] = fnLine.replace(/,\s*\(/, ', async (');
          fixed++;
        } else if (/\(\s*\(/.test(fnLine)) {
          // IIFE or wrapped callback: `((` → `(async (`
          lines[fnLineIdx] = fnLine.replace(/\(\s*\(/, '(async (');
          fixed++;
        }
        
        alreadyFixed.add(fnLineIdx);
      }
    }
    
    writeFileSync(file.path, lines.join('\n'), 'utf8');
  }
  
  console.log(`Fixed ${fixed} function declarations`);
  return fixed;
}

// ── Wave 3: Re-run await insertion for TS2339/TS2345 ──────────────

function fixMissingAwaits(errors) {
  const relevantErrors = errors.filter(
    (l) => l.includes('TS2339') || l.includes('TS2345') || l.includes('TS2488') || l.includes('TS2801')
  );
  console.log(`\n=== Wave 3: Missing awaits (${relevantErrors.length} errors) ===`);
  
  // Get exported async function names from db.ts
  const dbCode = readFileSync(resolve(root, 'src', 'db.ts'), 'utf8');
  const exportedAsyncFns = new Set();
  const fnRegex = /export\s+async\s+function\s+(\w+)/g;
  let m;
  while ((m = fnRegex.exec(dbCode)) !== null) {
    exportedAsyncFns.add(m[1]);
  }
  
  const byFile = {};
  for (const err of relevantErrors) {
    const fm = err.match(/^(.+?)\((\d+),/);
    if (!fm) continue;
    if (!byFile[fm[1]]) byFile[fm[1]] = new Set();
    byFile[fm[1]].add(parseInt(fm[2], 10));
  }
  
  let fixed = 0;
  for (const [relPath, errorLineNums] of Object.entries(byFile)) {
    const file = readFile(relPath);
    if (!file) continue;
    
    // Find imports from db.js
    const importedNames = new Set();
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"](?:\.\.?\/)*db\.js['"]/g;
    let im;
    while ((im = importRegex.exec(file.content)) !== null) {
      const names = im[1].split(',').map((n) => {
        const parts = n.trim().split(/\s+as\s+/);
        return parts[parts.length - 1].trim().replace(/^type\s+/, '');
      });
      for (const name of names) {
        if (name && exportedAsyncFns.has(name)) {
          importedNames.add(name);
        }
      }
    }
    
    if (importedNames.size === 0) continue;
    
    const lines = file.content.split('\n');
    
    for (const lineNum of errorLineNums) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      
      let line = lines[idx];
      
      for (const fnName of importedNames) {
        const callIdx = line.indexOf(fnName + '(');
        if (callIdx === -1) continue;
        
        // Check not a substring match
        if (callIdx > 0 && /[\w$.]/.test(line[callIdx - 1])) continue;
        
        // Check not already awaited
        const before = line.substring(0, callIdx);
        if (/await\s+$/.test(before)) continue;
        
        // Add await
        line = line.substring(0, callIdx) + 'await ' + line.substring(callIdx);
        lines[idx] = line;
        fixed++;
        break;
      }
    }
    
    writeFileSync(file.path, lines.join('\n'), 'utf8');
  }
  
  console.log(`Added ${fixed} awaits`);
  return fixed;
}

// ── Main: Run waves iteratively ───────────────────────────────────

console.log('Running initial tsc...');
let errors = runTsc();
console.log(`Initial errors: ${errors.length}`);

for (let wave = 1; wave <= 5; wave++) {
  console.log(`\n======== ITERATION ${wave} ========`);
  
  let totalFixed = 0;
  totalFixed += fixTS1064(errors);
  totalFixed += fixTS1308(errors);
  totalFixed += fixMissingAwaits(errors);
  
  if (totalFixed === 0) {
    console.log('\nNo more automatic fixes possible.');
    break;
  }
  
  console.log(`\nRe-running tsc after ${totalFixed} fixes...`);
  errors = runTsc();
  console.log(`Remaining errors: ${errors.length}`);
  
  if (errors.length === 0) {
    console.log('\n✓ All errors fixed!');
    break;
  }
}

if (errors.length > 0) {
  console.log(`\nRemaining ${errors.length} errors by type:`);
  const byCode = {};
  errors.forEach((l) => {
    const m = l.match(/error (TS\d+)/);
    if (m) byCode[m[1]] = (byCode[m[1]] || 0) + 1;
  });
  Object.entries(byCode)
    .sort((a, b) => b[1] - a[1])
    .forEach(([c, n]) => console.log(`  ${n} ${c}`));
}
