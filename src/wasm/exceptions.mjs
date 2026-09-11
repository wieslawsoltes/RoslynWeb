/** Exception-region control metadata for directly compiled WebAssembly methods.
 * These helpers never execute IL. Native WASM code owns all user instructions;
 * services select catch/finally instruction offsets and preserve unwind state.
 */
export class WasmExceptionPlanError extends Error {
  constructor(message, code = 'WASM_EXCEPTION_REGIONS') { super(message); this.name = 'WasmExceptionPlanError'; this.code = code; }
}
const fail = message => { throw new WasmExceptionPlanError(message); };
const contains = (offset, start, length) => offset >= start && offset < start + length;
const insideHandler = (handler, offset) => contains(offset, handler.handlerOffset, handler.handlerLength);
const nesting = (a, b) => a.tryLength - b.tryLength || b.tryOffset - a.tryOffset || a.order - b.order;

/** Validate EH metadata and produce plain serializable regions with handler stack types. */
export function buildExceptionPlan(method) {
  const body = method.body ?? [], offsets = new Set(body.map(instruction => instruction.offset));
  const end = body.reduce((end,instruction)=>Math.max(end,instruction.offset+instruction.size),0);
  const boundaries = new Set([...offsets, end]);
  const handlers = (method.exceptionHandlers ?? []).map((source, order) => {
    const kind = String(source.kind).toLowerCase() === 'clause' ? 'catch' : String(source.kind).toLowerCase();
    if (!['catch', 'filter', 'finally', 'fault'].includes(kind)) fail(`Native WebAssembly exception kind '${kind}' is unsupported.`);
    const handler = {kind, tryOffset:source.tryOffset, tryLength:source.tryLength, handlerOffset:source.handlerOffset, handlerLength:source.handlerLength, catchType:source.catchType ?? null, ...(kind === 'filter' ? {filterOffset:source.filterOffset} : {}), order};
    for (const key of ['tryOffset','tryLength','handlerOffset','handlerLength']) if (!Number.isSafeInteger(handler[key]) || handler[key] < 0) fail(`Invalid exception region ${key}.`);
    if (!handler.tryLength || !handler.handlerLength || !offsets.has(handler.tryOffset) || !offsets.has(handler.handlerOffset) || !boundaries.has(handler.tryOffset + handler.tryLength) || !boundaries.has(handler.handlerOffset + handler.handlerLength)) fail('Exception regions must start and end at valid IL instruction boundaries.');
    if (contains(handler.handlerOffset, handler.tryOffset, handler.tryLength) || contains(handler.tryOffset, handler.handlerOffset, handler.handlerLength)) fail('An exception handler cannot overlap its own protected region.');
    if (kind === 'filter' && (!Number.isSafeInteger(handler.filterOffset) || !offsets.has(handler.filterOffset) || handler.filterOffset >= handler.handlerOffset || contains(handler.filterOffset, handler.tryOffset, handler.tryLength))) fail('An exception filter must begin at a valid instruction before its handler and outside its protected region.');
    return Object.freeze(handler);
  });
  // Distinct protected regions may nest, but must not cross one another.
  for (let i = 0; i < handlers.length; i++) for (let j = i + 1; j < handlers.length; j++) {
    const a=handlers[i],b=handlers[j],ae=a.tryOffset+a.tryLength,be=b.tryOffset+b.tryLength;
    if (a.tryOffset < b.tryOffset && b.tryOffset < ae && ae < be || b.tryOffset < a.tryOffset && a.tryOffset < be && be < ae) fail('Partially overlapping exception protected regions are unsupported.');
  }
  return Object.freeze({handlers:Object.freeze(handlers),handlerEntries:Object.freeze(handlers.flatMap(handler => [...(handler.kind === 'filter' ? [Object.freeze({offset:handler.filterOffset,stack:Object.freeze(['externref'])})] : []),Object.freeze({offset:handler.handlerOffset,stack:Object.freeze(['catch','filter'].includes(handler.kind) ? ['externref'] : [])})])),endOffset:end});
}

