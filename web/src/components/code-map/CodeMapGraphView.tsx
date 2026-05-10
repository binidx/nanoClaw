import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import dagre from 'dagre';
import type { CodeMapFile, CodeMapEdge } from './code-map-api';
import { NcSelect } from '../common/NcSelect';

export interface CodeMapGraphViewProps {
  files: CodeMapFile[];
  edges: CodeMapEdge[];
  selectedFile: string | null;
  onSelectFile: (path: string | null) => void;
  allFiles?: CodeMapFile[];
  allEdges?: CodeMapEdge[];
  /** Scope key for view-state persistence (e.g. "repoId:branch") */
  viewScope?: string;
}

interface GraphNode {
  id: string;
  label: string;
  fullPath: string;
  language: string;
  rank: number;
  symbolCount: number;
  x: number;
  y: number;
  dir: string;
}

interface GraphLink {
  source: string;
  target: string;
  symbolCount: number;
  symbols: string[];
}

type LayoutMode = 'cluster' | 'tree';

const DEFAULT_MAX_NODES = 80;
const MAX_RENDER_NODES = 2000;
const NODE_MIN_R = 4;
const NODE_MAX_R = 18;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 6;
const NODE_COUNT_STEPS = [30, 50, 80, 120, 200, 300, 500, 800, 1200, 1600];

const DISPLAY_PREFS_KEY = 'codemap-display-prefs';
const VIEW_STATE_PREFIX = 'codemap-view:';

interface DisplayPrefs {
  maxNodes: number;
  spacing: number;
  layoutMode: LayoutMode;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
}

function hasCompleteViewState(view: Partial<ViewState>): view is ViewState {
  return (
    view.zoom !== undefined
    && view.panX !== undefined
    && view.panY !== undefined
  );
}

function computeGraphBounds(nodes: GraphNode[], maxRank: number, getNodeR: (rank: number, maxRank: number) => number): GraphBounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const r = getNodeR(node.rank, maxRank);
    minX = Math.min(minX, node.x - r - 24);
    minY = Math.min(minY, node.y - r - 24);
    maxX = Math.max(maxX, node.x + r + 24);
    maxY = Math.max(maxY, node.y + r + 24);
  }
  return { minX, minY, maxX, maxY };
}

function isGraphVisible(
  bounds: GraphBounds,
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
): boolean {
  if (!(width > 0 && height > 0 && zoom > 0)) return false;
  const left = (-panX) / zoom;
  const right = (width - panX) / zoom;
  const top = (-panY) / zoom;
  const bottom = (height - panY) / zoom;
  return bounds.maxX >= left && bounds.minX <= right && bounds.maxY >= top && bounds.minY <= bottom;
}

export function buildNodeCountOptions(totalFiles: number): number[] {
  const normalizedTotal = Number.isFinite(totalFiles)
    ? Math.max(1, Math.min(MAX_RENDER_NODES, Math.trunc(totalFiles)))
    : DEFAULT_MAX_NODES;
  const options = NODE_COUNT_STEPS.filter((count) => count < normalizedTotal);
  options.push(normalizedTotal);
  return [...new Set(options)].sort((left, right) => left - right);
}

function normalizeDisplayPrefs(raw: Record<string, unknown>): Partial<DisplayPrefs> {
  const result: Partial<DisplayPrefs> = {};
  if (raw.layoutMode === 'cluster' || raw.layoutMode === 'tree') {
    result.layoutMode = raw.layoutMode;
  }
  if (
    typeof raw.maxNodes === 'number'
    && Number.isFinite(raw.maxNodes)
    && raw.maxNodes >= 1
    && raw.maxNodes <= MAX_RENDER_NODES
  ) {
    result.maxNodes = Math.trunc(raw.maxNodes);
  }
  if (typeof raw.spacing === 'number' && Number.isFinite(raw.spacing)) {
    result.spacing = Math.max(0.4, Math.min(3.0, raw.spacing));
  }
  return result;
}

