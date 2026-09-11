export type NativeAbi = 'i32' | 'u32' | 'i64' | 'u64' | 'f32' | 'f64' | 'bool' | 'pointer' | 'utf8' | 'utf16' | 'bytes';
export interface NativeDescriptor { type: NativeAbi | 'void'; nullable?: boolean; direction?: 'in' | 'out' | 'inout'; maxBytes?: number; free?: boolean | string }
export interface NativeBinding {
  library: string; entryPoint: string; key?: string;
  managed?: { type: string; name: string; parameters?: string[] };
  parameters?: (NativeAbi | NativeDescriptor)[]; result?: NativeAbi | 'void' | NativeDescriptor;
}
export class LinearMemory {
  constructor(memory: WebAssembly.Memory, options?: { malloc?: (size: number) => number; free?: (pointer: number) => void; arena?: { base: number; size: number } });
  readonly memory: WebAssembly.Memory;
  readonly allocations: Map<number, number>;
  allocate(size: number, alignment?: number): number;
  free(pointer: number): void;
  read(pointer: number, length: number): Uint8Array;
  write(pointer: number, bytes: ArrayBufferView): void;
  allocateString(value: string, encoding?: 'utf8' | 'utf16'): number;
  readString(pointer: number, encoding?: 'utf8' | 'utf16', maxBytes?: number): string | null;
}
export interface NativeModule {
  name: string; module: WebAssembly.Module; instance: WebAssembly.Instance; exports: WebAssembly.Exports; memory: LinearMemory | null;
}
export class NativeModuleRegistry {
  constructor(options?: { fetch?: typeof fetch });
  readonly modules: Map<string, NativeModule>;
  readonly externals: Map<string, ((...args: any[]) => any) | { raw: true; invoke(context: any): any }>;
  register(name: string, source: BufferSource | WebAssembly.Module | string | URL, options?: {
    imports?: WebAssembly.Imports; signal?: AbortSignal; memory?: WebAssembly.Memory;
    memoryExport?: string; mallocExport?: string; freeExport?: string;
    malloc?: (size: number) => number; free?: (pointer: number) => void;
    arena?: { base: number; size: number };
  }): Promise<NativeModule>;
  bind(binding: NativeBinding): (...args: any[]) => any;
  unbind(key: string): boolean;
  unregister(name: string): boolean;
  dispose(): void;
}
export interface Widget {
  id: string;
  type: 'window' | 'panel' | 'label' | 'text' | 'button' | 'check' | 'list' | 'grid' | 'menu' | 'menuitem' | 'progress';
  props?: Record<string, any>;
  bindings?: Record<string, string | { path: string; mode?: 'oneWay' | 'twoWay' }>;
  events?: Record<string, string | { action: string; preventDefault?: boolean }>;
  children?: Widget[];
}
export interface DesktopEvent { sequence: number; id: string; type: string; action: string; value?: unknown; property?: string; key?: string; row?: number; rowKey?: unknown; column?: string }
export type DesktopCommand =
  | { op: 'create'; widget: Widget; parent?: string }
  | { op: 'update'; id: string; props?: Record<string, any>; events?: Widget['events']; bindings?: Widget['bindings'] }
  | { op: 'remove' | 'focus'; id: string }
  | { op: 'render'; widgets: Widget | Widget[] }
  | { op: 'data'; path: string; value: unknown }
  | { op: 'data'; data: Record<string, any> }
  | { op: 'batch'; commands: DesktopCommand[] };
export class BrowserDesktopHost {
  constructor(options: { root: HTMLElement; document?: Document; data?: Record<string, any>; onEvent?: (event: DesktopEvent) => void | string | DesktopCommand | DesktopCommand[] | Promise<void | string | DesktopCommand | DesktopCommand[]>; onError?: (error: Error, event: DesktopEvent) => void });
  readonly nodes: Map<string, { id: string; type: string; element: HTMLElement; [key: string]: any }>;
  readonly closed: boolean;
  render(widgets: Widget | Widget[]): this;
  create(widget: Widget, parent?: string | null): any;
  update(id: string, patch: Omit<Widget, 'id' | 'type' | 'children'>): any;
  remove(id: string): boolean;
  apply(command: string | DesktopCommand | DesktopCommand[]): any;
  setData(path: string, value: unknown): this;
  setData(data: Record<string, any>): this;
  getData(path?: string): any;
  on(listener: (event: DesktopEvent) => void | Promise<void>): () => boolean;
  flushEvents(): Promise<void>;
  dispose(): void;
}
export class RemoteHostTransport {
  constructor(options: { url: string; protocols?: string | string[]; WebSocket?: typeof WebSocket; timeoutMs?: number; maxMessageBytes?: number; onEvent?: (event: any) => void });
  readonly connected: boolean;
  readonly closed: boolean;
  connect(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<this>;
  request<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  dispose(error?: Error): void;
}
