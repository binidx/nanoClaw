declare module 'react-force-graph-2d' {
  import { ComponentType } from 'react';

  interface ForceGraphProps {
    graphData: { nodes: unknown[]; links: unknown[] };
    width?: number;
    height?: number;
    backgroundColor?: string;
    nodeLabel?: string | ((node: unknown) => string);
    nodeCanvasObjectMode?: string | ((node: unknown) => string);
    nodeCanvasObject?: (node: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => void;
    linkColor?: string | ((link: unknown) => string);
    linkWidth?: number | ((link: unknown) => number);
    linkLineDash?: number[] | null | ((link: unknown) => number[] | null);
    linkDirectionalParticles?: number | ((link: unknown) => number);
    onNodeClick?: (node: unknown) => void;
    cooldownTicks?: number;
    d3AlphaDecay?: number;
    d3VelocityDecay?: number;
    [key: string]: unknown;
  }

  const ForceGraph2D: ComponentType<ForceGraphProps>;
  export default ForceGraph2D;
}