function normalizeViewState(raw: Record<string, unknown>): Partial<ViewState> {
  const result: Partial<ViewState> = {};
  if (typeof raw.zoom === 'number' && Number.isFinite(raw.zoom)) {
    result.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, raw.zoom));
  }
  if (typeof raw.panX === 'number' && Number.isFinite(raw.panX)) result.panX = raw.panX;
  if (typeof raw.panY === 'number' && Number.isFinite(raw.panY)) result.panY = raw.panY;
  return result;
}

function loadDisplayPrefs(): Partial<DisplayPrefs> {
  try {
    const raw = localStorage.getItem(DISPLAY_PREFS_KEY);
    if (!raw) return {};
    return normalizeDisplayPrefs(JSON.parse(raw) as Record<string, unknown>);
  } catch { return {}; }
}

function saveDisplayPrefs(p: DisplayPrefs): void {
  try { localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(p)); } catch { /* noop */ }
}

function loadViewState(scope: string): Partial<ViewState> {
  if (!scope) return {};
  try {
    const raw = localStorage.getItem(VIEW_STATE_PREFIX + scope);
    if (!raw) return {};
    return normalizeViewState(JSON.parse(raw) as Record<string, unknown>);
  } catch { return {}; }
}

function saveViewState(scope: string, s: ViewState): void {
  if (!scope) return;
  try { localStorage.setItem(VIEW_STATE_PREFIX + scope, JSON.stringify(s)); } catch { /* noop */ }
}

function nodeBoxWidth(label: string): number {
  return Math.max(80, label.length * 8 + 20);
}

function buildDirHueMap(dirSet: string[]): Map<string, number> {
  const m = new Map<string, number>();
  dirSet.forEach((dir, idx) => m.set(dir, (idx * 137.508) % 360));
  return m;
}

function layoutWithForce(
  nodes: GraphNode[],
  links: GraphLink[],
  width: number,
  height: number,
  getNodeR: (rank: number, maxRank: number) => number,
  spacingFactor: number = 1,
): void {
  if (nodes.length === 0) return;
  const ITERATIONS = Math.max(48, Math.min(160, Math.round(160 - nodes.length * 0.4)));
  const REPULSION = 600 * spacingFactor * spacingFactor;
  const LINK_DISTANCE = 70 * spacingFactor;
  const LINK_STRENGTH = 0.06;
  const CLUSTER_STRENGTH = 0.25 / spacingFactor;
  const CENTER_STRENGTH = 0.012;

  const cx = width / 2;
  const cy = height / 2;
  const initR = Math.min(width, height) * 0.32;
  const maxRank = Math.max(...nodes.map((n) => n.rank), 0.001);

  for (let i = 0; i < nodes.length; i++) {
    const angle = (2 * Math.PI * i) / nodes.length;
    nodes[i].x = cx + initR * Math.cos(angle);
    nodes[i].y = cy + initR * Math.sin(angle);
  }

  const nodeIdx = new Map(nodes.map((n, i) => [n.id, i]));
  const vx = new Float64Array(nodes.length);
  const vy = new Float64Array(nodes.length);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;
    const a2 = alpha * alpha;
    vx.fill(0);
    vy.fill(0);

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const f = (REPULSION * a2) / (dist * dist);
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        vx[i] -= fx; vy[i] -= fy;
        vx[j] += fx; vy[j] += fy;
      }
    }

    for (const link of links) {
      const si = nodeIdx.get(link.source);
      const ti = nodeIdx.get(link.target);
      if (si === undefined || ti === undefined) continue;
      const dx = nodes[ti].x - nodes[si].x;
      const dy = nodes[ti].y - nodes[si].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const f = (dist - LINK_DISTANCE) * LINK_STRENGTH * alpha;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      vx[si] += fx; vy[si] += fy;
      vx[ti] -= fx; vy[ti] -= fy;
    }

    const clusterCenters = new Map<string, { sx: number; sy: number; cnt: number }>();
    for (const n of nodes) {
      const c = clusterCenters.get(n.dir) || { sx: 0, sy: 0, cnt: 0 };
      c.sx += n.x; c.sy += n.y; c.cnt++;
      clusterCenters.set(n.dir, c);
    }
    for (let i = 0; i < nodes.length; i++) {
      const c = clusterCenters.get(nodes[i].dir);
      if (!c || c.cnt < 2) continue;
      const ccx = c.sx / c.cnt;
      const ccy = c.sy / c.cnt;
      vx[i] += (ccx - nodes[i].x) * CLUSTER_STRENGTH * a2;
      vy[i] += (ccy - nodes[i].y) * CLUSTER_STRENGTH * a2;
    }

    for (let i = 0; i < nodes.length; i++) {
      vx[i] += (cx - nodes[i].x) * CENTER_STRENGTH;
      vy[i] += (cy - nodes[i].y) * CENTER_STRENGTH;
    }

    for (let i = 0; i < nodes.length; i++) {
      nodes[i].x += vx[i];
      nodes[i].y += vy[i];
    }

    for (let i = 0; i < nodes.length; i++) {
      const ri = getNodeR(nodes[i].rank, maxRank);
      for (let j = i + 1; j < nodes.length; j++) {
        const rj = getNodeR(nodes[j].rank, maxRank);
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const minDist = ri + rj + 18 * spacingFactor;
        if (dist < minDist) {
          const push = (minDist - dist) / 2;
          const px = (dx / dist) * push;
          const py = (dy / dist) * push;
          nodes[i].x -= px; nodes[i].y -= py;
          nodes[j].x += px; nodes[j].y += py;
        }
      }
    }
  }
}

