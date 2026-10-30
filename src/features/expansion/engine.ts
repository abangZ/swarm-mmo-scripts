import { defaults, validateSettings, members, completionMs, totalCount, type Contribution, type Assignment, type ExpansionSettings } from './types';
import { nearby, type ExpansionWorld, type WorldSnapshot } from './world';
import { distance } from '../../shared/distance';
import { planExpansion } from './planner';
import { coalitionOptions, combinations, type GroupSource } from './cooperation';
import type { Planet } from '../../game/types';
import { dispatch, sleep, withControl } from '../../runtime/operations';

export interface ExpansionState {
  running: boolean; phase: string; queue: Assignment[]; flights: number; sent: number; captured: number; missed: number; exact: boolean;
}
interface Flight { contributions: Contribution[] }
export class ExpansionEngine {
  state: ExpansionState = { running: false, phase: '尚未启动', queue: [], flights: 0, sent: 0, captured: 0, missed: 0, exact: false };
  private active = false;
  private working = false;
  private flights = new Map<bigint, Flight>();
  private debits = new Map<bigint, number>();
  private nextScan = 0;
  private nextDispatch = 0;
  private world?: ExpansionWorld;
  private settings = defaults;
  constructor(private update: (state: ExpansionState) => void, private createWorld: () => ExpansionWorld) {}
  get running() { return this.working; }
  private emit(phase?: string) { if (phase) this.state.phase = phase; this.state.running = this.working; this.update({ ...this.state, queue: [...this.state.queue] }); }
  stop() { this.active = false; this.state.queue = []; this.emit(this.working ? '正在停止；已发射舰队仍继续航行' : undefined); }
  async start(settings: ExpansionSettings): Promise<void> {
    if (this.working) return;
    validateSettings(settings);
    this.settings = { ...settings };
    this.active = true; this.working = true;
    this.flights.clear(); this.debits.clear(); this.nextScan = 0; this.nextDispatch = 0;
    this.state = { ...this.state, queue: [], sent: 0, captured: 0, missed: 0, flights: 0 };
    this.emit('正在获取操作权…');
    try {
      await withControl(async () => {
        if (!this.active) return;
        this.world = this.createWorld();
        while (this.active) {
          if (document.visibilityState === 'hidden') { this.emit('页面在后台，暂停发射；返回后重新扫描'); this.nextScan = 0; await sleep(500); continue; }
          await this.tick();
          if (this.active) await sleep(250);
        }
      });
      this.emit('已停止；已发射舰队仍继续航行');
    } catch (error) { this.emit(error instanceof Error ? error.message : String(error)); }
    finally { this.world?.dispose(); this.world = undefined; this.active = false; this.working = false; this.state.queue = []; this.emit(); }
  }
  private reconcile(snapshot: WorldSnapshot) {
    const owned = new Set((snapshot.allOwned ?? snapshot.owned).map(p => p.planetId));
    // Only release optimistic inventory after a new, acknowledged subscription snapshot.
    this.debits.clear();
    for (const [target] of this.flights) {
      if (owned.has(target)) { this.state.captured++; this.flights.delete(target); }
      else if (!snapshot.incoming.has(target)) { this.state.missed++; this.flights.delete(target); }
    }
  }
  private plan(snapshot: WorldSnapshot) {
    const locked = new Set([...snapshot.incoming, ...this.flights.keys()]);
    const budgets = new Map(snapshot.owned.map(p => [p.planetId, Math.max(0, (snapshot.budgets.get(p.planetId) ?? 0) - this.settings.reserve - (this.debits.get(p.planetId) ?? 0))]));
    const edges: Assignment[] = [];
    const groupCandidates = new Map<bigint, { target: Planet; sources: GroupSource[] }>();
    for (const source of snapshot.owned) {
      if (!budgets.get(source.planetId)) continue;
      for (const target of nearby(source, snapshot.planets, locked, this.settings)) {
        const quote = this.world!.quote(source.planetId, target.planetId);
        if (quote && quote.count <= budgets.get(source.planetId)!) edges.push({ sourceId: source.planetId, targetId: target.planetId, ...quote });
        if (this.settings.maxSources > 1 && this.world!.launchGroup) {
          const route = this.world!.route?.(source.planetId, target.planetId);
          if (route) {
            const candidate = groupCandidates.get(target.planetId) ?? { target, sources: [] };
            candidate.sources.push({ planet: source, available: budgets.get(source.planetId)!, ...route });
            groupCandidates.set(target.planetId, candidate);
          }
        }
      }
    }
    for (const { target, sources } of groupCandidates.values()) {
      // Bound combinatorics: compare pairs/triples among the six quickest nearby sources.
      const nearbySources = sources.sort((a, b) => a.travelMs - b.travelMs || b.available - a.available).slice(0, 6);
      for (let size = 2; size <= this.settings.maxSources; size++) {
        for (const group of combinations(nearbySources, size)) edges.push(...coalitionOptions(target, group, this.settings));
      }
    }
    const plan = planExpansion(edges, budgets, this.settings.intervalMs, this.settings.horizonMs);
    this.state.queue = plan.jobs;
    this.state.exact = plan.exact;
    this.state.flights = locked.size;
    return plan;
  }
  private async tick() {
    const world = this.world!;
    if (Date.now() >= this.nextScan) {
      this.emit('正在扫描己方星球与附近目标…');
      await world.scan(this.settings, () => this.active);
      if (!this.active) return;
      this.reconcile(world.read());
      this.nextScan = Date.now() + this.settings.scanMs;
    }
    if (!this.active || document.visibilityState === 'hidden' || Date.now() < this.nextDispatch) return;
    const snapshot = world.read();
    const plan = this.plan(snapshot);
    const job = plan.jobs[0];
    if (!job) { this.emit('等待兵力增长或新的无主目标'); this.nextDispatch = Date.now() + 1000; return; }
    this.emit(`准备 ${members(job).map(m => `#${m.sourceId}`).join(" + ")} → #${job.targetId}，共 ${totalCount(job)} 探针${job.support?.length ? "（联合占领）" : "（报价 +2）"}`);
    let actual: Assignment | undefined;
    await dispatch(() => {
      // This closure runs after throttling, immediately before the reducer call.
      const fresh = world.read();
      const target = fresh.planets.find(p => p.planetId === job.targetId);
      if (!target || target.ownerId != null || fresh.incoming.has(job.targetId) || this.flights.has(job.targetId)) return null;
      const available = (id: bigint) => (fresh.budgets.get(id) ?? 0) - this.settings.reserve - (this.debits.get(id) ?? 0);
      if (job.support?.length) {
        if (!world.launchGroup || !world.route) return null;
        const sources: GroupSource[] = [];
        for (const member of members(job)) {
          const planet = fresh.owned.find(p => p.planetId === member.sourceId);
          const route = world.route(member.sourceId, job.targetId);
          if (!planet || !route) return null;
          sources.push({ planet, available: available(member.sourceId), ...route });
        }
        const options = coalitionOptions(target, sources, this.settings);
        // Preserve the planner's allocation when still feasible: changing a split can consume
        // inventory deliberately left on a source for another target in the same plan.
        const plannedCounts = new Map(members(job).map(m => [m.sourceId, m.count]));
        const deviation = (option: Assignment) => members(option).reduce((sum, m) => sum + Math.abs(m.count - (plannedCounts.get(m.sourceId) ?? 0)), 0);
        const refreshed = options.sort((a, b) => deviation(a) - deviation(b) || completionMs(a) - completionMs(b) || totalCount(a) - totalCount(b))[0];
        if (!refreshed) return null;
        actual = refreshed;
        this.nextDispatch = Date.now() + this.settings.intervalMs;
        return () => world.launchGroup!(refreshed);
      }
      const source = fresh.owned.find(p => p.planetId === job.sourceId);
      const quote = world.quote(job.sourceId, job.targetId);
      if (!source || distance(source, target) > this.settings.radius || !quote || quote.count > available(job.sourceId) || quote.travelMs > this.settings.horizonMs) return null;
      actual = { sourceId: job.sourceId, targetId: job.targetId, ...quote };
      this.nextDispatch = Date.now() + this.settings.intervalMs;
      return () => world.launch(job.sourceId, job.targetId, quote.count);
    }, this.settings.intervalMs, () => this.active && document.visibilityState !== 'hidden');
    if (!actual) { this.state.queue = []; this.emit('目标或兵力已变化，将重新规划'); return; }
    for (const member of members(actual)) this.debits.set(member.sourceId, (this.debits.get(member.sourceId) ?? 0) + member.count);
    this.flights.set(actual.targetId, { contributions: members(actual) });
    this.state.sent += members(actual).length; this.state.queue = this.state.queue.filter(j => j.targetId !== actual!.targetId);
    this.state.flights = new Set([...snapshot.incoming, ...this.flights.keys()]).size;
    this.emit(`已确认发射 ${members(actual).map(m => `#${m.sourceId}`).join(" + ")} → #${actual.targetId}，共 ${totalCount(actual)} 探针；等待占领结果`);
  }
}