// Only the current native method's catch wrapper handles this marker. It then
// rethrows the original error outside that wrapper, preventing a repeated unwind.
class CompletedUnwind { constructor(frame, exception, search) { this.frame=frame;this.exception=exception;this.search=search; } }
class PropagatingUnwind { constructor(search) { this.search=search; } }
const parents = Object.freeze({
  'System.DivideByZeroException':'System.ArithmeticException','System.OverflowException':'System.ArithmeticException','System.ArithmeticException':'System.SystemException',
  'System.ArgumentNullException':'System.ArgumentException','System.ArgumentOutOfRangeException':'System.ArgumentException','System.ArgumentException':'System.SystemException',
  'System.InvalidOperationException':'System.SystemException','System.NullReferenceException':'System.SystemException','System.IndexOutOfRangeException':'System.SystemException',
  'System.InvalidCastException':'System.SystemException','System.NotSupportedException':'System.SystemException','System.FormatException':'System.SystemException',
  'System.IO.IOException':'System.SystemException','System.IO.FileNotFoundException':'System.IO.IOException','System.IO.DirectoryNotFoundException':'System.IO.IOException',
  'System.SystemException':'System.Exception'
});
function defaultIsInstance(error, requested) {
  if (requested === 'System.Object' || requested === 'System.Exception') return true;
  let type = error?.$type ?? error?.typeName ?? (String(error?.name).startsWith('System.') ? error.name : 'System.Exception');
  while (type) { if (type === requested) return true; type=parents[type]; }
  return false;
}

export function createExceptionFrame(plan, options = {}) {
  if (!Array.isArray(plan?.handlers)) fail('An exception frame requires a validated exception plan.');
  const frame={plan,isInstance:options.isInstance ?? defaultIsInstance,normalize:options.normalize ?? (error => error),isFatal:options.isFatal ?? (error => error?.runtimeLimitation || typeof error?.code === 'string' && /^(?:WASM_|NATIVE_WASM_|DISPOSED$|ABORTED$|TIMEOUT$)/.test(error.code)),transfer:null,activeFinally:null,exception:null,catches:[],context:options.context ?? null,origin:0,cells:[]};
  if(frame.context)frame.context.frames.push(frame);
  return frame;
}
function regionContains(frame, handler, offset) {
  return contains(offset,handler.tryOffset,handler.tryLength) || frame.plan.handlers.some(other => other.tryOffset === handler.tryOffset && other.tryLength === handler.tryLength && ['catch','filter'].includes(other.kind) && insideHandler(other,offset));
}
function completeTransfer(frame, fromFinally) {
  const transfer=frame.transfer;
  if (!transfer) fail('endfinally has no pending exception or leave continuation.');
  if (transfer.queue.length) {frame.activeFinally=transfer.queue.shift();return frame.activeFinally.handlerOffset;}
  frame.transfer=transfer.parent?.transfer ?? null;frame.activeFinally=transfer.parent?.activeFinally ?? null;
  if (transfer.kind === 'throw') {if(fromFinally)throw new CompletedUnwind(frame,transfer.exception,transfer.search);return escapeFrame(frame,transfer.exception,transfer.search);}
  frame.catches=frame.catches.filter(caught=>insideHandler(caught.handler,transfer.target));
  if (transfer.kind === 'catch') {frame.exception=transfer.exception;frame.catches.push({handler:transfer.handler,exception:transfer.exception});}
  return transfer.target;
}
function transfer(frame, request, origin) {
  request.parent=frame.transfer && frame.activeFinally && insideHandler(frame.activeFinally,request.target)
    ? {transfer:frame.transfer,activeFinally:frame.activeFinally} : null;
  request.queue=frame.plan.handlers.filter(handler=>(handler.kind === 'finally' || handler.kind === 'fault' && request.kind !== 'leave') && regionContains(frame,handler,origin) && !regionContains(frame,handler,request.target)).sort(nesting);
  frame.transfer=request;frame.activeFinally=null;
  return completeTransfer(frame,false);
}

/** A module-local stack coordinates CLR's search pass before any unwind pass.
 * Filter callbacks are native WebAssembly exports; this service never evaluates IL.
 */
