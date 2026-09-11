// Control-flow plans used by the JavaScript compiler. The generic block plan does
// not change evaluation order, instruction budgets or exception boundaries.
import {parseFloatBits, floatNumberFromBits, floatLiteralExecutionBits} from './float-bits.mjs';
const bodyOf = method => method.body ?? method.instructions ?? [];
const opcode = instruction => String(instruction.opcode ?? instruction.opCode ?? '').toLowerCase();
const branchPattern = /^(br|brtrue|brfalse|beq|bne\.un|bge(?:\.un)?|bgt(?:\.un)?|ble(?:\.un)?|blt(?:\.un)?|leave)(?:\.s)?$/;
const target = operand => Number(operand && typeof operand === 'object' ? operand.target ?? operand.offset : operand);
const terminates = op => branchPattern.test(op) || ['switch', 'ret', 'throw', 'rethrow', 'endfinally', 'endfilter', 'jmp'].includes(op);

export function buildBasicBlocks(method) {
  const body = bodyOf(method);
  if (!body.length) return [];
  const offsets = new Set(body.map(instruction => instruction.offset));
  const leaders = new Set([body[0].offset]);
  for (let i = 0; i < body.length; i++) {
    const instruction = body[i], op = opcode(instruction);
    if (branchPattern.test(op)) leaders.add(target(instruction.operand));
    if (op === 'switch' && Array.isArray(instruction.operand)) for (const offset of instruction.operand) leaders.add(Number(offset));
    if (terminates(op) && i + 1 < body.length) leaders.add(body[i + 1].offset);
  }
  // Normal execution may fall across region boundaries, while an unwind or
  // filter continuation can jump directly to any of these instruction offsets.
  for (const handler of method.exceptionHandlers ?? []) {
    for (const offset of [handler.tryOffset, handler.tryOffset + handler.tryLength, handler.handlerOffset,
      handler.handlerOffset + handler.handlerLength, handler.filterOffset]) if (offsets.has(offset)) leaders.add(offset);
  }
  const blocks = [];
  for (const instruction of body) {
    if (!blocks.length || leaders.has(instruction.offset)) blocks.push({ offset: instruction.offset, instructions: [] });
    blocks.at(-1).instructions.push(instruction);
  }
  return blocks;
}

const intTypes = new Set(['System.Int32', 'System.UInt32', 'System.Boolean', 'System.Byte', 'System.SByte',
  'System.Char', 'System.Int16', 'System.UInt16', 'System.IntPtr', 'System.UIntPtr',
  'int', 'uint', 'bool', 'byte', 'sbyte', 'char', 'short', 'ushort', 'nint', 'nuint']);
const type = item => typeof item === 'string' ? item : item?.type;
const voidType = name => name === 'System.Void' || name === 'void';
const localPattern = /^(ldloc|stloc|ldarg|starg)(?:\.[0-3]|\.s)?$/;
const constantPattern = /^ldc\.i4(?:\.(?:m1|[0-8]|s))?$/;
const binaryPattern = /^(add|sub|mul)(?:\.ovf(?:\.un)?)?$|^(div|rem|shr)(?:\.un)?$|^(and|or|xor|shl)$/;
const comparisonPattern = /^c(eq|gt|lt)(?:\.un)?$/;
const conversionPattern = /^conv\.(?:ovf\.)?(?:i1|u1|i2|u2|i4|u4|i|u)(?:\.un)?$/;
const variableIndex = (op, operand) => /^\d+$/.test(op.split('.').at(-1)) ? Number(op.split('.').at(-1)) : Number(operand && typeof operand === 'object' ? operand.index : operand);

/** A proven i32 evaluation stack for leaf methods. Anything uncertain uses the
 * general compiler, including floating point, Int64, EH, calls and addresses. */
