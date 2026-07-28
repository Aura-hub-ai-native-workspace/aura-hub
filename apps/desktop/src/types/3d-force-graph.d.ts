declare module '3d-force-graph' {
  import { Scene, WebGLRenderer, Camera } from 'three';
  import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

  interface GraphData {
    nodes: Array<Record<string, unknown>>;
    links: Array<Record<string, unknown>>;
  }

  interface ForceGraph3DInstance {
    graphData(): GraphData;
    graphData(data: GraphData): ForceGraph3DInstance;
    width(px?: number): ForceGraph3DInstance;
    height(px?: number): ForceGraph3DInstance;
    backgroundColor(color?: string): ForceGraph3DInstance;
    showNavInfo(flag?: boolean): ForceGraph3DInstance;
    nodeVal(accessor?: number | string | ((node: Record<string, unknown>) => number)): ForceGraph3DInstance;
    nodeColor(accessor?: string | ((node: Record<string, unknown>) => string)): ForceGraph3DInstance;
    nodeLabel(accessor?: string | ((node: Record<string, unknown>) => string)): ForceGraph3DInstance;
    nodeOpacity(opacity?: number): ForceGraph3DInstance;
    nodeResolution(res?: number): ForceGraph3DInstance;
    linkColor(accessor?: string | ((link: Record<string, unknown>) => string)): ForceGraph3DInstance;
    linkOpacity(opacity?: number): ForceGraph3DInstance;
    linkWidth(width?: number): ForceGraph3DInstance;
    linkDirectionalParticles(particles?: number): ForceGraph3DInstance;
    linkDirectionalParticleWidth(width?: number): ForceGraph3DInstance;
    linkDirectionalParticleSpeed(speed?: number): ForceGraph3DInstance;
    linkDirectionalParticleColor(accessor?: string | ((link: Record<string, unknown>) => string)): ForceGraph3DInstance;
    linkCurvature(curvature?: number): ForceGraph3DInstance;
    cameraPosition(pos?: { x: number; y: number; z: number }, lookAt?: { x: number; y: number; z: number }, transitionMs?: number): ForceGraph3DInstance;
    onNodeClick(fn?: (node: Record<string, unknown>, event: MouseEvent) => void): ForceGraph3DInstance;
    onNodeHover(fn?: (node: Record<string, unknown> | null, previousNode: Record<string, unknown> | null) => void): ForceGraph3DInstance;
    onBackgroundClick(fn?: (event: MouseEvent) => void): ForceGraph3DInstance;
    forceEngine(engine?: 'd3' | 'ngraph'): ForceGraph3DInstance;
    d3AlphaDecay(decay?: number): ForceGraph3DInstance;
    d3VelocityDecay(decay?: number): ForceGraph3DInstance;
    warmupTicks(ticks?: number): ForceGraph3DInstance;
    cooldownTime(ms?: number): ForceGraph3DInstance;
    scene(): Scene;
    renderer(): WebGLRenderer;
    camera(): Camera;
    controls(): OrbitControls;
    ticksPerFrame(ticks?: number): ForceGraph3DInstance;
    zoom(zoomLevel?: number, transitionMs?: number): ForceGraph3DInstance;
    resetProps(): ForceGraph3DInstance;
    _destructor(): void;
  }

  export default function ForceGraph3D(
    container: HTMLElement,
    options?: Record<string, unknown>
  ): ForceGraph3DInstance;
}
