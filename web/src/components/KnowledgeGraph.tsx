import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const KnowledgeGraphCanvas = lazy(() => import('./KnowledgeGraphCanvas').then((m) => ({ default: m.KnowledgeGraphCanvas })));

export interface KbGraphNode {
  id: string;
  label: string;
  type: 'document' | 'wiki';
  status?: string;
  processed?: boolean;
  llmStatus?: string | null;
  degree?: number;
  depth?: number;
  pageType?: string;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
  vx?: number;
  vy?: number;
}

export interface KbGraphLink {
  source: string | KbGraphNode;
  target: string | KbGraphNode;
  type: string;
  confidence?: number;
}

export interface KnowledgeGraphProps {
  graphData: { nodes: KbGraphNode[]; links: KbGraphLink[] };
  stats?: KnowledgeGraphStats | null;
  hiddenCounts?: KnowledgeGraphHiddenCounts | null;
  height?: number;
  onNodeClick?: (node: KbGraphNode) => void;
  viewScope?: string;
}

export interface KnowledgeGraphStats {
  view: 'overview' | 'focus' | 'full';
  max_nodes: number;
  min_confidence: number;
  focus_id: string | null;
  total_nodes: number;
  total_links: number;
  visible_nodes: number;
  visible_links: number;
  documents: number;
  wiki_pages: number;
  tree_edges: number;
  relation_edges: number;
  wiki_source_edges: number;
  include: string[];
}

export interface KnowledgeGraphHiddenCounts {
  nodes: number;
  links: number;
  unprocessed_nodes: number;
  tree_leaf_nodes?: number;
  low_confidence_relations: number;
  excluded_by_include: number;
  max_nodes: number;
  weak_wiki_source_edges: number;
}

type KnowledgeGraphLayoutMode = 'cluster' | 'hierarchy';

const GRAPH_PREF_KEY = 'knowledge-graph-display-prefs';
const GRAPH_VIEW_PREFIX = 'knowledge-graph-view:';

