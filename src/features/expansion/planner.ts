import { completionMs, members, totalCount, type Assignment, type Plan } from './types';
import { finishPlanning } from '../../runtime/planning';

// All jobs have the same capture horizon: longest trips have the earliest launch deadlines.
export function schedule(jobs: Assignment[], interval: number, horizon: number): Assignment[] | null {
  const ordered = [...jobs].sort((a, b) => completionMs(b) - completionMs(a) || (a.targetId < b.targetId ? -1 : 1));
  return ordered.every((job, i) => i * interval + completionMs(job) <= horizon) ? ordered : null;
}
function better(a: Assignment[], b: Assignment[], rapid = false): boolean {
  if (a.length !== b.length) return a.length > b.length;
  const fleets = (jobs: Assignment[]) => jobs.reduce((n, j) => n + members(j).length, 0);
  if (fleets(a) !== fleets(b)) return fleets(a) < fleets(b);
  const travel = (jobs: Assignment[]) => jobs.reduce((sum, j) => sum + completionMs(j), 0);
  if (rapid && travel(a) !== travel(b)) return travel(a) < travel(b);
  const value = (jobs: Assignment[]) => jobs.reduce((sum, j) => sum + (j.value ?? 0), 0);
  if (value(a) !== value(b)) return value(a) > value(b);
  const sum = (jobs: Assignment[], key: 'count' | 'travelMs') => jobs.reduce((total, j) => total + (key === 'count' ? totalCount(j) : completionMs(j)), 0);
  return sum(a, 'count') < sum(b, 'count') || (sum(a, 'count') === sum(b, 'count') && sum(a, 'travelMs') < sum(b, 'travelMs'));
}
export function planExpansion(edges: Assignment[], budgets: Map<bigint, number>, interval: number, horizon: number, maxTravelMs?: number): Plan {
  return finishPlanning(expansionPlanSteps(edges, budgets, interval, horizon, maxTravelMs));
}
export function* expansionPlanSteps(edges: Assignment[], budgets: Map<bigint, number>, interval: number, horizon: number, maxTravelMs?: number): Generator<void, Plan> {
  // Both modes pass a journey cap and use an independent dispatch window.
  // Omitting the cap retains the legacy arrival-deadline API for existing callers.
  const rapid = maxTravelMs !== undefined;
  const order = (jobs: Assignment[]) => {
    if (!rapid) return schedule(jobs, interval, horizon);
    if ((jobs.length - 1) * interval > horizon) return null;
    return [...jobs].sort((a, b) => completionMs(a) - completionMs(b) || (a.targetId < b.targetId ? -1 : 1));
  };
  const targets = new Map<bigint, Assignment[]>();
  for (const [index, edge] of edges.entries()) {
    if (index % 128 === 0) yield;
    const contributions = members(edge);
    if (contributions.length > 3 || new Set(contributions.map(m => m.sourceId)).size !== contributions.length) continue;
    if (contributions.some(m => !Number.isSafeInteger(m.count) || m.count < 1 || !Number.isFinite(m.travelMs) || m.travelMs < 0 || m.travelMs > (maxTravelMs ?? horizon) || m.count > (budgets.get(m.sourceId) ?? 0))) continue;
    const options = targets.get(edge.targetId) ?? [];
    options.push(edge); targets.set(edge.targetId, options);
  }
  let groups = [...targets.values()];
  const pruned = groups.length > 128 || edges.length > 1000;
  if (pruned) {
    const rank = (job: Assignment) => rapid ? 1 / (1 + completionMs(job)) : (1 + (job.value ?? 0)) / (totalCount(job) * (1 + completionMs(job) / horizon));
    const reduced: Assignment[][] = [];
    for (const options of groups) {
      yield;
      reduced.push(options.sort((a, b) => members(a).length - members(b).length || rank(b) - rank(a)).slice(0, 8));
    }
    groups = reduced.sort((a, b) => rank(b[0]) - rank(a[0])).slice(0, 128);
  }
  for (const group of groups) {
    yield;
    group.sort((a, b) => members(a).length - members(b).length || (rapid ? completionMs(a) - completionMs(b) : 0) || totalCount(a) - totalCount(b) || completionMs(a) - completionMs(b));
  }
  groups.sort((a, b) => a.length - b.length || completionMs(a[0]) - completionMs(b[0]));
  let best: Assignment[] = [];
  // Multiple bounded greedy passes provide a useful incumbent before branch and bound.
  for (const ordered of [groups, [...groups].sort((a, b) => totalCount(a[0]) - totalCount(b[0])), [...groups].sort((a, b) => completionMs(a[0]) - completionMs(b[0]))]) {
    const left = new Map(budgets), jobs: Assignment[] = [];
    for (const options of ordered) {
      yield;
      for (const job of options) {
        if (members(job).some(m => m.count > (left.get(m.sourceId) ?? 0)) || !order([...jobs, job])) continue;
        jobs.push(job); for (const m of members(job)) left.set(m.sourceId, left.get(m.sourceId)! - m.count); break;
      }
    }
    if (better(jobs, best, rapid)) best = jobs;
  }
  let exact = !pruned && groups.length <= 18 && edges.length <= 100;
  if (exact) {
    let visited = 0;
    const left = new Map(budgets), jobs: Assignment[] = [];
    const walk = function* (index: number): Generator<void> {
      if (++visited > 20000) { exact = false; return; }
      if (visited % 64 === 0) yield;
      if (better(jobs, best, rapid)) best = [...jobs];
      if (index === groups.length || jobs.length + groups.length - index < best.length) return;
      for (const job of groups[index]) {
        const contributions = members(job);
        if (contributions.some(m => m.count > (left.get(m.sourceId) ?? 0)) || !order([...jobs, job])) continue;
        jobs.push(job);
        for (const m of contributions) left.set(m.sourceId, left.get(m.sourceId)! - m.count);
        yield* walk(index + 1);
        jobs.pop();
        for (const m of contributions) left.set(m.sourceId, left.get(m.sourceId)! + m.count);
        if (!exact) return;
      }
      yield* walk(index + 1);
    };
    yield* walk(0);
  }
  return { jobs: order(best) ?? [], exact };
}
