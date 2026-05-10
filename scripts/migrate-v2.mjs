#!/usr/bin/env node
/**
 * Phase 1.8 v2: Reliable caller migration.
 *
 * Step 1: Add `await` before db function calls (no function-async modifications)
 * Step 2: Use tsc errors iteratively to:
 *   - TS1064: Wrap return types in Promise<> (using compiler's suggestion)
 *   - TS1308: Make containing functions/methods async (AST-based)
 *   - TS2339/TS2345: Add missing awaits for async calls used synchronously
 *
 * Uses TypeScript compiler API for robust function scope identification,
 * eliminating fragile regex-based backward brace scanning.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require2 = createRequire(import.meta.url);
const ts = require2('typescript');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const srcDir = resolve(root, 'src');

function runTsc() {
  const strip = lines => lines.split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.includes('error TS'));
  try {
    const out = execSync('npx tsc --noEmit 2>&1', {
      cwd: root, encoding: 'utf8', shell: 'cmd.exe',
      stdio: 'pipe', maxBuffer: 50 * 1024 * 1024,
    });
    return strip(out);
  } catch (e) {
    return strip((e.stdout || '') + '\n' + (e.stderr || ''));
  }
}

function findTsFiles(dir) {
  const r = [];
  for (const e of readdirSync(dir)) {
    const f = resolve(dir, e);
    if (['node_modules', 'dist', '.git'].includes(e)) continue;
    if (statSync(f).isDirectory()) r.push(...findTsFiles(f));
    else if (extname(e) === '.ts' && !e.endsWith('.d.ts')) r.push(f);
  }
  return r;
}

// ── AST-based function scope analysis ─────────────────────────────

/**
 * Traverse the AST to collect all function-like scopes.
 * Returns in depth-first pre-order: inner scopes come after outer ones.
 */
