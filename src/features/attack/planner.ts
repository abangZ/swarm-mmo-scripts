import type { Planet } from '../../game/types';
import type { ExpansionWorld, WorldSnapshot } from '../expansion/world';
import { fleetsFor } from '../expansion/world';
import { captureMargin, type Assignment } from '../expansion/types';
import { expansionPlanSteps } from '../expansion/planner';
import type { ModeConfig } from '../commander/types';
import { inZone } from '../commander/types';
import { hostile } from '../commander/safety';
import { distance } from '../../shared/distance';
import { validRoute } from '../expansion/cooperation';
import { PlanetIndex } from '../../shared/planet-index';

import { finishPlanning } from '../../runtime/planning';
import { attackCandidates } from './candidates';
import type { AttackDiagnostics } from './diagnostics';

export interface AttackPlan { diagnostics?: AttackDiagnostics; job?: Assignment; jobs?: Assignment[]; exact?: boolean; saving?: Assignment; candidates: number; waiting: string }
export function attackTarget(p: Planet, snapshot: WorldSnapshot, config: ModeConfig): boolean {
  return inZone(p, config.policy.zone) && hostile(p, snapshot) && (!config.policy.enemy || p.ownerId!.toHexString() === config.policy.enemy);
}
export function attackQuote(world: ExpansionWorld, snapshot: WorldSnapshot, source: Planet, target: Planet, config: ModeConfig, estimate = false): Assignment | null {
  if (!snapshot.intelligence || !attackTarget(target, snapshot, config) || !inZone(source, config.policy.zone) || distance(source, target) > config.settings.radius) return null;
  const route = world.route?.(source.planetId, target.planetId);
  if (!validRoute(route) || route.travelMs > config.settings.maxTravelMs) return null;
  // A single-source attack does not speculate about other battles or ownership changes.
  if (snapshot.incoming.has(target.planetId) || fleetsFor(snapshot, target.planetId).length) return null;
  const quote = world.quote(source.planetId, target.planetId);
  const level = target.level;
  if (!Number.isInteger(level) || level! < 1 || level! > 10) return null;
  // Cover one extra production tick (including maximum Defense), plus occupation garrison.
  const extra = Math.ceil((level! * 2 + config.policy.holdProbes) * 100 / (100 - route.lossPct));
  let count = quote ? quote.count + extra : NaN;
  if (!quote && estimate) {
    const updated = Number(target.lastUpdateTick?.toMillis());
    if (!Number.isFinite(updated)) return null;
    const ticks = Math.ceil((Math.max(0, Date.now() - updated) + route.travelMs) / 40000);
    count = Math.ceil(((target.probeCount + ticks * level!) * 2 + captureMargin) * 100 / (100 - route.lossPct)) + extra;
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 0xffffffff) return null;
  const near = distance(source, target);
  const value = (2 * level! + 8 / (1 + near)) / (count * (1 + route.travelMs / 60000));
  return { sourceId: source.planetId, targetId: target.planetId, count, travelMs: route.travelMs, value };
}
export function planAttack(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>): AttackPlan {
  return finishPlanning(attackPlanSteps(world, snapshot, config, budgets, locked));
}
export function* attackPlanSteps(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>): Generator<void, AttackPlan> {
  if (!snapshot.intelligence) throw new Error('缺少敌我关系或舰队情报，进攻未执行。');
  const allTargets = snapshot.planets.filter(p => attackTarget(p, snapshot, config));
  const targets = allTargets.filter(p => !locked.has(p.planetId) && !snapshot.incoming.has(p.planetId) && !fleetsFor(snapshot, p.planetId).length);
  const sources = snapshot.owned.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId));
  const diagnostics: AttackDiagnostics = { sources: sources.length, available: sources.reduce((n, p) => n + (budgets.get(p.planetId) ?? 0), 0), targets: allTargets.length,
    blocked: allTargets.length - targets.length, noBudget: 0, noTargets: 0, tooSlow: 0, noQuote: 0, insufficient: 0, feasible: 0 };
  const index = new PlanetIndex(targets), jobs: Assignment[] = [], savings: Assignment[] = [];
  const candidates = new Set<bigint>();
  for (const source of sources) {
    yield;
    const budget = budgets.get(source.planetId) ?? 0;
    if (budget <= 0) { diagnostics.noBudget++; continue; }
    const picked = attackCandidates(source, index.near(source, config.settings.radius), Math.max(32, config.settings.candidates * 8));
    if (!picked.length) diagnostics.noTargets++;
    const feasible: Assignment[] = [];
    let evaluated = 0;
    for (const target of picked) {
      yield;
      evaluated++;
      candidates.add(target.planetId);
      const route = world.route?.(source.planetId, target.planetId);
      if (validRoute(route) && route.travelMs > config.settings.maxTravelMs) { diagnostics.tooSlow++; continue; }
      const job = attackQuote(world, snapshot, source, target, config, true);
      if (!job) { diagnostics.noQuote++; continue; }
      if (job.count <= budget && world.quote(source.planetId, target.planetId)) { feasible.push(job); diagnostics.feasible++; }
      else {
        diagnostics.insufficient++;
        if (source.level && job.count <= budget + source.level * 2) savings.push(job);
      }
      if (feasible.length >= config.settings.candidates && evaluated >= config.settings.candidates * 2) break;
    }
    jobs.push(...feasible.sort((a, b) => a.travelMs - b.travelMs || a.count - b.count).slice(0, config.settings.candidates));
  }
  const order = (a: Assignment, b: Assignment) => (b.value ?? 0) - (a.value ?? 0) || a.travelMs - b.travelMs || (a.targetId < b.targetId ? -1 : 1);
  const waiting = !sources.length ? '战区内没有可出兵的己方星球；请同时覆盖己方兵源与敌方目标'
    : !allTargets.length ? '战区内没有符合敌人筛选的目标'
    : !targets.length ? `战区内 ${allTargets.length} 个敌方目标均有在途舰队或已锁定，等待战况更新`
    : `暂无可执行直攻：可用 ${diagnostics.available} 兵；${diagnostics.noBudget} 颗来源无预算，${diagnostics.noTargets} 颗来源在最大搜索距离内无可选目标；检查路线中 ${diagnostics.tooSlow} 条航时超限、${diagnostics.insufficient} 条兵力不足、${diagnostics.noQuote} 条报价不可用`;
  const plan = yield* expansionPlanSteps(jobs, budgets, config.settings.intervalMs, config.settings.horizonMs, config.settings.maxTravelMs);
  return { job: plan.jobs[0], jobs: plan.jobs, exact: plan.exact, saving: savings.sort(order)[0], candidates: candidates.size, waiting, diagnostics };
}
