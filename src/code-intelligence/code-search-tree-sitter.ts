/**
 * Tree-sitter based symbol extraction for Java, Go, Python, TypeScript.
 *
 * Uses web-tree-sitter (WASM) to parse source code into an AST and extract
 * symbols structurally — no regex, no false positives from control flow.
 *
 * Usage:
 *   await preloadTreeSitterGrammars();   // one-time async init
 *   const syms = extractSymbolsTS(lang, code, lines);  // sync after init
 *
 * ABI constraint: web-tree-sitter must stay on 0.25.x. The WASM grammar files
 * from tree-sitter-wasms are compiled against 0.20.x ABI which is incompatible
 * with web-tree-sitter 0.26+ (dylink metadata format changed). Do not upgrade
 * web-tree-sitter until tree-sitter-wasms publishes 0.26-compatible WASMs.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CodeSearchSymbol } from './code-search-types.js';

const require2 = createRequire(import.meta.url);

/* ---- Dynamic types (web-tree-sitter is optional) ---- */
/* eslint-disable @typescript-eslint/no-explicit-any */
type TSParser = any;
type TSLanguage = any;
type TSNode = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface TsJsFunctionGraphNode {
  localId: string;
  name: string;
  kind: CodeSearchSymbol['kind'];
  line: number;
  column: number;
  signature: string;
  startLine: number;
  endLine: number;
  parentLocalId: string | null;
}

export interface TsJsFunctionGraphCall {
  fromLocalId: string;
  calleeName: string;
  qualifier: string | null;
  line: number;
}

export interface TsJsFunctionGraph {
  functions: TsJsFunctionGraphNode[];
  calls: TsJsFunctionGraphCall[];
}

const SUPPORTED_LANGUAGES = new Set(['java', 'go', 'python', 'typescript', 'javascript']);

const WASM_FILES: Record<string, string> = {
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
};

let ParserCtor: (new () => TSParser) | null = null;
const loadedLanguages = new Map<string, TSLanguage>();
let initDone = false;
let initPromise: Promise<void> | null = null;

/**
 * Async one-time initialization. Safe to call concurrently — uses single-flight
 * pattern to prevent duplicate WASM loads.
 * After this resolves, `extractSymbolsTS` works synchronously.
 */
export function preloadTreeSitterGrammars(): Promise<void> {
  if (initDone) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  try {
    const mod = await import('web-tree-sitter');
    const Parser = mod.Parser;
    await Parser.init();
    ParserCtor = Parser as unknown as new () => TSParser;

    const wasmBase = path.join(
      path.dirname(require2.resolve('tree-sitter-wasms/package.json')),
      'out',
    );
    const loads = Object.entries(WASM_FILES).map(async ([lang, file]) => {
      try {
        const language = await mod.Language.load(path.join(wasmBase, file));
        loadedLanguages.set(lang, language);
      } catch { /* grammar unavailable — fallback to regex for this lang */ }
    });
    await Promise.all(loads);
    initDone = true;
  } catch {
    // web-tree-sitter or grammars not installed — all languages fall back to regex
    initPromise = null;
  }
}

export function isTreeSitterReady(language: string): boolean {
  return initDone && loadedLanguages.has(language);
}

export function isTreeSitterSupported(language: string): boolean {
  return SUPPORTED_LANGUAGES.has(language);
}

/**
 * Synchronous symbol extraction — call only after `preloadTreeSitterGrammars()` resolves.
 */