function findAllFunctionScopes(sourceFile) {
  const scopes = [];

  function visit(node) {
    const isFunctionLike =
      node.kind === ts.SyntaxKind.FunctionDeclaration ||
      node.kind === ts.SyntaxKind.FunctionExpression ||
      node.kind === ts.SyntaxKind.ArrowFunction ||
      node.kind === ts.SyntaxKind.MethodDeclaration;

    if (isFunctionLike) {
      const startPos = node.getStart(sourceFile);
      const endPos = node.getEnd();
      const startLC = sourceFile.getLineAndCharacterOfPosition(startPos);
      const endLine = sourceFile.getLineAndCharacterOfPosition(endPos).line;

      let hasAsync = false;
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (mod.kind === ts.SyntaxKind.AsyncKeyword) { hasAsync = true; break; }
        }
      }

      scopes.push({
        headerLine: startLC.line + 1,
        headerCol: startLC.character,
        endLine: endLine + 1,
        isAsync: hasAsync,
        kind: node.kind,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return scopes;
}

/**
 * Find the innermost non-async function scope containing errorLine.
 * Pre-order traversal means the last match is the most deeply nested.
 */
function findInnermostNonAsync(scopes, errorLine) {
  let result = null;
  for (const s of scopes) {
    if (errorLine >= s.headerLine && errorLine <= s.endLine && !s.isAsync) {
      result = s;
    }
  }
  return result;
}

/**
 * Insert `async` keyword on the function's header line based on AST node kind.
 */
function addAsyncToLine(line, kind, col) {
  if (kind === ts.SyntaxKind.FunctionDeclaration || kind === ts.SyntaxKind.FunctionExpression) {
    if (/export\s+default\s+function\b/.test(line)) {
      return line.replace(/export\s+default\s+function\b/, 'export default async function');
    }
    if (/export\s+function\b/.test(line)) {
      return line.replace(/export\s+function\b/, 'export async function');
    }
    if (/\bfunction\b/.test(line)) {
      return line.replace(/\bfunction\b/, 'async function');
    }
  }

  if (kind === ts.SyntaxKind.MethodDeclaration) {
    const cm = line.match(
      /^(\s*)((?:(?:private|public|protected|static|readonly|override|abstract)\s+)*)(\w+)\s*[\(<]/
    );
    if (cm && cm[3] !== 'constructor') {
      const escapedName = cm[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return line.replace(
        new RegExp(
          `^(\\s*)((?:(?:private|public|protected|static|readonly|override|abstract)\\s+)*)(${escapedName})(\\s*[\\(<])`
        ),
        '$1$2async $3$4'
      );
    }
  }

  if (kind === ts.SyntaxKind.ArrowFunction) {
    return line.substring(0, col) + 'async ' + line.substring(col);
  }

  return null;
}

// ── Step 1: Add `await` before db function calls ──────────────────

const dbCode = readFileSync(resolve(srcDir, 'db.ts'), 'utf8');
const dbAsyncFns = new Set();
let m;
const r = /export\s+async\s+function\s+(\w+)/g;
while ((m = r.exec(dbCode))) dbAsyncFns.add(m[1]);
console.log(`${dbAsyncFns.size} exported async functions in db.ts`);

let totalAwaits = 0;
for (const f of findTsFiles(srcDir)) {
  if (f.endsWith('db.ts')) continue;
  let code = readFileSync(f, 'utf8');

  const imported = new Set();
  const ir = /import\s*\{([^}]+)\}\s*from\s*['"](?:\.\.?\/)*db\.js['"]/g;
  while ((m = ir.exec(code))) {
    for (let n of m[1].split(',')) {
      n = n.trim().replace(/^type\s+/, '');
      const parts = n.split(/\s+as\s+/);
      const name = parts[parts.length - 1].trim();
      if (name && dbAsyncFns.has(name.replace(/^type\s+/, ''))) imported.add(name);
    }
  }
  const tir = /import\s+type\s*\{([^}]+)\}\s*from\s*['"](?:\.\.?\/)*db\.js['"]/g;
  while ((m = tir.exec(code))) {
    for (let n of m[1].split(',')) imported.delete(n.trim());
  }
  if (imported.size === 0) continue;

  const lines = code.split('\n');
  let fileChanges = 0;
  for (let pass = 0; pass < 5; pass++) {
    let passChanges = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('from') && line.includes('db.js')) continue;
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      for (const fn of imported) {
        const idx = line.indexOf(fn + '(');
        if (idx === -1) continue;
        if (idx > 0 && /[\w$.]/.test(line[idx - 1])) continue;
        if (/await\s+$/.test(line.substring(0, idx))) continue;

        lines[i] = line.substring(0, idx) + 'await ' + line.substring(idx);
        passChanges++;
        fileChanges++;
        break;
      }
    }
    if (passChanges === 0) break;
  }

  if (fileChanges > 0) {
    writeFileSync(f, lines.join('\n'), 'utf8');
    totalAwaits += fileChanges;
  }
}
console.log(`Step 1: Added ${totalAwaits} awaits to db function calls\n`);

// ── Step 2: Iterative tsc-driven fixes ────────────────────────────

for (let iter = 1; iter <= 15; iter++) {
  console.log(`=== Iteration ${iter} ===`);
  const errors = runTsc();
  console.log(`Errors: ${errors.length}`);
  if (errors.length === 0) { console.log('All fixed!'); break; }

  let totalFixes = 0;

  const byFile = {};
  for (const err of errors) {
    const em = err.match(/^(.+?)\((\d+),(\d+)\).*error (TS\d+)(.*)$/);
    if (!em) continue;
    const relPath = em[1].replace(/^\uFEFF/, '');
    if (!byFile[relPath]) byFile[relPath] = [];
    byFile[relPath].push({
      line: parseInt(em[2], 10),
      col: parseInt(em[3], 10),
      code: em[4],
      msg: em[5],
    });
  }

  for (const [relPath, fileErrors] of Object.entries(byFile)) {
    const absPath = resolve(root, relPath);
    if (!existsSync(absPath)) continue;
    const rawContent = readFileSync(absPath, 'utf8');
    const eol = rawContent.includes('\r\n') ? '\r\n' : '\n';
    const lines = rawContent.split('\n').map(l => l.replace(/\r$/, ''));
    let fileChanges = 0;

    // ── Fix TS1064: Wrap return types ──
    for (const err of fileErrors.filter(e => e.code === 'TS1064')) {
      const idx = err.line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const pm = err.msg.match(/'(Promise<.+>)'/);
      if (!pm) continue;
      const suggested = pm[1];
      const line = lines[idx];

      const m1 = line.match(/^(.*\)\s*:\s*)(.+?)(\s*\{)\s*$/);
      if (m1 && !m1[2].startsWith('Promise<') && !m1[2].includes('=>')) {
        if (!m1[2].trim()) continue;
        const opens = (m1[2].match(/\{/g) || []).length;
        const closes = (m1[2].match(/\}/g) || []).length;
        if (opens !== closes) continue;
        lines[idx] = `${m1[1]}${suggested}${m1[3]}`;
        fileChanges++;
        continue;
      }
      const m2 = line.match(/^(.*\)\s*:\s*)(.+?)(\s*=>\s*\{?)\s*$/);
      if (m2 && !m2[2].startsWith('Promise<')) {
        if (!m2[2].trim()) continue;
        const opens = (m2[2].match(/\{/g) || []).length;
        const closes = (m2[2].match(/\}/g) || []).length;
        if (opens !== closes) continue;
        lines[idx] = `${m2[1]}${suggested}${m2[3]}`;
        fileChanges++;
      }
    }

    // ── Fix TS1308: Make containing functions async (AST-based) ──
    const ts1308Errors = fileErrors.filter(e => e.code === 'TS1308');
    if (ts1308Errors.length > 0) {
      const code = lines.join('\n');
      let sf;
      try {
        sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true);
      } catch (_) {
        sf = null;
      }
      if (sf) {
        const scopes = findAllFunctionScopes(sf);
        const errorLines = [...new Set(ts1308Errors.map(e => e.line))];
        const madeAsync = new Set();

        for (const errLine of errorLines) {
          const fnInfo = findInnermostNonAsync(scopes, errLine);
          if (!fnInfo) continue;

          const headerIdx = fnInfo.headerLine - 1;
          if (headerIdx < 0 || headerIdx >= lines.length) continue;
          if (madeAsync.has(headerIdx)) continue;
          if (/\basync\b/.test(lines[headerIdx])) continue;

          const newLine = addAsyncToLine(lines[headerIdx], fnInfo.kind, fnInfo.headerCol);
          if (newLine !== null && newLine !== lines[headerIdx]) {
            lines[headerIdx] = newLine;
            fileChanges++;
            madeAsync.add(headerIdx);
          }
        }
      }
    }

    // ── Fix TS2339/TS2345: Add missing await for non-db async calls ──
    const allAsyncFns = new Set(dbAsyncFns);
    for (const tf of findTsFiles(srcDir)) {
      const tc = readFileSync(tf, 'utf8');
      let tm;
      const tr = /(?:export\s+)?async\s+(?:function\s+)?(\w+)/g;
      while ((tm = tr.exec(tc))) allAsyncFns.add(tm[1]);
    }

    const awaitErrorCodes = ['TS2339', 'TS2345', 'TS2488', 'TS2801', 'TS2322', 'TS2740'];
    const awaitErrorLines = new Set(
      fileErrors.filter(e => awaitErrorCodes.includes(e.code)).map(e => e.line)
    );

    for (const lineNum of awaitErrorLines) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      let line = lines[idx];

      for (const fn of allAsyncFns) {
        const re = new RegExp(`(?<!\\w)(?<!\\.)(?<!await\\s)${fn}\\(`);
        const match = line.match(re);
        if (match) {
          const before = line.substring(0, match.index);
          if (/\b(async|function)\s*$/.test(before)) continue;
          line = line.substring(0, match.index) + 'await ' + line.substring(match.index);
          lines[idx] = line;
          fileChanges++;
          break;
        }
      }
    }

    // ── Fix await precedence: await func(...).prop → (await func(...)).prop ──
    const promiseErrLines = new Set(
      fileErrors.filter(e =>
        e.code === 'TS2339' && e.msg.includes('Promise<')
      ).map(e => e.line)
    );
    for (const lineNum of promiseErrLines) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const line = lines[idx];
      const awaitMatch = line.match(/\bawait\s+[\w.]+\(/);
      if (!awaitMatch) continue;
      const awaitStart = awaitMatch.index;
      const openParen = line.indexOf('(', awaitStart + 6);
      if (openParen === -1) continue;
      let depth = 1, pos = openParen + 1;
      while (pos < line.length && depth > 0) {
        if (line[pos] === '(') depth++;
        else if (line[pos] === ')') depth--;
        pos++;
      }
      if (depth !== 0 || pos >= line.length || line[pos] !== '.') continue;
      if (awaitStart > 0 && line[awaitStart - 1] === '(') continue;
      lines[idx] = line.substring(0, awaitStart) + '(' +
        line.substring(awaitStart, pos) + ')' + line.substring(pos);
      fileChanges++;
    }

    // ── Fix cross-line: variable from async call without await ──
    for (const lineNum of promiseErrLines) {
      const idx = lineNum - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const line = lines[idx];
      if (/\bawait\b/.test(line)) continue;
      const varMatch = line.match(/\b(\w+)\s*\./);
      if (!varMatch) continue;
      const varName = varMatch[1];
      if (['this', 'self', 'console', 'Math', 'JSON', 'Object', 'Array', 'Promise',
           'Date', 'String', 'Number', 'Boolean', 'Error', 'Map', 'Set', 'process',
           'Buffer', 'RegExp', 'Symbol'].includes(varName)) continue;
      for (let j = idx - 1; j >= Math.max(0, idx - 50); j--) {
        const aLine = lines[j];
        for (const fn of allAsyncFns) {
          const pat = new RegExp(
            `(?:const|let|var)\\s+${varName}\\s*=\\s*(?!await\\s)${fn}\\(`
          );
          if (pat.test(aLine)) {
            lines[j] = aLine.replace(
              new RegExp(`(=\\s*)${fn}\\(`),
              `$1await ${fn}(`
            );
            fileChanges++;
            break;
          }
        }
      }
    }

    if (fileChanges > 0) {
      writeFileSync(absPath, lines.join(eol), 'utf8');
      totalFixes += fileChanges;
    }
  }

  console.log(`Applied ${totalFixes} fixes`);
  if (totalFixes === 0) {
    console.log('No more automatic fixes.');
    const byCode = {};
    errors.forEach(l => {
      const m2 = l.match(/error (TS\d+)/);
      if (m2) byCode[m2[1]] = (byCode[m2[1]] || 0) + 1;
    });
    Object.entries(byCode).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([c, n]) => console.log(`  ${n} ${c}`));
    break;
  }
}
