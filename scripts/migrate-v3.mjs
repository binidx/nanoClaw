#!/usr/bin/env node
/**
 * Phase 1.8 v3: Targeted fixes for remaining async migration errors.
 *
 * Handles patterns that migrate-v2 missed:
 *   1. Multi-line chain await precedence:
 *      `await asyncFn()\n  .method()` → `(await asyncFn())\n  .method()`
 *   2. Enhanced cross-line variable await:
 *      `const x = asyncFn(); x.prop` → `const x = await asyncFn(); x.prop`
 *   3. Same-line await precedence for missed cases
 *   4. TS2345 missing await in function arguments
 *   5. TS1064 multi-line return types (AST-based)
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

function collectAllAsyncFns() {
  const fns = new Set();
  for (const tf of findTsFiles(srcDir)) {
    const tc = readFileSync(tf, 'utf8');
    let tm;
    const tr = /(?:export\s+)?async\s+(?:function\s+)?(\w+)/g;
    while ((tm = tr.exec(tc))) fns.add(tm[1]);
  }
  return fns;
}

function findMatchingParen(text, openPos) {
  let depth = 1, pos = openPos + 1;
  while (pos < text.length && depth > 0) {
    if (text[pos] === '(' || text[pos] === '[' || text[pos] === '{') depth++;
    else if (text[pos] === ')' || text[pos] === ']' || text[pos] === '}') depth--;
    pos++;
  }
  return depth === 0 ? pos - 1 : -1;
}

// ── AST-based function scope analysis (from migrate-v2) ──────────

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

function findInnermostNonAsync(scopes, errorLine) {
  let result = null;
  for (const s of scopes) {
    if (errorLine >= s.headerLine && errorLine <= s.endLine && !s.isAsync) {
      result = s;
    }
  }
  return result;
}

function addAsyncToLine(line, kind, col) {
  if (kind === ts.SyntaxKind.FunctionDeclaration || kind === ts.SyntaxKind.FunctionExpression) {
    if (/export\s+default\s+function\b/.test(line))
      return line.replace(/export\s+default\s+function\b/, 'export default async function');
    if (/export\s+function\b/.test(line))
      return line.replace(/export\s+function\b/, 'export async function');
    if (/\bfunction\b/.test(line))
      return line.replace(/\bfunction\b/, 'async function');
  }
  if (kind === ts.SyntaxKind.MethodDeclaration) {
    const cm = line.match(
      /^(\s*)((?:(?:private|public|protected|static|readonly|override|abstract)\s+)*)(\w+)\s*[\(<]/
    );
    if (cm && cm[3] !== 'constructor') {
      const escapedName = cm[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return line.replace(
        new RegExp(`^(\\s*)((?:(?:private|public|protected|static|readonly|override|abstract)\\s+)*)(${escapedName})(\\s*[\\(<])`),
        '$1$2async $3$4'
      );
    }
  }
  if (kind === ts.SyntaxKind.ArrowFunction) {
    return line.substring(0, col) + 'async ' + line.substring(col);
  }
  return null;
}

// ── Main loop ─────────────────────────────────────────────────────
const allAsyncFns = collectAllAsyncFns();
console.log(`Found ${allAsyncFns.size} async functions in project`);

let prevErrorCount = -1;
for (let iter = 1; iter <= 20; iter++) {
  console.log(`\n=== Iteration ${iter} ===`);
  const errors = runTsc();
  console.log(`Total errors: ${errors.length}`);
  if (errors.length === 0) { console.log('All fixed!'); break; }
  if (errors.length === prevErrorCount) {
    console.log('Error count unchanged, stopping.');
    const byCode = {};
    errors.forEach(l => {
      const m2 = l.match(/error (TS\d+)/);
      if (m2) byCode[m2[1]] = (byCode[m2[1]] || 0) + 1;
    });
    Object.entries(byCode).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([c, n]) => console.log(`  ${n} ${c}`));
    break;
  }
  prevErrorCount = errors.length;

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
    const fixedLines = new Set();

    // ── Fixer 0a: TS1064 - Wrap return types in Promise<> (AST-based) ──
    const ts1064Errors = fileErrors.filter(e => e.code === 'TS1064');
    if (ts1064Errors.length > 0) {
      const codeForAst = lines.join('\n');
      let sf1064;
      try { sf1064 = ts.createSourceFile(relPath, codeForAst, ts.ScriptTarget.Latest, true); }
      catch (_) { sf1064 = null; }

      if (sf1064) {
        const funcNodes = [];
        function visitFn(node) {
          if (node.type && (
            node.kind === ts.SyntaxKind.FunctionDeclaration ||
            node.kind === ts.SyntaxKind.FunctionExpression ||
            node.kind === ts.SyntaxKind.ArrowFunction ||
            node.kind === ts.SyntaxKind.MethodDeclaration
          )) {
            const typeStart = node.type.getStart(sf1064);
            const typeEnd = node.type.getEnd();
            const typeLine = sf1064.getLineAndCharacterOfPosition(typeStart).line + 1;
            funcNodes.push({ typeLine, typeStart, typeEnd, node });
          }
          ts.forEachChild(node, visitFn);
        }
        visitFn(sf1064);

        const replacements = [];
        for (const err of ts1064Errors) {
          const pm = err.msg.match(/'(Promise<.+>)'/);
          if (!pm) continue;
          const suggested = pm[1];

          const fn = funcNodes.find(f => f.typeLine === err.line);
          if (!fn) continue;

          const currentType = codeForAst.substring(fn.typeStart, fn.typeEnd);
          if (currentType.startsWith('Promise<')) continue;

          replacements.push({
            start: fn.typeStart,
            end: fn.typeEnd,
            newText: suggested,
          });
        }

        if (replacements.length > 0) {
          replacements.sort((a, b) => b.start - a.start);
          let newCode = codeForAst;
          for (const r of replacements) {
            newCode = newCode.substring(0, r.start) + r.newText + newCode.substring(r.end);
            fileChanges++;
          }
          const newLines = newCode.split('\n').map(l => l.replace(/\r$/, ''));
          for (let i = 0; i < newLines.length; i++) lines[i] = newLines[i];
          while (lines.length > newLines.length) lines.pop();
          while (lines.length < newLines.length) lines.push(newLines[lines.length]);
        }
      } else {
        for (const err of ts1064Errors) {
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
          }
        }
      }
    }

    // ── Fixer 0b: TS1308 - Make containing functions async (AST-based) ──
    const ts1308Errors = fileErrors.filter(e => e.code === 'TS1308');
    if (ts1308Errors.length > 0) {
      const code = lines.join('\n');
      let sf;
      try { sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true); }
      catch (_) { sf = null; }
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

    const promiseErrors = fileErrors.filter(e =>
      e.code === 'TS2339' && e.msg.includes('Promise<')
    );

    // ── Fixer 1: Multi-line chain await precedence ──
    // Pattern: await asyncFn(args)   ← line A (has await, ends with ')')
    //            .method(...)         ← line B (TS2339 error here)
    // Fix: (await asyncFn(args))
    for (const err of promiseErrors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;

      const errLine = lines[errIdx];
      const trimmedErr = errLine.trimStart();

      if (!trimmedErr.startsWith('.')) continue;

      for (let j = errIdx - 1; j >= Math.max(0, errIdx - 20); j--) {
        const prevLine = lines[j];
        const trimmedPrev = prevLine.trimStart();
        if (trimmedPrev.startsWith('.')) continue;

        const awaitIdx = prevLine.indexOf('await ');
        if (awaitIdx === -1) break;

        if (prevLine[awaitIdx] === '(' || (awaitIdx > 0 && prevLine[awaitIdx - 1] === '(')) break;

        const afterAwait = prevLine.substring(awaitIdx + 6);
        const fnCallMatch = afterAwait.match(/^[\w.]+\(/);
        if (!fnCallMatch) break;

        const openParenAbsIdx = awaitIdx + 6 + fnCallMatch[0].length - 1;

        const allText = lines.slice(j).join('\n');
        const openParenInAll = prevLine.length - (prevLine.length - openParenAbsIdx);
        let depth = 1, pos = openParenInAll + 1;
        while (pos < allText.length && depth > 0) {
          const ch = allText[pos];
          if (ch === '(' || ch === '[' || ch === '{') depth++;
          else if (ch === ')' || ch === ']' || ch === '}') depth--;
          pos++;
        }

        if (depth !== 0) break;

        const closeParenPos = pos - 1;
        const textBeforeClose = allText.substring(0, closeParenPos + 1);
        const linesBefore = textBeforeClose.split('\n');
        const closeLineOffset = linesBefore.length - 1;
        const closeLineIdx = j + closeLineOffset;
        const closeCol = linesBefore[linesBefore.length - 1].length - 1;

        const nextCharIdx = closeParenPos + 1;
        const nextChar = nextCharIdx < allText.length ? allText[nextCharIdx] : '';

        if (nextChar === '.' || (nextChar === '\n' && errIdx === closeLineIdx + 1)) {
          lines[j] = prevLine.substring(0, awaitIdx) + '(' +
            prevLine.substring(awaitIdx);

          if (closeLineIdx === j) {
            lines[j] = lines[j].substring(0, closeCol + 2) + ')' +
              lines[j].substring(closeCol + 2);
          } else {
            const cl = lines[closeLineIdx];
            const adjustedCloseCol = closeCol;
            lines[closeLineIdx] = cl.substring(0, adjustedCloseCol + 1) + ')' +
              cl.substring(adjustedCloseCol + 1);
          }
          fileChanges++;
          fixedLines.add(j);
          fixedLines.add(errIdx);
        }
        break;
      }
    }

    // ── Fixer 2: Same-line await precedence (enhanced) ──
    // Pattern: await asyncFn(args).property
    // Fix: (await asyncFn(args)).property
    for (const err of promiseErrors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;

      const line = lines[errIdx];
      const awaitRe = /\bawait\s+([\w.]+)\(/g;
      let awaitMatch;

      while ((awaitMatch = awaitRe.exec(line)) !== null) {
        const awaitStart = awaitMatch.index;
        const openParen = line.indexOf('(', awaitStart + 6);
        if (openParen === -1) continue;

        const closeParen = findMatchingParen(line, openParen);
        if (closeParen === -1 || closeParen >= line.length - 1) continue;

        if (line[closeParen + 1] !== '.') continue;
        if (awaitStart > 0 && line[awaitStart - 1] === '(') continue;

        lines[errIdx] = line.substring(0, awaitStart) + '(' +
          line.substring(awaitStart, closeParen + 1) + ')' +
          line.substring(closeParen + 1);
        fileChanges++;
        fixedLines.add(errIdx);
        break;
      }
    }

    // ── Fixer 3: Cross-line variable await (aggressive) ──
    // Trust TypeScript: if it says variable is Promise<T>, find assignment and add await
    const allPromiseErrors = fileErrors.filter(e =>
      ['TS2339', 'TS2345', 'TS2322', 'TS2739', 'TS2740', 'TS2537', 'TS2488', 'TS2559', 'TS2367', 'TS2801'].includes(e.code)
      && e.msg.includes('Promise<')
    );
    for (const err of allPromiseErrors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;

      const line = lines[errIdx];

      const varMatch = line.match(/\b([a-zA-Z_]\w*)\s*(?:[.[\(]|$)/);
      if (!varMatch) continue;

      const varName = varMatch[1];
      const builtins = new Set([
        'this', 'self', 'console', 'Math', 'JSON', 'Object', 'Array',
        'Promise', 'Date', 'String', 'Number', 'Boolean', 'Error',
        'Map', 'Set', 'process', 'Buffer', 'RegExp', 'Symbol', 'window',
        'document', 'global', 'module', 'exports', 'require', 'path',
        'fs', 'os', 'util', 'events', 'stream', 'crypto', 'http', 'https',
        'return', 'const', 'let', 'var', 'if', 'for', 'while', 'switch',
        'case', 'new', 'typeof', 'void', 'delete', 'throw', 'async', 'await',
        'function', 'class', 'import', 'export', 'default', 'type', 'interface',
        'url', 'querystring', 'child_process', 'cluster', 'net', 'tls',
      ]);
      if (builtins.has(varName)) continue;
      if (/^\d/.test(varName)) continue;

      for (let j = errIdx - 1; j >= Math.max(0, errIdx - 100); j--) {
        const aLine = lines[j];
        if (fixedLines.has(j)) continue;

        const assignPat = new RegExp(
          `(?:const|let|var)\\s+${varName}\\s*=\\s*(?!await\\s)([\\w.]+)\\(`
        );
        const assignMatch = aLine.match(assignPat);
        if (assignMatch) {
          const fnName = assignMatch[1];
          if (builtins.has(fnName) || fnName === 'new') { break; }
          const escapedFn = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          lines[j] = aLine.replace(
            new RegExp(`(=\\s*)${escapedFn}\\(`),
            `$1await ${fnName}(`
          );
          fileChanges++;
          fixedLines.add(j);
          break;
        }

        const reassignPat = new RegExp(
          `\\b${varName}\\s*=\\s*(?!await\\s|=)([\\w.]+)\\(`
        );
        const reassignMatch = aLine.match(reassignPat);
        if (reassignMatch) {
          const fnName = reassignMatch[1];
          if (builtins.has(fnName)) { break; }
          const escapedFn = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          lines[j] = aLine.replace(
            new RegExp(`(${varName}\\s*=\\s*)${escapedFn}\\(`),
            `$1await ${fnName}(`
          );
          fileChanges++;
          fixedLines.add(j);
          break;
        }

        if (new RegExp(`(?:const|let|var)\\s+${varName}\\b`).test(aLine)) break;
        if (new RegExp(`\\b${varName}\\s*=`).test(aLine)) break;
      }
    }

    // NOTE: .map(async ...) de-async removed to prevent cycling with TS1308 fixer

    // ── Fixer 4: TS2345 missing await in function arguments ──
    const ts2345Errors = fileErrors.filter(e =>
      e.code === 'TS2345' && e.msg.includes('Promise<')
    );
    for (const err of ts2345Errors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;

      const line = lines[errIdx];

      for (const fn of allAsyncFns) {
        const re = new RegExp(`(?<!\\w)(?<!\\.)(?<!await\\s)${fn}\\(`);
        const match = line.match(re);
        if (match) {
          const before = line.substring(0, match.index);
          if (/\b(async|function)\s*$/.test(before)) continue;
          if (/\btype\s/.test(before)) continue;
          lines[errIdx] = line.substring(0, match.index) + 'await ' + line.substring(match.index);
          fileChanges++;
          fixedLines.add(errIdx);
          break;
        }
      }
    }

    // ── Fixer 5: TS2322/TS2739/TS2740 missing await ──
    const typeAssignErrors = fileErrors.filter(e =>
      ['TS2322', 'TS2739', 'TS2740'].includes(e.code) && e.msg.includes('Promise<')
    );
    for (const err of typeAssignErrors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;

      const line = lines[errIdx];

      for (const fn of allAsyncFns) {
        const re = new RegExp(`(?<!\\w)(?<!\\.)(?<!await\\s)${fn}\\(`);
        const match = line.match(re);
        if (match) {
          const before = line.substring(0, match.index);
          if (/\b(async|function)\s*$/.test(before)) continue;
          if (/\btype\s/.test(before)) continue;
          lines[errIdx] = line.substring(0, match.index) + 'await ' + line.substring(match.index);
          fileChanges++;
          fixedLines.add(errIdx);
          break;
        }
      }
    }

    // ── Fixer 6: TS2488/TS2801 (for..of on Promise, truthiness check on Promise) ──
    const iterErrors = fileErrors.filter(e =>
      ['TS2488', 'TS2801'].includes(e.code)
    );
    for (const err of iterErrors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;

      const line = lines[errIdx];

      for (const fn of allAsyncFns) {
        const re = new RegExp(`(?<!\\w)(?<!\\.)(?<!await\\s)${fn}\\(`);
        const match = line.match(re);
        if (match) {
          const before = line.substring(0, match.index);
          if (/\b(async|function)\s*$/.test(before)) continue;
          lines[errIdx] = line.substring(0, match.index) + 'await ' + line.substring(match.index);
          fileChanges++;
          fixedLines.add(errIdx);
          break;
        }
      }
    }

    // ── Fixer 7: TS2367/TS2537 comparison/index on Promise types ──
    const compareErrors = fileErrors.filter(e =>
      ['TS2367', 'TS2537'].includes(e.code) && e.msg.includes('Promise<')
    );
    for (const err of compareErrors) {
      const errIdx = err.line - 1;
      if (errIdx < 0 || errIdx >= lines.length) continue;
      if (fixedLines.has(errIdx)) continue;
      const line = lines[errIdx];
      if (/\bawait\b/.test(line)) continue;

      const varMatch = line.match(/\b(\w+)\s*(?:[=!<>]=|[<>]|\[)/);
      if (!varMatch) continue;
      const varName = varMatch[1];
      if (['this', 'console', 'Math', 'JSON', 'Array', 'Object', 'Promise'].includes(varName)) continue;

      for (let j = errIdx - 1; j >= Math.max(0, errIdx - 80); j--) {
        const aLine = lines[j];
        const pat = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*(?!await\\s)(\\w+)\\(`);
        const m = aLine.match(pat);
        if (!m) continue;
        const fn = m[1];
        lines[j] = aLine.replace(new RegExp(`(=\\s*)${fn}\\(`), `$1await ${fn}(`);
        fileChanges++;
        fixedLines.add(j);
        break;
      }
    }

    if (fileChanges > 0) {
      writeFileSync(absPath, lines.join(eol), 'utf8');
      totalFixes += fileChanges;
      console.log(`  ${relPath}: ${fileChanges} fixes`);
    }
  }

  console.log(`Applied ${totalFixes} fixes`);
  if (totalFixes === 0) {
    console.log('\nNo more automatic fixes. Remaining errors:');
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
