export type DxfPoint = { x: number; y: number; z?: number; bulge?: number } | [number, number, number?];
export type DxfColor = [number, number, number] | [number, number, number, number];
export interface DxfHatchPatternLine {
  /** World-space origin of line zero. Pattern rotation, scale and OCS/INSERT transforms are already applied. */
  origin: DxfPoint;
  /** World-space vector for one dash-length unit; need not be normalized after INSERT transforms. */
  direction: DxfPoint;
  /** World-space translation from line k to line k+1, including along-line dash phase displacement. */
  offset: DxfPoint;
  /** Optional transformed perpendicular vector for square dot markers. */
  perpendicular?: DxfPoint;
  /** Positive = drawn dash, negative = gap, zero = dot. Empty = continuous. Repeats in both directions. */
  dashes?: number[];
}
export interface DxfHatchPattern { name?: string; lines: DxfHatchPatternLine[]; }
export interface DxfEntity {
  /** Includes TEXT/MTEXT/ATTRIB, solid/patterned HATCH and WIPEOUT in addition to line/face primitives. */
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
  /** Closed world-space rings. Normal hatch style applies even/odd island parity. */
  loops?: DxfPoint[][];
  hatchStyle?: 'Normal' | 'Outer' | 'Ignore' | 0 | 1 | 2;
  /** HATCH without pattern is solid. Families clip to the same island region as solid fills. */
  pattern?: DxfHatchPattern;
  text?: string;
  height?: number;
  width?: number;
  widthFactor?: number;
  rotation?: number;
  obliqueAngle?: number;
  /** World-space basis vectors spanning one nominal text height; includes INSERT/OCS transforms. */
  axisX?: DxfPoint;
  axisY?: DxfPoint;
  alignment?: string;
  attachmentPoint?: number;
  lineSpacingFactor?: number;
  fontFamily?: string;
  fontFile?: string;
  fontStyle?: string;
  isBackward?: boolean;
  isUpsideDown?: boolean;
  isVertical?: boolean;
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
  /** Hard budget across line/triangle vertices plus six vertices per text quad. Default: 4,000,000. */
  maxVertices?: number;
  /** Chord error in drawing units; zero uses curveSegments. Default: zero. */
  tolerance?: number;
  /** Point cross diameter in drawing units. Default: 0.5. */
  pointSize?: number;
  /** Total expanded pattern lines across the scene. Default: 100,000. Exceeding the budget always throws. */
  maxHatchLines?: number;
  /** Total boundary, line clipping and dash expansion work across the scene. Default: 10,000,000. */
  maxHatchWork?: number;
  /** Square dot side in pattern dash units, clipped at boundaries. Default: 10% of the smaller spacing/dash cycle. */
  hatchDotSize?: number;
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
export interface DxfDrawCommand { kind: 'lines' | 'triangles' | 'mask' | 'text'; first: number; count: number; layer: string; visibilityLayers: string[]; }
export interface DxfTextGeometry extends DxfEntity { corners: DxfPoint[]; entityIndex: number; }
export interface DxfGeometry {
  version: 1;
  lines: DxfVertexBuffers;
  triangles: DxfVertexBuffers;
  /** Browser font shaping supplies texture coverage; the renderer draws WebGPU quads. */
  texts?: DxfTextGeometry[];
  /** Source entity order; masks cover earlier primitives and preserve later ones. */
  draws?: DxfDrawCommand[];
  /** World coordinates. GPU buffer coordinates are relative to origin. */
  bounds: DxfBounds;
  origin: [number, number, number];
  layers: DxfDrawLayer[];
  layerStates?: DxfLayer[];
  issues: DxfIssue[];
  /** vertices counts the line/triangle buffers; textQuads separately counts the texture quads. */
  counts: { entities: number; renderedEntities: number; lineSegments: number; triangles: number; vertices: number; textQuads?: number };
}
export function tessellateDxfScene(scene: DxfScene, options?: DxfTessellationOptions): DxfGeometry;
export function validateDxfGeometry(geometry: DxfGeometry): DxfGeometry;
