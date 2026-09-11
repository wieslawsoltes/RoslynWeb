/** Plan a conservative, structured native control-flow layout.
 * Reverse postorder puts loop headers before their bodies. Reducible intervals
 * become Wasm loops; graphs needing entries inside a loop keep the dispatcher.
 * No IL is removed or duplicated, so block-based instruction fuel is unchanged.
 */
export function planStructuredControlFlow(blocks) {
  // Try both deterministic successor orders. A branch may encode its loop exit
  // as either taken or fall-through; this keeps nested loop intervals compact.
  return planLayout(blocks,false) ?? planLayout(blocks,true);
}
function planLayout(blocks, reverseSuccessors) {
  if (!blocks.length) return null;
  const byOffset = new Map(blocks.map(block => [block.offset, block]));
  const visited = new Set(), postorder = [];
  // Iterative traversal avoids overflowing the JS stack on generated methods.
  const pending = [{offset: blocks[0].offset, exit: false}];
  while (pending.length) {
    const item = pending.pop();
    if (item.exit) { postorder.push(byOffset.get(item.offset)); continue; }
    if (visited.has(item.offset)) continue;
    const block = byOffset.get(item.offset);
    if (!block) return null;
    visited.add(item.offset); pending.push({offset: item.offset, exit: true});
    const successors = [...(block.successors ?? [])];
    if (reverseSuccessors) successors.reverse();
    for (const successor of successors) {
      if (!visited.has(successor)) pending.push({offset: successor, exit: false});
    }
  }
  if (visited.size !== blocks.length) return null;
  const ordered = postorder.reverse(), position = new Map(ordered.map((block, index) => [block.offset, index]));
  const loops = new Map();
  for (let source = 0; source < ordered.length; source++) {
    for (const target of ordered[source].successors ?? []) {
      const header = position.get(target);
      if (header === undefined) return null;
      if (header <= source) loops.set(header, Math.max(loops.get(header) ?? header, source));
    }
  }
  const intervals = [...loops].sort((a, b) => a[0] - b[0]);
  for (let n = 0; n < intervals.length; n++) {
    const [header, end] = intervals[n];
    for (let j = n + 1; j < intervals.length; j++) {
      const [inner, last] = intervals[j];
      if (inner > end) break;
      if (last > end) return null; // Crossing loop intervals need a dispatcher.
    }
    for (let source = 0; source < ordered.length; source++) {
      if (source >= header && source <= end) continue;
      for (const target of ordered[source].successors ?? []) {
        const index = position.get(target);
        if (index > header && index <= end) return null;
      }
    }
  }
  return {blocks: ordered, loops, originalNext: new Map(blocks.map((block, n) => [block.offset, blocks[n + 1]?.offset]))};
}
