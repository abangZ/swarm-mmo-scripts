import type { Planet } from '../../game/types';
import type { ExpansionWorld, WorldSnapshot } from '../expansion/world';
import { fleetsFor } from '../expansion/world';
import { captureMargin, type Assignment } from '../expansion/types';
import { planExpansion } from '../expansion/planner';
import type { ModeConfig } from '../commander/types';
import { inZone } from '../commander/types';
import { hostile } from '../commander/safety';
import { distance } from '../../shared/distance';
import { validRoute } from '../expansion/cooperation';
import { PlanetIndex } from '../../shared/planet-index';

export interface AttackPlan { job?: Assignment; jobs?: Assignment[]; exact?: boolean; saving?: Assignment; candidates: number; waiting: string }
export function attackTarget(p: Planet, snapshot: WorldSnapshot, config: ModeConfig): boolean {
  return inZone(p, config.policy.zone) && hostile(p, snapshot) && (!config.policy.enemy || p.ownerId!.toHexString() === config.policy.enemy);
}
export function attackQuote(world: ExpansionWorld, snapshot: WorldSnapshot, source: Planet, target: Planet, config: ModeConfig, estimate = false): Assignment | null {
  if (!snapshot.intelligence || !attackTarget(target, snapshot, config) || !inZone(source, config.policy.zone) || distance(source, target) > config.settings.radius) return null;
  const route = world.route?.(source.planetId, target.planetId);
  if (!validRoute(route) || route.travelMs > config.settings.horizonMs) return null;
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
    count = Math.ceil(((target.probeCount + ticks * level!) * 2 + 1 + captureMargin) * 100 / (100 - route.lossPct)) + extra;
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 0xffffffff) return null;
  const near = distance(source, target);
  const value = (2 * level! + 8 / (1 + near)) / (count * (1 + route.travelMs / 60000));
  return { sourceId: source.planetId, targetId: target.planetId, count, travelMs: route.travelMs, value };
}
export function planAttack(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>): AttackPlan {
  if (!snapshot.intelligence) throw new Error('缺少敌我关系或舰队情报，进攻未执行。');
  const targets = snapshot.planets.filter(p => attackTarget(p, snapshot, config) && !locked.has(p.planetId) && !snapshot.incoming.has(p.planetId) && !fleetsFor(snapshot, p.planetId).length);
  const index = new PlanetIndex(targets);
  const jobs: Assignment[] = [], savings: Assignment[] = [];
  const candidates = new Set<bigint>();
  for (const source of snapshot.owned.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId))) {
    const nearby = index.near(source, config.settings.radius);
    const sorted = [
      [...nearby].sort((a, b) => distance(source, a) - distance(source, b)),
      [...nearby].sort((a, b) => (b.level ?? 1) / (b.probeCount + 1) - (a.level ?? 1) / (a.probeCount + 1)),
    ];
    const picked = new Map<bigint, Planet>();
    for (let i = 0; picked.size < config.settings.candidates && i < nearby.length; i++) for (const order of sorted) {
      if (order[i] && picked.size < config.settings.candidates) picked.set(order[i].planetId, order[i]);
    }
    for (const target of picked.values()) {
      candidates.add(target.planetId);
      const job = attackQuote(world, snapshot, source, target, config, true);
      if (!job) continue;
      const budget = budgets.get(source.planetId) ?? 0;
      if (job.count <= budget && world.quote(source.planetId, target.planetId)) jobs.push(job);
      // Only reserve for an attainable short wait; natural level production is a lower bound.
      else if (source.level && job.count <= budget + source.level * 2) savings.push(job);
    }
  }
  const order = (a: Assignment, b: Assignment) => (b.value ?? 0) - (a.value ?? 0) || a.travelMs - b.travelMs || (a.targetId < b.targetId ? -1 : 1);
  const sourceCount = snapshot.owned.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId)).length;
  const fleetTargets = targets.filter(p => snapshot.incoming.has(p.planetId) || fleetsFor(snapshot, p.planetId).length).length;
  const waiting = !sourceCount ? '战区内没有可出兵的己方星球；原生自动化来源不参与'
    : !targets.length ? '战区内没有符合敌人筛选且未锁定的目标'
    : `暂无可执行攻击：${candidates.size} 个候选，${fleetTargets} 个目标有在途舰队；${sourceCount} 颗来源可用兵力 ${snapshot.owned.filter(p => inZone(p, config.policy.zone)).reduce((n, p) => n + (budgets.get(p.planetId) ?? 0), 0)}，继续等待兵力或航线条件`;
  const plan = planExpansion(jobs, budgets, config.settings.intervalMs, config.settings.horizonMs);
  // Schedule all affordable direct captures together, not just the highest-scored edge.
  return { job: plan.jobs[0], jobs: plan.jobs, exact: plan.exact, saving: savings.sort(order)[0], candidates: candidates.size, waiting };
}