export function analyzeInt32Method(method, blocks = buildBasicBlocks(method)) {
  const body = bodyOf(method), parameters = method.parameters ?? [], locals = method.locals ?? [];
  if (!method.isStatic || !body.length || method.decodeError || method.exceptionHandlers?.length || method.genericParameters?.length ||
    !(intTypes.has(method.returnType) || voidType(method.returnType)) ||
    parameters.some(parameter => !intTypes.has(type(parameter))) || locals.some(local => !intTypes.has(type(local)))) return null;
  const instructions = new Map(body.map(instruction => [instruction.offset, instruction]));
  if (instructions.size !== body.length) return null;
  const next = new Map(body.map((instruction, index) => [instruction.offset, body[index + 1]?.offset]));
  const effects = new Map();
  for (const instruction of body) {
    const op = opcode(instruction); let pop = 0, push = 0, successors = [next.get(instruction.offset)];
    if (op === 'nop') { /* no stack change */ }
    else if (constantPattern.test(op)) push = 1;
    else if (localPattern.test(op)) {
      const index = variableIndex(op, instruction.operand), list = op.includes('arg') ? parameters : locals;
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
      if (op.startsWith('ld')) push = 1; else pop = 1;
    } else if (op === 'dup') { pop = 1; push = 2; }
    else if (op === 'pop') pop = 1;
    else if (binaryPattern.test(op) || comparisonPattern.test(op)) { pop = 2; push = 1; }
    else if (op === 'neg' || op === 'not' || conversionPattern.test(op)) { pop = 1; push = 1; }
    else if (branchPattern.test(op) && !op.startsWith('leave')) {
      const branch = op.replace(/\.s$/, '');
      successors = branch === 'br' ? [target(instruction.operand)] : [target(instruction.operand), ...successors];
      pop = branch === 'br' ? 0 : branch === 'brtrue' || branch === 'brfalse' ? 1 : 2;
    } else if (op === 'switch' && Array.isArray(instruction.operand)) { pop = 1; successors.push(...instruction.operand.map(Number)); }
    else if (op === 'ret') { pop = voidType(method.returnType) ? 0 : 1; successors = []; }
    else return null;
    if (successors.some(offset => offset === undefined || !instructions.has(offset))) return null;
    effects.set(instruction.offset, { pop, push, successors });
  }
  const depths = new Map([[body[0].offset, 0]]), queue = [body[0].offset]; let maxStack = 0;
  for (let head = 0; head < queue.length; head++) {
    const offset = queue[head], depth = depths.get(offset), effect = effects.get(offset);
    if (depth < effect.pop || opcode(instructions.get(offset)) === 'ret' && depth !== effect.pop) return null;
    const after = depth - effect.pop + effect.push; maxStack = Math.max(maxStack, after);
    if (maxStack > 1024) return null;
    for (const successor of effect.successors) {
      if (depths.has(successor)) { if (depths.get(successor) !== after) return null; }
      else { depths.set(successor, after); queue.push(successor); }
    }
  }
  return { blocks: blocks.filter(block => depths.has(block.offset)), depths, maxStack, parameterTypes: parameters.map(type), localTypes: locals.map(type) };
}

function coerceInt32(value, name) {
  if (name === 'System.Byte' || name === 'byte') return `(${value}&255)`;
  if (name === 'System.SByte' || name === 'sbyte') return `((${value}<<24)>>24)`;
  if (name === 'System.Int16' || name === 'short') return `((${value}<<16)>>16)`;
  if (['System.UInt16', 'System.Char', 'ushort', 'char'].includes(name)) return `(${value}&65535)`;
  return value;
}

function compareExpression(op, left, right) {
  if (op.endsWith('.un')) { left = `(${left}>>>0)`; right = `(${right}>>>0)`; }
  const base = op.replace(/\.un$/, '');
  const operator = ({ ceq: '===', cgt: '>', clt: '<', beq: '===', bne: '!==', bge: '>=', bgt: '>', ble: '<=', blt: '<' })[base];
  return `(${left}${operator}${right})`;
}