function layoutWithDagre(
  nodes: GraphNode[],
  links: GraphLink[],
  width: number,
  height: number,
  spacingFactor: number = 1,
): void {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    nodesep: Math.round(35 * spacingFactor),
    ranksep: Math.round(45 * spacingFactor),
    edgesep: Math.round(18 * spacingFactor),
  });

  for (const n of nodes) {
    g.setNode(n.id, { width: nodeBoxWidth(n.label), height: 36 });
  }
  for (const link of links) {
    if (g.hasNode(link.source) && g.hasNode(link.target)) {
      g.setEdge(link.source, link.target);
    }
  }
  dagre.layout(g);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const pos = g.node(n.id) as { x: number; y: number } | undefined;
    if (!pos) continue;
    const hw = nodeBoxWidth(n.label) / 2;
    minX = Math.min(minX, pos.x - hw);
    maxX = Math.max(maxX, pos.x + hw);
    minY = Math.min(minY, pos.y - 18);
    maxY = Math.max(maxY, pos.y + 18);
  }
  if (!Number.isFinite(minX)) return;

  const ox = width / 2 - (minX + maxX) / 2;
  const oy = height / 2 - (minY + maxY) / 2;
  for (const n of nodes) {
    const pos = g.node(n.id) as { x: number; y: number } | undefined;
    if (!pos) continue;
    n.x = pos.x + ox;
    n.y = pos.y + oy;
  }
}

function truncateLabel(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  return `${name.slice(0, maxLen)}...`;
}

function basenameFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function labelFontSize(r: number): number {
  if (r < 8) return 9;
  if (r < 14) return 10;
  return 11;
}

