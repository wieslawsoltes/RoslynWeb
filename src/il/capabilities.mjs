/** Machine-readable description of the JavaScript IL execution tier. */
export const capabilities = Object.freeze({
  format: 'ecma335-normalized-il-v1',
  execution: 'generated-javascript-control-flow',
  numericKinds: ['int32', 'uint32', 'int64', 'uint64', 'native-int-32', 'float32', 'float64'],
  supported: [
    'stack-and-local-variables', 'integer-and-floating-arithmetic', 'checked-arithmetic',
    'branches-and-switch', 'managed-method-calls', 'virtual-dispatch', 'constructors',
    'instance-and-static-fields', 'static-initializers', 'arrays-and-array-addresses',
    'managed-references', 'boxing-and-unboxing', 'type-tests', 'value-type-copying',
    'catch-finally-and-rethrow', 'exception-filters', 'delegates', 'javascript-externals',
    'portable-generated-es-modules', 'linked-normalized-assemblies',
    'closed-generic-type-and-method-substitution', 'per-closed-type-static-storage',
    'linked-metadata-reflection-and-invocation', 'runtime-normalized-il-builders',
    'multidimensional-arrays', 'managed-function-pointer-calli', 'typed-references',
    'bounded-local-linear-memory', 'local-memory-copy-and-initialization',
    'explicitly-bound-pinvoke-exports', 'dictionary-hashset-and-selected-linq',
    'datetime-timespan-selected-tick-based-operations',
  ],
  unsupported: [
    'arbitrary-native-binary-execution', 'unrestricted-native-address-space',
    'threading-and-monitor-synchronization', 'complete-dotnet-framework-and-nuget-api-compatibility',
    'runtime-generic-constraint-verification', 'complete-reflection-binders-and-custom-attributes',
    'general-reflection-emit-bcl-compatibility', 'platform-native-and-desktop-ui-assemblies',
  ],
  notes: [
    'JavaScript Number, BigInt and tagged numeric values preserve distinct IL numeric stack categories.',
    'Native integers use 32 bits, matching the browser-wasm target.',
    'Local pointers designate bounded byte allocations owned by an invocation and expire when it returns.',
    'calli accepts linked managed function pointers with matching signatures; native machine-code addresses are not accepted.',
    'P/Invoke executes only explicitly supplied JavaScript exports; the runtime does not load native DLL files.',
    'The IL builders produce normalized IL and generated JavaScript. Roslyn remains the PE DLL emission route.',
    'Framework methods execute only when explicitly implemented or provided through externals.',
    'Unsupported instructions and unresolved framework calls produce diagnostics and throw on execution.',
    'Use the .NET WebAssembly execution tier for framework compatibility beyond these capabilities.',
  ],
});

export class ILCompilationError extends Error {
  constructor(message, diagnostics = []) {
    super(message); this.name = 'ILCompilationError'; this.diagnostics = diagnostics;
  }
}
export class ILExecutionError extends Error {
  constructor(message, details = {}) {
    super(message); this.name = 'ILExecutionError'; Object.assign(this, details);
  }
}