function numericInstruction(instruction, method, plan) {
  const op = opcode(instruction), operand = instruction.operand, depth = plan.depths.get(instruction.offset);
  const top = `$v${depth - 1}`, below = `$v${depth - 2}`, push = `$v${depth}`;
  const go = offset => `$pc=${offset};continue;`;
  if (op === 'nop') return '';
  if (constantPattern.test(op)) { const suffix = op.slice(7); return `${push}=${suffix === 'm1' ? -1 : /^[0-8]$/.test(suffix) ? Number(suffix) : Number(operand)}|0;`; }
  if (localPattern.test(op)) {
    const index = variableIndex(op, operand), argument = op.includes('arg'), slot = `${argument ? '$a' : '$l'}${index}`;
    return op.startsWith('ld') ? `${push}=${slot};` : `${slot}=${coerceInt32(top, (argument ? plan.parameterTypes : plan.localTypes)[index])};`;
  }
  if (op === 'dup') return `${push}=${top};`;
  if (op === 'pop') return '';
  if (binaryPattern.test(op)) {
    const expressions = { add: `(${below}+${top})|0`, sub: `(${below}-${top})|0`, mul: `Math.imul(${below},${top})`, and: `${below}&${top}`, or: `${below}|${top}`, xor: `${below}^${top}`, shl: `${below}<<${top}`, shr: `${below}>>${top}`, 'shr.un': `(${below}>>>${top})|0` };
    // Rare trapping/checked instructions retain the established runtime helper;
    // hot nontrapping arithmetic avoids Numeric allocations and stack traffic.
    return `${below}=${expressions[op] ?? `$rt.raw($rt.binary(${JSON.stringify(op)},$rt.i4(${below}),$rt.i4(${top})))`};`;
  }
  if (op === 'neg' || op === 'not') return `${top}=${op === 'neg' ? `(-${top})|0` : `~${top}`};`;
  if (conversionPattern.test(op)) {
    const names = { 'conv.i1': 'sbyte', 'conv.u1': 'byte', 'conv.i2': 'short', 'conv.u2': 'ushort' };
    return `${top}=${op.includes('.ovf') ? `$rt.raw($rt.convert(${JSON.stringify(op)},$rt.i4(${top})))` : coerceInt32(top, names[op])};`;
  }
  if (comparisonPattern.test(op)) return `${below}=${compareExpression(op, below, top)}?1:0;`;
  if (branchPattern.test(op)) {
    const branch = op.replace(/\.s$/, ''), destination = target(operand);
    if (branch === 'br') return go(destination);
    const condition = branch === 'brtrue' ? `${top}!==0` : branch === 'brfalse' ? `${top}===0` : compareExpression(branch, below, top);
    return `if(${condition}){${go(destination)}}`;
  }
  if (op === 'switch') return `switch(${top}){${operand.map((offset, index) => `case ${index}:$pc=${Number(offset)};break;`).join('')}default:$pc=${bodyOf(method)[bodyOf(method).indexOf(instruction)+1].offset};}continue;`;
  if (op === 'ret') return voidType(method.returnType) ? 'return undefined;' : `return $rt.i4(${coerceInt32(top, method.returnType)});`;
  throw new Error(`Unexpected Int32 lowering opcode ${op}`);
}

