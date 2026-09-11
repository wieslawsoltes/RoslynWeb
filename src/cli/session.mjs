import { cliError, decodeJson, encodeJson, serializeError } from './codec.mjs';

/** Public RoslynCompiler members. Callback registration is exposed by script mode. */
export const API_METHODS = Object.freeze([
  'info', 'disposed', 'onEvent', 'compile', 'compileToWasm', 'compileToJavaScript',
  'emitWasm', 'emitJavaScript', 'addReference', 'addAssembly', 'addDll',
  'addCompilerExtension', 'compilerExtensions', 'loadCompilerReferences',
  'loadTaskReferences', 'executeBuildTask', 'createWorkspace', 'readWorkspace',
  'writeWorkspace', 'listWorkspace', 'deleteWorkspaceFiles', 'disposeWorkspace',
  'addNativeCommand', 'runNativeCommand', 'removeNativeCommand', 'createResources',
  'convertResx', 'buildProject', 'evaluateProject', 'references', 'inspect',
  'restore', 'importPackage', 'loadPackages', 'run', 'invoke', 'createObject',
  'invokeObject', 'getProperty', 'setProperty', 'releaseObject', 'compileFunction',
  'evaluate', 'dispose',
]);
const methods = new Set(API_METHODS);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** One lazy compiler and a bounded, insertion-ordered table of raw result objects. */
export function createApiSession({ getCompiler, cwd = process.cwd(), signal, maxResults = 64, maxResultBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof getCompiler !== 'function') throw new TypeError('getCompiler is required');
  if (!Number.isSafeInteger(maxResults) || maxResults < 0 || maxResults > 100000) throw new RangeError('maxResults must be an integer from 0 to 100000');
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 0) throw new RangeError('maxResultBytes must be a nonnegative safe integer');
  const results = new Map();
  let compilerPromise, compiler, disposal, closed = false, nextId = 1, resultBytes = 0;
  let queue = Promise.resolve();

  async function get() {
    if (closed || signal?.aborted) throw cliError(signal?.aborted ? 'Session was aborted' : 'Session was disposed', signal?.aborted ? 'ABORTED' : 'DISPOSED');
    // Failed startup and terminated hosts stay failed; never silently replace their state.
    compilerPromise ||= Promise.resolve().then(() => getCompiler());
    compiler = await compilerPromise;
    if (closed || signal?.aborted || compiler.disposed) throw cliError(signal?.aborted ? 'Session was aborted' : 'Compiler was disposed', signal?.aborted ? 'ABORTED' : 'DISPOSED');
    return compiler;
  }

  function resolveRef(path) {
    const parts = path.split('.');
    if (parts.some(part => !part || forbidden.has(part))) throw cliError(`Unsafe result reference: ${path}`, 'INVALID_REFERENCE');
    // Select the longest matching id, allowing dots in caller-provided ids.
    let key, index;
    for (let count = parts.length; count > 0; count--) {
      const candidate = parts.slice(0, count).join('.');
      if (results.has(candidate)) { key = candidate; index = count; break; }
    }
    if (key === undefined) throw cliError(`Unknown or evicted result reference: ${path}`, 'INVALID_REFERENCE');
    let value = results.get(key).value;
    for (; index < parts.length; index++) {
      if (value === null || typeof value !== 'object') throw cliError(`Result property does not exist: ${path}`, 'INVALID_REFERENCE');
      const property = Object.getOwnPropertyDescriptor(value, parts[index]);
      if (!property || !own(property, 'value')) throw cliError(`Result property does not exist: ${path}`, 'INVALID_REFERENCE');
      value = property.value;
    }
    if (typeof value === 'function') throw cliError('Function references require a compileFunction target invocation', 'INVALID_REFERENCE');
    return value;
  }

  function forget(key) {
    const previous = results.get(key);
    if (previous) { resultBytes -= previous.bytes; results.delete(key); }
  }

  function remember(id, value, callable, encoded) {
    const key = String(id);
    forget(key);
    if (!maxResults || !maxResultBytes) return;
    // Encoding includes base64 and all serializable assembly metadata. The byte
    // budget is a transport-size bound, not a promise about JS engine heap size.
    const bytes = Buffer.byteLength(JSON.stringify(encoded) ?? 'null');
    if (bytes > maxResultBytes) return;
    results.set(key, { value, callable, bytes });
    resultBytes += bytes;
    while (results.size > maxResults || resultBytes > maxResultBytes) forget(results.keys().next().value);
  }

  function dispose() {
    if (disposal) return disposal;
    closed = true;
    signal?.removeEventListener('abort', abort);
    results.clear();
    resultBytes = 0;
    disposal = (async () => {
      if (compilerPromise) {
        try {
          const instance = await compilerPromise;
          if (typeof instance.close === 'function') await instance.close();
          else await instance.dispose();
        } catch { /* Failed startup has no live compiler. */ }
      }
    })();
    return disposal;
  }
  const abort = () => { void dispose(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  async function execute(request) {
    let id = null;
    try {
      if (!request || Array.isArray(request) || typeof request !== 'object') throw cliError('API request must be an object');
      id = own(request, 'id') ? request.id : String(nextId++);
      if ((typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'number' && !Number.isFinite(id)) || !String(id)) throw cliError('Request id must be a nonempty string or finite number');
      const method = request.method;
      if (typeof method !== 'string' || !methods.has(method)) throw cliError(`Unknown API method: ${String(method)}`, 'UNKNOWN_METHOD');
      if (request.args !== undefined && !Array.isArray(request.args)) throw cliError('Request args must be an array');
      if (request.target !== undefined && (typeof request.target !== 'string' && typeof request.target !== 'number')) throw cliError('Request target must be a result id');
      if (method === 'onEvent') throw cliError('JSON sessions emit events through the CLI event stream. Use script mode for callback registration.', 'CALLBACK_REQUIRES_SCRIPT');
      let value, callable = false;
      if (request.target !== undefined) {
        if (method !== 'invoke') throw cliError('Result targets only support compileFunction invoke', 'INVALID_TARGET');
        const target = results.get(String(request.target));
        if (!target?.callable) throw cliError(`Unknown, evicted, or non-callable compileFunction result: ${request.target}`, 'INVALID_TARGET');
        await get();
        value = await target.value.invoke(...await decodeJson(request.args || [], { cwd, resolveRef, signal }));
      } else if (method === 'dispose') {
        if (request.args?.length) throw cliError('dispose takes no arguments');
        await dispose();
        value = { disposed: true };
      } else if (method === 'disposed') {
        if (request.args?.length) throw cliError('disposed takes no arguments');
        value = closed || Boolean(signal?.aborted) || Boolean(compiler?.disposed);
      } else {
        const args = await decodeJson(request.args || [], { cwd, resolveRef, signal });
        const instance = await get();
        if (method === 'info') {
          if (args.length) throw cliError('info takes no arguments');
          value = instance.info;
        } else {
          if (!own(instance, method) || typeof instance[method] !== 'function') throw cliError(`Compiler does not implement ${method}`, 'UNAVAILABLE_METHOD');
          value = await instance[method](...args);
          callable = method === 'compileFunction' && value?.success === true && typeof value.invoke === 'function';
        }
      }
      const encoded = encodeJson(value);
      if (!closed) remember(id, value, callable, encoded);
      if (value?.success === false) {
        const error = serializeError({
          code: value.error?.code || (method.startsWith('compile') || method === 'buildProject' ? 'COMPILE_FAILED' : 'OPERATION_FAILED'),
          message: value.error?.message || (typeof value.error === 'string' ? value.error : 'Operation reported failure'),
          ...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics }),
        });
        return { id, success: false, error, result: encoded };
      }
      return { id, success: true, result: encoded === undefined ? null : encoded };
    } catch (error) {
      // Even malformed ids/errors must result in a JSON-safe response.
      if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isFinite(id))) id = null;
      return { id, success: false, error: serializeError(error) };
    }
  }

  return {
    dispatch(request) {
      const operation = queue.then(() => execute(request));
      queue = operation.catch(() => {});
      return operation;
    },
    dispose,
    get disposed() { return closed || Boolean(signal?.aborted) || Boolean(compiler?.disposed); },
    get resultCount() { return results.size; },
    get resultBytes() { return resultBytes; },
    methods: API_METHODS,
  };
}
