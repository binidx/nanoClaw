#!/usr/bin/env node
/**
 * Comprehensive async migration fixer.
 * Combines all fix strategies in one iterative loop.
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
      cwd: root, encoding: 'utf8', shell: 'cmd.exe',
      stdio: 'pipe', maxBuffer: 50 * 1024 * 1024,
    });
    return out.split('\n').filter((l) => l.includes('error TS'));
  } catch (e) {
    return ((e.stdout || '') + '\n' + (e.stderr || ''))
      .split('\n').filter((l) => l.includes('error TS'));
  }
}

function findTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (['node_modules', 'dist', '.git'].includes(entry)) continue;
    const st = statSync(full);
    if (st.isDirectory()) results.push(...findTsFiles(full));
    else if (extname(entry) === '.ts' && !entry.endsWith('.d.ts')) results.push(full);
  }
  return results;
}

// Build async function name set
const asyncFnNames = new Set();
for (const f of findTsFiles(resolve(root, 'src'))) {
  const code = readFileSync(f, 'utf8');
  let m;
  const r1 = /(?:export\s+)?async\s+function\s+(\w+)/g;
  while ((m = r1.exec(code)) !== null) asyncFnNames.add(m[1]);
  const r2 = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*async\s*[\(<]/g;
  while ((m = r2.exec(code)) !== null) asyncFnNames.add(m[1]);
  // Class async methods
  const r3 = /^\s*(?:private|public|protected|static|readonly|\s)*async\s+(\w+)\s*\(/gm;
  while ((m = r3.exec(code)) !== null) asyncFnNames.add(m[1]);
}
console.log(`${asyncFnNames.size} async function names found`);

function processFile(absPath, errorsByLine) {
  if (!existsSync(absPath)) return 0;
  const code = readFileSync(absPath, 'utf8');
  const lines = code.split('\n');
  let changes = 0;

  // ─ Fix 1: Bad `async` before function CALLS (should be `await`) ─
  // Pattern: `async functionName(` at statement level (not in a declaration context)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `async someFunctionCall(` where it's not a declaration
    const badAsync = line.match(/^(\s*)async\s+(\w+)\s*\(/);
    if (badAsync) {
      const name = badAsync[2];
      // It's OK if this is a function/method declaration context
      if (['function', 'class'].includes(name)) continue;
      // Check: is this line a function declaration? Look for `)` + `:` + `{` pattern later
      // If it's a standalone statement, replace `async` with `await`
      const hasDeclarationPattern = /\)\s*:\s*\w/.test(line) || /\)\s*\{/.test(line);
      if (!hasDeclarationPattern && asyncFnNames.has(name)) {
        lines[i] = line.replace(/^(\s*)async\s+/, '$1await ');
        changes++;
      }
    }
    
    // `= async (expression` where not followed by `=>` (bad from earlier script)
    if (/=\s*async\s+\((?!\s*\)|[^)]*\)\s*=>)/.test(line)) {
      // Check if any following lines have `=>`
      let isArrow = false;
      for (let k = i; k < Math.min(lines.length, i + 5); k++) {
        if (lines[k].includes('=>')) { isArrow = true; break; }
        if (k > i && /^\s*\)\s*=>/.test(lines[k])) { isArrow = true; break; }
        if (k > i && lines[k].trim().startsWith('{') && !lines[k].includes('=>')) break;
      }
      if (!isArrow) {
        lines[i] = line.replace(/=\s*async\s+\(/, '= (');
        changes++;
      }
    }
  }

  // ─ Fix 2: Add `await` before async function calls on error lines ─
  for (const [lineNum, errCodes] of errorsByLine) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) continue;
    
    const needsAwait = errCodes.some(c => 
      ['TS2339', 'TS2345', 'TS2488', 'TS2801', 'TS2322', 'TS2740',
       'TS2367', 'TS2559', 'TS18046', 'TS18048', 'TS2352', 'TS2741'].includes(c)
    );
    if (!needsAwait) continue;
    
    let line = lines[idx];
    for (const fnName of asyncFnNames) {
      // Match `fnName(` but not `awaitedFnName(` or `somePrefix.fnName(`
      const re = new RegExp(`(?<!\\w)(?<!await\\s)${fnName}\\(`);
      if (re.test(line)) {
        const match = line.match(re);
        if (match) {
          const pos = match.index;
          // Don't add await before `this.` method calls that were already handled
          if (pos > 0 && line[pos - 1] === '.') {
            // `obj.fnName(` → `(await obj.fnName(`? No, this changes semantics.
            // For `this.fnName(`, the await needs to be before `this`
            // Actually, let's handle `.fnName(` by checking if the prefix expression needs await
            const beforeDot = line.substring(0, pos - 1).trimEnd();
            if (beforeDot.endsWith('this') || beforeDot.endsWith(')')) {
              // Need to wrap: `this.fnName(args)` → `(await this.fnName(args))`
              // Or `expr.fnName(args)` → `(await expr.fnName(args))`
              // This is complex to handle correctly, skip for now
              continue;
            }
          }
          line = line.substring(0, pos) + 'await ' + line.substring(pos);
          lines[idx] = line;
          changes++;
          break;
        }
      }
    }
  }

  // ─ Fix 3: Make containing functions async for TS1308 lines ─
  const ts1308Lines = [...errorsByLine.entries()]
    .filter(([, codes]) => codes.includes('TS1308'))
    .map(([lineNum]) => lineNum);
  
  const madeAsync = new Set();
  for (const awaitLineNum of ts1308Lines) {
    const awaitIdx = awaitLineNum - 1;
    let depth = 0;
    let fnLineIdx = -1;
    
    for (let i = awaitIdx; i >= 0; i--) {
      for (let c = lines[i].length - 1; c >= 0; c--) {
        if (lines[i][c] === '}') depth++;
        if (lines[i][c] === '{') {
          depth--;
          if (depth < 0) {
            for (let j = i; j >= Math.max(0, i - 15); j--) {
              if (/\basync\b/.test(lines[j])) break;
              if (/\bfunction\s/.test(lines[j])) { fnLineIdx = j; break; }
              if (/(?:const|let|var)\s+\w+\s*=\s*\(/.test(lines[j])) { fnLineIdx = j; break; }
              // Class method
              const mm = lines[j].match(/^(\s*)((?:(?:private|public|protected|static|readonly)\s+)*)(\w+)\s*\(/);
              if (mm && !['if', 'for', 'while', 'switch', 'catch', 'else', 'return', 'throw', 'new', 'constructor'].includes(mm[3])) {
                fnLineIdx = j; break;
              }
              if (/,\s*\(/.test(lines[j]) || /\(\s*\(/.test(lines[j])) { fnLineIdx = j; break; }
            }
            break;
          }
        }
      }
      if (depth < 0) break;
    }
    
    if (fnLineIdx >= 0 && !madeAsync.has(fnLineIdx) && !/\basync\b/.test(lines[fnLineIdx])) {
      const fl = lines[fnLineIdx];
      if (/export\s+function\s/.test(fl)) {
        lines[fnLineIdx] = fl.replace(/export\s+function\s/, 'export async function ');
        changes++; madeAsync.add(fnLineIdx);
      } else if (/^\s*function\s/.test(fl)) {
        lines[fnLineIdx] = fl.replace(/function\s/, 'async function ');
        changes++; madeAsync.add(fnLineIdx);
      } else if (/^(\s*)((?:(?:private|public|protected|static|readonly)\s+)*)(\w+)\s*\(/.test(fl)) {
        lines[fnLineIdx] = fl.replace(/^(\s*)((?:(?:private|public|protected|static|readonly)\s+)*)(\w+)\s*\(/, '$1$2async $3(');
        changes++; madeAsync.add(fnLineIdx);
      } else if (/=\s*\(/.test(fl)) {
        lines[fnLineIdx] = fl.replace(/=\s*\(/, '= async (');
        changes++; madeAsync.add(fnLineIdx);
      } else if (/,\s*\(/.test(fl)) {
        lines[fnLineIdx] = fl.replace(/,\s*\(/, ', async (');
        changes++; madeAsync.add(fnLineIdx);
      } else if (/\(\s*\(/.test(fl)) {
        lines[fnLineIdx] = fl.replace(/\(\s*\(/, '(async (');
        changes++; madeAsync.add(fnLineIdx);
      }
    }
  }

  // ─ Fix 4: Wrap return types for TS1064 ─
  const ts1064Entries = [...errorsByLine.entries()]
    .filter(([, codes]) => codes.includes('TS1064'));
  
  for (const [lineNum] of ts1064Entries) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const line = lines[idx];
    
    const m1 = line.match(/^(.*\)\s*:\s*)(.+?)(\s*\{)\s*$/);
    if (m1 && !m1[2].startsWith('Promise<') && !m1[2].includes('=>')) {
      lines[idx] = `${m1[1]}Promise<${m1[2]}>${m1[3]}`;
      changes++;
      continue;
    }
    const m2 = line.match(/^(.*\)\s*:\s*)(.+?)(\s*=>\s*\{)\s*$/);
    if (m2 && !m2[2].startsWith('Promise<')) {
      lines[idx] = `${m2[1]}Promise<${m2[2]}>${m2[3]}`;
      changes++;
    }
  }

  // ─ Fix 5: Multi-line return type duplication ─
  // Pattern: `):Promise<{ prop: Type; }>{`  then old type body below
  for (let i = 0; i < lines.length - 2; i++) {
    const line = lines[i];
    const match = line.match(/\)\s*:\s*Promise<\{(.+)\}>\s*\{$/);
    if (!match) continue;
    
    // Check if next lines look like orphaned type body
    const nextLine = lines[i + 1]?.trim();
    if (nextLine && /^\w+\s*[:?]/.test(nextLine)) {
      // Scan for the old `} {` closing
      let endIdx = -1;
      for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
        if (/^\s*\}\s*\{/.test(lines[j]) || /^\s*\}\s*\|\s*\w/.test(lines[j])) {
          endIdx = j;
          break;
        }
      }
      if (endIdx >= 0) {
        // Remove lines from i+1 to endIdx and replace the `} {` with just `{`
        // Actually, just rebuild: keep the inline Promise type, remove old body
        const reformatted = [];
        const inlineTypes = match[1].trim().split(';').filter(s => s.trim());
        reformatted.push(line.replace(/\)\s*:\s*Promise<\{.+\}>\s*\{$/, '): Promise<{'));
        for (const typeEntry of inlineTypes) {
          reformatted.push(`  ${typeEntry.trim()};`);
        }
        reformatted.push('  }> {');
        
        lines.splice(i, endIdx - i + 1, ...reformatted);
        changes++;
      }
    }
  }

  if (changes > 0) {
    writeFileSync(absPath, lines.join('\n'), 'utf8');
  }
  return changes;
}

// ── Main loop ────────────────────────────────────────────────────

for (let iter = 1; iter <= 10; iter++) {
  console.log(`\n======== ITERATION ${iter} ========`);
  const errors = runTsc();
  console.log(`Errors: ${errors.length}`);
  
  if (errors.length === 0) { console.log('All fixed!'); break; }

  // Group errors by file and line
  const byFile = {};
  for (const err of errors) {
    const m = err.match(/^(.+?)\((\d+),\d+\).*error (TS\d+)/);
    if (!m) continue;
    const relPath = m[1].replace(/^\uFEFF/, '');
    const lineNum = parseInt(m[2], 10);
    const code = m[3];
    if (!byFile[relPath]) byFile[relPath] = new Map();
    const fileMap = byFile[relPath];
    if (!fileMap.has(lineNum)) fileMap.set(lineNum, []);
    fileMap.get(lineNum).push(code);
  }

  let totalChanges = 0;
  for (const [relPath, errorsByLine] of Object.entries(byFile)) {
    const absPath = resolve(root, relPath);
    const changes = processFile(absPath, errorsByLine);
    if (changes > 0) {
      totalChanges += changes;
      console.log(`  [${relPath}] +${changes}`);
    }
  }

  if (totalChanges === 0) {
    console.log('No more automatic fixes.');
    const byCode = {};
    errors.forEach(l => { const m = l.match(/error (TS\d+)/); if (m) byCode[m[1]] = (byCode[m[1]] || 0) + 1; });
    Object.entries(byCode).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${n} ${c}`));
    break;
  }
  console.log(`Total: ${totalChanges} fixes`);
}