export function generateInt32Method(method, plan, referenceSource) {
  const declarations = [
    ...plan.parameterTypes.map((_, index) => `$a${index}=$rt.raw($args[${index}])`),
    ...plan.localTypes.map((_, index) => `$l${index}=0`),
    ...Array.from({ length: plan.maxStack }, (_, index) => `$v${index}=0`),
    `$pc=${plan.blocks[0].offset}`,
  ];
  // An explicitly supplied raw Numeric value can violate a declared parameter
  // type. Such calls preserve the reference compiler's validation/semantics.
  const guard = plan.parameterTypes.length ? `if($args.length!==${plan.parameterTypes.length}||$args.some(value=>value?.kind!=="i4"))return (${referenceSource})($rt,$args,$self,$method);` : '';
  let source = `function($rt,$args,$self,$method){${guard}const $f=$rt.frame($method,$args,$self),$directTicks=$rt.hasDefaultInstructionTick()&&!$rt.options.signal;let $fastTicks=false,${declarations.join(',')};try{while(true){try{switch($pc){`;
  const body = bodyOf(method), next = new Map(body.map((instruction, index) => [instruction.offset, body[index + 1]?.offset]));
  for (const block of plan.blocks) {
    source += `case ${block.offset}:{$fastTicks=$directTicks&&$rt.instructionCount+${block.instructions.length}<=$rt.maxInstructions;`;
    for (const instruction of block.instructions) source += `if($fastTicks){++$rt.instructionCount;$f.offset=${instruction.offset};}else $rt.tick($f,${instruction.offset});${numericInstruction(instruction, method, plan)}`;
    const last = block.instructions.at(-1), op = opcode(last);
    if (!['ret', 'switch', 'br', 'br.s'].includes(op)) source += `$pc=${next.get(last.offset)};continue;`;
    source += '}';
  }
  return source + 'default:throw $rt.invalid("Invalid instruction offset "+$pc);}}catch($error){$pc=$rt.handleException($f,$error,$f.offset);}}}finally{$rt.releaseFrame($f);}}';
}

const longTypes = new Set(['System.Int64', 'System.UInt64', 'long', 'ulong']);
const numericKind = name => intTypes.has(name) ? 'i4' : longTypes.has(name) ? 'i8' :
  name === 'System.Single' || name === 'float' ? 'r4' : name === 'System.Double' || name === 'double' ? 'r8' : null;
const numericConversion = /^conv\.(?:r\.un|(?:ovf\.)?(?:i1|u1|i2|u2|i4|u4|i8|u8|i|u)(?:\.un)?|r4|r8)$/;
const isFloat = kind => kind === 'r4' || kind === 'r8';
const conversionKind = op => op === 'conv.r.un' ? 'r8' : /\.(?:i8|u8)(?:\.un)?$/.test(op) ? 'i8' :
  op === 'conv.r4' ? 'r4' : op === 'conv.r8' ? 'r8' : 'i4';
const floatConstant = instruction => {
  const kind = opcode(instruction).slice(4);
  return instruction.operandBits === undefined ? kind === 'r4' ? Math.fround(Number(instruction.operand)) : Number(instruction.operand) :
    floatNumberFromBits(kind, floatLiteralExecutionBits(kind, parseFloatBits(kind, instruction.operandBits)));
};

/** Prove the exact evaluation-stack kind at every reachable instruction. Numeric
 * locals remain in JS registers and Int64 values remain BigInts. Ambiguous joins,
 * addresses, managed calls and exception regions keep the general compiler.
 * Floating NaN literals retain their bit-provenance path in the general compiler. */