export function createExceptionContext(options = {}) {
  return {frames:[],filterBoundaries:[],evaluateFilter:options.evaluateFilter ?? (()=>fail('A native exception filter evaluator was not installed.'))};
}
export function positionExceptionFrame(frame, origin) {frame.origin=origin;}
export function captureExceptionCell(frame, index, cell) {frame.cells[index]=cell;}
export function exceptionCell(frame,index) {const cell=frame.cells[index];if(!cell)fail(`Exception filter storage cell ${index} was not captured.`);return cell;}
export function exitExceptionFrame(frame) {
  const frames=frame.context?.frames;if(!frames)return;
  const index=frames.lastIndexOf(frame);if(index>=0)frames.length=index;
}
export function resetExceptionContext(context) {context.frames.length=0;context.filterBoundaries.length=0;}
function escapeFrame(frame, exception, search) {
  const context=frame.context;
  exitExceptionFrame(frame);
  if(search && context && context.frames.length>(context.filterBoundaries.at(-1)??0))throw new PropagatingUnwind(search);
  throw exception;
}
function searchException(frame, origin, exception) {
  const context=frame.context, frames=context?.frames??[frame];
  const start=frames.lastIndexOf(frame), boundary=context?.filterBoundaries.at(-1)??0;
  if(start<0)fail('An exception escaped an inactive native frame.');
  frame.origin=origin;
  for(let index=start;index>=boundary;index--){
    const current=frames[index];
    const candidates=current.plan.handlers.filter(handler=>['catch','filter'].includes(handler.kind)&&contains(current.origin,handler.tryOffset,handler.tryLength)).sort(nesting);
    for(const handler of candidates){
      if(handler.kind==='catch'){
        if(!handler.catchType||current.isInstance(exception,handler.catchType))return {exception,frame:current,handler};
      }else{
        if(!context)fail('Exception filters require the module-wide native exception context.');
        const savedLength=frames.length;
        context.filterBoundaries.push(savedLength);
        let accepted=false;
        try{accepted=!!context.evaluateFilter(current,handler,exception);}
        catch(error){if(current.isFatal(error)||error instanceof WasmExceptionPlanError)throw error;}
        finally{frames.length=savedLength;context.filterBoundaries.pop();}
        if(accepted)return {exception,frame:current,handler};
      }
    }
  }
  return {exception,frame:null,handler:null};
}

/** Called from a native WASM catch clause; return the next handler's IL offset. */
export function dispatchException(frame, origin, error) {
  if(error instanceof CompletedUnwind&&error.frame===frame)return escapeFrame(frame,error.exception,error.search);
  // Engine limits and compatibility errors are host failures, not CLR exceptions.
  if(frame.isFatal(error)||error instanceof WasmExceptionPlanError){exitExceptionFrame(frame);throw error;}
  frame.origin=origin;
  const search=error instanceof PropagatingUnwind?error.search:searchException(frame,origin,frame.normalize(error));
  const handler=search.frame===frame?search.handler:null;
  return transfer(frame,handler?{kind:'catch',target:handler.handlerOffset,handler,exception:search.exception}:{kind:'throw',target:-1,exception:search.exception,search},origin);
}
export function leaveProtectedRegion(frame, origin, target) {
  if (!Number.isSafeInteger(target) || target < 0) fail('leave requires a valid instruction offset.');
  return transfer(frame,{kind:'leave',target},origin);
}
export function finishFinally(frame) {
  if (!frame.activeFinally) fail('endfinally is outside an active finally/fault handler.');
  return completeTransfer(frame,true);
}
export function caughtException(frame) {return frame.exception;}
export function rethrowException(frame, origin) {
  const caught=frame.catches.findLast(caught=>insideHandler(caught.handler,origin));
  if (!caught) fail('rethrow is outside an active catch handler.');
  throw caught.exception;
}

/** Native try/catch for JS managed exceptions requires the standardized JS tag. */
export function requireExceptionTag() {
  if (typeof WebAssembly === 'undefined' || !WebAssembly.JSTag) throw new WasmExceptionPlanError('This engine does not expose WebAssembly.JSTag required for native managed exception handling.','WASM_EXCEPTION_HANDLING_UNAVAILABLE');
  return WebAssembly.JSTag;
}