export function extractSymbolsTS(
  language: string,
  sourceCode: string,
  rawLines: string[],
): CodeSearchSymbol[] {
  if (!ParserCtor || !loadedLanguages.has(language)) return [];
  const parser = new ParserCtor();
  parser.setLanguage(loadedLanguages.get(language));

  try {
    const tree = parser.parse(sourceCode);
    try {
      switch (language) {
        case 'java':
          return extractJava(tree.rootNode, rawLines);
        case 'go':
          return extractGo(tree.rootNode, rawLines);
        case 'python':
          return extractPython(tree.rootNode, rawLines);
        case 'typescript':
        case 'javascript':
          return extractTsJs(tree.rootNode, rawLines);
        default:
          return [];
      }
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

export function extractTsJsFunctionGraphTS(
  language: string,
  sourceCode: string,
  rawLines: string[],
): TsJsFunctionGraph {
  if (!ParserCtor || !loadedLanguages.has(language)) {
    return { functions: [], calls: [] };
  }
  if (language !== 'typescript' && language !== 'javascript') {
    return { functions: [], calls: [] };
  }
  const parser = new ParserCtor();
  parser.setLanguage(loadedLanguages.get(language));
  try {
    const tree = parser.parse(sourceCode);
    try {
      return extractTsJsFunctionGraphFromRoot(tree.rootNode, rawLines);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function nameOf(node: TSNode): string | null {
  const n = node.childForFieldName('name');
  return n?.text ?? null;
}

function sigLine(rawLines: string[], row: number): string {
  return rawLines[row]?.trim() ?? '';
}

function sym(
  out: CodeSearchSymbol[],
  kind: CodeSearchSymbol['kind'],
  name: string,
  node: TSNode,
  rawLines: string[],
) {
  out.push({
    name,
    kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    signature: sigLine(rawLines, node.startPosition.row),
  });
}

/* ------------------------------------------------------------------ */
/*  Java                                                              */
/* ------------------------------------------------------------------ */

function extractJava(root: TSNode, rawLines: string[]): CodeSearchSymbol[] {
  const out: CodeSearchSymbol[] = [];
  walkJava(root, out, rawLines);
  return out;
}

function walkJava(node: TSNode, out: CodeSearchSymbol[], rawLines: string[]) {
  const t = node.type;

  if (t === 'package_declaration') {
    const id = node.descendantsOfType('scoped_identifier')[0]
      ?? node.descendantsOfType('identifier')[0];
    if (id) sym(out, 'package', id.text, node, rawLines);
    return;
  }
  if (t === 'class_declaration' || t === 'record_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'class', n, node, rawLines);
    eachChild(node, out, rawLines, walkJava);
    return;
  }
  if (t === 'interface_declaration' || t === 'annotation_type_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'interface', n, node, rawLines);
    if (t === 'interface_declaration') eachChild(node, out, rawLines, walkJava);
    return;
  }
  if (t === 'enum_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'enum', n, node, rawLines);
    return;
  }
  if (t === 'constructor_declaration' || t === 'method_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'method', n, node, rawLines);
    return;
  }
  if (t === 'field_declaration') {
    const mods = node.childForFieldName('modifiers')?.text ?? '';
    if (mods.includes('static') && mods.includes('final')) {
      for (const d of node.descendantsOfType('variable_declarator')) {
        const n = d.childForFieldName('name');
        if (n) sym(out, 'const', n.text, node, rawLines);
      }
    }
    return;
  }
  eachChild(node, out, rawLines, walkJava);
}

/* ------------------------------------------------------------------ */
/*  Go                                                                */
/* ------------------------------------------------------------------ */

function extractGo(root: TSNode, rawLines: string[]): CodeSearchSymbol[] {
  const out: CodeSearchSymbol[] = [];
  walkGo(root, out, rawLines);
  return out;
}

function walkGo(node: TSNode, out: CodeSearchSymbol[], rawLines: string[]) {
  const t = node.type;

  if (t === 'package_clause') {
    const id = node.descendantsOfType('package_identifier')[0];
    if (id) sym(out, 'package', id.text, node, rawLines);
    return;
  }
  if (t === 'function_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'function', n, node, rawLines);
    return;
  }
  if (t === 'method_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'method', n, node, rawLines);
    return;
  }
  if (t === 'type_declaration') {
    for (const spec of node.descendantsOfType('type_spec')) {
      const n = spec.childForFieldName('name');
      const typeNode = spec.childForFieldName('type');
      if (!n || !typeNode) continue;
      const tt = typeNode.type;
      if (tt === 'struct_type') sym(out, 'struct', n.text, spec, rawLines);
      else if (tt === 'interface_type') sym(out, 'interface', n.text, spec, rawLines);
      else sym(out, 'type', n.text, spec, rawLines);
    }
    return;
  }
  if (t === 'const_declaration') {
    for (const spec of node.descendantsOfType('const_spec')) {
      const n = spec.childForFieldName('name');
      if (n) sym(out, 'const', n.text, spec, rawLines);
    }
    return;
  }
  if (t === 'var_declaration') {
    for (const spec of node.descendantsOfType('var_spec')) {
      const n = spec.childForFieldName('name');
      if (n) sym(out, 'variable', n.text, spec, rawLines);
    }
    return;
  }
  eachChild(node, out, rawLines, walkGo);
}

/* ------------------------------------------------------------------ */
/*  Python                                                            */
/* ------------------------------------------------------------------ */

function extractPython(root: TSNode, rawLines: string[]): CodeSearchSymbol[] {
  const out: CodeSearchSymbol[] = [];
  walkPython(root, out, rawLines);
  return out;
}

function walkPython(node: TSNode, out: CodeSearchSymbol[], rawLines: string[]) {
  const t = node.type;

  if (t === 'class_definition') {
    const n = nameOf(node);
    if (n) sym(out, 'class', n, node, rawLines);
    eachChild(node, out, rawLines, walkPython);
    return;
  }
  if (t === 'function_definition') {
    const n = nameOf(node);
    if (n) sym(out, 'function', n, node, rawLines);
    return;
  }
  if (t === 'decorated_definition') {
    const decorators: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)!;
      if (child.type === 'decorator') {
        decorators.push(child.text);
      } else if (child.type === 'function_definition' || child.type === 'class_definition') {
        const n = nameOf(child);
        if (n) {
          const kind: CodeSearchSymbol['kind'] = child.type === 'class_definition' ? 'class' : 'function';
          const baseSig = sigLine(rawLines, child.startPosition.row);
          out.push({
            name: n,
            kind,
            line: child.startPosition.row + 1,
            column: child.startPosition.column + 1,
            signature: decorators.length > 0 ? `${decorators.join(' ')} ${baseSig}` : baseSig,
          });
          if (child.type === 'class_definition') eachChild(child, out, rawLines, walkPython);
        }
      }
    }
    return;
  }
  eachChild(node, out, rawLines, walkPython);
}

/* ------------------------------------------------------------------ */
/*  TypeScript / JavaScript                                           */
/* ------------------------------------------------------------------ */

function extractTsJs(root: TSNode, rawLines: string[]): CodeSearchSymbol[] {
  const out: CodeSearchSymbol[] = [];
  walkTs(root, out, rawLines);
  return out;
}

function extractTsJsFunctionGraphFromRoot(root: TSNode, rawLines: string[]): TsJsFunctionGraph {
  const functions: TsJsFunctionGraphNode[] = [];
  const calls: TsJsFunctionGraphCall[] = [];
  walkTsGraph(root, rawLines, functions, calls, null);
  return { functions, calls };
}

function walkTsGraph(
  node: TSNode,
  rawLines: string[],
  functions: TsJsFunctionGraphNode[],
  calls: TsJsFunctionGraphCall[],
  currentFunctionId: string | null,
) {
  const t = node.type;

  if (t === 'export_statement') {
    const decl = node.childForFieldName('declaration');
    if (decl) {
      walkTsGraph(decl, rawLines, functions, calls, currentFunctionId);
      return;
    }
  }

  if (t === 'function_declaration') {
    const name = nameOf(node);
    if (name) {
      const fn = registerTsGraphFunction(node, name, 'function', rawLines, currentFunctionId);
      functions.push(fn);
      const body = node.childForFieldName('body');
      if (body) walkTsGraph(body, rawLines, functions, calls, fn.localId);
      return;
    }
  }

  if (t === 'method_definition') {
    const name = nameOf(node);
    if (name) {
      const fn = registerTsGraphFunction(node, name, 'method', rawLines, currentFunctionId);
      functions.push(fn);
      const body = node.childForFieldName('body');
      if (body) walkTsGraph(body, rawLines, functions, calls, fn.localId);
      return;
    }
  }

  if (t === 'variable_declarator') {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    if (
      nameNode
      && valueNode
      && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
    ) {
      const kind = variableDeclaratorKind(node);
      const line = node.startPosition.row + 1;
      const fn: TsJsFunctionGraphNode = {
        localId: `${nameNode.text}:${line}:${nameNode.startPosition.column + 1}`,
        name: nameNode.text,
        kind,
        line,
        column: nameNode.startPosition.column + 1,
        signature: sigLine(rawLines, node.startPosition.row),
        startLine: line,
        endLine: valueNode.endPosition.row + 1,
        parentLocalId: currentFunctionId,
      };
      functions.push(fn);
      const body = valueNode.childForFieldName('body') || valueNode;
      walkTsGraph(body, rawLines, functions, calls, fn.localId);
      return;
    }
  }

  if (currentFunctionId && t === 'call_expression') {
    const parsed = parseTsCall(node);
    if (parsed) {
      calls.push({
        fromLocalId: currentFunctionId,
        calleeName: parsed.calleeName,
        qualifier: parsed.qualifier,
        line: node.startPosition.row + 1,
      });
    }
  }

  for (let i = 0; i < node.namedChildCount; i += 1) {
    walkTsGraph(node.namedChild(i)!, rawLines, functions, calls, currentFunctionId);
  }
}

function registerTsGraphFunction(
  node: TSNode,
  name: string,
  kind: CodeSearchSymbol['kind'],
  rawLines: string[],
  parentLocalId: string | null,
): TsJsFunctionGraphNode {
  const line = node.startPosition.row + 1;
  const column = node.startPosition.column + 1;
  return {
    localId: `${name}:${line}:${column}`,
    name,
    kind,
    line,
    column,
    signature: sigLine(rawLines, node.startPosition.row),
    startLine: line,
    endLine: node.endPosition.row + 1,
    parentLocalId,
  };
}

function variableDeclaratorKind(node: TSNode): CodeSearchSymbol['kind'] {
  const parent = node.parent;
  if (!parent) return 'const';
  const source = parent.text || '';
  return /\bconst\b/.test(source) ? 'const' : 'variable';
}

function unwrapCallTarget(node: TSNode | null): TSNode | null {
  let current = node;
  while (current) {
    if (
      current.type === 'parenthesized_expression'
      || current.type === 'type_assertion'
      || current.type === 'as_expression'
      || current.type === 'satisfies_expression'
      || current.type === 'non_null_expression'
      || current.type === 'await_expression'
    ) {
      current = current.namedChild(0) || current.childForFieldName('expression');
      continue;
    }
    return current;
  }
  return null;
}

function parseTsCall(node: TSNode): { calleeName: string; qualifier: string | null } | null {
  const callee = unwrapCallTarget(node.childForFieldName('function'));
  if (!callee) return null;

  if (callee.type === 'identifier' || callee.type === 'property_identifier') {
    return { calleeName: callee.text, qualifier: null };
  }

  if (callee.type === 'member_expression') {
    const objectNode = unwrapCallTarget(callee.childForFieldName('object'));
    const propertyNode = unwrapCallTarget(callee.childForFieldName('property'));
    if (!propertyNode || !propertyNode.text) return null;
    const qualifier = objectNode?.text || null;
    return {
      calleeName: propertyNode.text,
      qualifier,
    };
  }

  return null;
}

function walkTs(node: TSNode, out: CodeSearchSymbol[], rawLines: string[]) {
  const t = node.type;

  if (t === 'export_statement') {
    const decl = node.childForFieldName('declaration');
    if (decl) walkTs(decl, out, rawLines);
    else eachChild(node, out, rawLines, walkTs);
    return;
  }
  if (t === 'class_declaration' || t === 'abstract_class_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'class', n, node, rawLines);
    eachChild(node, out, rawLines, walkTs);
    return;
  }
  if (t === 'interface_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'interface', n, node, rawLines);
    return;
  }
  if (t === 'type_alias_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'type', n, node, rawLines);
    return;
  }
  if (t === 'enum_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'enum', n, node, rawLines);
    return;
  }
  if (t === 'function_declaration') {
    const n = nameOf(node);
    if (n) sym(out, 'function', n, node, rawLines);
    return;
  }
  if (t === 'method_definition') {
    const n = nameOf(node);
    if (n) sym(out, 'method', n, node, rawLines);
    return;
  }
  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const decl = node.namedChild(i)!;
      if (decl.type !== 'variable_declarator') continue;
      const n = decl.childForFieldName('name');
      const val = decl.childForFieldName('value');
      if (n && val) {
        const vt = val.type;
        if (vt === 'arrow_function' || vt === 'function_expression' || vt === 'call_expression') {
          sym(out, 'const', n.text, node, rawLines);
        }
      }
    }
    return;
  }
  if (t === 'module') {
    const n = nameOf(node);
    if (n) sym(out, 'namespace', n, node, rawLines);
    eachChild(node, out, rawLines, walkTs);
    return;
  }
  eachChild(node, out, rawLines, walkTs);
}

/* ------------------------------------------------------------------ */
/*  Shared traversal                                                  */
/* ------------------------------------------------------------------ */

type WalkFn = (node: TSNode, out: CodeSearchSymbol[], rawLines: string[]) => void;

function eachChild(node: TSNode, out: CodeSearchSymbol[], rawLines: string[], walk: WalkFn) {
  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i)!, out, rawLines);
  }
}
