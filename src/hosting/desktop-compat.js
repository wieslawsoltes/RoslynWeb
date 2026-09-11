import { BrowserDesktopHost } from './desktop.js';

const installed = new WeakMap();
const activeSessions = new WeakSet();
const installations = [
  ['Runtime.cs', 'RoslynWeb.Desktop'],
  ['Forms.cs', 'System.Windows.Forms'],
  ['PresentationCore.cs', 'PresentationCore'],
  ['PresentationFramework.cs', 'PresentationFramework'],
];
async function readSource(url, fetcher) {
  if (url.protocol === 'file:' && typeof process !== 'undefined' && process.versions?.node) {
    return (await import('node:fs/promises')).readFile(url, 'utf8');
  }
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Desktop compatibility source download failed (${response.status}): ${url}`);
  return response.text();
}
function requireResult(result) {
  if (!result?.success) {
    const error = new Error(result?.error?.message || result?.diagnostics?.filter(d => d.severity === 'error').map(d => d.message).join('\n') || 'Desktop managed operation failed');
    error.code = 'DESKTOP_COMPATIBILITY_ERROR'; error.details = result; throw error;
  }
  return result.result;
}

/** Install an opt-in, bounded desktop binary compatibility layer on a compiler.
 * Original desktop DLL bytes are executed unchanged in .NET WASM. The assemblies
 * provided here are unsigned clean-room replacements, not Microsoft binaries.
 * Use a dedicated compiler instance: assembly replacements last until disposal.
 */
export async function createDesktopCompatibility({ compiler, root, document, onOutput, onError, fetch: fetcher = globalThis.fetch } = {}) {
  if (!compiler?.compile || !compiler?.invoke || !compiler?.addDll) throw new TypeError('A Roslyn compiler instance is required');
  if (activeSessions.has(compiler)) throw new Error('This compiler already has an active desktop compatibility session; dispose that session or use another compiler');
  activeSessions.add(compiler);
  try {
  if (!installed.has(compiler)) {
    const installation = (async () => {
      const sources = await Promise.all(installations.map(([file]) => readSource(new URL(`./compat/${file}`, import.meta.url), fetcher)));
      let runtime;
      const assemblies = [];
      for (let i = 0; i < installations.length; i++) {
        const [file, name] = installations[i];
        const result = await compiler.compile(sources[i], { assemblyName: name, outputKind: 'library', emitPdb: false, compilerExtensions: [], enableGenerators: false, enableAnalyzers: false });
        requireResult(result); await compiler.addDll(`${name}.dll`, result.pe);
        if (i === 0) runtime = result.assemblyId;
        else assemblies.push(requireResult(await compiler.invoke(runtime, 'RoslynWeb.Desktop.Runtime', 'Install', [name])));
      }
      return { runtime, assemblies };
    })();
    installed.set(compiler, installation);
    installation.catch(() => installed.delete(compiler));
  }
  const { runtime, assemblies } = await installed.get(compiler);
  let closed = false, host;
  const invoke = async (method, args = []) => {
    if (closed) throw new Error('Desktop compatibility session was disposed');
    const result = await compiler.invoke(runtime, 'RoslynWeb.Desktop.Runtime', method, args);
    onOutput?.({ stdout: result.stdout || '', stderr: result.stderr || '' });
    return requireResult(result);
  };
  const apply = (widgets, acknowledgedSequence = 0) => {
    if (host && !host.closed) synchronizeDesktopTree(host, widgets, { acknowledgedSequence });
    return widgets;
  };
  const api = {
    assemblies,
    get host() { return host; },
    async snapshot() { return JSON.parse(await invoke('Snapshot')); },
    async refresh() { return apply(await api.snapshot()); },
    async dispatch(event) {
      if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw new TypeError('Desktop events require id and type');
      try {
        return apply(JSON.parse(await invoke('Dispatch', [event.id, event.type, JSON.stringify(event.value ?? null)])), event.sequence ?? Number.POSITIVE_INFINITY);
      } catch (error) {
        const node = host?.nodes.get(event.id);
        if (node?.pendingEdit && node.pendingEdit.sequence <= (event.sequence ?? Number.POSITIVE_INFINITY)) delete node.pendingEdit;
        throw error;
      }
    },
    async run(assembly, options = {}) {
      if (closed) throw new Error('Desktop compatibility session was disposed');
      if (options.backend && options.backend !== 'wasm') throw new TypeError('Desktop binary compatibility uses the WebAssembly backend');
      const result = await compiler.run(assembly, { ...options, backend: 'wasm' });
      onOutput?.({ stdout: result.stdout || '', stderr: result.stderr || '' });
      await api.refresh(); return result;
    },
    attach(element, options = {}) {
      if (closed) throw new Error('Desktop compatibility session was disposed');
      host?.dispose();
      host = new BrowserDesktopHost({ root: element, document: options.document || document, onError: options.onError || onError, onEvent: event => api.dispatch(event).then(() => undefined) });
      return api.refresh();
    },
    async reset() { await invoke('Reset'); return api.refresh(); },
    async dispose() {
      if (closed) return;
      closed = true; host?.dispose(); activeSessions.delete(compiler);
      if (!compiler.disposed) requireResult(await compiler.invoke(runtime, 'RoslynWeb.Desktop.Runtime', 'Reset', []));
    },
  };
  if (root) await api.attach(root);
  return api;
  } catch (error) { activeSessions.delete(compiler); throw error; }
}

/** Keep DOM nodes (and selection/caret) stable when a managed event changes props. */
export function synchronizeDesktopTree(host, widgets, { acknowledgedSequence = Number.POSITIVE_INFINITY } = {}) {
  // A later browser edit can already exist while an earlier Worker event is awaiting
  // its managed snapshot. Preserve that newer value until its event is acknowledged.
  const preserve = list => list.map(widget => {
    const node = host.nodes.get(widget.id), pending = node?.pendingEdit;
    const props = { ...(widget.props || {}) };
    if (pending && pending.sequence > acknowledgedSequence) props[pending.property] = structuredClone(pending.value);
    else if (pending) delete node.pendingEdit;
    return { ...widget, props, children: preserve(widget.children || []) };
  });
  widgets = preserve(widgets);
  const flat = [];
  const visit = (list, parent = null) => { for (const widget of list) { flat.push({ widget, parent }); visit(widget.children || [], widget.id); } };
  visit(widgets);
  const roots = [...host.nodes.values()].filter(node => node.parent === null).map(node => node.id);
  const unchanged = roots.join('\0') === widgets.map(widget => widget.id).join('\0') && flat.length === host.nodes.size && flat.every(({ widget, parent }) => {
    const node = host.nodes.get(widget.id);
    return node?.type === widget.type && (widget.type !== 'text' || !!node.props.multiline === !!widget.props?.multiline) && node.parent === parent && node.children.join('\0') === (widget.children || []).map(c => c.id).join('\0');
  });
  if (unchanged) {
    for (const { widget } of flat) {
      const node = host.nodes.get(widget.id), props = widget.props || {};
      for (const property of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'margin', 'position', 'left', 'top', 'right', 'bottom', 'color', 'backgroundColor']) {
        if (!(property in props) && property in node.props) node.element.style[property] = '';
      }
      node.props = structuredClone(props);
      host.update(widget.id, { events: widget.events || {}, bindings: widget.bindings || {} });
    }
  } else {
    const active = host.document.activeElement;
    const selected = active && [...host.nodes.values()].find(node => node.element === active || node.input === active);
    const selection = selected && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const pending = new Map([...host.nodes.values()].filter(node => node.pendingEdit).map(node => [node.id, node.pendingEdit]));
    host.render(widgets);
    for (const [id, edit] of pending) if (host.nodes.has(id)) host.nodes.get(id).pendingEdit = edit;
    const next = selected && host.nodes.get(selected.id);
    if (next) { const element = next.input || next.element; element.focus(); if (selection && element.setSelectionRange) element.setSelectionRange(...selection); }
  }
  return host;
}
