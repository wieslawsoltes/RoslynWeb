const kinds = new Set(['window', 'panel', 'label', 'text', 'button', 'check', 'list', 'grid', 'menu', 'menuitem', 'progress']);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function pathParts(path) {
  if (typeof path !== 'string' || !path || path.split('.').some(p => !p || forbidden.has(p))) throw new TypeError('Binding paths must contain ordinary property names');
  return path.split('.');
}
function readPath(data, path) { return pathParts(path).reduce((value, part) => value?.[part], data); }
function dataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Desktop data must be an object');
  return clone(value);
}
function writePath(data, path, value) {
  const parts = pathParts(path); let current = data;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}
const clone = value => structuredClone(value);
const length = value => typeof value === 'number' && Number.isFinite(value) ? `${value}px` : /^(?:auto|\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw))$/.test(String(value)) ? String(value) : '';
const boxStyle = { boxSizing: 'border-box', minWidth: '0' };
function assignStyle(element, values) { Object.assign(element.style, values); }

/** DOM widget host shared by the JSON protocol and optional desktop binary shims. */
export class BrowserDesktopHost {
  constructor({ root, document = root?.ownerDocument || globalThis.document, onEvent, onError, data = {} } = {}) {
    if (!root || !document?.createElement) throw new TypeError('A DOM root element and document are required');
    this.root = root; this.document = document; this.onEvent = onEvent; this.onError = onError;
    this.nodes = new Map(); this.data = dataObject(data); this.closed = false; this.queue = Promise.resolve();
    this.sequence = 0; this.listeners = new Set();
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  validate(model, occupied = new Set(this.nodes.keys())) {
    if (!model || typeof model.id !== 'string' || !model.id || !kinds.has(model.type)) throw new TypeError('Each widget requires a nonempty id and a supported type');
    if (occupied.has(model.id)) throw new Error(`Duplicate widget id '${model.id}'`);
    occupied.add(model.id);
    if (model.children?.length && !['window', 'panel', 'menu'].includes(model.type)) throw new TypeError(`Widget type '${model.type}' cannot contain child widgets`);
    for (const binding of Object.values(model.bindings || {})) pathParts(typeof binding === 'string' ? binding : binding.path);
    for (const child of model.children || []) this.validate(child, occupied);
  }
  render(models) {
    if (this.closed) throw new Error('Desktop host was disposed');
    const items = Array.isArray(models) ? models : [models], occupied = new Set();
    for (const model of items) this.validate(model, occupied);
    for (const id of [...this.nodes.keys()]) this.remove(id);
    for (const model of items) this.create(model);
    return this;
  }
  create(model, parentId = null) {
    if (this.closed) throw new Error('Desktop host was disposed');
    this.validate(model);
    const parent = parentId == null ? null : this.nodes.get(parentId);
    if (parentId != null && !parent) throw new Error(`Unknown parent '${parentId}'`);
    if (parent && !['window', 'panel', 'menu'].includes(parent.type)) throw new Error(`Widget '${parentId}' cannot contain child widgets`);
    return this._create(model, parent);
  }
  _create(model, parent) {
    const d = this.document;
    const tag = { window: 'section', panel: 'div', label: 'span', text: model.props?.multiline ? 'textarea' : 'input', button: 'button', check: 'label', list: 'select', grid: 'table', menu: 'nav', menuitem: 'button', progress: 'progress' }[model.type];
    const element = d.createElement(tag);
    const node = { id: model.id, type: model.type, parent: parent?.id ?? null, element, content: element, props: clone(model.props || {}), bindings: clone(model.bindings || {}), events: clone(model.events || {}), children: [], cleanup: [] };
    element.dataset.widgetId = node.id; element.dataset.widgetType = node.type;
    assignStyle(element, boxStyle);
    if (node.type === 'window') {
      const header = d.createElement('header'), title = d.createElement('span'), close = d.createElement('button'), body = d.createElement('div');
      close.textContent = '×'; close.type = 'button'; close.setAttribute('aria-label', 'Close window');
      header.append(title, close); element.append(header, body); node.content = body; node.title = title; node.close = close;
      assignStyle(element, { display: 'flex', flexDirection: 'column', border: '1px solid #8a94a6', borderRadius: '8px', overflow: 'hidden', background: 'Canvas', color: 'CanvasText', font: '14px system-ui, sans-serif' });
      assignStyle(header, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'ButtonFace', fontWeight: '600' });
      assignStyle(close, { border: '0', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '20px' });
      assignStyle(body, { flex: '1', minHeight: '0', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' });
      element.setAttribute('role', 'region'); this.listen(node, close, 'click', event => this.emit(node, 'close', {}, event));
    }
    if (node.type === 'check') {
      node.input = d.createElement('input'); node.input.type = 'checkbox'; node.caption = d.createElement('span'); element.append(node.input, node.caption);
      assignStyle(element, { display: 'flex', alignItems: 'center', gap: '6px' });
    }
    if (node.type === 'text' && tag === 'input') element.type = 'text';
    if (node.type === 'button' || node.type === 'menuitem') { element.type = 'button'; this.listen(node, element, 'click', event => this.emit(node, 'click', {}, event)); }
    if (node.type === 'menu') { element.setAttribute('aria-label', node.props.label || 'Application menu'); assignStyle(element, { display: 'flex', flexWrap: 'wrap', gap: '4px' }); }
    if (node.type === 'text') {
      for (const type of ['input', 'change']) this.listen(node, element, type, event => this.change(node, type, 'value', element.value, event));
      this.listen(node, element, 'keydown', event => this.emit(node, 'keydown', { key: event.key, ctrlKey: !!event.ctrlKey, altKey: !!event.altKey, shiftKey: !!event.shiftKey }, event));
    }
    if (node.type === 'check') this.listen(node, node.input, 'change', event => this.change(node, 'change', 'checked', node.input.checked, event));
    if (node.type === 'list') this.listen(node, element, 'change', event => this.change(node, 'change', 'value', element.multiple ? [...element.selectedOptions].map(option => option.value) : element.value, event));
    this.nodes.set(node.id, node);
    if (parent) parent.children.push(node.id);
    (parent?.content || this.root).append(element); this.draw(node);
    for (const child of model.children || []) this._create(child, node);
    return node;
  }
  listen(node, element, type, callback) {
    element.addEventListener(type, callback); node.cleanup.push(() => element.removeEventListener(type, callback));
  }
  change(node, type, property, value, nativeEvent) {
    node.props[property] = value;
    const binding = node.bindings[property];
    if (binding && (typeof binding === 'string' || binding.mode !== 'oneWay')) this.setData(typeof binding === 'string' ? binding : binding.path, value);
    this.emit(node, type, { value, property }, nativeEvent);
  }
  emit(node, type, details = {}, nativeEvent) {
    if (this.closed) return;
    const action = node.events[type];
    if (action && typeof action === 'object' && action.preventDefault) nativeEvent?.preventDefault?.();
    const event = { sequence: ++this.sequence, id: node.id, type, action: typeof action === 'object' ? action.action : action || type, ...details };
    if (details.property) node.pendingEdit = { sequence: event.sequence, property: details.property, value: clone(details.value) };
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      for (const listener of this.listeners) await listener(event);
      const commands = await this.onEvent?.(event);
      if (!this.closed && commands) this.apply(commands);
    }).catch(error => { this.lastError = error; try { this.onError?.(error, event); } catch (handlerError) { this.lastError = handlerError; } });
  }
  flushEvents() { return this.queue; }
  update(id, patch = {}) {
    if (this.closed) throw new Error('Desktop host was disposed');
    const node = this.nodes.get(id); if (!node) throw new Error(`Unknown widget '${id}'`);
    for (const binding of Object.values(patch.bindings || {})) pathParts(typeof binding === 'string' ? binding : binding.path);
    if (patch.props) Object.assign(node.props, clone(patch.props));
    if (patch.events) node.events = clone(patch.events);
    if (patch.bindings) node.bindings = clone(patch.bindings);
    this.draw(node); return node;
  }
  draw(node) {
    const p = { ...node.props }, el = node.element;
    for (const [property, binding] of Object.entries(node.bindings)) p[property] = readPath(this.data, typeof binding === 'string' ? binding : binding.path);
    el.hidden = p.visible === false; el.setAttribute('aria-disabled', String(p.enabled === false));
    (node.input || el).disabled = p.enabled === false;
    el.title = String(p.tooltip ?? '');
    el.setAttribute('aria-label', String(p.ariaLabel ?? p.label ?? p.title ?? p.text ?? node.id));
    if (p.tabIndex !== undefined) el.tabIndex = Number(p.tabIndex);
    const styles = {};
    for (const property of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'margin']) if (p[property] !== undefined) styles[property] = length(p[property]);
    if (p.grow !== undefined) styles.flexGrow = Math.max(0, Number(p.grow) || 0);
    if (['relative', 'absolute'].includes(p.position)) styles.position = p.position;
    for (const property of ['left', 'top', 'right', 'bottom']) if (p[property] !== undefined) styles[property] = length(p[property]);
    for (const property of ['color', 'backgroundColor']) if (typeof p[property] === 'string') styles[property] = p[property];
    assignStyle(el, styles);
    if (p.layout) {
      const layout = p.layout, container = node.content;
      if (layout.kind === 'absolute') {
        assignStyle(container, { display: 'block', position: 'relative', minHeight: '0' });
      } else if (layout.kind === 'grid') {
        assignStyle(container, { display: 'grid', gridTemplateColumns: (layout.columns || [1]).map(value => `${Math.max(0.01, Number(value) || 1)}fr`).join(' ') });
      } else assignStyle(container, { display: 'flex', flexDirection: layout.orientation === 'horizontal' ? 'row' : 'column', flexWrap: layout.wrap ? 'wrap' : 'nowrap' });
      container.style.gap = length(layout.gap ?? 8); container.style.padding = length(layout.padding ?? 0);
      if (['start', 'end', 'center', 'stretch'].includes(layout.align)) container.style.alignItems = layout.align;
      if (['start', 'end', 'center', 'space-between', 'space-around'].includes(layout.justify)) container.style.justifyContent = layout.justify;
    }
    switch (node.type) {
      case 'window': node.title.textContent = String(p.title ?? 'Window'); node.close.hidden = p.closable === false; break;
      case 'label': case 'button': case 'menuitem': el.textContent = String(p.text ?? p.label ?? ''); break;
      case 'text':
        if (el.value !== String(p.value ?? '')) el.value = String(p.value ?? '');
        el.placeholder = String(p.placeholder ?? ''); el.readOnly = !!p.readOnly;
        if (el.tagName?.toLowerCase() === 'input') el.type = p.password ? 'password' : 'text';
        if (p.maxLength !== undefined) el.maxLength = Math.max(0, Number(p.maxLength) || 0);
        if (el.tagName?.toLowerCase() === 'textarea') el.rows = Math.max(1, Number(p.rows) || 3);
        break;
      case 'check': node.input.indeterminate = !!p.indeterminate; node.input.checked = !!p.checked; node.caption.textContent = String(p.text ?? p.label ?? ''); break;
      case 'list': {
        el.multiple = !!p.multiple; el.size = Math.max(1, Number(p.size) || 1);
        el.replaceChildren(); const values = new Set((Array.isArray(p.value) ? p.value : [p.value]).map(String));
        for (const item of p.items || []) {
          const option = this.document.createElement('option'), obj = item != null && typeof item === 'object' ? item : { value: item, text: item };
          option.value = String(obj.value ?? ''); option.textContent = String(obj.text ?? obj.value ?? ''); option.disabled = !!obj.disabled; option.selected = values.has(option.value); el.append(option);
        }
        break;
      }
      case 'grid': this.drawGrid(node, p); break;
      case 'progress': el.max = Math.max(1, Number(p.max) || 100); if (p.value == null) el.removeAttribute('value'); else el.value = Number(p.value) || 0; break;
    }
    // Inline flex/grid display overrides the browser's default [hidden] rule.
    if (p.visible === false) {
      if (el.style.display !== 'none') node.visibleDisplay = el.style.display || '';
      el.style.display = 'none';
    } else if (node.visibleDisplay !== undefined) {
      if (el.style.display === 'none') el.style.display = node.visibleDisplay;
      delete node.visibleDisplay;
    }
  }
  drawGrid(node, props) {
    const el = node.element, columns = props.columns || [];
    // Remove listeners attached to replaced cell elements without retaining detached subtrees.
    for (const cleanup of node.cellCleanup || []) cleanup(); node.cellCleanup = [];
    el.replaceChildren(); assignStyle(el, { borderCollapse: 'collapse', width: '100%' });
    const head = this.document.createElement('thead'), header = this.document.createElement('tr'); head.append(header); el.append(head);
    for (const col of columns) { const cell = this.document.createElement('th'); cell.textContent = String(col.title ?? col.key ?? ''); cell.setAttribute('scope', 'col'); assignStyle(cell, { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #8a94a6' }); header.append(cell); }
    const body = this.document.createElement('tbody'); el.append(body);
    (props.rows || []).forEach((row, rowIndex) => {
      const tr = this.document.createElement('tr'); body.append(tr);
      columns.forEach(col => {
        const cell = this.document.createElement('td'); assignStyle(cell, { padding: '4px 8px', borderBottom: '1px solid #c7cdd6' }); tr.append(cell);
        if (col.editable) {
          const input = this.document.createElement('input'); input.type = 'text'; input.value = String(row[col.key] ?? ''); input.disabled = props.enabled === false;
          input.setAttribute('aria-label', `${col.title ?? col.key}, row ${rowIndex + 1}`); cell.append(input);
          const handler = event => this.emit(node, 'cellchange', { row: rowIndex, column: col.key, value: input.value, rowKey: props.rowKey ? row[props.rowKey] : rowIndex }, event);
          input.addEventListener('change', handler); node.cellCleanup.push(() => input.removeEventListener('change', handler));
        } else cell.textContent = String(row[col.key] ?? '');
      });
    });
  }
  setData(path, value) {
    if (this.closed) throw new Error('Desktop host was disposed');
    if (typeof path === 'string') writePath(this.data, path, clone(value)); else this.data = dataObject(path);
    for (const node of this.nodes.values()) if (Object.keys(node.bindings).length) this.draw(node);
    return this;
  }
  getData(path) { return clone(path == null ? this.data : readPath(this.data, path)); }
  remove(id) {
    const node = this.nodes.get(id); if (!node) return false;
    for (const child of [...node.children]) this.remove(child);
    for (const cleanup of [...node.cleanup, ...(node.cellCleanup || [])]) cleanup();
    const parent = this.nodes.get(node.parent); if (parent) parent.children = parent.children.filter(child => child !== id);
    node.element.remove(); this.nodes.delete(id); return true;
  }
  apply(command) {
    if (this.closed) throw new Error('Desktop host was disposed');
    if (typeof command === 'string') command = JSON.parse(command);
    if (Array.isArray(command)) return command.map(c => this.apply(c));
    switch (command?.op) {
      case 'create': return this.create(command.widget, command.parent ?? null);
      case 'update': return this.update(command.id, command);
      case 'remove': return this.remove(command.id);
      case 'render': return this.render(command.widgets ?? command.widget);
      case 'data': return this.setData(command.path ?? command.data, command.value);
      case 'focus': { const node = this.nodes.get(command.id); if (!node) throw new Error(`Unknown widget '${command.id}'`); (node.input || node.element).focus(); return node; }
      case 'batch': return this.apply(command.commands);
      default: throw new TypeError(`Unknown desktop command '${command?.op}'`);
    }
  }
  dispose() {
    for (const id of [...this.nodes.keys()]) this.remove(id);
    this.listeners.clear(); this.closed = true;
  }
}