export function CodeMapGraphView({
  files,
  edges,
  selectedFile,
  onSelectFile,
  allFiles,
  allEdges,
  viewScope = '',
}: CodeMapGraphViewProps) {
  const { t } = useTranslation('codeMap');
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });

  const [savedDisplay] = useState(() => loadDisplayPrefs());
  const [initialViewState] = useState(() => loadViewState(viewScope));
  const [pan, setPan] = useState({
    x: initialViewState.panX ?? 0,
    y: initialViewState.panY ?? 0,
  });
  const [zoom, setZoom] = useState(initialViewState.zoom ?? 1);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(savedDisplay.layoutMode ?? 'cluster');
  const [spacingInput, setSpacingInput] = useState(savedDisplay.spacing ?? 1.5);
  const [spacing, setSpacing] = useState(savedDisplay.spacing ?? 1.5);
  const [maxNodes, setMaxNodes] = useState(savedDisplay.maxNodes ?? DEFAULT_MAX_NODES);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  const [edgeTooltip, setEdgeTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [shouldAutoFit, setShouldAutoFit] = useState(
    !hasCompleteViewState(initialViewState),
  );
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [nodePositionOverrides, setNodePositionOverrides] = useState<Record<string, { x: number; y: number }>>({});
  const panningRef = useRef<{ startX: number; startY: number; origPanX: number; origPanY: number } | null>(null);
  const wasDraggingRef = useRef(false);
  const hasSyncedScopeRef = useRef(false);
  const totalFileCount = allFiles?.length ?? files.length;
  const nodeCountOptions = useMemo(() => buildNodeCountOptions(totalFileCount), [totalFileCount]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSpacing(spacingInput);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [spacingInput]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ width: Math.round(width), height: Math.round(Math.max(height, 300)) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!hasSyncedScopeRef.current) {
      hasSyncedScopeRef.current = true;
      return;
    }
    const savedView = loadViewState(viewScope);
    if (hasCompleteViewState(savedView)) {
      setPan({ x: savedView.panX, y: savedView.panY });
      setZoom(savedView.zoom);
      setShouldAutoFit(false);
      return;
    }
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setShouldAutoFit(true);
  }, [viewScope]);

  useEffect(() => {
    const maxAllowed = Math.max(1, Math.min(MAX_RENDER_NODES, totalFileCount));
    if (maxNodes > maxAllowed) {
      setMaxNodes(maxAllowed);
    }
  }, [maxNodes, totalFileCount]);

  const getNodeR = useCallback((rank: number, mr: number) =>
    NODE_MIN_R + (rank / mr) * (NODE_MAX_R - NODE_MIN_R),
  []);

  const { nodes, links, maxRank, dirHueMap, actualNodeCount, bounds } = useMemo(() => {
    const topFiles = [...files].sort((a, b) => b.rank - a.rank).slice(0, maxNodes);
    const topSet = new Set(topFiles.map((f) => f.relativePath));

    // Inject selected file if not already in topN
    if (selectedFile && !topSet.has(selectedFile)) {
      const pool = allFiles ?? files;
      const sf = pool.find((f) => f.relativePath === selectedFile);
      if (sf) {
        topFiles.push(sf);
        topSet.add(sf.relativePath);
      }
    }

    const dirSet = [...new Set(topFiles.map((f) => {
      const parts = f.relativePath.split('/');
      return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    }))].sort();
    const hueMap = buildDirHueMap(dirSet);

    const graphNodes: GraphNode[] = topFiles.map((f) => {
      const dir = f.relativePath.split('/').length > 1
        ? f.relativePath.split('/').slice(0, -1).join('/')
        : '';
      return {
        id: f.relativePath,
        fullPath: f.relativePath,
        label: f.relativePath.split('/').pop() || f.relativePath,
        language: f.language,
        rank: f.rank,
        symbolCount: f.symbols.length,
        dir,
        x: 0,
        y: 0,
      };
    });

    const edgePool = allEdges ?? edges;
    const graphLinks: GraphLink[] = edgePool
      .filter((e) => topSet.has(e.fromFile) && topSet.has(e.toFile))
      .map((e) => ({
        source: e.fromFile,
        target: e.toFile,
        symbolCount: e.symbols.length,
        symbols: e.symbols.slice(),
      }));

    if (layoutMode === 'cluster') {
      layoutWithForce(graphNodes, graphLinks, size.width, size.height, getNodeR, spacing);
    } else {
      layoutWithDagre(graphNodes, graphLinks, size.width, size.height, spacing);
    }

    const mr = Math.max(...graphNodes.map((n) => n.rank), 0.001);
    const bounds = computeGraphBounds(graphNodes, mr, getNodeR);
    return { nodes: graphNodes, links: graphLinks, maxRank: mr, dirHueMap: hueMap, actualNodeCount: topFiles.length, bounds };
  }, [files, edges, allFiles, allEdges, selectedFile, size.width, size.height, layoutMode, getNodeR, spacing, maxNodes]);

  useEffect(() => {
    saveDisplayPrefs({ maxNodes, spacing: spacingInput, layoutMode });
  }, [maxNodes, spacingInput, layoutMode]);

  useEffect(() => {
    saveViewState(viewScope, { zoom, panX: pan.x, panY: pan.y });
  }, [viewScope, zoom, pan.x, pan.y]);

  useEffect(() => {
    if (!bounds || shouldAutoFit) return;
    if (!isGraphVisible(bounds, size.width, size.height, zoom, pan.x, pan.y)) {
      setShouldAutoFit(true);
    }
  }, [bounds, size.width, size.height, zoom, pan.x, pan.y, shouldAutoFit]);

  useEffect(() => {
    if (!shouldAutoFit || nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const r = getNodeR(n.rank, maxRank);
      minX = Math.min(minX, n.x - r - 20);
      minY = Math.min(minY, n.y - r - 20);
      maxX = Math.max(maxX, n.x + r + 20);
      maxY = Math.max(maxY, n.y + r + 20);
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw <= 0 || bh <= 0) return;
    const fitZoom = Math.min(size.width / bw, size.height / bh, 1.5) * 0.9;
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setPan({ x: size.width / 2 - cx * clamped, y: size.height / 2 - cy * clamped });
    setZoom(clamped);
    setShouldAutoFit(false);
  }, [shouldAutoFit, nodes, maxRank, size.width, size.height, getNodeR]);

  const getR = useCallback((rank: number) =>
    NODE_MIN_R + (rank / maxRank) * (NODE_MAX_R - NODE_MIN_R),
  [maxRank]);

  const labelMaxChars = useCallback((r: number, isActive: boolean) => {
    if (isActive) return 30;
    if (r >= 14) return 18;
    if (r >= 8) return 14;
    return 10;
  }, []);

  const currentNodes = useMemo(
    () =>
      nodes.map((node) => {
        const override = nodePositionOverrides[node.id];
        return override ? { ...node, x: override.x, y: override.y } : node;
      }),
    [nodePositionOverrides, nodes],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleBgMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if ((e.target as SVGElement).tagName === 'svg' || (e.target as SVGElement).classList.contains('codemap-graph-bg')) {
      panningRef.current = { startX: e.clientX, startY: e.clientY, origPanX: pan.x, origPanY: pan.y };
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (dragState) {
      wasDraggingRef.current = true;
      const dx = (e.clientX - dragState.startX) / zoom;
      const dy = (e.clientY - dragState.startY) / zoom;
      const x = dragState.origX + dx;
      const y = dragState.origY + dy;
      setNodePositionOverrides((prev) => ({
        ...prev,
        [dragState.id]: { x, y },
      }));
      return;
    }
    if (panningRef.current) {
      const p = panningRef.current;
      setPan({ x: p.origPanX + (e.clientX - p.startX), y: p.origPanY + (e.clientY - p.startY) });
    }
  }, [dragState, zoom]);

  const handleMouseUp = useCallback(() => {
    setDragState(null);
    panningRef.current = null;
  }, []);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const node = currentNodes.find((n) => n.id === nodeId);
    if (node) {
      setDragState({ id: nodeId, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y });
    }
  }, [currentNodes]);

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    e.stopPropagation();
    onSelectFile(nodeId === selectedFile ? null : nodeId);
  }, [selectedFile, onSelectFile]);

  const handleNodeHover = useCallback((e: React.MouseEvent, node: GraphNode | null) => {
    if (node) {
      setHoveredNode(node.id);
      setEdgeTooltip(null);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top - 12, node });
      }
    } else {
      setHoveredNode(null);
      setTooltip(null);
    }
  }, []);

  const handleEdgeHover = useCallback((e: React.MouseEvent, link: GraphLink | null) => {
    if (link) {
      setTooltip(null);
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const fromName = basenameFromPath(link.source);
        const toName = basenameFromPath(link.target);
        const symPart = link.symbols.length > 0
          ? `{${link.symbols.join(', ')}}`
          : t('graph.noSymbols');
        const text = `${fromName} → ${toName}: ${symPart}`;
        setEdgeTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top - 8, text });
      }
    } else {
      setEdgeTooltip(null);
    }
  }, [t]);

  const handleEdgeMouseMove = useCallback((e: React.MouseEvent, link: GraphLink) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fromName = basenameFromPath(link.source);
    const toName = basenameFromPath(link.target);
    const symPart = link.symbols.length > 0
      ? `{${link.symbols.join(', ')}}`
      : t('graph.noSymbols');
    setEdgeTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top - 8,
      text: `${fromName} → ${toName}: ${symPart}`,
    });
  }, [t]);

  const handleBgClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as SVGElement).tagName === 'svg' || (e.target as SVGElement).classList.contains('codemap-graph-bg')) {
      onSelectFile(null);
    }
  }, [onSelectFile]);

  const resetView = useCallback(() => {
    setShouldAutoFit(true);
  }, []);

  const nodeMap = useMemo(() => new Map(currentNodes.map((n) => [n.id, n])), [currentNodes]);
  const maxNodeOption = nodeCountOptions[nodeCountOptions.length - 1] ?? totalFileCount;

  if (files.length === 0) {
    return <div className="codemap-graph-empty">{t('graph.noFiles')}</div>;
  }

  return (
    <div className="codemap-graph-wrapper" ref={containerRef}>
      <svg
        className="codemap-graph-svg"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        onMouseDown={handleBgMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleBgClick}
      >
        <defs>
          <marker id="codemap-arrow" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="5" markerHeight="4" orient="auto">
            <path d="M0,0 L10,3 L0,6" fill="var(--text-tertiary, #94a3b8)" opacity="0.4" />
          </marker>
          <marker id="codemap-arrow-hl" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="6" markerHeight="5" orient="auto">
            <path d="M0,0 L10,3 L0,6" fill="var(--accent-blue, #3b82f6)" opacity="0.7" />
          </marker>
        </defs>

        <rect className="codemap-graph-bg" width={size.width} height={size.height} fill="transparent" />

        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Edges */}
          {links.map((link) => {
            const a = nodeMap.get(link.source);
            const b = nodeMap.get(link.target);
            if (!a || !b) return null;
            const isHighlight = selectedFile === link.source || selectedFile === link.target;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const off = Math.min(30, Math.sqrt(dx * dx + dy * dy) * 0.15);
            const cx = mx + (dy > 0 ? off : -off) * 0.5;
            const cy = my + (dx > 0 ? -off : off) * 0.5;

            const rB = getR(b.rank);
            const dist = Math.sqrt((b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy)) || 1;
            const ex = b.x - ((b.x - cx) / dist) * (rB + 3);
            const ey = b.y - ((b.y - cy) / dist) * (rB + 3);

            const pathD = `M${a.x},${a.y} Q${cx},${cy} ${ex},${ey}`;
            return (
              <g key={`${link.source}->${link.target}`}>
                {/* Invisible wider hit area for easier hover */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={10}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseEnter={(e) => handleEdgeHover(e, link)}
                  onMouseMove={(e) => handleEdgeMouseMove(e, link)}
                  onMouseLeave={(e) => handleEdgeHover(e, null)}
                  style={{ cursor: 'help' }}
                />
                <path
                  d={pathD}
                  fill="none"
                  stroke={isHighlight ? 'var(--accent-blue, #3b82f6)' : 'var(--text-tertiary, #94a3b8)'}
                  strokeWidth={isHighlight ? 1.5 : 0.8}
                  opacity={isHighlight ? 0.7 : 0.25}
                  markerEnd={isHighlight ? 'url(#codemap-arrow-hl)' : 'url(#codemap-arrow)'}
                  className="codemap-graph-edge"
                />
              </g>
            );
          })}

          {/* Nodes */}
          {currentNodes.map((node) => {
            const r = getR(node.rank);
            const isSelected = node.id === selectedFile;
            const isHovered = node.id === hoveredNode;
            const isActive = isSelected || isHovered;
            const hue = dirHueMap.get(node.dir) ?? 210;
            const fill = `hsl(${hue}, 60%, 55%)`;

            const displayText = isActive
              ? node.label
              : truncateLabel(node.label, labelMaxChars(r, false));
            const fs = isSelected ? 12 : labelFontSize(r);
            const textW = displayText.length * fs * 0.6 + 8;
            const textH = fs + 4;
            const textY = node.y + r + 12 + fs * 0.35;

            return (
              <g
                key={node.id}
                className="codemap-graph-node"
                onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                onClick={(e) => handleNodeClick(e, node.id)}
                onMouseEnter={(e) => handleNodeHover(e, node)}
                onMouseLeave={(e) => handleNodeHover(e, null)}
                style={{ cursor: 'pointer' }}
              >
                {isSelected && (
                  <circle cx={node.x} cy={node.y} r={r + 5} fill="none"
                    stroke="var(--accent-blue, #3b82f6)" strokeWidth="2" opacity="0.5" />
                )}
                <circle
                  cx={node.x} cy={node.y} r={r}
                  fill={fill}
                  opacity={isActive ? 1 : 0.75}
                  className="codemap-graph-node-circle"
                />
                <rect
                  x={node.x - textW / 2}
                  y={textY - textH / 2 - 1}
                  width={textW}
                  height={textH}
                  rx={3}
                  className="codemap-graph-label-bg"
                  opacity={isActive ? 0.92 : 0.78}
                />
                <text
                  x={node.x} y={textY}
                  textAnchor="middle"
                  className="codemap-graph-label"
                  fontWeight={isSelected ? 600 : 400}
                  fontSize={fs}
                >
                  {displayText}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="codemap-graph-tooltip"
          style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="codemap-tooltip-path">{tooltip.node.fullPath}</div>
          <div className="codemap-tooltip-meta">
            <span>{tooltip.node.language}</span>
            <span>{t('graph.symbols', { count: tooltip.node.symbolCount })}</span>
            <span>rank {tooltip.node.rank.toFixed(4)}</span>
          </div>
        </div>
      )}

      {edgeTooltip && (
        <div
          className="codemap-graph-edge-tooltip"
          style={{ left: edgeTooltip.x, top: edgeTooltip.y, transform: 'translate(-50%, -100%)' }}
        >
          {edgeTooltip.text}
        </div>
      )}

      {/* Controls */}
      <div className="codemap-graph-controls">
        <button
          type="button"
          className="codemap-graph-dir-toggle"
          onClick={() => setLayoutMode((m) => (m === 'cluster' ? 'tree' : 'cluster'))}
          title={layoutMode === 'cluster' ? t('graph.switchToHierarchy') : t('graph.switchToCluster')}
        >
          {layoutMode === 'cluster' ? t('graph.cluster') : t('graph.hierarchy')}
        </button>
          <div className="codemap-graph-spacing-group" title={t('graph.spacing')}>
            <span className="codemap-graph-spacing-label">{t('graph.spacing')}</span>
            <input
              type="range"
              className="codemap-graph-spacing-slider"
              min={0.4}
              max={3.0}
              step={0.1}
              value={spacingInput}
              onChange={(e) => setSpacingInput(Number(e.target.value))}
            />
          </div>
        <NcSelect
          className="codemap-graph-node-count-select"
          value={maxNodes}
          onChange={(e) => setMaxNodes(Number(e.target.value))}
          title={t('graph.nodeCount')}
        >
          {nodeCountOptions.map((n) => (
            <option key={n} value={n}>
              {n === maxNodeOption ? t('graph.allNodes', { count: n }) : t('graph.nodeCountLabel', { count: n })}
            </option>
          ))}
        </NcSelect>
        <button className="codemap-graph-ctrl-btn" onClick={resetView} title={t('graph.fitView')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 8a6 6 0 0111.5-2.3M14 8a6 6 0 01-11.5 2.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M14 2v4h-4M2 14v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button className="codemap-graph-ctrl-btn" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.3))} title={t('graph.zoomIn', '+')}>+</button>
        <button className="codemap-graph-ctrl-btn" onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.3))} title={t('graph.zoomOut', '-')}>−</button>
        <span className="codemap-graph-zoom-label">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="codemap-graph-legend">
        <span>{t('graph.legend.pagerank')}</span>
        <span>{t('graph.legend.import')}</span>
        <span>{t('graph.legend.color')}</span>
        <span>{t('graph.fileCount', { actual: actualNodeCount, total: files.length })}</span>
      </div>
    </div>
  );
}
