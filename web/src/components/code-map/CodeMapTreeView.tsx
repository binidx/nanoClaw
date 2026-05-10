import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodeMapFile, CodeMapEdge } from './code-map-api';
import { getKindLabels, KIND_COLORS } from './code-map-api';

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: CodeMapFile;
}

export interface CodeMapTreeViewProps {
  files: CodeMapFile[];
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  selectedFileData: CodeMapFile | null;
  relatedEdges: CodeMapEdge[];
}


function buildTree(files: CodeMapFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] };

  for (const file of files) {
    const parts = file.relativePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const nodePath = parts.slice(0, i + 1).join('/');

      let child = current.children.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          path: nodePath,
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.isDir) sortTree(child);
  }
}

function rankToHeat(rank: number, maxRank: number): string {
  if (maxRank <= 0) return 'var(--text-secondary)';
  const intensity = Math.min(1, rank / maxRank);
  if (intensity > 0.7) return 'var(--accent-orange, #f59e0b)';
  if (intensity > 0.4) return 'var(--accent-blue, #3b82f6)';
  return 'var(--text-secondary)';
}

export function CodeMapTreeView({
  files,
  selectedFile,
  onSelectFile,
  selectedFileData,
  relatedEdges,
}: CodeMapTreeViewProps) {
  const { t } = useTranslation('codeMap');
  const tree = useMemo(() => buildTree(files), [files]);
  const maxRank = useMemo(
    () => Math.max(...files.map((f) => f.rank), 0.001),
    [files],
  );

  return (
    <div className="code-map-tree-layout">
      <div className="code-map-tree-sidebar">
        <TreeNodeView
          node={tree}
          depth={-1}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          maxRank={maxRank}
          isRoot
        />
      </div>
      <div className="code-map-tree-detail">
        {selectedFileData ? (
          <FileDetail
            file={selectedFileData}
            relatedEdges={relatedEdges}
            onSelectFile={onSelectFile}
          />
        ) : (
          <div className="code-map-tree-empty">
            {t('tree.clickToView')}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  selectedFile,
  onSelectFile,
  maxRank,
  isRoot = false,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  maxRank: number;
  isRoot?: boolean;
}) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (isRoot) {
    return (
      <div className="code-map-tree-root">
        {node.children.map((child) => (
          <TreeNodeView
            key={child.path}
            node={child}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            maxRank={maxRank}
          />
        ))}
      </div>
    );
  }

  if (node.isDir) {
    return (
      <div className="code-map-tree-dir">
        <button
          type="button"
          className="code-map-tree-dir-toggle"
          onClick={() => setExpanded(!expanded)}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <span className="code-map-tree-chevron">{expanded ? '▼' : '▶'}</span>
          <span className="code-map-tree-dir-icon" aria-hidden="true">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </span>
          <span className="code-map-tree-dir-name">{node.name}/</span>
          <span className="code-map-tree-dir-count">
            {countFiles(node)}
          </span>
        </button>
        {expanded && (
          <div className="code-map-tree-dir-children">
            {node.children.map((child) => (
              <TreeNodeView
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
                maxRank={maxRank}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = selectedFile === node.path;
  const file = node.file;
  const symbolCount = file?.symbols.length ?? 0;

  return (
    <button
      type="button"
      className={`code-map-tree-file${isSelected ? ' code-map-tree-file-selected' : ''}`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={() => onSelectFile(isSelected ? null : node.path)}
    >
      <span
        className="code-map-tree-heat"
        style={{ backgroundColor: file ? rankToHeat(file.rank, maxRank) : undefined }}
      />
      <span className="code-map-tree-file-name">{node.name}</span>
      {symbolCount > 0 && (
        <span className="code-map-tree-file-badge">{symbolCount}</span>
      )}
    </button>
  );
}

function countFiles(node: TreeNode): number {
  if (!node.isDir) return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

function FileDetail({
  file,
  relatedEdges,
  onSelectFile,
}: {
  file: CodeMapFile;
  relatedEdges: CodeMapEdge[];
  onSelectFile: (path: string | null) => void;
}) {
  const { t } = useTranslation('codeMap');
  const sortedSymbols = useMemo(
    () => [...file.symbols].sort((a, b) => b.rank - a.rank),
    [file],
  );

  const imports = relatedEdges.filter((e) => e.fromFile === file.relativePath);
  const importedBy = relatedEdges.filter((e) => e.toFile === file.relativePath);

  return (
    <div className="code-map-file-detail">
      <div className="code-map-file-header">
        <h4 className="code-map-file-title">{file.relativePath}</h4>
        <div className="code-map-file-meta">
          <span>{file.language}</span>
          <span>{t('tree.lines', { count: file.lineCount })}</span>
          <span>{t('tree.symbols', { count: file.symbols.length })}</span>
          <span>{t('tree.imports', { count: file.importCount })}</span>
        </div>
      </div>

      {sortedSymbols.length > 0 && (
        <div className="code-map-file-section">
          <h5 className="code-map-section-title">{t('tree.symbolDefs')}</h5>
          <div className="code-map-symbol-list">
            {sortedSymbols.map((sym, i) => {
              const kindLabels = getKindLabels();
              const kindKey = Object.prototype.hasOwnProperty.call(kindLabels, sym.kind)
                ? sym.kind
                : 'unknown';
              const bg = KIND_COLORS[kindKey] || KIND_COLORS.unknown;
              return (
                <div key={`${sym.name}-${sym.line}-${i}`} className="code-map-symbol-item">
                  <span
                    className="codemap-kind-badge"
                    style={{ backgroundColor: bg }}
                    title={sym.kind}
                  >
                    {kindLabels[kindKey]}
                  </span>
                  <code className="code-map-symbol-sig">{sym.signature}</code>
                  <span className="code-map-symbol-line">L{sym.line}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {imports.length > 0 && (
        <div className="code-map-file-section">
          <h5 className="code-map-section-title">{t('tree.dependencies', { count: imports.length })}</h5>
          <ul className="code-map-edge-list">
            {imports.map((e) => (
              <li key={e.toFile}>
                <button
                  type="button"
                  className="code-map-edge-link"
                  onClick={() => onSelectFile(e.toFile)}
                >
                  → {e.toFile}
                </button>
                {e.symbols.length > 0 && (
                  <span className="code-map-edge-symbols">
                    {' '}({e.symbols.join(', ')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {importedBy.length > 0 && (
        <div className="code-map-file-section">
          <h5 className="code-map-section-title">{t('tree.referencedBy', { count: importedBy.length })}</h5>
          <ul className="code-map-edge-list">
            {importedBy.map((e) => (
              <li key={e.fromFile}>
                <button
                  type="button"
                  className="code-map-edge-link"
                  onClick={() => onSelectFile(e.fromFile)}
                >
                  ← {e.fromFile}
                </button>
                {e.symbols.length > 0 && (
                  <span className="code-map-edge-symbols">
                    {' '}({e.symbols.join(', ')})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
