export interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
}

/** Bound the comparison cost for long notes while preserving every changed line. */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  const result: DiffLine[] = left.slice(0, start).map(text => ({ kind: "same", text }));
  const a = left.slice(start, left.length - end);
  const b = right.slice(start, right.length - end);
  if (a.length * b.length <= 160_000) {
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lengths[i * width + j] = a[i] === b[j]
          ? 1 + lengths[(i + 1) * width + j + 1]!
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        result.push({ kind: "same", text: a[i++]! }); j++;
      } else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
        result.push({ kind: "removed", text: a[i++]! });
      } else {
        result.push({ kind: "added", text: b[j++]! });
      }
    }
  } else {
    for (const text of a) result.push({ kind: "removed", text });
    for (const text of b) result.push({ kind: "added", text });
  }
  for (const text of left.slice(left.length - end)) result.push({ kind: "same", text });
  return result;
}

export function diffContext(lines: DiffLine[], context = 3): Array<DiffLine | { kind: "omitted"; count: number }> {
  const result: Array<DiffLine | { kind: "omitted"; count: number }> = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind !== "same") { result.push(lines[index++]!); continue; }
    let end = index;
    while (end < lines.length && lines[end]!.kind === "same") end++;
    const head = index > 0 ? Math.min(context, end - index) : 0;
    const tail = end < lines.length ? Math.min(context, end - index - head) : 0;
    result.push(...lines.slice(index, index + head));
    if (end - index > head + tail) result.push({ kind: "omitted", count: end - index - head - tail });
    result.push(...lines.slice(end - tail, end));
    index = end;
  }
  return result;
}
