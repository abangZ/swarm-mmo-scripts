import { dispatch, unresolved, withControl } from '../../runtime/operations';
import type { ExpansionWorld, WorldSnapshot } from '../expansion/world';
import { completionMs, members, sourceLabel, totalCount, validateSettings, type Assignment } from '../expansion/types';
import type { ExpansionActivity, ExpansionState } from '../expansion/engine';
import { expansionProposalSteps, expansionQuote, refreshGroup } from '../expansion/proposals';
import { expansionPlanSteps } from '../expansion/planner';
import { runPlanning } from '../../runtime/planning';
import { attackQuote } from '../attack/planner';
import { OffensivePlanner, type Supply } from '../attack/rally';
import { arriving } from '../expansion/cooperation';
import { availableBudgets, reserveFor } from './safety';
import { inZone, validatePolicy, type Mode, type ModeConfig } from './types';

export const idleState = (): ExpansionState => ({ activity: 'idle', ownedCount: 0, candidateCount: 0, lastScanAt: null, nextScanAt: null, running: false, phase: '尚未启动', queue: [], flights: 0, sent: 0, captured: 0, missed: 0, exact: false });
const modes: Mode[] = ['expansion', 'attack'];
interface Flight { mode: Mode; job: Assignment; due: number }

/** One inventory ledger and scan coordinator; each mode owns its planning/execution lane. */
export class Commander {
  states: Record<Mode, ExpansionState> = { expansion: idleState(), attack: idleState() };
  private configs: Partial<Record<Mode, ModeConfig>> = {};
  private world?: ExpansionWorld;
  private working = false;
  private run?: Promise<void>;
  private revision = 0;
  private nextScan = 0;
  private nextPlan: Record<Mode, number> = { expansion: 0, attack: 0 };
  private tasks = new Map<Mode, Promise<void>>();
  private cancellations = new Map<Mode, AbortController>();
  private wake?: () => void;
  private pendingSources = new Set<bigint>();
  private inventoryRevision = 0;
  private pendingTargets = new Set<bigint>();
  private attackReservations = new Map<bigint, number>();
  private coveredRevision = -1;
  private scanning = false;
  private failure?: Error;
  private flights = new Map<bigint, Flight>();
  private debits = new Map<bigint, number>();
  private saving?: { key: string; until: number };
  private savingCooldown = 0;
  private offensive = new OffensivePlanner();
  private supplies: { hub: bigint; deliveries: Supply[] }[] = [];
  constructor(private update: (mode: Mode, state: ExpansionState) => void, private createWorld: () => ExpansionWorld) {}
  private emit(mode: Mode, phase?: string, activity?: ExpansionActivity) {
    const state = this.states[mode];
    if (phase) state.phase = phase;
    if (activity) state.activity = activity;
    this.update(mode, { ...state, queue: [...state.queue] });
  }
  private interruptWaiting() { for (const controller of this.cancellations.values()) controller.abort(); this.wake?.(); }
  private wait(ms: number) {
    return new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); if (this.wake === finish) this.wake = undefined; resolve(); };
      const timer = setTimeout(finish, ms); this.wake = finish;
    });
  }
  private get active() { return modes.some(mode => !!this.configs[mode]); }
  private activeConfigs() { return modes.flatMap(mode => this.configs[mode] ? [this.configs[mode]!] : []); }
  start(mode: Mode, config: ModeConfig): Promise<void> {
    if (this.states[mode].running || this.working && !this.active) return this.run ?? Promise.resolve();
    if (mode === 'attack') config = { ...config, settings: { ...config.settings, intervalMs: 1000 } };
    validateSettings(config.settings); validatePolicy(config.policy, mode);
    if (mode === 'attack') this.offensive.reset();
    this.configs[mode] = structuredClone(config);
    this.states[mode] = { ...idleState(), running: true };
    this.revision++; this.nextScan = 0; this.nextPlan = { expansion: 0, attack: 0 }; this.interruptWaiting();
    this.emit(mode, '正在获取操作权…', 'starting');
    if (!this.working) { this.failure = undefined; this.working = true; this.run = this.loop(); }
    return this.run!;
  }
  stop(mode?: Mode) {
    for (const m of mode ? [mode] : modes) {
      delete this.configs[m];
      this.states[m].queue = [];
      if (m === 'attack') { this.attackReservations.clear(); this.saving = undefined; this.savingCooldown = 0; this.offensive.reset(); this.states.attack.rally = undefined; }
      if (this.states[m].running) this.emit(m, '正在停止；已发射舰队仍继续航行', 'stopping');
    }
    this.revision++; this.nextScan = 0; this.nextPlan = { expansion: 0, attack: 0 }; this.interruptWaiting();
  }
  private finishStopped() {
    for (const mode of modes) if (!this.configs[mode] && !this.tasks.has(mode) && !this.failure && this.states[mode].running) {
      this.states[mode].running = false; this.states[mode].nextScanAt = null;
      this.emit(mode, '已停止；未发射任务已取消，已发射舰队仍继续航行', 'stopped');
    }
  }
  private fail(error: unknown) {
    if (this.failure || !this.active && !unresolved()) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.configs = {}; this.attackReservations.clear(); this.revision++; this.interruptWaiting();
    for (const mode of modes) if (this.states[mode].running) this.emit(mode, this.failure.message, 'error');
  }
  private async loop() {
    try {
      await withControl(async () => {
        try {
          if (!this.active) return;
          this.world = this.createWorld();
          while (this.active) {
            if (document.visibilityState === 'hidden') {
              for (const mode of modes) if (this.configs[mode]) { this.states[mode].nextScanAt = null; this.emit(mode, '页面在后台，暂停发射；返回后重新扫描', 'paused'); }
              this.nextScan = 0; this.interruptWaiting(); await this.wait(500);
            } else await this.tick();
            this.finishStopped();
            if (this.active) await this.wait(250);
          }
        } catch (error) { this.fail(error); }
        finally {
          // Keep ownership, subscriptions and inventory barriers alive until both
          // lanes settle, including a second receipt after the first lane fails.
          await Promise.all(this.tasks.values());
        }
      });
    } catch (error) { this.fail(error); }
    finally {
      this.finishStopped();
      this.world?.dispose(); this.world = undefined; this.configs = {}; this.working = false;
      this.saving = undefined; this.debits.clear(); this.pendingSources.clear(); this.pendingTargets.clear(); this.attackReservations.clear();
      for (const mode of modes) if (this.states[mode].running) {
        this.states[mode].running = false; this.states[mode].queue = []; this.states[mode].nextScanAt = null; this.emit(mode);
      }
    }
  }
  private budgets(snapshot: WorldSnapshot) {
    const budgets = availableBudgets(snapshot, this.activeConfigs(), this.debits);
    // The cache may already reflect a launch before its acknowledgement/barrier.
    // Only these unsynchronized sources wait; other sources remain independent.
    for (const id of this.pendingSources) budgets.set(id, 0);
    return budgets;
  }
  private reconcile(snapshot: WorldSnapshot) {
    // Legacy adapters release settled debits at the scan barrier. Never clear an
    // in-flight debit when the other lane performs a periodic coverage scan.
    for (const id of this.debits.keys()) if (!this.pendingSources.has(id)) this.debits.delete(id);
    this.supplies = this.supplies.filter(s => s.deliveries.some(d => Date.now() < d.arrival + 5000));
    const owned = new Set((snapshot.allOwned ?? snapshot.owned).map(p => p.planetId));
    for (const [id, flight] of this.flights) {
      const state = this.states[flight.mode];
      if (owned.has(id)) {
        state.captured++; this.flights.delete(id);
        if (flight.mode === 'attack' && this.configs.attack) this.offensive.captured(id, this.configs.attack);
        if (this.configs[flight.mode]) this.emit(flight.mode, `已确认占领 #${id}`, 'captured');
      } else if (Date.now() >= flight.due + 5000 && !snapshot.incoming.has(id)) {
        state.missed++; this.flights.delete(id);
        if (this.configs[flight.mode]) this.emit(flight.mode, `舰队已结束航行，未确认占领 #${id}；重新评估`, 'waiting');
      }
    }
  }
  private pendingSupply(hub: bigint): Supply {
    // Track each route separately: part of a batch may already be in the hub's stock.
    // The acknowledged ledger remains for reconciliation, but elapsed promises are not
    // added to actual inventory again when funding the next campaign.
    const pending = this.supplies.filter(s => s.hub === hub).flatMap(s => s.deliveries).filter(s => s.arrival > Date.now());
    return { count: pending.reduce((n, s) => n + s.count, 0), arrival: Math.max(Date.now(), ...pending.map(s => s.arrival)) };
  }
  private flightCount(mode: Mode) { return [...this.flights.values()].filter(f => f.mode === mode).length + (mode === 'attack' ? this.supplies.length : 0); }
  private async tick() {
    const world = this.world!;
    if (Date.now() >= this.nextScan || world.needsScan?.()) {
      const revision = this.revision, configs = this.activeConfigs();
      const settings = { ...configs[0].settings, radius: Math.max(...configs.map(c => c.settings.radius)) };
      world.configure?.(configs);
      for (const mode of modes) if (this.configs[mode]) this.emit(mode, '正在扫描战区星球、舰队与科技覆盖…', 'scanning');
      this.scanning = true;
      try { await world.scan(settings, () => this.active); } finally { this.scanning = false; }
      if (!this.active || revision !== this.revision) return;
      this.coveredRevision = revision;
      const snapshot = world.read(); this.reconcile(snapshot);
      this.nextScan = Date.now() + Math.min(...configs.map(c => c.settings.scanMs));
      for (const mode of modes) if (this.configs[mode]) {
        const state = this.states[mode];
        state.lastScanAt = Date.now(); state.nextScanAt = this.nextScan;
        state.ownedCount = snapshot.owned.filter(p => inZone(p, this.configs[mode]!.policy.zone)).length;
        this.emit(mode, `扫描完成：战区内 ${state.ownedCount} 颗己方星球，开始评估目标`, 'scanning');
      }
      this.nextPlan = { expansion: 0, attack: 0 };
    }
    if (!this.active || document.visibilityState === 'hidden') return;
    // Attack reserves its concrete planned amounts before expansion reads the
    // common budget. Neither lane waits for the other lane's cooldown or receipt.
    for (const mode of ['attack', 'expansion'] as const) {
      const config = this.configs[mode];
      if (!config || this.tasks.has(mode) || Date.now() < this.nextPlan[mode]) continue;
      const controller = new AbortController(); this.cancellations.set(mode, controller);
      const task = this.runLane(mode, config, controller.signal).catch(error => this.fail(error)).finally(() => {
        this.tasks.delete(mode); this.cancellations.delete(mode); this.finishStopped(); if (!this.active || !this.configs[mode]) this.wake?.();
      });
      this.tasks.set(mode, task);
    }
  }
  private async runLane(mode: Mode, config: ModeConfig, signal: AbortSignal) {
    const world = this.world!, planningRevision = this.revision, inventoryRevision = this.inventoryRevision;
    const current = () => !signal.aborted && this.configs[mode] === config && !this.failure && planningRevision === this.revision && document.visibilityState !== 'hidden';
    const snapshot = world.read(), configs = this.activeConfigs();
    const budgets = this.budgets(snapshot);
    const locked = new Set([...this.flights.keys(), ...this.pendingTargets]);
    const interval = config.settings.intervalMs;
    let attack: Assignment | undefined;
    const attackConfig = mode === 'attack' ? config : undefined;
    if (attackConfig) {
      const reserved = new Map<bigint, number>();
      const planningConfig = attackConfig;
      const plan = this.offensive.plan(world, snapshot, planningConfig, budgets, locked, hub => this.pendingSupply(hub), hub => ({
        percent: Math.max(0, ...configs.filter(c => inZone(hub, c.policy.zone)).map(c => c.policy.frontlinePercent)),
        deficit: Math.max(0, reserveFor(hub, snapshot, configs) - Math.max(0, (snapshot.budgets.get(hub.planetId) ?? 0) - (this.debits.get(hub.planetId) ?? 0))),
      }));
      attack = plan.next;
      for (const [id, count] of plan.reservations) reserved.set(id, count);
      this.states.attack.rally = plan.rallyState;
      this.states.attack.candidateCount = plan.candidates;
      this.states.attack.exact = plan.exact ?? false;
      let savingJob: Assignment | undefined;
      if (!attack && !plan.rallyState && plan.saving && Date.now() >= this.savingCooldown) {
        const key = `${plan.saving.sourceId}:${plan.saving.targetId}`;
        this.saving ??= { key, until: Date.now() + 120000 };
        if (Date.now() >= this.saving.until) { this.saving = undefined; this.savingCooldown = Date.now() + 60000; }
        else if (this.saving.key === key) { savingJob = plan.saving; reserved.set(plan.saving.sourceId, plan.saving.count); }
      } else if (attack || !plan.saving) this.saving = undefined;
      this.attackReservations = reserved;
      this.states.attack.queue = plan.jobs ?? [];
      if (!attack) this.emit('attack', savingJob ? `正在为 #${savingJob.targetId} 攒兵：#${savingJob.sourceId} 需 ${savingJob.count}，当前可用 ${budgets.get(savingJob.sourceId) ?? 0}；最多预留 120 秒`
        : plan.waiting, 'waiting');
    }
    const expansionConfig = mode === 'expansion' ? config : undefined;
    let expansion: Assignment | undefined;
    if (expansionConfig) {
      const left = new Map(budgets);
      for (const [id, count] of this.attackReservations) left.set(id, Math.max(0, (left.get(id) ?? 0) - count));
      const proposals = await runPlanning(expansionProposalSteps(world, snapshot, expansionConfig, left, locked), current, () => world.refreshQuotes?.());
      if (!proposals || !current()) return;
      const plan = await runPlanning(expansionPlanSteps(proposals.edges, left, interval, expansionConfig.settings.horizonMs, expansionConfig.settings.maxTravelMs), current);
      if (!plan || !current()) return;
      const assigned = new Set(plan.jobs.flatMap(job => members(job).map(m => m.sourceId)));
      const idle = proposals.sources.filter(source => !assigned.has(source.sourceId)).sort((a, b) => b.available - a.available).slice(0, 6);
      this.states.expansion.planning = { sources: proposals.sources.length, ready: proposals.readySources, assigned: assigned.size, idle };
      this.states.expansion.queue = plan.jobs; this.states.expansion.exact = plan.exact; this.states.expansion.candidateCount = proposals.candidates;
      expansion = plan.jobs[0];
      if (!expansion) this.emit('expansion', `暂无可执行扩张：${proposals.readySources}/${proposals.sources.length} 颗来源可出兵；${idle[0]?.reason ?? '战区内暂无己方来源'}`, 'waiting');
    }
    if (!current()) return;
    this.states[mode].flights = this.flightCount(mode); this.emit(mode);
    this.nextPlan[mode] = Date.now() + (inventoryRevision === this.inventoryRevision ? 1000 : 0);
    const job = mode === 'attack' ? attack : expansion;
    if (!job) return;
    const dispatchRevision = this.revision;
    this.emit(mode, `准备${job.kind === 'reinforce' ? '集结 ' : ' '}${sourceLabel(job)} → #${job.targetId}，共 ${totalCount(job)} 探针；等待操作间隔`, 'queued');
    let actual: Assignment | undefined;
    let supplyDeliveries: { count: number; travelMs: number }[] = [];
    try { await dispatch(() => {
      const fresh = world.read();
      if (!current() || this.scanning || this.coveredRevision !== dispatchRevision || this.flights.has(job.targetId) || this.pendingTargets.has(job.targetId)) return null;
      const target = fresh.planets.find(p => p.planetId === job.targetId);
      if (!target || !inZone(target, config.policy.zone)) return null;
      const available = this.budgets(fresh);
      if (mode === 'expansion') for (const [id, count] of this.attackReservations) available.set(id, Math.max(0, (available.get(id) ?? 0) - count));
      if (members(job).some(m => !fresh.owned.some(p => p.planetId === m.sourceId && inZone(p, config.policy.zone)))) return null;
      const source = fresh.owned.find(p => p.planetId === job.sourceId)!;
      const groupBudgets = new Map(available);
      // A newly affordable solo may replace a coalition, but cannot consume troops that
      // the current expansion plan needs for another target.
      if (mode === 'expansion' && job.support?.length) for (const other of this.states.expansion.queue) {
        if (other.targetId !== job.targetId) for (const m of members(other)) groupBudgets.set(m.sourceId, Math.max(0, (groupBudgets.get(m.sourceId) ?? 0) - m.count));
      }
      const refreshed = job.kind === 'reinforce' ? this.offensive.refresh(world, fresh, config, available, job)
        : mode === 'attack' ? attackQuote(world, fresh, source, target, config)
        : job.support?.length ? refreshGroup(world, fresh, job, groupBudgets, config.settings) : expansionQuote(world, fresh, source, target, config);
      if (!refreshed || members(refreshed).some(m => m.count > (available.get(m.sourceId) ?? 0))) return null;
      actual = refreshed;
      for (const m of members(actual)) {
        this.pendingSources.add(m.sourceId);
        this.debits.set(m.sourceId, (this.debits.get(m.sourceId) ?? 0) + m.count);
        if (mode === 'attack') this.attackReservations.set(m.sourceId, Math.max(0, (this.attackReservations.get(m.sourceId) ?? 0) - m.count));
      }
      this.pendingTargets.add(actual.targetId); this.inventoryRevision++;
      if (refreshed.kind === 'reinforce') supplyDeliveries = members(refreshed).map(m => ({ count: arriving(m.count, world.route!(m.sourceId, refreshed.targetId)!.lossPct), travelMs: m.travelMs }));
      return () => {
        this.emit(mode, `正在${refreshed.kind === 'reinforce' ? `集结 ${members(refreshed).length} 颗来源` : '发送'} → #${refreshed.targetId}，${totalCount(refreshed)} 探针；等待服务器确认`, 'sending');
        return refreshed.support?.length ? world.launchGroup!(refreshed) : world.launch(refreshed.sourceId, refreshed.targetId, refreshed.count);
      };
    }, interval, current, mode, signal);
    if (actual) {
      if (actual.kind === 'reinforce') this.supplies.push({ hub: actual.targetId, deliveries: supplyDeliveries.map(s => ({ count: s.count, arrival: Date.now() + s.travelMs })) });
      else this.flights.set(actual.targetId, { mode, job: actual, due: Date.now() + completionMs(actual) });
      if (mode === 'attack' && this.configs.attack === config) this.offensive.launched(actual, config);
      this.states[mode].sent += members(actual).length;
      this.states[mode].flights = this.flightCount(mode);
      this.states[mode].queue = this.states[mode].queue.filter(job => job.targetId !== actual!.targetId);
      if (!this.failure) this.emit(mode, actual.kind === 'reinforce' ? `已确认集结发射：${members(actual).length} 颗来源 → 中转星 #${actual.targetId}；等待实际到达后出击` : `已确认发射 → #${actual.targetId}；等待抵达和占领确认`, 'sent');
      if (world.syncInventory) {
        const sources = members(actual).map(m => m.sourceId);
        await world.syncInventory(sources);
        for (const id of sources) this.debits.delete(id);
      }
    }
    } catch (error) { this.fail(error); } finally {
      if (actual) {
        for (const m of members(actual)) this.pendingSources.delete(m.sourceId);
        this.pendingTargets.delete(actual.targetId); this.inventoryRevision++;
        this.nextPlan = { expansion: 0, attack: 0 };
      }
      this.nextPlan[mode] = 0;
    }
  }
}