export function analyzeNumericMethod(method, blocks = buildBasicBlocks(method)) {
  const body = bodyOf(method), parameters = method.parameters ?? [], locals = method.locals ?? [];
  const parameterTypes = parameters.map(type), localTypes = locals.map(type);
  const parameterKinds = parameterTypes.map(numericKind), localKinds = localTypes.map(numericKind), returnKind = numericKind(method.returnType);
  if (!method.isStatic || !body.length || method.decodeError || method.exceptionHandlers?.length || method.genericParameters?.length ||
    !(returnKind || voidType(method.returnType)) || parameterKinds.some(kind => !kind) || localKinds.some(kind => !kind)) return null;
  const instructions = new Map(body.map(instruction => [instruction.offset, instruction]));
  if (instructions.size !== body.length) return null;
  const next = new Map(body.map((instruction, index) => [instruction.offset, body[index + 1]?.offset]));
  for (const instruction of body) {
    const op = opcode(instruction);
    if (!(constantPattern.test(op) || ['ldc.i8', 'ldc.r4', 'ldc.r8', 'nop', 'dup', 'pop', 'neg', 'not', 'ckfinite', 'switch', 'ret'].includes(op) ||
      localPattern.test(op) || binaryPattern.test(op) || comparisonPattern.test(op) || numericConversion.test(op) || branchPattern.test(op) && !op.startsWith('leave'))) return null;
    if (['ldc.r4', 'ldc.r8'].includes(op) && Number.isNaN(floatConstant(instruction))) return null;
  }
  const stacks = new Map([[body[0].offset, []]]), queue = [body[0].offset]; let maxStack = 0;
  for (let head = 0; head < queue.length; head++) {
    const offset = queue[head], instruction = instructions.get(offset), op = opcode(instruction), stack = [...stacks.get(offset)];
    let successors = [next.get(offset)];
    if (op === 'nop') { /* no stack change */ }
    else if (constantPattern.test(op)) stack.push('i4');
    else if (['ldc.i8', 'ldc.r4', 'ldc.r8'].includes(op)) stack.push(op.slice(4));
    else if (localPattern.test(op)) {
      const index = variableIndex(op, instruction.operand), kinds = op.includes('arg') ? parameterKinds : localKinds;
      if (!Number.isInteger(index) || index < 0 || index >= kinds.length) return null;
      if (op.startsWith('ld')) stack.push(kinds[index]);
      else if (stack.pop() !== kinds[index]) return null;
    } else if (op === 'dup') { if (!stack.length) return null; stack.push(stack.at(-1)); }
    else if (op === 'pop') { if (!stack.pop()) return null; }
    else if (binaryPattern.test(op)) {
      const right = stack.pop(), left = stack.pop(), shift = /^(shl|shr)(?:\.un)?$/.test(op);
      if (!left || !right) return null;
      if (shift) { if (!['i4', 'i8'].includes(left) || right !== 'i4') return null; stack.push(left); }
      else if (isFloat(left) && isFloat(right)) {
        if (!['add', 'sub', 'mul', 'div', 'rem'].includes(op)) return null;
        stack.push(left === 'r4' && right === 'r4' ? 'r4' : 'r8');
      } else { if (left !== right || isFloat(left)) return null; stack.push(left); }
    } else if (comparisonPattern.test(op)) {
      const right = stack.pop(), left = stack.pop();
      if (!left || !right || left !== right && !(isFloat(left) && isFloat(right))) return null;
      stack.push('i4');
    } else if (op === 'neg' || op === 'not' || op === 'ckfinite') {
      const kind = stack.at(-1);
      if (!kind || op === 'not' && isFloat(kind) || op === 'ckfinite' && !isFloat(kind)) return null;
    } else if (numericConversion.test(op)) {
      const from = stack.pop();
      if (!from || op === 'conv.r.un' && isFloat(from)) return null;
      stack.push(conversionKind(op));
    } else if (branchPattern.test(op)) {
      const branch = op.replace(/\.s$/, '');
      if (branch === 'br') successors = [target(instruction.operand)];
      else {
        successors.push(target(instruction.operand));
        const right = stack.pop();
        if (branch === 'brtrue' || branch === 'brfalse') { if (!['i4', 'i8'].includes(right)) return null; }
        else { const left = stack.pop(); if (!left || !right || left !== right && !(isFloat(left) && isFloat(right))) return null; }
      }
    } else if (op === 'switch') {
      if (stack.pop() !== 'i4' || !Array.isArray(instruction.operand)) return null;
      successors.push(...instruction.operand.map(Number));
    } else if (op === 'ret') {
      if (returnKind && stack.pop() !== returnKind || stack.length) return null;
      successors = [];
    }
    maxStack = Math.max(maxStack, stack.length);
    if (maxStack > 1024 || successors.some(successor => successor === undefined || !instructions.has(successor))) return null;
    for (const successor of successors) {
      const previous = stacks.get(successor);
      if (previous) { if (previous.length !== stack.length || previous.some((kind, index) => kind !== stack[index])) return null; }
      else { stacks.set(successor, [...stack]); queue.push(successor); }
    }
  }
  const branchTargets = new Set(body.flatMap(instruction => branchPattern.test(opcode(instruction)) ? [target(instruction.operand)] : opcode(instruction) === 'switch' ? instruction.operand.map(Number) : []));
  const singleSources = new Map(), singleInputs = new Map();
  for (let index = 0; index + 1 < body.length; index++) {
    const instruction = body[index], following = body[index + 1];
    if (opcode(instruction) !== 'conv.r.un' || opcode(following) !== 'conv.r4' || stacks.get(instruction.offset)?.at(-1) !== 'i8') continue;
    // A branch into the second instruction can bypass the saved integer source.
    // The general stack compiler handles that shape without speculating provenance.
    if (branchTargets.has(following.offset)) return null;
    singleSources.set(instruction.offset, following.offset); singleInputs.set(following.offset, instruction.offset);
  }
  return {blocks: blocks.filter(block => stacks.has(block.offset)), stacks, maxStack, parameterTypes, parameterKinds, localTypes, localKinds, returnKind, singleSources, singleInputs};
}