function shortenLabel(label: string, max = 20): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max)}…`;
}

function linkTypeKey(link: KbGraphLink): string {
  return link.type;
}

function linkColorForType(t: string): string {
  switch (t) {
    case 'parent_of':
      return '#3b82f6';
    case 'supersedes':
      return '#ef4444';
    case 'supplements':
      return '#22c55e';
    case 'contradicts':
      return '#f97316';
    case 'references':
      return '#9ca3af';
    case 'wiki_source':
      return '#c4b5fd';
    default:
      return '#6b7280';
  }
}

function linkWidthForType(t: string): number {
  if (t === 'supersedes') return 3;
  if (t === 'parent_of') return 2;
  if (t === 'references' || t === 'wiki_source') return 1;
  return 1.5;
}

function linkDashForType(t: string): number[] | null {
  if (t === 'supplements') return [6, 4];
  if (t === 'contradicts') return [4, 4];
  if (t === 'references') return [2, 3];
  if (t === 'wiki_source') return [3, 6];
  return null;
}

function docFillForDepth(depth: number | undefined): string {
  const d = depth ?? 0;
  if (d <= 0) return '#2563eb';
  const t = Math.min(d / 8, 1);
  const r = Math.round(37 + (191 - 37) * t);
  const g = Math.round(99 + (219 - 99) * t);
  const b = Math.round(235 + (254 - 235) * t);
  return `rgb(${r},${g},${b})`;
}

function loadLayoutMode(): KnowledgeGraphLayoutMode {
  try {
    const raw = localStorage.getItem(GRAPH_PREF_KEY);
    if (!raw) return 'cluster';
    const parsed = JSON.parse(raw) as { layoutMode?: unknown };
    return parsed.layoutMode === 'hierarchy' ? 'hierarchy' : 'cluster';
  } catch {
    return 'cluster';
  }
}

function saveLayoutMode(layoutMode: KnowledgeGraphLayoutMode): void {
  try {
    localStorage.setItem(GRAPH_PREF_KEY, JSON.stringify({ layoutMode }));
  } catch { /* noop */ }
}

function loadViewState(scope: string): { zoom: number; x: number; y: number } | null {
  if (!scope) return null;
  try {
    const raw = localStorage.getItem(GRAPH_VIEW_PREFIX + scope);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { zoom?: unknown; x?: unknown; y?: unknown };
    if (
      typeof parsed.zoom === 'number'
      && typeof parsed.x === 'number'
      && typeof parsed.y === 'number'
    ) {
      return {
        zoom: Math.max(0.1, Math.min(6, parsed.zoom)),
        x: parsed.x,
        y: parsed.y,
      };
    }
  } catch { /* noop */ }
  return null;
}

function saveViewState(scope: string, state: { zoom: number; x: number; y: number }): void {
  if (!scope) return;
  try {
    localStorage.setItem(GRAPH_VIEW_PREFIX + scope, JSON.stringify(state));
  } catch { /* noop */ }
}

export function KnowledgeGraph({
  graphData,
  stats,
  hiddenCounts,
  height = 420,
  onNodeClick,
  viewScope = '',
}: KnowledgeGraphProps) {
  const { t } = useTranslation('knowledge');
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const [width, setWidth] = useState(320);
  const [spacing, setSpacing] = useState(1.9);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<KnowledgeGraphLayoutMode>(() => loadLayoutMode());
  const labelColorRef = useRef('#e5e7eb');

  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const w = Math.max(240, el.clientWidth || el.getBoundingClientRect().width);
    setWidth(w);
    const v = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();
    labelColorRef.current = v || '#e5e7eb';
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const resetView = useCallback(() => {
    if (!graphRef.current) return;
    graphRef.current.zoomToFit?.(400, 48);
  }, []);

  useEffect(() => {
    saveLayoutMode(layoutMode);
  }, [layoutMode]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (layoutMode === 'hierarchy') {
      graph.d3ReheatSimulation?.();
      return;
    }

    const charge = graph.d3Force('charge');
    charge?.strength?.((node: KbGraphNode) => {
      const base = node.type === 'wiki' ? 260 : 210;
      const processedBoost = node.processed ? 1 : 0.55;
      const degreeBoost = 1 + Math.min((node.degree ?? 0) * 0.08, 0.4);
      return -1 * base * spacing * spacing * processedBoost * degreeBoost;
    });

    const linkForce = graph.d3Force('link');
    linkForce?.distance?.((link: KbGraphLink) => {
      const base = link.type === 'parent_of' ? 120 : link.type === 'wiki_source' ? 140 : 165;
      return base * spacing;
    });
    linkForce?.strength?.((link: KbGraphLink) => (
      link.type === 'parent_of' ? 0.18 : link.type === 'wiki_source' ? 0.14 : 0.11
    ));

    graph.d3ReheatSimulation?.();
  }, [graphData, layoutMode, spacing]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = loadViewState(viewScope);
      if (saved && graphRef.current) {
        graphRef.current.centerAt?.(saved.x, saved.y, 0);
        graphRef.current.zoom?.(saved.zoom, 0);
        setZoomLevel(Math.round(saved.zoom * 100));
      } else {
        resetView();
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [graphData, width, height, resetView, viewScope]);

  const nodeCanvasObject = useCallback(
    (node: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as KbGraphNode;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const processed = n.processed !== false;
      const r = n.type === 'wiki'
        ? (processed ? 5.5 : 4)
        : (processed ? 4.5 : 3.2);
      const fill = n.type === 'wiki'
        ? (processed ? '#22c55e' : 'rgba(34, 197, 94, 0.35)')
        : (processed ? docFillForDepth(n.depth) : 'rgba(148, 163, 184, 0.3)');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = fill;
      ctx.fill();
      if (hoveredNodeId === n.id) {
        ctx.beginPath();
        ctx.arc(x, y, r + 2 / globalScale, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.95)';
        ctx.lineWidth = Math.max(1, 1.6 / globalScale);
        ctx.stroke();
      }

      const shouldDrawLabel =
        hoveredNodeId === n.id
        || n.type === 'wiki'
        || ((n.degree ?? 0) >= 3 && processed)
        || globalScale >= 1.8;
      if (!shouldDrawLabel) return;

      const fontSize = Math.max(9, 11 / globalScale);
      ctx.font = `${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = processed ? labelColorRef.current : 'rgba(148, 163, 184, 0.78)';
      ctx.fillText(shortenLabel(n.label, hoveredNodeId === n.id ? 28 : 18), x + r + 4 / globalScale, y);
    },
    [hoveredNodeId],
  );

  const linkColor = useCallback((link: unknown) => linkColorForType(linkTypeKey(link as KbGraphLink)), []);
  const linkWidth = useCallback((link: unknown) => linkWidthForType(linkTypeKey(link as KbGraphLink)), []);
  const linkLineDash = useCallback((link: unknown) => linkDashForType(linkTypeKey(link as KbGraphLink)), []);

  const particles = graphData.links.length > 180 || layoutMode === 'hierarchy' ? 0 : 1;
  const hiddenSummary = hiddenCounts
    ? [
      hiddenCounts.unprocessed_nodes > 0 ? t('graph.unprocessed', { count: hiddenCounts.unprocessed_nodes }) : null,
      hiddenCounts.tree_leaf_nodes && hiddenCounts.tree_leaf_nodes > 0 ? t('graph.treeLeaf', { count: hiddenCounts.tree_leaf_nodes }) : null,
      hiddenCounts.low_confidence_relations > 0 ? t('graph.lowConfidence', { count: hiddenCounts.low_confidence_relations }) : null,
      hiddenCounts.weak_wiki_source_edges > 0 ? t('graph.weakSource', { count: hiddenCounts.weak_wiki_source_edges }) : null,
      hiddenCounts.max_nodes > 0 ? t('graph.maxNodes', { count: hiddenCounts.max_nodes }) : null,
    ].filter(Boolean).join(' · ')
    : '';

  return (
    <div ref={wrapRef} className="knowledge-graph-container" style={{ height }}>
      <div className="knowledge-graph-canvas-tools">
        <div className="knowledge-graph-toggle" role="group" aria-label={t('graph.layout')}>
          <button
            type="button"
            className={layoutMode === 'cluster' ? 'is-active' : ''}
            onClick={() => setLayoutMode('cluster')}
          >
            {t('graph.cluster')}
          </button>
          <button
            type="button"
            className={layoutMode === 'hierarchy' ? 'is-active' : ''}
            onClick={() => setLayoutMode('hierarchy')}
          >
            {t('graph.hierarchy')}
          </button>
        </div>
        <label className="knowledge-graph-spacing-inline">
          <span>{t('graph.spacing')}</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.1}
            value={spacing}
            onChange={(event) => setSpacing(Number(event.target.value))}
          />
        </label>
        <button type="button" className="btn-outline btn-xs" onClick={() => graphRef.current?.zoom?.(graphRef.current.zoom() * 1.15, 300)}>
          {t('graph.zoomIn')}
        </button>
        <button type="button" className="btn-outline btn-xs" onClick={() => graphRef.current?.zoom?.(graphRef.current.zoom() / 1.15, 300)}>
          {t('graph.zoomOut')}
        </button>
        <button type="button" className="btn-outline btn-xs" onClick={resetView}>
          {t('graph.resetView')}
        </button>
        <span className="knowledge-graph-zoom-readout">{zoomLevel}%</span>
      </div>
      {stats ? (
        <div className="knowledge-graph-stats">
          <span>{t('graph.nodes', { visible: stats.visible_nodes, total: stats.total_nodes })}</span>
          <span>{t('graph.links', { visible: stats.visible_links, total: stats.total_links })}</span>
          <span>{t('graph.confidence', { pct: Math.round(stats.min_confidence * 100) })}</span>
          {hiddenSummary ? <span title={hiddenSummary}>{t('graph.hidden', { summary: hiddenSummary })}</span> : null}
        </div>
      ) : null}
      <Suspense fallback={<div className="knowledge-note">{t('加载图谱画布…')}</div>}>
        <KnowledgeGraphCanvas
          ref={graphRef}
          graphData={graphData}
          width={width}
          height={height}
          layoutMode={layoutMode}
          particles={particles}
          nodeCanvasObject={nodeCanvasObject}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkLineDash={linkLineDash}
          onNodeHover={(node: unknown) => setHoveredNodeId((node as KbGraphNode | null)?.id ?? null)}
          onNodeClick={onNodeClick ? (n) => onNodeClick(n as KbGraphNode) : undefined}
          onZoomEnd={({ k, x, y }: { k: number; x: number; y: number }) => {
            setZoomLevel(Math.round(k * 100));
            saveViewState(viewScope, { zoom: k, x, y });
          }}
        />
      </Suspense>
    </div>
  );
}
