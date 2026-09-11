// Control-flow plans used by the JavaScript compiler. The generic block plan does
// not change evaluation order, instruction budgets or exception boundaries.
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