const numberLiteral = value => Object.is(value, -0) ? '-0' : String(value);
const wrapRaw = (kind, value) => `$rt.${kind}(${value})`;
const normalizeRaw = (kind, value) => kind === 'i8' ? `BigInt.asIntN(64,${value})` : kind === 'i4' ? `(${value})|0` : kind === 'r4' ? `Math.fround(${value})` : value;

function typedCompare(op, left, right, kind) {
  if (kind === 'i4') return compareExpression(op, left, right);
  const unsigned = op.endsWith('.un');
  if (unsigned && kind === 'i8') { left = `BigInt.asUintN(64,${left})`; right = `BigInt.asUintN(64,${right})`; }
  const base = op.replace(/\.un$/, ''), operator = ({ceq: '===', cgt: '>', clt: '<', beq: '===', bne: '!==', bge: '>=', bgt: '>', ble: '<=', blt: '<'})[base];
  const expression = `(${left}${operator}${right})`;
  return unsigned && isFloat(kind) ? `(Number.isNaN(${left})||Number.isNaN(${right})||${expression})` : expression;
}

function typedConversion(op, value, from) {
  const to = conversionKind(op), suffix = op.replace(/^conv\.(?:ovf\.)?/, '').replace(/\.un$/, '');
  // The runtime owns exact checked bounds and .NET's saturating FP conversions.
  if (op.includes('.ovf.') || isFloat(from) && !isFloat(to)) return `$rt.raw($rt.convert(${JSON.stringify(op)},${wrapRaw(from, value)}))`;
  if (isFloat(to)) {
    if (op === 'conv.r.un') value = from === 'i8' ? `BigInt.asUintN(64,${value})` : `(${value}>>>0)`;
    return to === 'r4' ? from === 'i8' ? `$rt.integerToSingle(${value})` : `Math.fround(Number(${value}))` : `Number(${value})`;
  }
  if (to === 'i8') return from === 'i8' ? value : `BigInt(${op === 'conv.u8' ? `(${value}>>>0)` : value})`;
  const bits = /1$/.test(suffix) ? 8 : /2$/.test(suffix) ? 16 : 32;
  if (from === 'i8') return `Number(BigInt.as${suffix.startsWith('u') && bits < 32 ? 'Uint' : 'Int'}N(${bits},${value}))`;
  return coerceInt32(value, ({i1: 'sbyte', u1: 'byte', i2: 'short', u2: 'ushort'})[suffix]);
}

