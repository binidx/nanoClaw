import ForceGraph2D from 'react-force-graph-2d';
import dagre from 'dagre';
import { forwardRef, useMemo } from 'react';

import type { KbGraphLink, KbGraphNode } from './KnowledgeGraph';

export interface KnowledgeGraphCanvasProps {
  graphData: { nodes: KbGraphNode[]; links: KbGraphLink[] };
  width: number;
  height: number;
  layoutMode: 'cluster' | 'hierarchy';
  particles: number;
  nodeCanvasObject: (node: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => void;
  linkColor: (link: unknown) => string;
  linkWidth: (link: unknown) => number;
  linkLineDash: (link: unknown) => number[] | null;
  onNodeHover: (node: unknown) => void;
  onNodeClick?: (node: unknown) => void;
  onZoomEnd: ({ k, x, y }: { k: number; x: number; y: number }) => void;
}

function linkEndpointId(endpoint: string | KbGraphNode): string {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : String(endpoint);
}

function applyHierarchyLayout(nodes: KbGraphNode[], links: KbGraphLink[], width: number, height: number): void {
  if (nodes.length === 0) return;
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    nodesep: 36,
    ranksep: 90,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    g.setNode(node.id, {
      width: Math.max(90, Math.min(220, node.label.length * 7 + 28)),
      height: node.type === 'wiki' ? 38 : 30,
    });
  }
  for (const link of links) {
    g.setEdge(linkEndpointId(link.source), linkEndpointId(link.target));
  }
  dagre.layout(g);
  const graph = g.graph();
  const offsetX = Math.max(20, (width - (graph.width ?? width)) / 2);
  const offsetY = Math.max(20, (height - (graph.height ?? height)) / 2);
  for (const node of nodes) {
    const laidOut = g.node(node.id);
    if (!laidOut) continue;
    node.x = laidOut.x + offsetX;
    node.y = laidOut.y + offsetY;
    node.fx = node.x;
    node.fy = node.y;
  }
}

export const KnowledgeGraphCanvas = forwardRef<any, KnowledgeGraphCanvasProps>(function KnowledgeGraphCanvas(
  {
    graphData,
    width,
    height,
    layoutMode,
    particles,
    nodeCanvasObject,
    linkColor,
    linkWidth,
    linkLineDash,
    onNodeHover,
    onNodeClick,
    onZoomEnd,
  },
  ref,
) {
  const stableGraph = useMemo(() => {
    const nodes = graphData.nodes.map((n) => ({ ...n }));
    const links = graphData.links.map((l) => ({
      ...l,
      source: typeof l.source === 'object' && l.source !== null ? (l.source as KbGraphNode).id : l.source,
      target: typeof l.target === 'object' && l.target !== null ? (l.target as KbGraphNode).id : l.target,
    }));
    if (layoutMode === 'hierarchy') applyHierarchyLayout(nodes, links, width, height);
    return { nodes, links };
  }, [graphData.nodes, graphData.links, height, layoutMode, width]);

  return (
    <ForceGraph2D
      ref={ref}
      graphData={stableGraph}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      nodeLabel={(node: unknown) => {
        const n = node as KbGraphNode;
        return [
          n.label,
          n.type === 'wiki' ? `Wiki · ${n.pageType ?? 'page'}` : `文档 · ${n.status ?? 'unknown'}`,
          n.llmStatus ? `LLM: ${n.llmStatus}` : null,
          `连接: ${n.degree ?? 0}`,
        ].filter(Boolean).join('\n');
      }}
      nodeCanvasObjectMode={() => 'replace'}
      nodeCanvasObject={nodeCanvasObject}
      linkColor={linkColor}
      linkWidth={linkWidth}
      linkLineDash={linkLineDash}
      linkDirectionalParticles={particles}
      onNodeHover={onNodeHover}
      onNodeClick={onNodeClick}
      onZoomEnd={onZoomEnd}
      cooldownTicks={180}
      d3AlphaDecay={0.016}
      d3VelocityDecay={0.28}
    />
  );
});
