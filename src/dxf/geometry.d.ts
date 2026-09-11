export type DxfPoint = { x: number; y: number; z?: number; bulge?: number } | [number, number, number?];
export type DxfColor = [number, number, number] | [number, number, number, number];
export interface DxfEntity {
  /** LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE/POLYLINE, SOLID/TRACE/3DFACE, POINT, SEGMENTS or TRIANGLES. */
  type: string;
  layer?: string;
  color?: DxfColor;
  visible?: boolean;
  /** Own layer and ancestor INSERT layers that must all be visible. */
  visibilityLayers?: string[];
  start?: DxfPoint;
  end?: DxfPoint;
  center?: DxfPoint;
  position?: DxfPoint;
  vertices?: DxfPoint[];
  normal?: DxfPoint;
  majorAxis?: DxfPoint;
  minorAxis?: DxfPoint;
  radius?: number;
  ratio?: number;
  /** Counterclockwise degrees. Ellipse angles are parametric. */
  startAngle?: number;
  endAngle?: number;
  closed?: boolean;
  outline?: boolean;
  size?: number;
  [property: string]: unknown;
}
export interface DxfLayer { name: string; visible?: boolean; color?: DxfColor; }
export interface DxfIssue { code: string; message: string; entityIndex?: number; type?: string | null; [property: string]: unknown; }
export interface DxfBounds { minX: number; minY: number; maxX: number; maxY: number; }
export interface DxfScene {
  version: 1;
  entities: DxfEntity[];
  layers?: DxfLayer[];
  bounds?: DxfBounds;
  issues?: DxfIssue[];
  [property: string]: unknown;
}
export interface DxfTessellationOptions {
  /** Segments per full circle when tolerance is zero. Default: 96. */
  curveSegments?: number;
  /** Maximum segments per individual curve. Default: 4096. */
  maxCurveSegments?: number;
  /** Hard budget across line and triangle vertices. Default: 4,000,000. */
  maxVertices?: number;
  /** Chord error in drawing units; zero uses curveSegments. Default: zero. */
  tolerance?: number;
  /** Point cross diameter in drawing units. Default: 0.5. */
  pointSize?: number;
  /** Reject unsupported/invalid entities instead of recording issues. */
  strict?: boolean;
}
export interface DxfVertexBuffers { positions: Float32Array; colors: Float32Array; }
export interface DxfDrawLayer {
  name: string; visible: boolean;
  visibilityLayers?: string[];
  lineFirst: number; lineCount: number;
  triangleFirst: number; triangleCount: number;
}
export interface DxfGeometry {
  version: 1;
  lines: DxfVertexBuffers;
  triangles: DxfVertexBuffers;
  /** World coordinates. GPU buffer coordinates are relative to origin. */
  bounds: DxfBounds;
  origin: [number, number, number];
  layers: DxfDrawLayer[];
  layerStates?: DxfLayer[];
  issues: DxfIssue[];
  counts: { entities: number; renderedEntities: number; lineSegments: number; triangles: number; vertices: number };
}
export function tessellateDxfScene(scene: DxfScene, options?: DxfTessellationOptions): DxfGeometry;
export function validateDxfGeometry(geometry: DxfGeometry): DxfGeometry;
