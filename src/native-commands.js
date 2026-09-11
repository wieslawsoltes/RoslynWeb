// Shared by the Worker and direct host; loading this module never starts .NET.
export class NativeCommandHost {
  async call(operation, args) {
    if (!this.registry) {
      const { WasmCommandRegistry } = await import('./hosting/wasi.js');
      this.registry = new WasmCommandRegistry();
    }
    if (operation === 'register') {
      const command = await this.registry.register(...args);
      return { name: command.name, imports: command.imports };
    }
    if (operation === 'run') return this.registry.run(...args);
    if (operation === 'remove') return this.registry.unregister(...args);
    throw new TypeError(`Unknown native command operation: ${operation}`);
  }
  dispose() { this.registry?.dispose(); }
}
