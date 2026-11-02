import type { Planet } from '../../game/types';
import { distance } from '../../shared/distance';
import { PlanetIndex } from '../../shared/planet-index';
import { inZone, type ModeConfig } from '../commander/types';
import { arriving, validRoute, type Route } from '../expansion/cooperation';
import { members, type Assignment, type Contribution } from '../expansion/types';
import { fleetsFor, type ExpansionWorld, type WorldSnapshot } from '../expansion/world';
import type { ExpansionState } from '../expansion/engine';
import { attackQuote, attackTarget, planAttack, type AttackPlan } from './planner';

export const rallyBatchSize = 50;
const maxDonors = 1000;
interface Campaign { hub: bigint; target: bigint; deadline: number }
interface Donor extends Route { planet: Planet; available: number }
export interface Supply { count: number; arrival: number }
export interface RallyGuard { percent: number; deficit: number }
export interface OffensivePlan extends AttackPlan {
  next?: Assignment;
  rally?: Assignment;
  rallyState?: ExpansionState['rally'];
  reservations: Map<bigint, number>;
}
interface Gathering { job?: Assignment; reservations: Map<bigint, number>; state: NonNullable<ExpansionState['rally']>; complete: boolean; waitMs: number }

/** Friendly reinforcement is unlimited in source count; enemy combat remains one single fleet. */
export class OffensivePlanner {
  private campaign?: Campaign;
  private preferredHub?: bigint;
  private lastKind: 'direct' | 'reinforce' = 'reinforce';
  private advancing = new Set<bigint>();
  reset() { this.campaign = undefined; this.preferredHub = undefined; this.lastKind = 'reinforce'; this.advancing.clear(); }
  captured(id: bigint, config: ModeConfig) {
    if (!this.advancing.delete(id) || !config.policy.advanceHub) return;
    this.preferredHub = id;
    // A follow-up campaign may already have started while the capture was in flight.
    // Move only unsent plans; previously launched supply still belongs to its original hub.
    if (this.campaign?.hub !== id) this.campaign = undefined;
  }
  launched(job: Assignment, config: ModeConfig) {
    this.lastKind = job.kind === 'reinforce' ? 'reinforce' : 'direct';
    if (job.kind === 'reinforce') return;
    const hub = this.hubId(config);
    if (job.targetId === this.campaign?.target || !this.campaign && (job.sourceId === hub || hub === undefined)) this.advancing.add(job.targetId);
    // A nearby independent strike must not cancel a different gathering operation.
    if (job.targetId === this.campaign?.target) this.campaign = undefined;
  }
  private hubId(config: ModeConfig) { return this.preferredHub ?? (config.policy.rallyId ? BigInt(config.policy.rallyId) : undefined); }
  plan(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>, pending: (hub: bigint) => Supply, guard: (hub: Planet) => RallyGuard): OffensivePlan {
    // Every source can attack directly, even with a manually chosen hub or active campaign.
    const direct = planAttack(world, snapshot, config, budgets, locked);
    const directJobs = direct.jobs ?? [];
    const left = new Map(budgets), reserved = new Map<bigint, number>(), excluded = new Set(locked);
    for (const job of directJobs) {
      excluded.add(job.targetId);
      left.set(job.sourceId, (left.get(job.sourceId) ?? 0) - job.count);
      reserved.set(job.sourceId, (reserved.get(job.sourceId) ?? 0) + job.count);
    }
    // Direct strikes consume alternating attack slots while gathering is active.
    const rallyConfig = directJobs.length ? { ...config, settings: { ...config.settings, intervalMs: config.settings.intervalMs * 2 } } : config;
    const gathering = this.planGathering(world, snapshot, rallyConfig, left, excluded, pending, guard);
    if (gathering.job) directJobs.push(gathering.job);
    for (const [id, count] of gathering.reservations) reserved.set(id, (reserved.get(id) ?? 0) + count);
    const queue = [...directJobs];
    if (gathering.rally) queue.splice(this.lastKind === 'direct' || !queue.length ? 0 : 1, 0, gathering.rally);
    const waiting = gathering.rallyState || gathering.candidates ? gathering.waiting : direct.waiting;
    return { ...direct, job: directJobs[0], jobs: queue, next: queue[0], rally: gathering.rally, rallyState: gathering.rallyState,
      reservations: reserved, candidates: direct.candidates + (gathering.rallyState ? 1 : 0), waiting };
  }
  private planGathering(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>, pending: (hub: bigint) => Supply, guard: (hub: Planet) => RallyGuard): OffensivePlan {
    let preferred = this.hubId(config);
    if (preferred !== undefined && !snapshot.owned.some(p => p.planetId === preferred && inZone(p, config.policy.zone) && !snapshot.automated?.has(preferred!))) {
      return { candidates: 1, waiting: `中转星 #${preferred} 不属于己方、位于战区外或启用了原生自动化；请停止进攻后调整`, reservations: new Map() };
    }
    if (this.campaign) {
      const target = snapshot.planets.find(p => p.planetId === this.campaign!.target);
      const hub = snapshot.owned.find(p => p.planetId === this.campaign!.hub);
      if (!target || !hub || !attackTarget(target, snapshot, config) || snapshot.automated?.has(hub.planetId)) {
        this.campaign = undefined; preferred = this.hubId(config);
      } else if (locked.has(target.planetId)) {
        return { candidates: 0, waiting: '集结目标已可直接进攻，暂停补给并等待出击', reservations: new Map() };
      } else if (Date.now() > this.campaign.deadline) {
        this.preferredHub = hub.planetId; this.campaign = undefined;
        return { candidates: 1, waiting: '本次集结等待超时，已释放未发射预留；已发舰队继续航行', reservations: new Map() };
      } else {
        const ready = attackQuote(world, snapshot, hub, target, config);
        if (ready && ready.count <= (budgets.get(hub.planetId) ?? 0)) return { job: ready, candidates: 1, waiting: '', reservations: new Map([[ready.sourceId, ready.count]]) };
        const gathering = this.gather(world, snapshot, config, budgets, hub, target, pending(hub.planetId), guard(hub));
        if (gathering) return this.result(gathering);
        // A new fleet at the enemy target makes the old battle premise invalid; release unsent donors.
        return { candidates: 1, waiting: `集结目标 #${target.planetId} 的战况变化，暂停补给并等待重新评估`, reservations: new Map() };
      }
    }
    const sources = preferred === undefined ? snapshot.owned : snapshot.owned.filter(p => p.planetId === preferred);
    const direct = { candidates: 0, waiting: '剩余兵力不足以完成新的集结，继续评估附近直攻机会' };
    if (!world.launchGroup || world.supportsGroup?.() === false) return { ...direct, reservations: new Map() };
    const enemies = snapshot.planets.filter(p => attackTarget(p, snapshot, config) && !locked.has(p.planetId));
    const index = new PlanetIndex(enemies);
    const hubs = sources.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId) && index.near(p, config.settings.radius).length)
      .sort((a, b) => (budgets.get(b.planetId) ?? 0) - (budgets.get(a.planetId) ?? 0)).slice(0, 8);
    let best: Gathering | undefined;
    for (const hub of hubs) {
      const targets = index.near(hub, config.settings.radius).sort((a, b) => (b.level ?? 1) / (b.probeCount + 1) - (a.level ?? 1) / (a.probeCount + 1)).slice(0, Math.min(config.settings.candidates, 3));
      const donors = this.donors(world, snapshot, config, budgets, hub);
      for (const target of targets) {
        const gathering = this.gather(world, snapshot, config, budgets, hub, target, pending(hub.planetId), guard(hub), donors);
        if (gathering?.complete && (gathering.job || gathering.state.incoming > 0) && (!best || gathering.waitMs < best.waitMs || gathering.waitMs === best.waitMs && gathering.state.required < best.state.required)) best = gathering;
      }
    }
    if (best) {
      this.campaign = { hub: best.state.hub, target: best.state.target, deadline: Date.now() + config.policy.rallyMs + config.settings.horizonMs + 60000 };
      return this.result(best);
    }
    return { ...direct, reservations: new Map() };
  }
  private result(plan: Gathering): OffensivePlan {
    return { candidates: 1, rally: plan.job, rallyState: plan.state, reservations: plan.reservations,
      waiting: plan.job ? `正在募集 ${plan.state.sources} 颗来源 → 中转星 #${plan.state.hub}，目标 #${plan.state.target}`
        : `等待集结：中转星 #${plan.state.hub}，进攻预计需 ${plan.state.required}，补给在途 ${plan.state.incoming}；目标 #${plan.state.target}` };
  }
  private donors(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, hub: Planet): Donor[] {
    const result: Donor[] = [];
    // Bound route queries by a mixed list of nearby and strong sources; never the expansion 1–3 cap.
    const eligible = snapshot.owned.filter(p => p.planetId !== hub.planetId && inZone(p, config.policy.zone) && (budgets.get(p.planetId) ?? 0) > 0 && !snapshot.automated?.has(p.planetId));
    const near = [...eligible].sort((a, b) => distance(a, hub) - distance(b, hub)).slice(0, maxDonors / 2);
    const strong = [...eligible].sort((a, b) => (budgets.get(b.planetId) ?? 0) - (budgets.get(a.planetId) ?? 0)).slice(0, maxDonors / 2);
    for (const p of [...new Map([...near, ...strong, ...eligible].map(p => [p.planetId, p])).values()].slice(0, maxDonors)) {
      const route = world.route?.(p.planetId, hub.planetId);
      if (validRoute(route) && route.travelMs <= config.policy.rallyMs) result.push({ planet: p, available: budgets.get(p.planetId)!, ...route });
    }
    return result.sort((a, b) => a.travelMs - b.travelMs || b.available - a.available || (a.planet.planetId < b.planet.planetId ? -1 : 1));
  }
  private gather(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, hub: Planet, target: Planet, pending: Supply, guard: RallyGuard, donors?: Donor[]): Gathering | null {
    if (!Number.isFinite(guard.deficit) || fleetsFor(snapshot, hub.planetId).some(f => f.owner !== snapshot.identity && !snapshot.allies?.has(f.owner))) return null;
    const base = attackQuote(world, snapshot, hub, target, config, true);
    const attackRoute = world.route?.(hub.planetId, target.planetId);
    if (!base || !validRoute(attackRoute)) return null;
    const incoming = fleetsFor(snapshot, hub.planetId).filter(f => f.owner === snapshot.identity || snapshot.allies?.has(f.owner));
    // Unknown incoming supply is not zero and must not trigger duplicate gathering.
    if (incoming.some(f => f.arriving === null || f.arrival === null)) return null;
    const arrivingCount = Math.max(pending.count, incoming.reduce((n, f) => n + f.arriving!, 0));
    let waitMs = Math.max(0, pending.arrival - Date.now(), ...incoming.map(f => f.arrival! - Date.now()));
    const available = budgets.get(hub.planetId) ?? 0;
    const usableRatio = 1 - guard.percent / 100;
    const required = (wait: number) => base.count + Math.ceil(Math.ceil(wait / 40000) * target.level! * 2 * 100 / (100 - attackRoute.lossPct));
    const needs = (wait: number) => Math.max(0, Math.ceil((required(wait) - available + guard.deficit) / usableRatio));
    const allocations: Contribution[] = [];
    let collected = arrivingCount;
    for (const donor of donors ?? this.donors(world, snapshot, config, budgets, hub)) {
      if (collected >= needs(waitMs)) break;
      const arrival = donor.travelMs + Math.floor(allocations.length / rallyBatchSize) * config.settings.intervalMs;
      waitMs = Math.max(waitMs, arrival);
      const deficit = needs(waitMs) - collected;
      const count = Math.min(donor.available, Math.ceil(deficit * 100 / (100 - donor.lossPct)));
      const arrives = arriving(count, donor.lossPct);
      if (arrives < 1) continue;
      allocations.push({ sourceId: donor.planet.planetId, count, travelMs: donor.travelMs }); collected += arrives;
    }
    const complete = collected >= needs(waitMs) && required(waitMs) <= 0xffffffff;
    const reservations = new Map<bigint, number>([[hub.planetId, available]]);
    if (complete) for (const member of allocations) reservations.set(member.sourceId, member.count);
    const batch = complete ? allocations.slice(0, rallyBatchSize) : [];
    const [lead, ...support] = batch;
    return { job: lead ? { ...lead, support, targetId: hub.planetId, kind: 'reinforce' } : undefined, reservations,
      state: { hub: hub.planetId, target: target.planetId, required: required(waitMs), available, incoming: arrivingCount, sources: allocations.length }, complete, waitMs };
  }
  refresh(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, job: Assignment): Assignment | null {
    const campaign = this.campaign;
    if (!campaign || campaign.hub !== job.targetId || !world.launchGroup || world.supportsGroup?.() === false) return null;
    const hub = snapshot.owned.find(p => p.planetId === job.targetId);
    const target = snapshot.planets.find(p => p.planetId === campaign.target);
    if (!hub || !target || !inZone(hub, config.policy.zone) || snapshot.automated?.has(hub.planetId) || !attackQuote(world, snapshot, hub, target, config, true)) return null;
    if (fleetsFor(snapshot, hub.planetId).some(f => f.owner !== snapshot.identity && !snapshot.allies?.has(f.owner))) return null;
    const ready = attackQuote(world, snapshot, hub, target, config);
    if (ready && ready.count <= (budgets.get(hub.planetId) ?? 0)) return null;
    const fresh: Contribution[] = [];
    for (const member of members(job)) {
      const source = snapshot.owned.find(p => p.planetId === member.sourceId), route = world.route?.(member.sourceId, hub.planetId);
      if (!source || source.planetId === hub.planetId || !inZone(source, config.policy.zone) || snapshot.automated?.has(source.planetId) || member.count > (budgets.get(member.sourceId) ?? 0) || !validRoute(route) || route.travelMs > config.policy.rallyMs || arriving(member.count, route.lossPct) < 1) return null;
      fresh.push({ ...member, travelMs: route.travelMs });
    }
    const [lead, ...support] = fresh;
    return lead ? { ...lead, targetId: hub.planetId, kind: 'reinforce', support } : null;
  }
}