function typedInstruction(instruction, method, plan) {
  const op = opcode(instruction), operand = instruction.operand, stack = plan.stacks.get(instruction.offset), depth = stack.length;
  const top = `$v${depth - 1}`, below = `$v${depth - 2}`, push = `$v${depth}`, kind = stack.at(-1), leftKind = stack.at(-2);
  const go = offset => `$pc=${offset};continue;`;
  if (op === 'nop') return '';
  if (constantPattern.test(op)) { const suffix = op.slice(7); return `${push}=${suffix === 'm1' ? -1 : /^[0-8]$/.test(suffix) ? Number(suffix) : Number(operand)}|0;`; }
  if (op === 'ldc.i8') return `${push}=${BigInt.asIntN(64, BigInt(operand))}n;`;
  if (op === 'ldc.r4' || op === 'ldc.r8') return `${push}=${numberLiteral(floatConstant(instruction))};`;
  if (localPattern.test(op)) {
    const index = variableIndex(op, operand), argument = op.includes('arg'), slot = `${argument ? '$a' : '$l'}${index}`;
    return op.startsWith('ld') ? `${push}=${slot};` : `${slot}=${coerceInt32(top, (argument ? plan.parameterTypes : plan.localTypes)[index])};`;
  }
  if (op === 'dup') return `${push}=${top};`;
  if (op === 'pop') return '';
  if (binaryPattern.test(op)) {
    if (op.includes('.ovf')) return `${below}=$rt.raw($rt.binary(${JSON.stringify(op)},${wrapRaw(leftKind, below)},${wrapRaw(kind, top)}));`;
    if (/^(div|rem)(?:\.un)?$/.test(op) && !isFloat(leftKind)) {
      const wide = leftKind === 'i8', unsigned = op.endsWith('.un'), zero = wide ? '0n' : '0';
      const failure = `${top}===${zero}${unsigned ? '' : `||(${below}===${wide ? '-9223372036854775808n' : '-2147483648'}&&${top}===${wide ? '-1n' : '-1'})`}`;
      const integer = value => unsigned ? wide ? `BigInt.asUintN(64,${value})` : `(${value}>>>0)` : value;
      const expression = `${integer(below)}${op.startsWith('div') ? '/' : '%'}${integer(top)}`;
      // Only the exceptional edge enters the managed helper. Successful divides
      // and remainders keep their operands and result unboxed, including UInt64.
      return `if(${failure})$rt.binary(${JSON.stringify(op)},${wrapRaw(leftKind, below)},${wrapRaw(kind, top)});${below}=${normalizeRaw(leftKind, wide ? expression : `Math.trunc(${expression})`)};`;
    }
    let expression;
    const operator = ({add: '+', sub: '-', mul: '*', div: '/', rem: '%', and: '&', or: '|', xor: '^'})[op];
    if (operator) expression = op === 'mul' && leftKind === 'i4' ? `Math.imul(${below},${top})` : `${below}${operator}${top}`;
    else if (leftKind === 'i8') expression = `${op === 'shr.un' ? `BigInt.asUintN(64,${below})` : below}${op === 'shl' ? '<<' : '>>'}BigInt(${top}&63)`;
    else expression = `${below}${op === 'shl' ? '<<' : op === 'shr.un' ? '>>>' : '>>'}${top}`;
    const resultKind = isFloat(leftKind) ? leftKind === 'r4' && kind === 'r4' ? 'r4' : 'r8' : leftKind;
    return `${below}=${normalizeRaw(resultKind, expression)};`;
  }
  if (op === 'neg' || op === 'not') return `${top}=${normalizeRaw(kind, `${op === 'neg' ? '-' : '~'}${top}`)};`;
  if (op === 'ckfinite') return `if(!Number.isFinite(${top}))throw $rt.arithmeticException();`;
  if (numericConversion.test(op)) {
    if (plan.singleSources.has(instruction.offset)) return `$uSingle${instruction.offset}=BigInt.asUintN(64,${top});${top}=Number($uSingle${instruction.offset});`;
    if (plan.singleInputs.has(instruction.offset)) return `${top}=$rt.integerToSingle($uSingle${plan.singleInputs.get(instruction.offset)});`;
    return `${top}=${typedConversion(op, top, kind)};`;
  }
  if (comparisonPattern.test(op)) return `${below}=${typedCompare(op, below, top, leftKind)}?1:0;`;
  if (branchPattern.test(op)) {
    const branch = op.replace(/\.s$/, '');
    if (branch === 'br') return go(target(operand));
    const condition = branch === 'brtrue' ? `${top}!==${kind === 'i8' ? '0n' : '0'}` : branch === 'brfalse' ? `${top}===${kind === 'i8' ? '0n' : '0'}` : typedCompare(branch, below, top, leftKind);
    return `if(${condition}){${go(target(operand))}}`;
  }
  if (op === 'switch') return `switch(${top}){${operand.map((offset, index) => `case ${index}:$pc=${Number(offset)};break;`).join('')}default:$pc=${bodyOf(method)[bodyOf(method).indexOf(instruction)+1].offset};}continue;`;
  if (op === 'ret') return plan.returnKind ? `return ${wrapRaw(plan.returnKind, coerceInt32(top, method.returnType))};` : 'return undefined;';
  throw new Error(`Unexpected numeric lowering opcode ${op}`);
}

