import { completionMs, members, totalCount, type Assignment, type Plan } from './types';

// All jobs have the same capture horizon: longest trips have the earliest launch deadlines.
export function schedule(jobs: Assignment[], interval: number, horizon: number): Assignment[] | null {
  const ordered = [...jobs].sort((a, b) => completionMs(b) - completionMs(a) || (a.targetId < b.targetId ? -1 : 1));
  return ordered.every((job, i) => i * interval + completionMs(job) <= horizon) ? ordered : null;
}
function better(a: Assignment[], b: Assignment[]): boolean {
  if (a.length !== b.length) return a.length > b.length;
  const sum = (jobs: Assignment[], key: 'count' | 'travelMs') => jobs.reduce((total, j) => total + (key === 'count' ? totalCount(j) : completionMs(j)), 0);
  return sum(a, 'travelMs') < sum(b, 'travelMs') || (sum(a, 'travelMs') === sum(b, 'travelMs') && sum(a, 'count') < sum(b, 'count'));
}
export function planExpansion(edges: Assignment[], budgets: Map<bigint, number>, interval: number, horizon: number): Plan {
  const targets = new Map<bigint, Assignment[]>();
  for (const edge of edges) {
    const contributions = members(edge);
    if (contributions.length > 3 || new Set(contributions.map(m => m.sourceId)).size !== contributions.length) continue;
    if (contributions.some(m => !Number.isSafeInteger(m.count) || m.count < 1 || !Number.isFinite(m.travelMs) || m.travelMs < 0 || m.travelMs > horizon || m.count > (budgets.get(m.sourceId) ?? 0))) continue;
    const options = targets.get(edge.targetId) ?? [];
    options.push(edge); targets.set(edge.targetId, options);
  }
  const groups = [...targets.values()];
  for (const group of groups) group.sort((a, b) => totalCount(a) - totalCount(b) || completionMs(a) - completionMs(b));
  groups.sort((a, b) => a.length - b.length || completionMs(a[0]) - completionMs(b[0]));
  let best: Assignment[] = [];
  // Multiple bounded greedy passes provide a useful incumbent before branch and bound.
  for (const ordered of [groups, [...groups].sort((a, b) => totalCount(a[0]) - totalCount(b[0])), [...groups].sort((a, b) => completionMs(a[0]) - completionMs(b[0]))]) {
    const left = new Map(budgets), jobs: Assignment[] = [];
    for (const options of ordered) {
      for (const job of options) {
        if (members(job).some(m => m.count > (left.get(m.sourceId) ?? 0)) || !schedule([...jobs, job], interval, horizon)) continue;
        jobs.push(job); for (const m of members(job)) left.set(m.sourceId, left.get(m.sourceId)! - m.count); break;
      }
    }
    if (better(jobs, best)) best = jobs;
  }
  let exact = groups.length <= 18 && edges.length <= 100;
  if (exact) {
    let visited = 0;
    const left = new Map(budgets), jobs: Assignment[] = [];
    const walk = (index: number) => {
      if (++visited > 20000) { exact = false; return; }
      if (better(jobs, best)) best = [...jobs];
      if (index === groups.length || jobs.length + groups.length - index < best.length) return;
      for (const job of groups[index]) {
        const contributions = members(job);
        if (contributions.some(m => m.count > (left.get(m.sourceId) ?? 0)) || !schedule([...jobs, job], interval, horizon)) continue;
        jobs.push(job);
        for (const m of contributions) left.set(m.sourceId, left.get(m.sourceId)! - m.count);
        walk(index + 1);
        jobs.pop();
        for (const m of contributions) left.set(m.sourceId, left.get(m.sourceId)! + m.count);
        if (!exact) return;
      }
      walk(index + 1);
    };
    walk(0);
  }
  return { jobs: schedule(best, interval, horizon) ?? [], exact };
}
