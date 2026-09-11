import {parseFloatBits, floatNumberFromBits, floatLiteralExecutionBits} from './float-bits.mjs';
import { ILCompilationError, capabilities } from './capabilities.mjs';
import { createRuntime, methodKey } from './runtime.mjs';
import { buildBasicBlocks, analyzeInt32Method, generateInt32Method, analyzeNumericMethod, generateNumericMethod } from './optimizer.mjs';
import { genericDefinitionName, matchesMethodReference } from './generics.mjs';
import { isExtendedBuiltin } from './framework.mjs';
import { isReflectionBuiltin } from './reflection.mjs';
import { isEmitBuiltin, isEmitField } from './reflection-emit.mjs';
import { isCollectionsBuiltin } from './collections-extra.mjs';
import { isIoBuiltin } from './io.mjs';
import { isJavaScriptIntrinsic } from './intrinsics.mjs';
import { isStandardValueBuiltin, isStandardValueField } from './standard-values.mjs';

// This is JavaScript source serialization, including exact 64-bit metadata constants.
const literal = value => {
  if (typeof value === 'bigint') return `${value}n`;
  if (Object.is(value, -0)) return '-0';
  if (typeof value === 'number' && !Number.isFinite(value)) return Number.isNaN(value) ? 'NaN' : value < 0 ? '-Infinity' : 'Infinity';
  if (Array.isArray(value)) return `[${value.map(literal).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}:${literal(item)}`).join(',')}}`;
  return JSON.stringify(value ?? null).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
};
const bodyOf = method => method.body ?? method.instructions ?? [];
const opcodeOf = instruction => String(instruction.opcode ?? instruction.opCode ?? '').toLowerCase();
const typeName = operand => operand && typeof operand === 'object' ? operand.name ?? operand.fullName ?? operand.type : operand;
const noOperand = new Set(['nop', 'break', 'ldnull', 'dup', 'pop', 'ret', 'throw', 'rethrow', 'endfinally', 'endfilter', 'ldlen', 'ckfinite', 'add', 'add.ovf', 'add.ovf.un', 'sub', 'sub.ovf', 'sub.ovf.un', 'mul', 'mul.ovf', 'mul.ovf.un', 'div', 'div.un', 'rem', 'rem.un', 'and', 'or', 'xor', 'shl', 'shr', 'shr.un', 'neg', 'not', 'ceq', 'cgt', 'cgt.un', 'clt', 'clt.un']);
const prefixes = new Set(['constrained.', 'readonly.', 'tail.', 'volatile.', 'unaligned.']);
const objectOps = new Set(['box', 'unbox', 'unbox.any', 'castclass', 'isinst', 'initobj', 'ldobj', 'stobj', 'cpobj', 'sizeof', 'ldtoken', 'ldftn', 'ldvirtftn', 'newarr', 'call', 'callvirt', 'newobj', 'jmp']);
const branches = /^(br|brtrue|brfalse|beq|bne\.un|bge(?:\.un)?|bgt(?:\.un)?|ble(?:\.un)?|blt(?:\.un)?|leave)(?:\.s)?$/;
const conversions = /^conv\.(?:r\.un|(?:ovf\.)?(?:i1|u1|i2|u2|i4|u4|i8|u8|i|u|r4|r8)(?:\.un)?)$/;
const locals = /^(?:ldloc|stloc|ldarg|starg)(?:\.[0-3]|\.s)?$|^(?:ldloca|ldarga)(?:\.s)?$/;
const constants = /^ldc\.(?:i4(?:\.(?:m1|[0-8]|s))?|i8|r4|r8)$/;
const fields = /^(?:ldfld|ldflda|stfld|ldsfld|ldsflda|stsfld)$/;
const arrayOps = /^(?:ldelem(?:\.(?:i1|u1|i2|u2|i4|u4|i8|i|r4|r8|ref|any))?|stelem(?:\.(?:i1|i2|i4|i8|i|r4|r8|ref|any))?|ldelema)$/;
const indirect = /^(?:ldind\.(?:i1|u1|i2|u2|i4|u4|i8|i|r4|r8|ref)|stind\.(?:i1|i2|i4|i8|i|r4|r8|ref))$/;

export function isOpcodeSupported(opcode) {
  return noOperand.has(opcode) || prefixes.has(opcode) || objectOps.has(opcode) || branches.test(opcode) || conversions.test(opcode) || locals.test(opcode) || constants.test(opcode) || fields.test(opcode) || arrayOps.test(opcode) || indirect.test(opcode) || ['switch', 'ldstr', 'calli', 'localloc', 'cpblk', 'initblk', 'mkrefany', 'refanytype', 'refanyval'].includes(opcode);
}

/** This is a deliberately finite bridge, not a replacement implementation of the .NET BCL. */
export function isBuiltinCandidate(ref) {
  if (!ref || typeof ref !== 'object') return false;
  if (isJavaScriptIntrinsic(ref) || isStandardValueBuiltin(ref) || isCollectionsBuiltin(ref) || isExtendedBuiltin(ref) || isReflectionBuiltin(ref) || isEmitBuiltin(ref) || isIoBuiltin(ref)) return true;
  if (/\[[,]+\]$/.test(ref.declaringType ?? '')) { const rank = ref.declaringType.slice(ref.declaringType.lastIndexOf('[')).split(',').length, n = ref.parameters?.length ?? 0; return ref.name === '.ctor' && n === rank || ['Get','Address'].includes(ref.name) && n === rank || ref.name === 'Set' && n === rank + 1; }
  const type = String(ref.declaringType ?? '').split(/[<\[]/)[0], name = ref.name, p = (ref.parameters ?? []).map(p => p.type ?? p), n = p.length;
  const numeric = t => /^System\.(Boolean|Byte|SByte|Char|Int16|UInt16|Int32|UInt32|Int64|UInt64|IntPtr|UIntPtr|Single|Double)$/.test(t);
  const primitiveFormat = t => numeric(t) || t === 'System.String';
  const isMath = type === 'System.Math' || type === 'System.MathF';
  if (type === 'System.Console') return ['Write', 'WriteLine'].includes(name) && (n <= 1 && (n === 0 || primitiveFormat(p[0]) || ['System.Object', 'System.Char[]'].includes(p[0])) || n >= 2 && p[0] === 'System.String' && p.slice(1).every(t => t === 'System.Object' || t === 'System.Object[]'));
  if (type === 'System.String') {
    if (['get_Length', 'ToString', 'ToUpperInvariant', 'ToLowerInvariant', 'Trim', 'ToCharArray'].includes(name)) return n === 0;
    if (['get_Chars'].includes(name)) return n === 1 && p[0] === 'System.Int32';
    if (['IsNullOrEmpty', 'IsNullOrWhiteSpace', 'Contains', 'StartsWith', 'EndsWith'].includes(name)) return n === 1 && p[0] === 'System.String';
    if (['op_Equality', 'op_Inequality'].includes(name)) return n === 2 && p.every(t => t === 'System.String');
    if (name === 'Equals') return ref.isStatic ? n === 2 && p.every(t => t === 'System.String') : n === 1 && ['System.String', 'System.Object'].includes(p[0]);
    if (name === 'Substring') return (n === 1 || n === 2) && p.every(t => t === 'System.Int32');
    if (name === 'Replace') return n === 2 && p.every(t => t === 'System.String');
    if (name === '.ctor') return n === 1 && p[0] === 'System.Char[]';
    if (name === 'Concat') return n >= 1 && n <= 4 && p.every(t => ['System.String', 'System.Object', 'System.String[]', 'System.Object[]'].includes(t));
    if (name === 'Format') return n >= 2 && p[0] === 'System.String' && p.slice(1).every(t => ['System.Object', 'System.Object[]'].includes(t));
    if (name === 'Join') return n === 2 && p[0] === 'System.String' && ['System.String[]', 'System.Object[]'].includes(p[1]);
    return false;
  }
  if (type === 'System.Object' && name === 'GetHashCode') return ref.isStatic === false && n === 0 && ref.returnType === 'System.Int32';
  if (isMath && name === 'Round') return n === 1;
  if (type === 'System.Array') {
    if (['get_Length', 'get_Rank', 'Empty'].includes(name)) return n === 0;
    if (['GetLength','GetLowerBound','GetUpperBound'].includes(name)) return n === 1 && p[0] === 'System.Int32';
    if (name === 'CreateInstance') return n >= 2 && p[0] === 'System.Type' && (p.slice(1).every(t=>t==='System.Int32') || p.slice(1).every(t=>t==='System.Int32[]'));
    if (name === 'GetValue' || name === 'SetValue') { const start=name==='SetValue'?1:0;return n>start && (name!=='SetValue'||p[0]==='System.Object') && (p.slice(start).every(t=>t==='System.Int32')||n===start+1&&p[start]==='System.Int32[]'); }
    if (name === 'Copy') return n === 3 && p[2] === 'System.Int32';
    if (name === 'Clear') return n === 3;
    return false;
  }
  if (type === 'System.Text.StringBuilder') {
    if (name === '.ctor') return n === 0 || n === 1 && ['System.String', 'System.Int32'].includes(p[0]);
    if (name === 'Append') return n === 1 && (primitiveFormat(p[0]) || p[0] === 'System.Object');
    if (name === 'AppendLine') return n === 0 || n === 1 && p[0] === 'System.String';
    return ['ToString', 'get_Length', 'Clear'].includes(name) && n === 0;
  }
  if (type === 'System.Collections.Generic.List`1') {
    if (name === '.ctor') return n === 0 || n === 1 && p[0] === 'System.Int32';
    if (['get_Count', 'Clear', 'ToArray', 'GetEnumerator'].includes(name)) return n === 0;
    if (['Add', 'Contains', 'IndexOf', 'get_Item'].includes(name)) return n === 1;
    return name === 'set_Item' && n === 2;
  }
  if (type === 'System.Runtime.CompilerServices.DefaultInterpolatedStringHandler') {
    if (name === '.ctor') return n === 2 && p.every(t => t === 'System.Int32');
    if (name === 'AppendLiteral') return n === 1 && p[0] === 'System.String';
    if (name === 'ToStringAndClear') return n === 0;
    return name === 'AppendFormatted' && n >= 1 && n <= 3 && primitiveFormat(ref.genericArguments?.[0] ?? p[0]) && p.slice(1).every(t => ['System.Int32', 'System.String'].includes(t));
  }
  const exact = {
    'System.Object': ['.ctor', 'ReferenceEquals', 'Equals', 'ToString', 'GetType'],
    'System.Console': ['Write', 'WriteLine'],
    'System.String': ['Concat', 'get_Length', 'get_Chars', 'op_Equality', 'op_Inequality', 'Equals', 'IsNullOrEmpty', 'IsNullOrWhiteSpace', 'ToString', 'Substring', 'Contains', 'StartsWith', 'EndsWith', 'Replace', 'ToUpperInvariant', 'ToLowerInvariant', 'Trim', 'Format', 'Join', 'ToCharArray', '.ctor'],
    'System.Math': ['Abs', 'Acos', 'Acosh', 'Asin', 'Asinh', 'Atan', 'Atan2', 'Atanh', 'Cbrt', 'Ceiling', 'Cos', 'Cosh', 'Exp', 'Floor', 'Log', 'Log10', 'Log2', 'Max', 'Min', 'Pow', 'Sin', 'Sinh', 'Sqrt', 'Tan', 'Tanh', 'Truncate', 'Sign', 'Clamp', 'Round'],
    'System.Array': ['get_Length', 'get_Rank', 'Empty', 'GetLength', 'Copy', 'Clear'],
    'System.Type': ['GetTypeFromHandle', 'get_FullName', 'get_Name', 'op_Equality'],
    'System.Text.StringBuilder': ['.ctor', 'Append', 'AppendLine', 'ToString', 'get_Length', 'Clear'],
    'System.Collections.Generic.List`1': ['.ctor', 'Add', 'get_Count', 'get_Item', 'set_Item', 'Clear', 'Contains', 'IndexOf', 'ToArray', 'GetEnumerator'],
    'System.Runtime.CompilerServices.RuntimeHelpers': ['InitializeArray'],
  };
  if (type === 'System.MathF') return exact['System.Math'].includes(name);
  if (exact[type]?.includes(name)) return true;
  if (numeric(type)) return name === 'ToString' && (n === 0 || n === 1 && p[0] === 'System.String') || ['Equals', 'CompareTo', 'IsNaN', 'IsInfinity'].includes(name) && n === 1;
  if (/^System\..*Exception$/.test(type)) return name === '.ctor' && (n === 0 || n === 1 && p[0] === 'System.String' || n === 2 && p[0] === 'System.String' && p[1] === 'System.Exception') || ['get_Message', 'get_InnerException', 'ToString'].includes(name) && n === 0;
  if (/^System\.(Action|Func|Predicate|Comparison)(`\d+)?$/.test(type)) return name === '.ctor' && n === 2 || name === 'Invoke';
  if (type.includes('Enumerator') || type === 'System.IDisposable') return ['MoveNext', 'get_Current', 'Dispose'].includes(name);
  return false;
}

function allMethods(model) {
  return (model.types ?? []).flatMap(type => (type.methods ?? []).map(method => ({ ...method, declaringType: method.declaringType ?? type.name ?? type.fullName })));
}

function externalExists(externals, ref) {
  const has = key => externals instanceof Map ? externals.has(key) : !!externals?.[key];
  return has(methodKey(ref)) || has(`${ref.declaringType}::${ref.name}`);
}

export function analyzeAssembly(model, options = {}) {
  const diagnostics = [];
  if (!model || !Array.isArray(model.types)) throw new ILCompilationError('Expected a normalized assembly model with a types array.');
  const methods = allMethods(model), linked = [...methods, ...(options.assemblies ?? []).flatMap(allMethods)];
  const methodKeys = new Set(linked.map(methodKey)), tokens = new Set(methods.map(method => method.token));
  const fieldKeys = new Set([model, ...(options.assemblies ?? [])].flatMap(assembly => assembly.types.flatMap(type => (type.fields ?? []).map(field => `${field.declaringType ?? type.name}::${field.name}`))));
  const calls = new Map(), instructionCounts = new Map();
  let supportedInstructions = 0, totalInstructions = 0;
  for (const method of linked) {
    const key = methodKey(method), body = bodyOf(method), offsets = new Set(body.map(i => i.offset));
    const add = (code, message, instruction, severity = 'error') => diagnostics.push({ severity, code, method: key, token: method.token, ...(instruction ? { offset: instruction.offset, opcode: opcodeOf(instruction) } : {}), message });
    if (method.decodeError) add('IL_DECODE_ERROR', method.decodeError);
    if (body.length === 0 && !method.isAbstract && !method.isPInvoke && !method.isExternal && !method.isRuntime) add('IL_NO_BODY', 'This method has no decoded IL body.');
    if ((method.isPInvoke || method.pinvoke) && !externalExists(options.externals, method)) add('IL_PINVOKE', 'Native P/Invoke requires an explicitly supplied JavaScript external for this import.');
    if (body.length && offsets.size !== body.length) add('IL_DUPLICATE_OFFSET', 'Method contains duplicate instruction offsets.');
    for (const instruction of body) {
      const op = opcodeOf(instruction); totalInstructions++;
      instructionCounts.set(op, (instructionCounts.get(op) ?? 0) + 1);
      if (isOpcodeSupported(op)) supportedInstructions++;
      else add('IL_UNSUPPORTED_OPCODE', `Opcode '${op}' is not implemented by the JavaScript tier.`, instruction);
      if (branches.test(op)) {
        const target = typeof instruction.operand === 'object' ? instruction.operand.target ?? instruction.operand.offset : instruction.operand;
        if (!offsets.has(Number(target))) add('IL_INVALID_BRANCH', `Branch target ${target} is not an instruction boundary.`, instruction);
      }
      if (op === 'switch' && (!Array.isArray(instruction.operand) || instruction.operand.some(target => !offsets.has(Number(target))))) add('IL_INVALID_SWITCH', 'Switch has an invalid branch target.', instruction);
      if (fields.test(op)) {
        const f = instruction.operand, key = `${f?.declaringType}::${f?.name}`;
        const builtin = isStandardValueField(f) || op === 'ldsfld' && (key === 'System.String::Empty' || key === 'System.Type::EmptyTypes' || ['System.IntPtr::Zero', 'System.UIntPtr::Zero'].includes(key)) || (op === 'ldsfld' || op === 'ldsflda') && isEmitField(f);
        const external = options.externals instanceof Map ? options.externals.get(key) : options.externals?.[key];
        if (!fieldKeys.has(key) && !fieldKeys.has(`${genericDefinitionName(f?.declaringType)}::${f?.name}`) && !builtin && !(external && typeof external.get === 'function')) add('IL_UNRESOLVED_FIELD', `No linked storage or JavaScript external for field '${key}'.`, instruction);
      }
      if (['call', 'callvirt', 'newobj', 'ldftn', 'ldvirtftn', 'jmp'].includes(op)) {
        const ref = instruction.operand;
        if (!ref || typeof ref !== 'object') {
          if (!tokens.has(ref)) add('IL_UNRESOLVED_TOKEN', `Method token ${ref} was not resolved during inspection.`, instruction);
          continue;
        }
        const target = methodKey(ref);
        if (!Array.isArray(ref.parameters)) add('IL_METHOD_SIGNATURE', `Call operand '${target}' must include its parameter signature.`, instruction);
        if (ref.isStatic === undefined && !['newobj', 'ldftn', 'ldvirtftn'].includes(op)) add('IL_METHOD_SIGNATURE', `Call operand '${target}' must specify isStatic.`, instruction);
        if (!methodKeys.has(target) && !linked.some(m => matchesMethodReference(m, ref)) && !externalExists(options.externals, ref)) {
          if (isBuiltinCandidate(ref)) calls.set(target, { method: ref, kind: 'builtin', overloadValidatedAtRuntime: false });
          else { calls.set(target, { method: ref, kind: 'unresolved' }); add('IL_UNRESOLVED_CALL', `No linked implementation or JavaScript external for '${target}'.`, instruction); }
        }
      }
    }
    for (const handler of method.exceptionHandlers ?? []) {
      if (!['catch', 'clause', 'finally', 'fault', 'filter'].includes(String(handler.kind).toLowerCase())) add('IL_EXCEPTION_HANDLER', `Unsupported exception handler kind '${handler.kind}'.`);
      if (!offsets.has(handler.tryOffset) || !offsets.has(handler.handlerOffset)) add('IL_EXCEPTION_BOUNDARY', 'Exception region starts at an invalid instruction boundary.');
      if (String(handler.kind).toLowerCase() === 'filter' && !offsets.has(handler.filterOffset)) add('IL_EXCEPTION_BOUNDARY', 'Exception filter starts at an invalid instruction boundary.');
    }
  }
  const errors = diagnostics.filter(d => d.severity === 'error');
  return {
    assembly: model.name, supported: errors.length === 0, executable: errors.length === 0,
    methods: linked.length, totalInstructions, supportedInstructions,
    opcodes: Object.fromEntries([...instructionCounts].sort(([a], [b]) => a.localeCompare(b))),
    dependencies: [...calls.values()], diagnostics, capabilities,
  };
}

function operandIndex(op, operand) {
  const suffix = op.split('.').at(-1);
  return /^\d+$/.test(suffix) ? Number(suffix) : Number(typeof operand === 'object' ? operand.index : operand);
}

function targetOffset(operand) { return Number(typeof operand === 'object' ? operand.target ?? operand.offset : operand); }

function instructionSource(instruction, next, method, inline = false, filterEntry = false, nextOpcode = '') {
  const op = opcodeOf(instruction), operand = instruction.operand, lit = `$rt.context(${literal(operand)},$f.method)`;
  const go = target => `$pc=${Number(target)};continue;`;
  const advance = inline ? '' : next === null ? 'throw $rt.invalid("Method fell through without ret.");' : go(next);
  const emit = code => `${code}${advance}`;
  if (op === 'nop' || prefixes.has(op)) return advance;
  if (op === 'break') return emit('$rt.options.onBreakpoint?.({method:$f.method,offset:$f.offset});');
  if (op === 'ldnull') return emit('$s.push(null);');
  if (op === 'ldstr') return emit(`$s.push(${literal(operand)});`);
  if (constants.test(op)) {
    if (op.startsWith('ldc.i4')) { const suffix = op.slice(7); const value = suffix === 'm1' ? -1 : /^[0-8]$/.test(suffix) ? Number(suffix) : Number(operand); return emit(`$s.push($rt.i4(${value}));`); }
    const kind = op.split('.')[1];
    if (['r4','r8'].includes(kind) && instruction.operandBits !== undefined) {
      const bits=floatLiteralExecutionBits(kind,parseFloatBits(kind,instruction.operandBits)),value=floatNumberFromBits(kind,bits);
      return emit(Number.isNaN(value)?`$s.push($rt.floatLiteral(${literal(kind)},${bits}n));`:`$s.push($rt.${kind}(${literal(value)}));`);
    }
    return emit(`$s.push($rt.${kind}(${lit}));`);
  }
  if (locals.test(op)) {
    const i = operandIndex(op, operand), arg = op.includes('arg'), list = arg ? '$a' : '$l';
    if (op.startsWith('ldarga') || op.startsWith('ldloca')) return emit(`$s.push($rt.localAddress($f,${i},${arg}));`);
    if (op.startsWith('ld')) return emit(`$s.push($rt.copy(${list}[${i}]));`);
    return emit(`${list}[${i}]=$rt.coerce($s.pop(),$rt.typeContext(${literal(arg ? method.parameters?.[i - (method.isStatic ? 0 : 1)]?.type : method.locals?.[i]?.type ?? method.locals?.[i])},$f.method));`);
  }
  if (op === 'dup') return emit('$s.push($rt.copy($s[$s.length-1]));');
  if (op === 'pop') return emit('$s.pop();');
  if (/^(add|sub|mul|div|rem|and|or|xor|shl|shr)(\.|$)/.test(op)) return emit(`{const b=$s.pop(),a=$s.pop();$s.push($rt.binary(${literal(op)},a,b));}`);
  if (op === 'neg' || op === 'not') return emit(`$s.push($rt.unary(${literal(op)},$s.pop()));`);
  if (op.startsWith('conv.')) {
    const adjacentSingle = op === 'conv.r.un' && nextOpcode === 'conv.r4';
    return emit(`$s.push($rt.convert(${literal(op)},$s.pop()${adjacentSingle ? ',true' : ''}));`);
  }
  if (/^c(eq|gt|lt)(\.|$)/.test(op)) return emit(`{const b=$s.pop(),a=$s.pop();$s.push($rt.i4($rt.compare(${literal(op)},a,b)));}`);
  if (branches.test(op)) {
    const branch = op.replace(/\.s$/, ''), target = targetOffset(operand);
    if (branch === 'br') return go(target);
    if (branch === 'leave') return '$pc=$rt.leave($f,' + target + ');continue;';
    if (branch === 'brtrue' || branch === 'brfalse') return `if($rt.truth($s.pop())${branch === 'brfalse' ? '===false' : ''}){${go(target)}}${advance}`;
    return `{const b=$s.pop(),a=$s.pop();if($rt.compare(${literal(branch)},a,b)){${go(target)}}}${advance}`;
  }
  if (op === 'switch') return `{const i=Number($rt.raw($s.pop())),targets=${lit};if(i>=0&&i<targets.length){$pc=targets[i];continue;}}${advance}`;
  if (['call', 'callvirt', 'newobj'].includes(op)) return emit(`$rt.call($f,${lit},${literal(op)});`);
  if (op === 'jmp') return `return $rt.invokeManaged($rt.resolveMethod(${lit},$f.method.$assembly),$f.method.isStatic?$a:$a.slice(1),$f.method.isStatic?null:$a[0]);`;
  if (op === 'ret') return method.returnType === 'System.Void' || method.returnType === 'void' ? 'return undefined;' : 'return $rt.coerce($s.pop(),$f.method.returnType);';
  if (fields.test(op)) return emit(`$rt.field($f,${lit},${literal(op)});`);
  if (op === 'newarr') return emit(`$s.push($rt.newArray(${`$rt.typeContext(${literal(typeName(operand))},$f.method)`},$s.pop()));`);
  if (op === 'ldlen') return emit('$s.push($rt.i4($rt.nullCheck($s.pop()).items.length));');
  if (arrayOps.test(op)) {
    if (op === 'ldelema') return emit(`{const i=$s.pop(),a=$s.pop();$s.push($rt.arrayAddress(a,i,${`$rt.typeContext(${literal(typeName(operand))},$f.method)`}));}`);
    if (op.startsWith('stelem')) return emit(`{const v=$s.pop(),i=$s.pop(),a=$s.pop();$rt.arrayStore(a,i,v,${literal(op)},${`$rt.typeContext(${literal(typeName(operand))},$f.method)`});}`);
    return emit(`{const i=$s.pop(),a=$s.pop();$s.push($rt.arrayLoad(a,i,${literal(op)},${`$rt.typeContext(${literal(typeName(operand))},$f.method)`}));}`);
  }
  if (indirect.test(op)) {
    if (op.startsWith('st')) return emit(`{const v=$s.pop(),a=$s.pop();$rt.indirectStore(a,v,${literal(op)});}`);
    return emit(`$s.push($rt.indirectLoad($s.pop(),${literal(op)}));`);
  }
  if (op === 'initobj') return emit(`$rt.indirectStore($s.pop(),$rt.defaultValue(${`$rt.typeContext(${literal(typeName(operand))},$f.method)`}),"stobj",${`$rt.typeContext(${literal(typeName(operand))},$f.method)`});`);
  if (op === 'ldobj') return emit(`$s.push($rt.indirectLoad($s.pop(),'ldobj',$rt.typeContext(${literal(typeName(operand))},$f.method)));`);
  if (op === 'stobj') return emit(`{const value=$s.pop(),a=$s.pop();$rt.indirectStore(a,value,"stobj",${`$rt.typeContext(${literal(typeName(operand))},$f.method)`});}`);
  if (op === 'cpobj') return emit(`{const source=$s.pop(),target=$s.pop();$rt.indirectStore(target,$rt.indirectLoad(source,"ldobj",$rt.typeContext(${literal(typeName(operand))},$f.method)),"stobj",${`$rt.typeContext(${literal(typeName(operand))},$f.method)`});}`);
  if (op === 'box') return emit(`$s.push($rt.box($s.pop(),${`$rt.typeContext(${literal(typeName(operand))},$f.method)`}));`);
  if (op === 'unbox' || op === 'unbox.any') return emit(`$s.push($rt.unbox($s.pop(),${`$rt.typeContext(${literal(typeName(operand))},$f.method)`},${op === 'unbox.any'}));`);
  if (op === 'castclass' || op === 'isinst') return emit(`$s.push($rt.cast($s.pop(),${`$rt.typeContext(${literal(typeName(operand))},$f.method)`},${op === 'castclass'}));`);
  if (op === 'ldtoken') return emit(`$s.push(${lit});`);
  if (op === 'sizeof') return emit(`$s.push($rt.sizeOf(${`$rt.typeContext(${literal(typeName(operand))},$f.method)`}));`);
  if (op === 'ldftn' || op === 'ldvirtftn') return emit(`$s.push($rt.functionPointer($f,${lit},${op === 'ldvirtftn'},${op === 'ldvirtftn' ? '$s.pop()' : 'null'}));`);
  if (op === 'localloc') return emit('$s.push($rt.allocateMemory($f,$s.pop()));');
  if (op === 'cpblk') return emit('{const count=$s.pop(),source=$s.pop(),destination=$s.pop();$rt.copyMemory(destination,source,count);}');
  if (op === 'initblk') return emit('{const count=$s.pop(),value=$s.pop(),destination=$s.pop();$rt.initializeMemory(destination,value,count);}');
  if (op === 'mkrefany') return emit(`$s.push($rt.makeTypedReference($s.pop(),$rt.typeContext(${literal(typeName(operand))},$f.method)));`);
  if (op === 'refanyval') return emit(`$s.push($rt.typedReferenceValue($s.pop(),$rt.typeContext(${literal(typeName(operand))},$f.method)));`);
  if (op === 'refanytype') return emit('{const value=$s.pop();if(!value?.$typedReference)throw $rt.invalid("Expected a typed reference.");$s.push({name:value.type});}');
  if (op === 'calli') return emit(`$rt.callIndirect($f,${lit});`);
  if (op === 'throw') return 'throw $rt.nullCheck($s.pop());';
  if (op === 'rethrow') return '$rt.rethrow($f);';
  if (op === 'endfinally') return '$pc=$rt.endFinally($f);continue;';
  if (op === 'endfilter') return (filterEntry ? 'if($filter)return $rt.truth($s.pop());' : '') + '$pc=$rt.endFilter($f,$s.pop());continue;';
  if (op === 'ckfinite') return emit('if(!Number.isFinite(Number($rt.raw($s[$s.length-1]))))throw $rt.arithmeticException();');
  return `throw $rt.unsupported(${literal(op)},$f);`;
}

function referenceMethod(method, blocks) {
  const body = bodyOf(method), filterEntry = (method.exceptionHandlers ?? []).some(handler => String(handler.kind).toLowerCase() === 'filter');
  let source = filterEntry
    ? `function($rt,$args,$self,$method){\nconst $f=$rt.frame($method,$args,$self),$l=$f.locals,$a=$f.args;\nfunction $execute($pc,$filter){const $s=$f.stack;while(true){try{switch($pc){\n`
    : `function($rt,$args,$self,$method){\nconst $f=$rt.frame($method,$args,$self),$s=$f.stack,$l=$f.locals,$a=$f.args;let $pc=${body[0].offset};\ntry{while(true){try{switch($pc){\n`;
  const indices = new Map(body.map((instruction, index) => [instruction.offset, index]));
  for (const block of blocks) {
    source += `case ${block.offset}:{`;
    for (let i = 0; i < block.instructions.length; i++) {
      const instruction = block.instructions[i], index = indices.get(instruction.offset);
      source += `$rt.tick($f,${instruction.offset});${instructionSource(instruction, body[index + 1]?.offset ?? null, method, i + 1 < block.instructions.length, filterEntry, opcodeOf(body[index + 1] ?? {}))}`;
    }
    source += '}\n';
  }
  source += `default:throw $rt.invalid("Invalid instruction offset "+$pc);\n}}catch($error){${filterEntry ? 'if($filter)throw $error;' : ''}$pc=$rt.handleException($f,$error,$f.offset);}}}`;
  if (filterEntry) return source + `$f.evaluateFilter=($offset,$exception)=>{const $stack=$f.stack,$offsetBefore=$f.offset;$f.stack=[$exception];try{return $execute($offset,true);}finally{$f.stack=$stack;$f.offset=$offsetBefore;}};try{return $execute(${body[0].offset},false);}finally{$rt.releaseFrame($f);}}`;
  return source + `finally{$rt.releaseFrame($f);}}`;
}

function methodPlan(method, options) {
  const body = bodyOf(method), name = methodKey(method);
  if (!body.length || method.decodeError) return { source: `function($rt){throw $rt.unsupported(${literal(method.decodeError ?? 'method-without-il-body')},{method:${literal({ name, declaringType: method.declaringType })},offset:0});}`, mode: 'unavailable', blocks: 0, instructions: body.length };
  const blocks = options.optimize === false ? body.map(instruction => ({ offset: instruction.offset, instructions: [instruction] })) : buildBasicBlocks(method);
  const reference = referenceMethod(method, blocks);
  const optimizeNumeric = options.optimize !== false && options.optimize !== 'blocks';
  const int32 = optimizeNumeric ? analyzeInt32Method(method, blocks) : null;
  const numeric = !int32 && optimizeNumeric ? analyzeNumericMethod(method, blocks) : null;
  return { source: int32 ? generateInt32Method(method, int32, reference) : numeric ? generateNumericMethod(method, numeric, reference) : reference,
    mode: int32 ? 'int32' : numeric ? 'numeric' : options.optimize === false ? 'reference' : 'blocks',
    blocks: (int32 ?? numeric)?.blocks.length ?? blocks.length, instructions: body.length };
}

export function generateMethod(method, options = {}) { return methodPlan(method, options).source; }

function prepareSources(model, options) {
  const analysis = analyzeAssembly(model, options);
  if (options.strict && !analysis.supported) throw new ILCompilationError(`Assembly '${model.name}' is not fully supported by the JavaScript tier.`, analysis.diagnostics);
  const optimization = { enabled: options.optimize !== false, mode: options.optimize === false ? 'reference' : options.optimize === 'blocks' ? 'blocks' : 'numeric', methods: 0, numericMethods: 0, basicBlocks: 0, instructions: 0, generatedSourceBytes: 0 };
  const generatedMap = assembly => `\n{${allMethods(assembly).map(method => {
    const plan = methodPlan(method, options);
    optimization.methods++; optimization.numericMethods += plan.mode === 'int32' || plan.mode === 'numeric' ? 1 : 0;
    optimization.basicBlocks += plan.blocks; optimization.instructions += plan.instructions;
    optimization.generatedSourceBytes += plan.source.length * 2;
    return `${literal(String(method.token))}:${plan.source}`;
  }).join(',\n')}\n}`;
  const source = generatedMap(model), linked = (options.assemblies ?? []).map(assembly => ({ model: assembly, source: generatedMap(assembly) }));
  return { model, source, linked, analysis, optimization };
}

function moduleSource(prepared, options) {
  const { model, source, linked, analysis, optimization } = prepared;
  const importPath = options.runtimeImport ?? './runtime.mjs';
  const linkedSource = linked.map(linked => `{model:${literal(linked.model)},compiledMethods:${linked.source}}`).join(',\n');
  return `// Generated from normalized ECMA-335 IL. These method bodies are precompiled JavaScript; explicit runtime-emission APIs still require dynamic-code permission.\nimport {createRuntime} from ${literal(importPath)};\nexport const model=${literal(model)};\nexport const diagnostics=${literal(analysis.diagnostics)};\nexport const optimization=${literal(optimization)};\nexport const compiledMethods=${source};\nexport const linkedAssemblies=[${linkedSource}];\nexport function createAssembly(options={}){const runtime=createRuntime(model,{...options,compiledMethods});for(const linked of linkedAssemblies)runtime.addAssembly(linked.model,linked.compiledMethods);runtime.optimization=optimization;return runtime;}\nexport default createAssembly;\n`;
}

export function generateModule(model, options = {}) { return moduleSource(prepareSources(model, options), options); }

/** Compile reusable JavaScript functions once. Every created runtime owns its
 * globals, virtual files, instruction budget, object heap and output handlers. */
export function compileJavaScriptModule(model, options = {}) {
  const prepared = prepareSources(model, options);
  const compile = source => {
    try { return Function(`"use strict";return (${source})`)(); }
    catch (error) { throw new ILCompilationError(`Could not compile JavaScript for '${model.name}': ${error.message}`, prepared.analysis.diagnostics); }
  };
  const compiledMethods = compile(prepared.source);
  const linked = prepared.linked.map(item => ({ model: item.model, compiledMethods: compile(item.source) }));
  let source;
  const blueprint = {
    model, compiledMethods, linked, analysis: prepared.analysis, optimization: prepared.optimization, generatedSourceBytes: prepared.optimization.generatedSourceBytes,
    get source() { return source ??= moduleSource(prepared, options); },
    createRuntime(runtimeOptions = {}) {
      const runtime = createRuntime(model, { ...options, ...runtimeOptions, compiledMethods });
      for (const item of linked) runtime.addAssembly(item.model, item.compiledMethods);
      runtime.analysis = prepared.analysis; runtime.diagnostics = prepared.analysis.diagnostics; runtime.optimization = prepared.optimization;
      Object.defineProperty(runtime, 'source', { configurable: true, enumerable: true, get: () => blueprint.source });
      return runtime;
    },
  };
  return blueprint;
}

/** Compile all IL methods to real JS functions; unresolved paths throw when reached. */
export function compileAssembly(model, options = {}) { return compileJavaScriptModule(model, options).createRuntime(); }