export function generateNumericMethod(method, plan, referenceSource) {
  const declarations = [
    ...plan.parameterTypes.map((_, index) => `$a${index}=$rt.raw($args[${index}])`),
    ...plan.localKinds.map((kind, index) => `$l${index}=${kind === 'i8' ? '0n' : '0'}`),
    ...[...plan.singleSources.keys()].map(offset => `$uSingle${offset}=0n`),
    ...Array.from({length: plan.maxStack}, (_, index) => `$v${index}=0`), `$pc=${plan.blocks[0].offset}`,
  ];
  // Provenance-bearing/NaN input takes the general path, preserving exact NaN
  // payloads through transfers and negation. Custom ticks can inspect frame state.
  const parametersGuard = plan.parameterKinds.map((kind, index) => `$args[${index}]?.kind!==${JSON.stringify(kind)}${isFloat(kind) ? `||$args[${index}].floatBits!==undefined||Number.isNaN($args[${index}].value)` : ''}`);
  const guard = `if(!$rt.hasDefaultInstructionTick()||$args.length!==${plan.parameterKinds.length}${parametersGuard.length ? `||${parametersGuard.join('||')}` : ''})return (${referenceSource})($rt,$args,$self,$method);`;
  let source = `function($rt,$args,$self,$method){${guard}const $f=$rt.frame($method,$args,$self),$directTicks=!$rt.options.signal;let $fastTicks=false,${declarations.join(',')};try{while(true){try{switch($pc){`;
  const body = bodyOf(method), next = new Map(body.map((instruction, index) => [instruction.offset, body[index + 1]?.offset]));
  for (const block of plan.blocks) {
    source += `case ${block.offset}:{$fastTicks=$directTicks&&$rt.instructionCount+${block.instructions.length}<=$rt.maxInstructions;`;
    for (const instruction of block.instructions) source += `if($fastTicks){++$rt.instructionCount;$f.offset=${instruction.offset};}else $rt.tick($f,${instruction.offset});${typedInstruction(instruction, method, plan)}`;
    const last = block.instructions.at(-1), op = opcode(last);
    if (!['ret', 'switch', 'br', 'br.s'].includes(op)) source += `$pc=${next.get(last.offset)};continue;`;
    source += '}';
  }
  return source + 'default:throw $rt.invalid("Invalid instruction offset "+$pc);}}catch($error){$pc=$rt.handleException($f,$error,$f.offset);}}}finally{$rt.releaseFrame($f);}}';
}
