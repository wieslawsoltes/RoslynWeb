export class NuGetError extends Error { code: string; details: Record<string, unknown>; constructor(code: string, message: string, details?: Record<string, unknown>); }
export interface NuGetVersion { parts: number[]; prerelease: string; normalized: string; }
export interface NuGetVersionRange { raw: string; min: NuGetVersion | null; max: NuGetVersion | null; minInclusive: boolean; maxInclusive: boolean; floating: boolean; includePrerelease: boolean; }
export function parseVersion(version: string): NuGetVersion;
export function normalizeVersion(version: string): string;
export function compareVersions(a: string | NuGetVersion, b: string | NuGetVersion): number;
export function parseVersionRange(range?: string): NuGetVersionRange;
export function satisfiesVersion(version: string | NuGetVersion, range: string | NuGetVersionRange, options?: { includePrerelease?: boolean }): boolean;
export function validatePackageId(id: string): string;
export interface NuGetFramework { family: string; normalized: string; major?: number; minor?: number; platform: string; }
export function parseFramework(framework?: string): NuGetFramework;
export function frameworkScore(candidate: string, target?: string): number;
export function selectFramework(frameworks: string[], target?: string): string | null;
export interface PackageRequest { id: string; version: string; includeAssets?: string; excludeAssets?: string; privateAssets?: string; }
export interface PackageDependency extends PackageRequest { include: string; exclude: string; }
export interface PackageMetadata { id: string; version: string; title: string; description: string; authors: string; license: string; contentFiles: Array<Record<string,string>>; dependencyGroups: Array<{targetFramework: string; dependencies: PackageDependency[]}>; frameworkAssemblies: Array<Record<string,string>>; }
export interface PackageAsset { path: string; relativePath?: string; name: string; bytes: Uint8Array; packageId: string; packageVersion: string; key: string; kind?: string; phase?: string; framework?: string; language?: string; roslynVersion?: string; }
export interface ImportedPackage extends PackageMetadata { targetFramework: string; runtimeIdentifier: string; selectedFramework: string | null; selectedRuntimeFramework: string | null; selectedRuntimeIdentifier: string | null; dependencies: PackageDependency[]; compileAssets: PackageAsset[]; runtimeAssets: PackageAsset[]; nativeAssets: PackageAsset[]; analyzerAssets: PackageAsset[]; buildAssets: PackageAsset[]; contentAssets: PackageAsset[]; direct?: boolean; assetKinds?: string[]; files: Map<string,Uint8Array>; warnings: string[]; unsupportedAssets: string[]; feed?: string; }
export interface ZipOptions { inflateRaw?: (bytes: Uint8Array, expectedSize: number) => Uint8Array | Promise<Uint8Array>; maxArchiveBytes?: number; maxUncompressedBytes?: number; maxEntryBytes?: number; maxEntries?: number; signal?: AbortSignal; }
export interface PackageImportOptions extends ZipOptions { targetFramework?: string; runtimeIdentifier?: 'browser-wasm' | 'browser'; allowNativeAssets?: boolean; language?: 'cs' | 'vb'; roslynVersion?: string; }
export function readZip(bytes: Uint8Array | ArrayBuffer, options?: ZipOptions): Promise<Map<string,Uint8Array>>;
export function parseNuspec(xml: string): PackageMetadata;
export function importNupkg(bytes: Uint8Array | ArrayBuffer, options?: PackageImportOptions): Promise<ImportedPackage>;
export interface PackageByteCache { get(key: string): Promise<Uint8Array | undefined>; set(key: string, value: Uint8Array): Promise<void>; delete(key: string): Promise<void>; clear(): Promise<void>; }
export class MemoryPackageCache implements PackageByteCache { values: Map<string,Uint8Array>; get(key: string): Promise<Uint8Array | undefined>; set(key: string, value: Uint8Array): Promise<void>; delete(key: string): Promise<void>; clear(): Promise<void>; }
export class BrowserPackageCache implements PackageByteCache { name: string; constructor(name?: string); get(key: string): Promise<Uint8Array | undefined>; set(key: string, value: Uint8Array): Promise<void>; delete(key: string): Promise<void>; clear(): Promise<void>; }
export interface PackageProgress { phase: 'cache' | 'fetch' | 'download' | 'resolve' | 'complete'; url?: string; bytes?: number; total?: number; id?: string; version?: string; steps?: number; packages?: number; compileAssemblies?: number; runtimeAssemblies?: number; }
export interface NuGetResolverOptions extends PackageImportOptions { feeds?: Array<string | {url: string}>; fetch?: typeof globalThis.fetch; cache?: PackageByteCache; headers?: HeadersInit; onProgress?: (event: PackageProgress)=>void; includePrerelease?: boolean; maxResolutionSteps?: number; maxPackages?: number; }
export interface PackageResolution { packages: ImportedPackage[]; compileAssets: PackageAsset[]; runtimeAssets: PackageAsset[]; nativeAssets: PackageAsset[]; analyzerAssets: PackageAsset[]; buildAssets: PackageAsset[]; contentAssets: PackageAsset[]; warnings: string[]; lock: { version: number; targetFramework?: string; runtimeIdentifier?: string; packages: Array<{id: string; version: string; feed?: string; dependencies: PackageRequest[]}>}; }
export class NuGetResolver { constructor(options?: NuGetResolverOptions); cache: PackageByteCache; resolve(requests: PackageRequest[], options?: NuGetResolverOptions): Promise<PackageResolution>; }

export function assetKinds(include?: string, exclude?: string): Set<string>;
export function selectToolingAssets(files: Map<string,Uint8Array>, targetFramework: string, options?: PackageImportOptions): {analyzerAssets: Partial<PackageAsset>[]; buildAssets: Partial<PackageAsset>[]; contentAssets: Partial<PackageAsset>[]};
