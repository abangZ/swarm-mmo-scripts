/** Stable top-k selection. Rank each item once; never sort the entire neighborhood. */
export function bestCandidates<T>(items: readonly T[], limit: number, rank: (item: T) => number): T[] {
  interface Entry { item: T; score: number; index: number }
  const heap: Entry[] = [];
  const compare = (a: Entry, b: Entry) => a.score - b.score || a.index - b.index;
  if (limit <= 0) return [];
  if (limit >= items.length) return items.map((item, index) => ({ item, index, score: rank(item) })).sort(compare).map(entry => entry.item);
  for (let index = 0; index < items.length; index++) {
    const entry = { item: items[index], score: rank(items[index]), index };
    if (heap.length < limit) {
      let at = heap.length; heap.push(entry);
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (compare(heap[parent], entry) >= 0) break;
        heap[at] = heap[parent]; at = parent;
      }
      heap[at] = entry;
    } else if (compare(entry, heap[0]) < 0) {
      let at = 0;
      while (at * 2 + 1 < heap.length) {
        let child = at * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
        if (compare(entry, heap[child]) >= 0) break;
        heap[at] = heap[child]; at = child;
      }
      heap[at] = entry;
    }
  }
  return heap.sort(compare).map(entry => entry.item);
}
