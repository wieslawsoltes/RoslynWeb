import type { DxfScene, DxfGeometry, DxfTessellationOptions } from './geometry.js';
/** Structural subset avoids requiring a separate @webgpu/types dependency. */
export interface DxfGpuDevice {
  readonly queue: { onSubmittedWorkDone(): Promise<void> };
  readonly lost: Promise<{ reason: string; message: string }>;
  destroy(): void;
}
export interface DxfRendererOptions {
  /** Optional existing device. Its lifetime stays with the caller. */
  device?: DxfGpuDevice;
  /** Optional navigator.gpu replacement, primarily for host integration. */
  gpu?: object;
  format?: string;
  powerPreference?: 'low-power' | 'high-performance';
  background?: [number, number, number, number];
  maxBufferBytes?: number;
  /** Aggregate RGBA text coverage texture budget. Default: 64 MiB. */
  maxTextTextureBytes?: number;
  text?: {
    /** Browser fallback for SHX or unspecified fonts. Default: sans-serif. */
    fontFamily?: string;
    /** Raster font size before cap-height measurement. Default: 64. */
    fontSize?: number;
    maxTextureDimension?: number;
    canvasFactory?: (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;
  };
  controls?: boolean;
  autoResize?: boolean;
  pixelRatio?: number;
  tessellation?: DxfTessellationOptions;
  onError?: (error: Error & { code?: string }) => void;
}
export interface DxfCamera { x: number; y: number; scale: number; }
export interface DxfRendererStats {
  lineSegments: number; triangles: number; vertices: number; textQuads: number;
  drawCalls: number; frames: number; width: number; height: number;
  disposed: boolean; lost: boolean;
}
export interface DxfSetSceneOptions extends DxfTessellationOptions { fit?: boolean; padding?: number; }
export interface DxfRenderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly device: DxfGpuDevice;
  readonly geometry: DxfGeometry | null;
  readonly camera: DxfCamera;
  readonly stats: DxfRendererStats;
  readonly disposed: boolean;
  setScene(scene: DxfScene, options?: DxfSetSceneOptions): DxfGeometry;
  setGeometry(geometry: DxfGeometry, options?: { fit?: boolean; padding?: number }): this;
  setLayerVisibility(name: string, visible: boolean): boolean;
  setCamera(camera: Partial<DxfCamera>): this;
  fit(padding?: number): this;
  pan(dx: number, dy: number): this;
  zoomAt(factor: number, x?: number, y?: number): this;
  screenToWorld(x: number, y: number): { x: number; y: number };
  worldToScreen(x: number, y: number): { x: number; y: number };
  resize(width?: number, height?: number, pixelRatio?: number): this;
  render(): DxfRendererStats;
  dispose(): void;
}
export function createDxfRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, options?: DxfRendererOptions): Promise<DxfRenderer>;
