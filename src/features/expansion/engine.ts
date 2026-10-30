import { defaults, validateSettings, members, completionMs, totalCount, type Contribution, type Assignment, type ExpansionSettings } from './types';
import { nearby, type ExpansionWorld, type WorldSnapshot } from './world';
import { distance } from '../../shared/distance';
import { planExpansion } from './planner';
import { coalitionOptions, combinations, type GroupSource } from './cooperation';
import type { Planet } from '../../game/types';
import { dispatch, sleep, withControl, unresolved } from '../../runtime/operations';

export type ExpansionActivity = 'idle' | 'starting' | 'scanning' | 'waiting' | 'queued' | 'sending' | 'sent' | 'captured' | 'paused' | 'stopping' | 'stopped' | 'error';
export interface ExpansionState {
  activity: ExpansionActivity; ownedCount: number; candidateCount: number; lastScanAt: number | null; nextScanAt: number | null;
  running: boolean; phase: string; queue: Assignment[]; flights: number; sent: number; captured: number; missed: number; exact: boolean;
}
interface Flight { contributions: Contribution[] }
export class ExpansionEngine {
  state: ExpansionState = { activity: 'idle', ownedCount: 0, candidateCount: 0, lastScanAt: null, nextScanAt: null, running: false, phase: '尚未启动', queue: [], flights: 0, sent: 0, captured: 0, missed: 0, exact: false };
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
  private get canDispatch() { return this.active && document.visibilityState !== 'hidden'; }
  private emit(phase?: string, activity?: ExpansionActivity) { if (phase) this.state.phase = phase; if (activity) this.state.activity = activity; this.state.running = this.working; this.update({ ...this.state, queue: [...this.state.queue] }); }
  stop() { this.active = false; this.state.queue = []; this.emit(this.working ? '正在停止；已发射舰队仍继续航行' : undefined, this.working ? 'stopping' : undefined); }
  async start(settings: ExpansionSettings): Promise<void> {
    if (this.working) return;
    validateSettings(settings);
    this.settings = { ...settings };
    this.active = true; this.working = true;
    this.flights.clear(); this.debits.clear(); this.nextScan = 0; this.nextDispatch = 0;
    this.state = { ...this.state, queue: [], sent: 0, captured: 0, missed: 0, flights: 0, ownedCount: 0, candidateCount: 0, lastScanAt: null, nextScanAt: null };
    this.emit('正在获取操作权…', 'starting');
    try {
      await withControl(async () => {
        if (!this.active) return;
        this.world = this.createWorld();
        while (this.active) {
          if (document.visibilityState === 'hidden') { this.state.nextScanAt = null; this.emit('页面在后台，暂停发射；返回后重新扫描', 'paused'); this.nextScan = 0; await sleep(500); continue; }
          await this.tick();
          if (this.active) await sleep(250);
        }
      });
      this.emit('已停止；已发射舰队仍继续航行', 'stopped');
    } catch (error) {
      if (!this.active && !unresolved()) this.emit('已停止；未发射任务已取消', 'stopped');
      else this.emit(error instanceof Error ? error.message : String(error), 'error');
    }
    finally { this.world?.dispose(); this.world = undefined; this.active = false; this.working = false; this.state.queue = []; this.state.nextScanAt = null; this.emit(); }
  }
  private reconcile(snapshot: WorldSnapshot) {
    const owned = new Set((snapshot.allOwned ?? snapshot.owned).map(p => p.planetId));
    // Only release optimistic inventory after a new, acknowledged subscription snapshot.
    this.debits.clear();
    for (const [target] of this.flights) {
      if (owned.has(target)) { this.state.captured++; this.flights.delete(target); this.emit(`已确认占领 #${target}`, 'captured'); }
      else if (!snapshot.incoming.has(target)) { this.state.missed++; this.flights.delete(target); this.emit(`舰队已结束航行，未确认占领 #${target}；下轮重新评估`, 'waiting'); }
    }
  }
  private plan(snapshot: WorldSnapshot) {
    const locked = new Set([...snapshot.incoming, ...this.flights.keys()]);
    const budgets = new Map(snapshot.owned.map(p => [p.planetId, Math.max(0, (snapshot.budgets.get(p.planetId) ?? 0) - this.settings.reserve - (this.debits.get(p.planetId) ?? 0))]));
    const edges: Assignment[] = [];
    const candidates = new Set<bigint>();
    this.state.ownedCount = snapshot.owned.length;
    const groupCandidates = new Map<bigint, { target: Planet; sources: GroupSource[] }>();
    for (const source of snapshot.owned) {
      const targets = nearby(source, snapshot.planets, locked, this.settings);
      for (const target of targets) candidates.add(target.planetId);
      if (!budgets.get(source.planetId)) continue;
      for (const target of targets) {
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
    this.state.candidateCount = candidates.size;
    const plan = planExpansion(edges, budgets, this.settings.intervalMs, this.settings.horizonMs);
    this.state.queue = plan.jobs;
    this.state.exact = plan.exact;
    this.state.flights = locked.size;
    return plan;
  }
  private async tick() {
    const world = this.world!;
    if (Date.now() >= this.nextScan) {
      this.emit('正在扫描己方星球与附近目标…', 'scanning');
      await world.scan(this.settings, () => this.active);
      if (!this.active) return;
      const scanned = world.read();
      this.reconcile(scanned);
      this.state.ownedCount = scanned.owned.length;
      this.state.lastScanAt = Date.now();
      this.nextScan = Date.now() + this.settings.scanMs;
      this.state.nextScanAt = this.nextScan;
      this.emit(`扫描完成：已加载 ${scanned.owned.length} 颗己方星球，开始评估目标`, 'scanning');
    }
    if (!this.active || document.visibilityState === 'hidden' || Date.now() < this.nextDispatch) return;
    const snapshot = world.read();
    const plan = this.plan(snapshot);
    const job = plan.jobs[0];
    if (!job) {
      const reason = !snapshot.owned.length ? '等待己方星球：当前没有可参与扩张的星球'
        : !this.state.candidateCount ? `等待新目标：附近没有未锁定的无主星球，${this.state.flights} 个目标在途或已锁定`
        : `暂无可执行方案：${this.state.candidateCount} 个候选的兵力、航线或规划时限尚不满足，持续检查中`;
      this.emit(reason, 'waiting'); this.nextDispatch = Date.now() + 1000; return;
    }
    this.emit(`准备 ${members(job).map(m => `#${m.sourceId}`).join(" + ")} → #${job.targetId}，共 ${totalCount(job)} 探针${job.support?.length ? "（联合占领）" : "（报价 +2）"}；等待操作间隔`, 'queued');
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
        return () => {
          this.emit(`正在联合发送至 #${job.targetId}，共 ${totalCount(refreshed)} 探针；等待服务器确认`, 'sending');
          return world.launchGroup!(refreshed);
        };
      }
      const source = fresh.owned.find(p => p.planetId === job.sourceId);
      const quote = world.quote(job.sourceId, job.targetId);
      if (!source || distance(source, target) > this.settings.radius || !quote || quote.count > available(job.sourceId) || quote.travelMs > this.settings.horizonMs) return null;
      actual = { sourceId: job.sourceId, targetId: job.targetId, ...quote };
      this.nextDispatch = Date.now() + this.settings.intervalMs;
      return () => {
        this.emit(`正在发送 #${job.sourceId} → #${job.targetId}，${quote.count} 探针；等待服务器确认`, 'sending');
        return world.launch(job.sourceId, job.targetId, quote.count);
      };
    }, this.settings.intervalMs, () => this.canDispatch);
    if (!actual) { this.state.queue = []; if (this.canDispatch) this.emit('目标或兵力已变化，将重新规划', 'waiting'); return; }
    for (const member of members(actual)) this.debits.set(member.sourceId, (this.debits.get(member.sourceId) ?? 0) + member.count);
    this.flights.set(actual.targetId, { contributions: members(actual) });
    this.state.sent += members(actual).length; this.state.queue = this.state.queue.filter(j => j.targetId !== actual!.targetId);
    this.state.flights = new Set([...snapshot.incoming, ...this.flights.keys()]).size;
    this.emit(`已确认发射 ${members(actual).map(m => `#${m.sourceId}`).join(" + ")} → #${actual.targetId}，共 ${totalCount(actual)} 探针；等待占领结果`, this.active ? 'sent' : 'stopping');
  }
}
