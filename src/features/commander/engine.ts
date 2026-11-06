import { dispatch, dispatchExpansion, expansionInterval, unresolved, withControl, within } from '../../runtime/operations';
import type { ExpansionWorld, WorldSnapshot } from '../expansion/world';
import { bodyFleetsFor, bodyFor } from '../expansion/world';
import { maxUpgradeBatch, completionMs, jobKey, targetKey, members, planetLocks, sourceLabel, targetLabel, totalCount, validateSettings, type Assignment } from '../expansion/types';
import type { ExpansionActivity, ExpansionState } from '../expansion/engine';
import { BackgroundPlanner } from '../expansion/background-planner';
import { FrontierPlanner } from '../expansion/frontier';
import { fingerprint } from '../../shared/fingerprint';
import { PlanningQuotes } from '../expansion/planning-quotes';
import { jobQuoteRules, sameJobRules } from '../expansion/quote-rules';
import { runPlanning, planningTiming, yieldToFrontier } from '../../runtime/planning';
import { attackStartupIssue } from '../attack/diagnostics';
import { attackQuote } from '../attack/planner';
import { OffensivePlanner, type Supply } from '../attack/rally';
import { arriving } from '../expansion/cooperation';
import { availableBudgets, hostile, reserveFor } from './safety';
import { distance } from '../../shared/distance';
import { inZone, validatePolicy, type Mode, type ModeConfig } from './types';
import { LogisticsPlanner, logisticsQuoteBudget, logisticsPairBudget, type LogisticsPlan } from '../expansion/logistics';
import { MeteoriteFrontier } from '../expansion/meteorite-frontier';
import { decisionLabel, ExpansionJournal, StableUpgrades, validSpecialTarget, specialTargetSkipReason } from '../expansion/strategy';

export const idleState = (): ExpansionState => ({ activity: 'idle', ownedCount: 0, candidateCount: 0, lastScanAt: null, nextScanAt: null, running: false, phase: '尚未启动', queue: [], flights: 0, sent: 0, captured: 0, missed: 0, exact: false });
const modes: Mode[] = ['expansion', 'attack'];
interface Flight { mode: Mode; job: Assignment; due: number }
const fleetState = (snapshot: WorldSnapshot, job: Assignment) => [(job.targetKind ?? 'planet') === 'planet' && snapshot.incoming.has(job.targetId), ...bodyFleetsFor(snapshot, job.targetId, job.targetKind)
  .map(f => [f.id, f.owner, f.count, f.arriving, f.arrival].join(':')).sort()].join('|');

/** One inventory ledger and scan coordinator; each mode owns its planning/execution lane. */
export class Commander {
  states: Record<Mode, ExpansionState> = { expansion: idleState(), attack: idleState() };
  private configs: Partial<Record<Mode, ModeConfig>> = {};
  private world?: ExpansionWorld;
  private working = false;
  private run?: Promise<void>;
  private revision = 0;
  private nextScan = 0;
  private scanPlans = new Set<Mode>();
  private expansionFleets = new Map<string, string>();
  private nextPlan: Record<Mode, number> = { expansion: 0, attack: 0 };
  private tasks = new Map<Mode, Promise<void>>();
  private cancellations = new Map<Mode, AbortController>();
  private wake?: () => void;
  private pendingSources = new Set<bigint>();
  private inventoryRevision = 0;
  private pendingTargets = new Set<string>();
  private attackReservations = new Map<bigint, number>();
  private coveredRevision = -1;
  private scanning = false;
  private scanTask?: Promise<void>;
  private planningTask?: Promise<void>;
  private frontierTask?: Promise<void>;
  private frontierCancel?: AbortController;
  private frontier = new FrontierPlanner();
  private frontierQuotes = new PlanningQuotes();
  private nextFrontier = 0;
  private meteoriteTask?: Promise<void>;
  private meteoriteCancel?: AbortController;
  private meteoritePlanner = new MeteoriteFrontier();
  private meteoriteQuotes = new PlanningQuotes();
  private nextMeteorite = 0;
  private planningCancel?: AbortController;
  private planner = new BackgroundPlanner();
  private planningQuotes = new PlanningQuotes();
  private expansionQuoteVersion?: string;
  private planningMs = 0;
  private failure?: Error;
  private reconnectAt: number | null = null;
  private identity?: string;
  private flights = new Map<string, Flight>();
  private debits = new Map<bigint, number>();
  private expansionStock = new Map<bigint, number>();
  private expansionPending = new Map<bigint, number>();
  private expansionObservers = new Set<Promise<void>>();
  private inventoryDirty = new Set<bigint>();
  private inventoryRecovery?: Promise<void>;
  private nextInventoryRetry = 0;
  private expansionDelay = 0;
  private lastExpansionSupply = false;
  private saving?: { key: string; until: number };
  private savingCooldown = 0;
  private offensive = new OffensivePlanner();
  // Each slot owns its in-flight deliveries and only its share of the common stock.
  private logistics = (['sun', 'sun', 'sun', 'planet'] as const).map(kind => ({
    planner: new LogisticsPlanner(kind), reserves: new Map<bigint, number>(),
  }));
  private resetLogistics() {
    for (const slot of this.logistics) { slot.planner.reset(); slot.reserves.clear(); }
    this.states.expansion.suns = []; this.states.expansion.logistics = [];
  }
  private logisticsTask?: Promise<void>;
  private logisticsCancel?: AbortController;
  private logisticsRevision = 0;
  private nextLogistics = 0;
  private logisticsReservations = new Map<bigint, number>();
  private upgrades = new StableUpgrades();
  private journal = new ExpansionJournal();
  private supplies: { hub: bigint; deliveries: Supply[] }[] = [];
  constructor(private update: (mode: Mode, state: ExpansionState) => void, private createWorld: () => ExpansionWorld) {}
  private emit(mode: Mode, phase?: string, activity?: ExpansionActivity) {
    const state = this.states[mode];
    state.diagnostics = this.world?.diagnostics?.();
    if (phase) state.phase = phase;
    if (activity) state.activity = activity;
    state.work = { ...state.work, scanning: this.scanning, background: mode === 'expansion' ? this.expansionObservers.size : 0,
      inventory: mode === 'expansion' ? this.inventoryDirty.size : 0 };
    this.update(mode, { ...state, work: { ...state.work }, queue: [...state.queue] });
  }
  private interruptWaiting() { this.scanPlans.clear(); this.planningCancel?.abort(); this.meteoriteCancel?.abort(); this.frontierCancel?.abort(); this.logisticsCancel?.abort(); for (const controller of this.cancellations.values()) controller.abort(); this.wake?.(); }
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
    if (mode === 'attack') config = { ...config, settings: { ...config.settings, peacefulDevelopment: 0, intervalMs: 1000, captureSuns: 0, captureMeteorites: 0, upgradeStable: 0 } };
    validateSettings(config.settings); validatePolicy(config.policy, mode);
    if (mode === 'expansion' && config.settings.peacefulDevelopment) config = { ...config, settings: { ...config.settings, captureSuns: 0, captureMeteorites: 1, cautiousExpansion: 1 } };
    if (mode === 'attack') this.offensive.reset();
    else { this.resetLogistics(); this.nextLogistics = 0; this.frontier.reset(); this.frontierQuotes.clear(); this.meteoritePlanner = new MeteoriteFrontier(); this.meteoriteQuotes.clear(); this.nextMeteorite = 0; this.nextFrontier = 0; this.expansionDelay = 0; this.upgrades.reset(); this.journal = new ExpansionJournal(); this.planningQuotes.clear(); }
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
      if (m === 'expansion') { this.planner.dispose(); this.resetLogistics(); this.nextLogistics = 0; this.frontier.reset(); this.frontierQuotes.clear(); this.meteoritePlanner = new MeteoriteFrontier(); this.meteoriteQuotes.clear(); this.nextMeteorite = 0; this.logisticsReservations.clear(); this.upgrades.reset(); this.planningQuotes.clear(); }
      if (m === 'attack') { this.attackReservations.clear(); this.saving = undefined; this.savingCooldown = 0; this.offensive.reset(); this.states.attack.rally = undefined; this.states.attack.rallies = undefined; }
      if (this.states[m].running) this.emit(m, '正在停止；已发射舰队仍继续航行', 'stopping');
    }
    this.revision++; this.nextScan = 0; this.nextPlan = { expansion: 0, attack: 0 }; this.interruptWaiting();
  }
  private finishStopped() {
    for (const mode of modes) if (!this.configs[mode] && !this.tasks.has(mode) && !this.failure && this.states[mode].running) {
      this.states[mode].running = false; this.states[mode].nextScanAt = null; this.states[mode].work = undefined;
      this.emit(mode, '已停止；未发射任务已取消，已发射舰队仍继续航行', 'stopped');
    }
  }
  private fail(error: unknown) {
    if (this.failure || !this.active && !unresolved()) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.configs = {}; this.attackReservations.clear(); this.revision++; this.interruptWaiting();
    for (const mode of modes) if (this.states[mode].running) this.emit(mode, this.failure.message, 'error');
  }
  private recover(error: unknown) {
    if (!this.configs.expansion || unresolved()) { this.fail(error); return; }
    if (this.reconnectAt !== null) return;
    if (this.configs.attack) this.stop('attack');
    this.revision++; this.nextScan = 0; this.scanPlans.clear(); this.interruptWaiting();
    this.states.expansion.queue = []; this.states.expansion.nextScanAt = null;
    this.planner.dispose();
    this.logisticsReservations.clear(); this.upgrades.reset();
    this.planningQuotes.clear(); this.resetLogistics(); this.nextLogistics = 0; this.frontier.reset(); this.frontierQuotes.clear(); this.meteoritePlanner = new MeteoriteFrontier(); this.meteoriteQuotes.clear(); this.nextMeteorite = 0;
    this.reconnectAt = Date.now() + 5000;
    this.emit('expansion', `连接或情报暂不可用，5 秒后自动尝试恢复：${error instanceof Error ? error.message : String(error)}`, 'paused');
  }
  private async loop() {
    try {
      await withControl(async () => {
        try {
          if (!this.active) return;
          while (this.active) {
            try {
              if (this.reconnectAt !== null) {
                if (Date.now() < this.reconnectAt) { await this.wait(Math.min(1000, this.reconnectAt - Date.now())); continue; }
                await this.scanTask; await this.planningTask; await this.frontierTask; await this.meteoriteTask; await this.logisticsTask;
                await Promise.all(this.tasks.values()); await Promise.all(this.expansionObservers); await this.inventoryRecovery;
                this.world?.dispose(); this.world = undefined; this.reconnectAt = null;
                if (!this.active) break;
              }
              this.world ??= this.createWorld();
              if (document.visibilityState === 'hidden' && !this.configs.expansion) {
                for (const mode of modes) if (this.configs[mode]) { this.states[mode].nextScanAt = null; this.emit(mode, '页面在后台，暂停发射；返回后重新扫描', 'paused'); }
                this.nextScan = 0; this.interruptWaiting(); await this.wait(500);
              } else await this.tick();
            } catch (error) { this.recover(error); }
            this.finishStopped();
            if (this.active) await this.wait(250);
          }
        } catch (error) { this.fail(error); }
        finally {
          // Keep ownership, subscriptions and inventory barriers alive until both
          // lanes settle, including a second receipt after the first lane fails.
          await Promise.all(this.tasks.values());
          await this.scanTask; await this.planningTask; await this.frontierTask; await this.meteoriteTask; await this.logisticsTask;
          await Promise.all(this.expansionObservers);
          await this.inventoryRecovery;
        }
      });
    } catch (error) { this.fail(error); }
    finally {
      this.finishStopped();
      this.world?.dispose(); this.world = undefined; this.configs = {}; this.working = false;
      this.planner.dispose();
      this.planningQuotes.clear(); this.resetLogistics(); this.nextLogistics = 0; this.frontier.reset(); this.frontierQuotes.clear(); this.meteoritePlanner = new MeteoriteFrontier(); this.meteoriteQuotes.clear(); this.nextMeteorite = 0;
      this.reconnectAt = null; this.identity = undefined;
      this.saving = undefined; this.debits.clear(); this.pendingSources.clear(); this.pendingTargets.clear(); this.attackReservations.clear();
      this.expansionStock.clear(); this.expansionPending.clear(); this.inventoryDirty.clear(); this.expansionFleets.clear();
      this.logisticsReservations.clear(); this.upgrades.reset();
      for (const mode of modes) if (this.states[mode].running) {
        this.states[mode].running = false; this.states[mode].queue = []; this.states[mode].nextScanAt = null; this.emit(mode);
      }
    }
  }
  private budgets(snapshot: WorldSnapshot, sources?: Set<bigint>) {
    const stock = new Map(snapshot.budgets);
    // A local upper bound permits another launch from the same source without
    // subtracting an already-applied send from the live cache a second time.
    for (const [id, left] of this.expansionStock) stock.set(id, Math.min(stock.get(id) ?? 0, left));
    const budgets = availableBudgets({ ...snapshot, budgets: stock, owned: sources ? snapshot.owned.filter(p => sources.has(p.planetId)) : snapshot.owned }, this.activeConfigs(), this.debits);
    // The cache may already reflect a launch before its acknowledgement/barrier.
    // Only these unsynchronized sources wait; other sources remain independent.
    for (const id of this.pendingSources) budgets.set(id, 0);
    return budgets;
  }
  private reconcile(snapshot: WorldSnapshot, inventoryBarrier = true) {
    // Legacy adapters release settled debits at the scan barrier. Never clear an
    // in-flight debit when the other lane performs a periodic coverage scan.
    if (inventoryBarrier) for (const id of this.debits.keys()) if (!this.pendingSources.has(id)) this.debits.delete(id);
    if (inventoryBarrier && !this.world?.syncInventory) for (const id of this.inventoryDirty) if (!this.expansionPending.has(id)) {
      this.expansionStock.delete(id); this.inventoryDirty.delete(id);
    }
    this.supplies = this.supplies.filter(s => s.deliveries.some(d => Date.now() < d.arrival + 5000));
    const owned = new Set((snapshot.allOwned ?? snapshot.owned).map(p => p.planetId));
    for (const [id, flight] of this.flights) {
      const state = this.states[flight.mode];
      const job = flight.job;
      const captured = !job.targetKind || job.targetKind === 'planet' ? owned.has(job.targetId)
        : !!snapshot.identity && bodyFor(snapshot, job.targetId, job.targetKind)?.ownerId?.toHexString() === snapshot.identity;
      if (captured) {
        state.captured++; this.flights.delete(id); this.inventoryRevision++;
        if (flight.mode === 'expansion') this.journal.captured(job, snapshot);
        if (flight.mode === 'attack' && this.configs.attack) this.offensive.captured(job.targetId, this.configs.attack);
        if (this.configs[flight.mode]) this.emit(flight.mode, `已确认占领${targetLabel(job)}`, 'captured');
      } else if (Date.now() >= flight.due + 5000 && !bodyFleetsFor(snapshot, job.targetId, job.targetKind).length
        && (job.targetKind && job.targetKind !== 'planet' || !snapshot.incoming.has(job.targetId))) {
        state.missed++; this.flights.delete(id); this.inventoryRevision++;
        if (this.configs[flight.mode]) this.emit(flight.mode, `舰队已结束航行，未确认占领${targetLabel(job)}；重新评估`, 'waiting');
      }
    }
    this.journal.observe(snapshot); this.states.expansion.metrics = this.journal.snapshot();
    if (this.configs.expansion) this.upgrades.observe(snapshot, this.configs.expansion);
  }
  private pendingSupply(hub: bigint): Supply {
    // Track each route separately: part of a batch may already be in the hub's stock.
    // The acknowledged ledger remains for reconciliation, but elapsed promises are not
    // added to actual inventory again when funding the next campaign.
    const pending = this.supplies.filter(s => s.hub === hub).flatMap(s => s.deliveries).filter(s => s.arrival > Date.now());
    return { count: pending.reduce((n, s) => n + s.count, 0), arrival: Math.max(Date.now(), ...pending.map(s => s.arrival)) };
  }
  private flightCount(mode: Mode) { return [...this.flights.values()].filter(f => f.mode === mode).length + (mode === 'attack' ? this.supplies.length : this.logistics.filter(slot => slot.planner.kind === 'sun' && slot.planner.gathering).length); }
  private planned(mode: Mode) {
    if (!this.scanPlans.delete(mode) || this.scanPlans.size) return;
    // Coverage and planning form one scan round. Receipts and draining its queue
    // are deliberately outside this clock.
    this.nextScan = Date.now() + Math.min(...this.activeConfigs().map(c => c.settings.scanMs));
    for (const active of modes) if (this.configs[active]) {
      this.states[active].nextScanAt = this.nextScan;
      this.emit(active);
    }
  }
  private async scan(world: ExpansionWorld, coverageOnly = false) {
      const revision = this.revision, configs = this.activeConfigs();
      const settings = { ...configs[0].settings, radius: Math.max(...configs.map(c => c.settings.radius)) };
      if (!coverageOnly) {
        this.nextScan = Infinity; this.scanPlans.clear();
        for (const mode of modes) if (this.configs[mode]) this.states[mode].nextScanAt = null;
      }
      world.configure?.(configs);
      this.scanning = true;
      for (const mode of modes) if (this.configs[mode]) this.emit(mode, coverageOnly ? '正在补充新来源覆盖，当前规划与队列继续…' : '正在扫描内存情报与战区覆盖，已有队列继续执行…', 'scanning');
      try { await world.scan(settings, () => this.active && revision === this.revision && this.reconnectAt === null); } finally { this.scanning = false; }
      if (!this.active || revision !== this.revision) return;
      this.coveredRevision = revision;
      const snapshot = world.read();
      if (this.identity !== undefined && snapshot.identity !== this.identity) { this.fail(new Error('游戏身份已变化，已停止；请重新手动启动。')); return; }
      this.identity ??= snapshot.identity;
      this.reconcile(snapshot);
      if (this.configs.attack && this.states.attack.lastScanAt === null) {
        const issue = attackStartupIssue(snapshot, this.configs.attack);
        if (issue) {
          const state = this.states.attack;
          state.ownedCount = snapshot.owned.filter(p => inZone(p, this.configs.attack!.policy.zone)).length;
          state.lastScanAt = Date.now(); state.nextScanAt = null; state.running = false;
          delete this.configs.attack; this.attackReservations.clear(); this.offensive.reset();
          this.revision++; this.nextScan = 0; this.interruptWaiting();
          this.emit('attack', issue, 'error');
          return; // Rescan remaining expansion coverage before any new dispatch.
        }
      }
      if (!coverageOnly) this.scanPlans = new Set(modes.filter(mode => this.configs[mode] && (mode === 'expansion' || document.visibilityState !== 'hidden')));
      for (const mode of modes) if (this.configs[mode]) {
        const state = this.states[mode];
        state.lastScanAt = Date.now();
        if (!coverageOnly) state.nextScanAt = null;
        state.ownedCount = snapshot.owned.filter(p => inZone(p, this.configs[mode]!.policy.zone)).length;
        this.emit(mode, coverageOnly ? `补充覆盖完成：战区内 ${state.ownedCount} 颗己方星球；当前规划与扫描计时保留`
          : `扫描完成：战区内 ${state.ownedCount} 颗己方星球，开始评估目标`, 'scanning');
      }
      this.nextPlan = { expansion: 0, attack: 0 };
  }
  private async tick() {
    const world = this.world!;
    this.retryInventory(world);
    if (document.visibilityState === 'hidden') this.planned('attack');
    const needsCoverage = !this.scanTask && world.needsScan?.();
    if (!this.scanTask && (needsCoverage || !this.planningTask && !this.scanPlans.size && Date.now() >= this.nextScan)) {
      const revision = this.revision;
      const coverageOnly = !!needsCoverage && this.coveredRevision === revision
        && (!!this.planningTask || !!this.scanPlans.size || Date.now() < this.nextScan);
      this.scanTask = this.scan(world, coverageOnly).catch(error => { if (this.active && revision === this.revision) this.recover(error); })
        .finally(() => { this.scanTask = undefined; this.wake?.(); });
    }
    // Only initial/configuration coverage gates dispatch. Routine scans run beside
    // the existing queue and cannot cancel its rate-limit wait or erase its jobs.
    if (this.coveredRevision !== this.revision) {
      await this.scanTask;
      if (this.coveredRevision !== this.revision) return;
    }
    if (!this.active) return;
    // Attack reserves its concrete planned amounts before expansion reads the
    // common budget. Neither lane waits for the other lane's cooldown or receipt.
    for (const mode of ['attack', 'expansion'] as const) {
      const config = this.configs[mode];
      if (!config || mode === 'attack' && (document.visibilityState === 'hidden' || this.tasks.has(mode) || Date.now() < this.nextPlan[mode])) continue;
      if (mode === 'expansion') {
        if (!this.meteoriteTask && Date.now() >= this.nextMeteorite && config.settings.captureMeteorites) {
          const controller = new AbortController(); this.meteoriteCancel = controller;
          this.nextMeteorite = Date.now() + 1000;
          this.meteoriteTask = this.updateMeteorites(config, controller.signal).catch(error => this.recover(error)).finally(() => {
            this.meteoriteTask = undefined; this.meteoriteCancel = undefined; this.wake?.();
          });
        }
        if (!config.settings.peacefulDevelopment && !this.logisticsTask && Date.now() >= this.nextLogistics) {
          const controller = new AbortController(); this.logisticsCancel = controller;
          this.nextLogistics = Date.now() + 1000;
          this.logisticsTask = this.updateLogistics(config, controller.signal).catch(error => this.recover(error)).finally(() => {
            this.logisticsTask = undefined; this.logisticsCancel = undefined; this.wake?.();
          });
        }
        if (!config.settings.peacefulDevelopment && !this.frontierTask && Date.now() >= this.nextFrontier) {
          const controller = new AbortController(); this.frontierCancel = controller;
          this.nextFrontier = Date.now() + 1000;
          this.frontierTask = this.updateFrontier(config, controller.signal).catch(error => this.recover(error)).finally(() => {
            this.frontierTask = undefined; this.frontierCancel = undefined;
            this.states.expansion.work = { ...this.states.expansion.work, frontier: undefined };
            this.emit('expansion'); this.wake?.();
          });
        }
        // Refill near depletion without turning one slow historical round into
        // a permanent request to recompute a full queue on every tick.
        const refillAt = Math.max(3, Math.min(20, Math.ceil(this.planningMs / config.settings.intervalMs) + 3));
        if (!this.scanTask && !this.planningTask && Date.now() >= this.nextPlan.expansion && (this.scanPlans.has(mode)
          || this.states.expansion.queue.length <= refillAt)) {
          const controller = new AbortController(); this.planningCancel = controller;
          this.planningTask = this.runLane(mode, config, controller.signal).catch(error => this.recover(error)).finally(() => {
            this.planningTask = undefined; this.planningCancel = undefined;
            this.states.expansion.work = { ...this.states.expansion.work, plan: undefined }; this.emit('expansion'); this.wake?.();
          });
        }
        const supply = this.states.expansion.queue.find(job => job.kind === 'sun-supply' || job.kind === 'expansion-supply');
        const capture = this.states.expansion.queue.find(job => !job.kind);
        const job = this.lastExpansionSupply && capture ? capture : supply ?? this.states.expansion.queue[0];
        if (!job || this.tasks.has(mode)) continue;
        const controller = new AbortController(), revision = this.revision;
        this.cancellations.set(mode, controller);
        const current = () => !controller.signal.aborted && this.configs.expansion === config && revision === this.revision && !this.failure && this.reconnectAt === null;
        const task = this.executeJob(mode, config, controller.signal, current, job).catch(error => this.recover(error)).finally(() => {
          this.tasks.delete(mode); this.cancellations.delete(mode); this.wake?.();
        });
        this.tasks.set(mode, task);
        continue;
      }
      const controller = new AbortController(); this.cancellations.set(mode, controller);
      const task = this.runLane(mode, config, controller.signal).catch(error => this.fail(error)).finally(() => {
        this.tasks.delete(mode); this.cancellations.delete(mode);
        this.states[mode].work = { ...this.states[mode].work, plan: undefined, dispatch: undefined }; this.emit(mode); this.finishStopped();
        if (!this.active || !this.configs[mode]) this.wake?.();
      });
      this.tasks.set(mode, task);
    }
  }
  private campaignPlanner(job: Assignment) { return this.logistics[job.campaignSlot!].planner; }
  private fastBudgets(snapshot: WorldSnapshot) {
    const available = this.budgets(snapshot);
    for (const reserves of [this.attackReservations, this.logisticsReservations]) for (const [id, n] of reserves) available.set(id, Math.max(0, (available.get(id) ?? 0) - n));
    for (const job of this.states.expansion.queue) if (job.kind !== 'upgrade' && !job.campaignKind) {
      for (const m of members(job)) available.set(m.sourceId, Math.max(0, (available.get(m.sourceId) ?? 0) - m.count));
    }
    return available;
  }
  private async updateMeteorites(config: ModeConfig, signal: AbortSignal) {
    const world = this.world!, revision = this.revision;
    const current = () => !signal.aborted && revision === this.revision && this.configs.expansion === config && !this.failure && this.reconnectAt === null;
    const snapshot = world.read();
    if (snapshot.identity !== this.identity) { this.fail(new Error('游戏身份已变化，已停止')); return; }
    if (!snapshot.meteorites?.length) { this.states.expansion.meteorites = []; return; }
    this.retainCurrentRules(snapshot);
    const capacity = Math.floor(config.settings.horizonMs / config.settings.intervalMs) + 1;
    const queued = this.states.expansion.queue.filter(job => job.kind !== 'upgrade').length;
    if (queued >= capacity) {
      this.states.expansion.meteorites = snapshot.meteorites.slice(0, 6).map(t => ({ targetId: t.meteoriteId, reason: '规划队列窗口已满，等待释放位置后复查' })); return;
    }
    const locks = new Set([...this.flights.keys(), ...this.pendingTargets, ...this.states.expansion.queue.map(jobKey)]);
    const draft = this.meteoritePlanner.fork();
    const plan = await runPlanning(draft.steps(this.meteoriteQuotes.begin(world, snapshot), snapshot, config, this.fastBudgets(snapshot), locks,
      (queued + Number(this.tasks.has('expansion'))) * config.settings.intervalMs), current, () => world.refreshQuotes?.(), yieldToFrontier);
    if (!plan || !current()) return;
    this.meteoritePlanner = draft; this.states.expansion.meteorites = plan.reports;
    if (!plan.jobs.length) { this.emit('expansion'); return; }
    const fresh = world.read();
    if (fresh.identity !== snapshot.identity) return;
    const available = this.fastBudgets(fresh), accepted: Assignment[] = [];
    const seen = new Set([...this.flights.keys(), ...this.pendingTargets, ...this.states.expansion.queue.map(jobKey)]);
    const waiting = this.states.expansion.queue.filter(job => job.kind !== 'upgrade').length;
    for (const job of plan.jobs) {
      let reason: string | undefined;
      if (!sameJobRules(snapshot, fresh, job)) reason = '来源报价规则已变化，等待重新检查';
      else if (seen.has(jobKey(job))) reason = '已有舰队在途或任务排队';
      else if (!validSpecialTarget(job, fresh, config)) reason = specialTargetSkipReason(job, fresh, config);
      else if (!fresh.owned.some(p => p.planetId === job.sourceId) || job.count > (available.get(job.sourceId) ?? 0)) reason = '来源归属或共享可用兵力已变化';
      else if (waiting + accepted.length >= capacity) reason = '规划队列窗口已满';
      else if (Date.now() + (waiting + accepted.length + Number(this.tasks.has('expansion'))) * config.settings.intervalMs + job.travelMs + 5000 >= job.expiresAt!) reason = '当前排队和航程已无法赶在消失前抵达';
      if (reason) {
        this.states.expansion.meteorites = [{ targetId: job.targetId, reason }, ...(this.states.expansion.meteorites ?? []).filter(r => r.targetId !== job.targetId)].slice(0, 6); continue;
      }
      job.quoteRules = jobQuoteRules(fresh, job);
      available.set(job.sourceId, available.get(job.sourceId)! - job.count);
      accepted.push(job); seen.add(jobKey(job)); this.expansionFleets.set(jobKey(job), fleetState(fresh, job));
    }
    if (accepted.length) {
      this.states.expansion.queue = [...this.states.expansion.queue.filter(job => job.kind !== 'upgrade' || job.campaignKind), ...accepted];
      this.expansionQuoteVersion = fresh.quoteVersion;
      this.emit('expansion', `陨石快速规划：补入 ${accepted.length} 项，不等待全局规划`, 'queued');
    } else this.emit('expansion');
  }
  private rulesCurrent(job: Assignment, snapshot: WorldSnapshot) {
    return job.quoteRules !== undefined ? job.quoteRules === jobQuoteRules(snapshot, job) : this.expansionQuoteVersion === snapshot.quoteVersion;
  }
  private retainCurrentRules(snapshot: WorldSnapshot) {
    const previous = this.states.expansion.queue;
    this.states.expansion.queue = previous.filter(job => this.rulesCurrent(job, snapshot));
    const removed = previous.length - this.states.expansion.queue.length;
    if (removed) {
      this.nextLogistics = 0; this.nextPlan.expansion = 0;
      this.emit('expansion', `来源报价规则变化：释放 ${removed} 项受影响任务；其余队列与规划继续`, 'waiting');
    }
  }
  private async updateLogistics(config: ModeConfig, signal: AbortSignal) {
    const world = this.world!, revision = this.revision, logisticsRevision = this.logisticsRevision;
    const current = () => !signal.aborted && revision === this.revision && logisticsRevision === this.logisticsRevision
      && this.configs.expansion === config && !this.failure && this.reconnectAt === null;
    const started = performance.now(), snapshot = world.read();
    if (snapshot.identity !== this.identity) { this.fail(new Error('游戏身份已变化，已停止')); return; }
    if (!snapshot.intelligence) return;
    const spendable = (view: WorldSnapshot) => {
      const result = this.budgets(view);
      for (const [id, n] of this.attackReservations) result.set(id, Math.max(0, (result.get(id) ?? 0) - n));
      for (const job of this.states.expansion.queue) if (!job.campaignKind && job.kind !== 'upgrade') for (const m of members(job)) result.set(m.sourceId, Math.max(0, (result.get(m.sourceId) ?? 0) - m.count));
      return result;
    };
    const capacity = Math.floor(config.settings.horizonMs / config.settings.intervalMs) + 1;
    if (this.states.expansion.queue.filter(job => job.kind !== 'upgrade').length >= capacity) return;
    const invalid = new Set<Assignment>();
    const left = spendable(snapshot), drafts = this.logistics.map(slot => slot.planner.fork());
    const plans = new Map<number, LogisticsPlan>();
    const baseLocks = new Set([...this.flights.keys(), ...this.pendingTargets, ...this.states.expansion.queue.filter(job => !job.campaignKind).map(jobKey)]);
    const queuedBySlot = drafts.map((_, i) => this.states.expansion.queue.filter(job => job.campaignSlot === i));
    const remainingSuns = (locks: Set<string>) => snapshot.suns?.some(t => t.ownerId == null && inZone(t, config.policy.zone) && !locks.has(targetKey(t.sunId, 'sun')));
    const priority = (i: number) => queuedBySlot[i].length ? 0 : drafts[i].gathering ? 1 : 2;
    const order = drafts.map((_, i) => i).sort((a, b) => priority(a) - priority(b));
    const sunLimit = { routes: logisticsQuoteBudget, pairs: logisticsPairBudget };
    let noNewSun = false;
    for (const i of order) {
      const planner = drafts[i], kind = planner.kind;
      const queued = queuedBySlot[i].filter(job => {
        const target = bodyFor(snapshot, job.targetId, job.targetKind);
        const valid = job.kind === 'sun-supply' || job.kind === 'expansion-supply' ? planner.validSupply(job, snapshot, config)
          : job.kind === 'upgrade' ? planner.validUpgrade(job, snapshot, config, left.get(job.sourceId) ?? 0)
          : !!target && target.ownerId == null && target.probeCount === job.garrison && !bodyFleetsFor(snapshot, job.targetId, job.targetKind).length;
        if (!this.rulesCurrent(job, snapshot) || !valid || members(job).some(m => m.count > (left.get(m.sourceId) ?? 0))
          || (job.hubBudget ?? 0) > (left.get(job.targetId) ?? 0)) { invalid.add(job); return false; }
        return true;
      });
      const hubs = new Set<bigint>(), locks = new Set(baseLocks);
      for (const other of drafts) if (other !== planner) {
        if (other.hub !== undefined) hubs.add(other.hub);
        if (other.target !== undefined) locks.add(targetKey(other.target, other.kind));
      }
      let plan: LogisticsPlan | undefined;
      if (queued.length) {
        const reservations = new Map([...this.logistics[i].reserves].map(([id, n]) => [id, Math.min(n, left.get(id) ?? 0)]));
        plan = { reservations, hub: planner.hub, sun: kind === 'sun' ? planner.target : undefined,
          state: this.states.expansion.logistics?.find(state => state.kind === kind && state.target === planner.target) };
      } else if (kind === 'sun' && !planner.gathering && (noNewSun || !remainingSuns(locks))) {
        plan = { reservations: new Map() };
      } else {
        // Protect active projects even if their slot runs later. A shared donor
        // may contribute its remaining stock to several distinct hubs.
        const otherActiveSuns = order.slice(order.indexOf(i) + 1).filter(j => drafts[j].kind === 'sun' && drafts[j].gathering && !queuedBySlot[j].length).length;
        const limit = kind === 'sun' ? { routes: Math.floor(sunLimit.routes / (1 + otherActiveSuns)), pairs: sunLimit.pairs } : undefined;
        plan = await runPlanning(planner.steps(world, { ...snapshot, owned: snapshot.owned.filter(p => !hubs.has(p.planetId)) }, config, left, locks,
          hub => ({ percent: Math.max(0, ...this.activeConfigs().filter(c => inZone(hub, c.policy.zone)
            && snapshot.planets.some(p => hostile(p, snapshot) && distance(p, hub) <= c.policy.threatRadius)).map(c => c.policy.frontlinePercent)),
            deficit: Math.max(0, reserveFor(hub, snapshot, this.activeConfigs()) - (snapshot.budgets.get(hub.planetId) ?? 0)) }),
          limit), current, () => world.refreshQuotes?.(), yieldToFrontier);
        if (kind === 'sun') {
          sunLimit.routes -= planner.stats.routes; sunLimit.pairs -= planner.stats.checkedPairs;
          // An idle slot would otherwise repeat the same discovery from the start.
          if (!planner.gathering && planner.stats.checkedPairs) noNewSun = true;
        }
      }
      if (!plan || !current()) return;
      plans.set(i, plan);
      for (const [id, n] of plan.reservations) left.set(id, Math.max(0, (left.get(id) ?? 0) - n));
    }
    const fresh = world.read();
    if (!current() || snapshot.identity !== fresh.identity) return;
    // Hub forecasts and all donor routes must still use their original rules.
    for (const [i, plan] of plans) {
      // A fast capture may have been queued while this supply draft yielded.
      // Its destination is the campaign target, not the friendly supply hub.
      const target = drafts[i].target;
      if (target !== undefined) {
        const key = targetKey(target, drafts[i].kind);
        if (this.flights.has(key) || this.pendingTargets.has(key)
          || this.states.expansion.queue.some(job => !job.campaignKind && jobKey(job) === key)) return;
      }
      if (plan.job && !sameJobRules(snapshot, fresh, plan.job)) return;
      if (plan.hub !== undefined && !sameJobRules(snapshot, fresh, { sourceId: plan.hub, targetId: plan.hub, count: 0, travelMs: 0 })) return;
    }
    const available = spendable(fresh), additions: Assignment[] = [];
    let slots = Math.max(0, capacity - this.states.expansion.queue.filter(job => !invalid.has(job) && (job.kind !== 'upgrade' || job.campaignKind)).length);
    for (const [i, plan] of plans) {
      let job = plan.job;
      if (job && slots <= 0) {
        // Keep the campaign, but release donors for a batch outside this queue window.
        plan.job = job = undefined;
        plan.reservations = new Map([...plan.reservations].filter(([id]) => id === plan.hub));
      }
      if (job) {
        if (this.states.expansion.queue.some(queued => !invalid.has(queued) && jobKey(queued) === jobKey(job)) || this.flights.has(jobKey(job)) || this.pendingTargets.has(jobKey(job))) return;
        if (job.kind === 'sun-supply' || job.kind === 'expansion-supply') { if (!drafts[i].validSupply(job, fresh, config)) return; }
        else if (job.kind === 'upgrade') { if (!drafts[i].validUpgrade(job, fresh, config, available.get(job.sourceId) ?? 0)) return; }
        else if (fingerprint(bodyFor(snapshot, job.targetId, job.targetKind)) !== fingerprint(bodyFor(fresh, job.targetId, job.targetKind)) || fleetState(snapshot, job) !== fleetState(fresh, job)) return;
      }
      for (const [id, n] of plan.reservations) {
        if (n > (available.get(id) ?? 0)) return;
        available.set(id, available.get(id)! - n);
      }
      if (job) { job.campaignSlot = i; job.quoteRules = jobQuoteRules(fresh, job); additions.push(job); slots--; }
    }
    this.logistics = drafts.map((planner, i) => ({ planner, reserves: plans.get(i)!.reservations }));
    const reserves = new Map<bigint, number>();
    for (const plan of plans.values()) for (const [id, n] of plan.reservations) reserves.set(id, (reserves.get(id) ?? 0) + n);
    this.logisticsReservations = reserves;
    for (const job of additions) this.expansionFleets.set(jobKey(job), fleetState(fresh, job));
    if (additions.length || invalid.size) {
      this.states.expansion.queue = [...additions, ...this.states.expansion.queue.filter(job => !invalid.has(job) && (job.kind !== 'upgrade' || job.campaignKind))];
      this.expansionQuoteVersion = fresh.quoteVersion;
    }
    this.states.expansion.logistics = [...plans.values()].flatMap(plan => plan.state ? [plan.state] : []);
    this.states.expansion.suns = [...plans.values()].flatMap(p => p.sun === undefined ? [] : [{ target: p.sun, hub: p.hub, waiting: p.waiting }]);
    const routes = drafts.reduce((sum, p) => sum + p.stats.routes, 0), reused = drafts.reduce((sum, p) => sum + p.stats.reused, 0);
    this.states.expansion.work = { ...this.states.expansion.work, logisticsMs: performance.now() - started, logisticsRoutes: routes, logisticsReused: reused };
    this.emit('expansion', additions.length ? `后勤计划增量更新：新增 ${additions.length} 项；原生航路新算 ${routes} 条` : undefined,
      additions.length ? 'queued' : undefined);
  }
  private async updateFrontier(config: ModeConfig, signal: AbortSignal) {
    const world = this.world!, revision = this.revision;
    const current = () => !signal.aborted && this.configs.expansion === config && revision === this.revision && !this.failure && this.reconnectAt === null;
    const snapshot = world.read();
    if (this.identity !== undefined && snapshot.identity !== this.identity) { this.fail(new Error('游戏身份已变化，已停止；请重新手动启动。')); return; }
    // Active SDK subscriptions already carry occupation results. Do not hold
    // their counters/locks until an empire-wide proposal pass has finished.
    this.reconcile(snapshot, false);
    this.retainCurrentRules(snapshot);
    const remaining = (view: WorldSnapshot) => {
      const available = this.budgets(view);
      for (const reserves of [this.attackReservations, this.logisticsReservations]) for (const [id, n] of reserves) available.set(id, Math.max(0, (available.get(id) ?? 0) - n));
      for (const job of this.states.expansion.queue) {
        // Sun allocations are already accounted for by logisticsReservations.
        if (job.kind === 'upgrade' || job.campaignKind) continue;
        for (const m of members(job)) available.set(m.sourceId, Math.max(0, (available.get(m.sourceId) ?? 0) - m.count));
      }
      return available;
    };
    const locks = () => new Set([...this.flights.keys(), ...this.pendingTargets, ...this.states.expansion.queue.map(jobKey)]);
    const timing = planningTiming();
    this.states.expansion.work = { ...this.states.expansion.work, frontier: Date.now(), frontierTiming: timing }; this.emit('expansion');
    world.refreshQuotes?.();
    const quoteWorld = this.frontierQuotes.begin(world, snapshot);
    const jobs = await runPlanning(this.frontier.steps(quoteWorld, snapshot, config, remaining(snapshot), planetLocks(locks()),
      this.states.expansion.queue.filter(job => job.kind !== 'upgrade').length < 3), current, () => world.refreshQuotes?.(), yieldToFrontier, 8, timing);
    if (!jobs?.length || !current()) return;
    const fresh = world.read();
    if (fresh.identity !== snapshot.identity) return;
    const available = remaining(fresh), seen = locks(), accepted: Assignment[] = [];
    const owned = new Set(fresh.owned.map(p => p.planetId));
    const room = Math.max(0, Math.floor(config.settings.horizonMs / config.settings.intervalMs) + 1 - this.states.expansion.queue.filter(job => job.kind !== 'upgrade').length);
    for (const job of jobs) {
      if (accepted.length >= room) break;
      const key = jobKey(job), target = bodyFor(fresh, job.targetId);
      if (!sameJobRules(snapshot, fresh, job) || seen.has(key) || !target || target.ownerId != null || members(job).some(m => !owned.has(m.sourceId) || m.count > (available.get(m.sourceId) ?? 0))
        || fingerprint(target) !== fingerprint(bodyFor(snapshot, job.targetId)) || fleetState(snapshot, job) !== fleetState(fresh, job)
      ) continue;
      for (const m of members(job)) available.set(m.sourceId, available.get(m.sourceId)! - m.count);
      job.quoteRules = jobQuoteRules(fresh, job);
      accepted.push(job); seen.add(key); this.expansionFleets.set(key, fleetState(fresh, job));
    }
    if (!accepted.length) return;
    // Maintenance can be planned again later; it must not consume the queue
    // window or inventory needed by a newly reinforced frontline.
    this.states.expansion.queue = [...this.states.expansion.queue.filter(job => job.kind !== 'upgrade' || job.campaignKind), ...accepted]
      .sort((a, b) => Number(b.kind === 'sun-supply' || b.targetKind === 'sun') - Number(a.kind === 'sun-supply' || a.targetKind === 'sun') || completionMs(a) - completionMs(b));
    this.expansionQuoteVersion = snapshot.quoteVersion;
    this.emit('expansion', `前线增量规划：补入 ${accepted.length} 个附近目标；已有计划继续执行`, 'queued');
  }
  private async runLane(mode: Mode, config: ModeConfig, signal: AbortSignal) {
    const world = this.world!, planningRevision = this.revision, inventoryRevision = this.inventoryRevision;
    const current = () => !signal.aborted && this.configs[mode] === config && !this.failure && this.reconnectAt === null && planningRevision === this.revision && (mode === 'expansion' || document.visibilityState !== 'hidden');
    // Attack used to solve the whole empire again after every single send.
    // Consume its existing mixed queue between scans, with fresh quotes and
    // shared-budget validation inside executeJob (including failed-job release).
    if (mode === 'attack' && !this.scanPlans.has(mode) && this.states.attack.queue.length) {
      await this.executeJob(mode, config, signal, current, this.states.attack.queue[0]);
      return;
    }
    const planningStarted = performance.now();
    if (mode === 'expansion') {
      this.planner.resetTiming();
      this.states.expansion.work = { ...this.states.expansion.work, planningTiming: this.planner.timing };
    }
    const stage = (label: string) => {
      const work = this.states[mode].work;
      this.states[mode].work = { ...work, plan: { startedAt: work?.plan?.startedAt ?? Date.now(), stage: label } };
      this.emit(mode);
    };
    stage(mode === 'attack' ? '评估直攻与集结' : '读取库存与共享预算');
    const snapshot = world.read(), configs = this.activeConfigs();
    if (mode === 'expansion') this.retainCurrentRules(snapshot);
    const budgets = this.budgets(snapshot);
    const bodyLocked = new Set([...this.flights.keys(), ...this.pendingTargets]);
    const retained = mode === 'expansion' ? [...this.states.expansion.queue] : [];
    for (const job of retained) bodyLocked.add(jobKey(job));
    const locked = planetLocks(bodyLocked);
    const interval = config.settings.intervalMs;
    let attack: Assignment | undefined;
    const attackConfig = mode === 'attack' ? config : undefined;
    if (attackConfig) {
      for (const [id, count] of this.logisticsReservations) budgets.set(id, Math.max(0, (budgets.get(id) ?? 0) - count));
      const reserved = new Map<bigint, number>();
      const draft = this.offensive.fork();
      const plan = await runPlanning(draft.steps(world, snapshot, attackConfig, budgets, locked, hub => this.pendingSupply(hub), hub => ({
        percent: Math.max(0, ...configs.filter(c => inZone(hub, c.policy.zone)).map(c => c.policy.frontlinePercent)),
        deficit: Math.max(0, reserveFor(hub, snapshot, configs) - Math.max(0, (snapshot.budgets.get(hub.planetId) ?? 0) - (this.debits.get(hub.planetId) ?? 0))),
      })), () => current() && inventoryRevision === this.inventoryRevision, () => world.refreshQuotes?.());
      if (!plan || !current() || inventoryRevision !== this.inventoryRevision) return;
      this.offensive = draft;
      attack = plan.next;
      for (const [id, count] of plan.reservations) reserved.set(id, count);
      this.states.attack.rally = plan.rallyState; this.states.attack.rallies = plan.rallyStates;
      this.states.attack.attackDiagnostics = plan.diagnostics;
      this.states.attack.candidateCount = plan.candidates;
      this.states.attack.exact = plan.exact ?? false;
      let savingJob: Assignment | undefined;
      if (!attack && !plan.rallyState && plan.saving && Date.now() >= this.savingCooldown) {
        const key = `${plan.saving.sourceId}:${plan.saving.targetId}`;
        this.saving ??= { key, until: Date.now() + 120000 };
        if (Date.now() >= this.saving.until) { this.saving = undefined; this.savingCooldown = Date.now() + 60000; }
        else if (this.saving.key === key) { savingJob = plan.saving; reserved.set(plan.saving.sourceId, plan.saving.count); }
      } else if (attack || !plan.saving) this.saving = undefined;
      if (reserved.size !== this.attackReservations.size || [...reserved].some(([id, n]) => n !== this.attackReservations.get(id))) this.inventoryRevision++;
      this.attackReservations = reserved;
      this.states.attack.queue = plan.jobs ?? [];
      if (!attack) this.emit('attack', savingJob ? `正在为 #${savingJob.targetId} 攒兵：#${savingJob.sourceId} 需 ${savingJob.count}，当前可用 ${budgets.get(savingJob.sourceId) ?? 0}；最多预留 120 秒`
        : plan.waiting, 'waiting');
    }
    const expansionConfig = mode === 'expansion' ? config : undefined;
    let expansion: Assignment | undefined;
    if (expansionConfig) {
      // Dispatch can advance while this draft computes. Validate concrete jobs
      // against live budgets at publication instead of requiring global stillness.
      const planningCurrent = current;
      const quoteWorld = this.planningQuotes.begin(world, snapshot);
      const left = new Map(budgets);
      for (const [id, count] of this.attackReservations) left.set(id, Math.max(0, (left.get(id) ?? 0) - count));
      for (const [id, count] of this.logisticsReservations) left.set(id, Math.max(0, (left.get(id) ?? 0) - count));
      for (const job of retained) if (!job.campaignKind) for (const m of members(job)) left.set(m.sourceId, Math.max(0, (left.get(m.sourceId) ?? 0) - m.count));
      stage('筛选附近目标与合兵');
      let progressAt = 0;
      const proposals = await this.planner.proposals(quoteWorld, snapshot, expansionConfig, left, locked, signal, planningCurrent, (completed, total) => {
        const work = this.states.expansion.work;
        if (!work?.plan || !planningCurrent()) return;
        this.states.expansion.work = { ...work, plan: { ...work.plan, completed, total } };
        if (Date.now() - progressAt >= 250 || completed === total) { progressAt = Date.now(); this.emit('expansion'); }
      });
      if (!proposals || !planningCurrent()) return;
      const allocationSnapshot = world.read();
      if (allocationSnapshot.identity !== snapshot.identity) return;
      const currentEdges = proposals.edges.filter(job => sameJobRules(snapshot, allocationSnapshot, job));
      if (currentEdges.length < proposals.edges.length) this.emit('expansion', `报价规则变化：移除 ${proposals.edges.length - currentEdges.length} 个受影响候选，其余继续分配，不重启本轮`, 'waiting');
      const delay = retained.filter(job => job.kind !== 'upgrade').length * interval;
      stage('分配兵力与发射顺序');
      const plan = await this.planner.plan(world, currentEdges, left, interval,
        Math.max(0, expansionConfig.settings.horizonMs - delay), expansionConfig.settings.maxTravelMs, delay, signal, planningCurrent);
      if (!plan || !planningCurrent()) return;
      const captures = plan.jobs;
      const protectedSources = new Set([...this.logisticsReservations.keys(), ...this.attackReservations.keys(), ...captures.flatMap(job => members(job).map(m => m.sourceId))]);
      stage('检查后方升级');
      let maintenance = world.upgrade || world.upgradeMany ? await runPlanning(this.upgrades.steps(snapshot, config, left, protectedSources), planningCurrent, undefined, undefined, 8, this.planner.timing) : [];
      if (!maintenance || !planningCurrent()) return;
      if (inventoryRevision !== this.inventoryRevision) maintenance = [];
      const fresh = world.read(), available = this.budgets(fresh), seen = new Set([...this.flights.keys(), ...this.pendingTargets]);
      if (fresh.identity !== snapshot.identity) return;
      for (const [id, n] of this.attackReservations) available.set(id, Math.max(0, (available.get(id) ?? 0) - n));
      const candidates = [...this.states.expansion.queue.filter(job => job.campaignKind), ...this.states.expansion.queue.filter(job => !job.campaignKind && job.kind !== 'upgrade'), ...captures,
        ...this.states.expansion.queue.filter(job => !job.campaignKind && job.kind === 'upgrade'), ...maintenance];
      const isSun = (job: Assignment) => !!job.campaignKind;
      const proposedReservations = this.logisticsReservations;
      const reservations = new Map<bigint, number>();
      const queuedReservations = new Map<bigint, number>();
      for (const job of candidates.filter(isSun)) for (const member of members(job)) queuedReservations.set(member.sourceId, (queuedReservations.get(member.sourceId) ?? 0) + member.count);
      // Hold the campaign's hub stock even between supply batches. Queued jobs
      // debit their own allocations below, so each probe is reserved only once.
      for (const [id, count] of proposedReservations) {
        const held = Math.min(Math.max(0, count - (queuedReservations.get(id) ?? 0)), available.get(id) ?? 0);
        if (held > 0) { reservations.set(id, held); available.set(id, available.get(id)! - held); }
      }
      const jobs: Assignment[] = [], signatures = new Map<string, string>();
      let slots = 0, upgradeCount = 0;
      for (const job of candidates) {
        const retainedJob = this.states.expansion.queue.includes(job);
        if (retainedJob ? !this.rulesCurrent(job, fresh) : !sameJobRules(snapshot, fresh, job)) continue;
        const key = jobKey(job), signature = this.states.expansion.queue.includes(job) ? this.expansionFleets.get(key) : fleetState(snapshot, job);
        const target = bodyFor(fresh, job.targetId, job.targetKind);
        if (seen.has(key) || !target || signature !== fleetState(fresh, job) || (!job.kind && target.ownerId != null)) continue;
        if ((job.kind === 'sun-supply' || job.kind === 'expansion-supply') && !this.campaignPlanner(job).validSupply(job, fresh, config)) continue;
        if (job.targetKind === 'sun' && !validSpecialTarget(job, fresh, config)) continue;
        const required = new Map(members(job).map(m => [m.sourceId, m.count]));

        if ([...required].some(([id, count]) => count > (available.get(id) ?? 0))) continue;
        const slotCost = job.kind === 'upgrade' && world.upgradeMany ? Number(upgradeCount % maxUpgradeBatch === 0) : 1;
        if (slots + slotCost > Math.floor(config.settings.horizonMs / interval) + 1) continue;
        slots += slotCost; if (job.kind === 'upgrade') upgradeCount++;
        job.quoteRules = jobQuoteRules(fresh, job);
        jobs.push(job); seen.add(key); signatures.set(key, signature!);
        for (const [id, count] of required) {
          available.set(id, (available.get(id) ?? 0) - count);
          if (isSun(job)) reservations.set(id, (reservations.get(id) ?? 0) + count);
        }

      }

      // Commit the selected jobs and their reserves together, without an await.
      // A rejected new sun cannot reserve stock or evict a valid retained job.
      if (reservations.size !== this.logisticsReservations.size || [...reservations].some(([id, n]) => n !== this.logisticsReservations.get(id))) this.inventoryRevision++;
      this.logisticsReservations = reservations;
      const assigned = new Set(plan.jobs.flatMap(job => members(job).map(m => m.sourceId)));
      for (const job of jobs) for (const member of members(job)) assigned.add(member.sourceId);
      const idle = proposals.sources.filter(source => !assigned.has(source.sourceId)).sort((a, b) => b.available - a.available).slice(0, 6);
      this.states.expansion.planning = { sources: proposals.sources.length, ready: proposals.readySources, assigned: assigned.size, idle };
      this.states.expansion.queue = jobs; this.states.expansion.exact = plan.exact && !retained.length && !maintenance.length; this.states.expansion.candidateCount = proposals.candidates;
      this.states.expansion.decisions = jobs.slice(0, 5).map(decisionLabel);
      this.states.expansion.exposed = proposals.exposed;
      this.expansionFleets = signatures;
      this.expansionQuoteVersion = snapshot.quoteVersion;
      this.planningMs = performance.now() - planningStarted;
      if (jobs.length || this.scanPlans.has('expansion')) this.emit('expansion', `后台评估完成：${(this.planningMs / 1000).toFixed(1)} 秒，待执行 ${jobs.length} 项；队列已合并；报价新算 ${this.planningQuotes.stats.fresh} / 复用 ${this.planningQuotes.stats.reused}${proposals.deferredSources ? `；${proposals.deferredSources} 颗来源的剩余候选下轮续查` : ''}`, jobs.length ? 'queued' : 'waiting');
      expansion = jobs[0];
      if (!expansion) this.emit('expansion', `${config.settings.peacefulDevelopment ? '安稳发育：等待可占陨石或安全升级' : '暂无可执行扩张'}：${proposals.readySources}/${proposals.sources.length} 颗来源可出兵；${idle[0]?.reason ?? '战区内暂无己方来源'}`, 'waiting');
    }
    if (!current()) return;
    this.states[mode].work = { ...this.states[mode].work, plan: undefined };
    this.planned(mode);
    this.states[mode].flights = this.flightCount(mode); this.emit(mode);
    this.nextPlan[mode] = Date.now() + (inventoryRevision === this.inventoryRevision ? 1000 : 0);
    const job = mode === 'attack' ? attack : expansion;
    if (!job || mode === 'expansion') return;
    await this.executeJob(mode, config, signal, current, job);
  }
  private async executeUpgrades(config: ModeConfig, signal: AbortSignal, current: () => boolean) {
    const world = this.world!, revision = this.revision;
    const candidates: Assignment[] = [];
    for (const job of this.states.expansion.queue) {
      if (job.kind !== 'upgrade' || candidates.length === maxUpgradeBatch) break;
      candidates.push(job);
    }
    this.states.expansion.work = { ...this.states.expansion.work, dispatch: `等待批量升级 ${candidates.length} 颗的操作间隔` };
    this.emit('expansion', `准备批量升级 ${candidates.length} 颗星球；等待操作间隔`, 'queued');
    this.expansionDelay ||= expansionInterval(config.settings.intervalMs);
    try {
      await dispatchExpansion(() => {
        const fresh = world.read();
        if (!current() || this.coveredRevision !== revision) return null;
        this.upgrades.observe(fresh, config);
        const available = this.budgets(fresh), owned = new Map(fresh.owned.map(p => [p.planetId, p]));
        const protectedSources = new Set(this.states.expansion.queue.filter(job => job.kind !== 'upgrade').flatMap(job => members(job).map(m => m.sourceId)));
        const seen = new Set<bigint>();
        const jobs = candidates.filter(job => {
          const source = owned.get(job.sourceId), key = jobKey(job);
          if (!this.rulesCurrent(job, fresh) || !this.states.expansion.queue.includes(job) || seen.has(job.sourceId) || !source || !inZone(source, config.policy.zone)
            || source.level !== job.expectedLevel || this.flights.has(key) || this.pendingTargets.has(key)
            || this.expansionFleets.get(key) !== fleetState(fresh, job) || protectedSources.has(job.sourceId)
            || this.attackReservations.has(job.sourceId) || !job.campaignKind && this.logisticsReservations.has(job.sourceId)
            || job.count > (available.get(job.sourceId) ?? 0) || (job.campaignKind ? !this.campaignPlanner(job).validUpgrade(job, fresh, config, available.get(job.sourceId) ?? 0) : !this.upgrades.eligible(source, fresh, config))) return false;
          seen.add(job.sourceId); return true;
        });
        if (!jobs.length) return null;
        return () => {
          for (const job of jobs) {
            this.expansionStock.set(job.sourceId, Math.min(fresh.budgets.get(job.sourceId) ?? 0, this.expansionStock.get(job.sourceId) ?? Infinity) - job.count);
            this.expansionPending.set(job.sourceId, (this.expansionPending.get(job.sourceId) ?? 0) + 1);
            this.upgrades.launched(job);
            if (job.campaignKind) { this.campaignPlanner(job).launched(job, fresh); this.logisticsRevision++; }
          }
          this.inventoryRevision++; this.expansionDelay = 0;
          let receipt: Promise<void>;
          try { receipt = world.upgradeMany!(jobs.map(job => job.sourceId)); } catch (error) { receipt = Promise.reject(error); }
          this.emit('expansion', `已提交批量升级 ${jobs.length} 颗星球；后台核实，继续其他任务`, 'sent');
          const observer = this.observeExpansion(world, config, jobs[0], receipt, jobs).finally(() => { this.expansionObservers.delete(observer); this.emit('expansion'); });
          this.expansionObservers.add(observer);
        };
      }, this.expansionDelay, current, signal);
    } finally {
      this.states.expansion.queue = this.states.expansion.queue.filter(job => !candidates.includes(job));
      this.states.expansion.work = { ...this.states.expansion.work, dispatch: undefined }; this.emit('expansion');
    }
  }
  private async executeJob(mode: Mode, config: ModeConfig, signal: AbortSignal, current: () => boolean, job: Assignment) {
    const world = this.world!;
    if (mode === 'expansion' && job.kind === 'upgrade' && world.upgradeMany) { await this.executeUpgrades(config, signal, current); return; }
    const dispatchRevision = this.revision;
    this.states[mode].work = { ...this.states[mode].work, dispatch: `等待发射间隔 → ${targetLabel(job)}` };
    this.emit(mode, `准备${job.kind === 'upgrade' ? '升级 ' : job.kind ? '集结 ' : ' '}${sourceLabel(job)} → ${targetLabel(job)}，共 ${totalCount(job)} 探针；等待操作间隔`, 'queued');
    if (mode === 'expansion') {
      this.expansionDelay ||= expansionInterval(config.settings.intervalMs);
      let submitted = false, skipReason: string | undefined;
      const skip = (reason: string) => { skipReason = reason; return null; };
      try {
        await dispatchExpansion(() => {
          const fresh = world.read();
          if (!current()) return null;
          if (!this.rulesCurrent(job, fresh)) { this.nextPlan.expansion = 0; return skip('来源科技 / 覆盖规则已变化，仅释放本任务重新规划'); }
          if (!this.states.expansion.queue.includes(job)) return skip('任务已撤销或替换');
          if (this.coveredRevision !== dispatchRevision) return skip('当前配置的战区覆盖尚未就绪');
          if (this.flights.has(jobKey(job)) || this.pendingTargets.has(jobKey(job))) return skip('目标已有助手舰队在途或待确认');
          const target = bodyFor(fresh, job.targetId, job.targetKind);
          if (!target) return skip('目标已消失或不在当前情报中');
          if (!inZone(target, config.policy.zone)) return skip('目标不在固定战区内');
          if (this.expansionFleets.get(jobKey(job)) !== fleetState(fresh, job)) return skip('目标在途舰队已变化，避免重复或错误补兵');
          if (job.kind === 'sun-supply' || job.kind === 'expansion-supply') { if (!this.campaignPlanner(job).validSupply(job, fresh, config)) return skip('补给计划或中转星条件已变化'); }
          else if (job.kind === 'upgrade') {
            this.upgrades.observe(fresh, config);
            const source = fresh.owned.find(p => p.planetId === job.sourceId);
            if (!source || source.level !== job.expectedLevel || this.attackReservations.has(job.sourceId) || !job.campaignKind && this.logisticsReservations.has(job.sourceId) || (job.campaignKind ? !this.campaignPlanner(job).validUpgrade(job, fresh, config, this.budgets(fresh).get(job.sourceId) ?? 0) : !this.upgrades.eligible(source, fresh, config))) return skip('等级、升级预算或稳定条件已变化');
          } else if (job.targetKind && job.targetKind !== 'planet') { const reason = specialTargetSkipReason(job, fresh, config); if (reason) return skip(reason); }
          else if (target.ownerId != null) return skip('目标已有人占领');
          const contributions = members(job), sourceIds = new Set(contributions.map(m => m.sourceId));
          if (job.kind === 'sun-supply' || job.kind === 'expansion-supply') sourceIds.add(job.targetId);
          const available = this.budgets(fresh, sourceIds);
          const ownReserves = job.campaignKind ? this.logistics[job.campaignSlot!].reserves : undefined;
          if (job.kind === 'sun-supply' || job.kind === 'expansion-supply') {
            const otherHolds = Math.max(0, (this.logisticsReservations.get(job.targetId) ?? 0) - (ownReserves?.get(job.targetId) ?? 0));
            if ((available.get(job.targetId) ?? 0) - (this.attackReservations.get(job.targetId) ?? 0) - otherHolds < (job.hubBudget ?? 0)) return skip('中转星实际库存不足计划所需');
          }
          for (const m of contributions) {
            if (!fresh.owned.some(p => p.planetId === m.sourceId && inZone(p, config.policy.zone))) return skip(`来源 #${m.sourceId} 已失去所有权或不在战区内`);
            const own = ownReserves?.get(m.sourceId) ?? 0;
            const left = Math.max(0, (available.get(m.sourceId) ?? 0) - (this.attackReservations.get(m.sourceId) ?? 0)
              - Math.max(0, (this.logisticsReservations.get(m.sourceId) ?? 0) - Math.min(m.count, own)));
            if (m.count > left) return skip(`来源 #${m.sourceId} 共享可用兵力不足：需 ${m.count}，可用 ${left}`);
          }
          return () => {
            submitted = true;
            this.lastExpansionSupply = job.kind === 'sun-supply' || job.kind === 'expansion-supply';
            for (const m of contributions) {
              this.expansionStock.set(m.sourceId, Math.min(fresh.budgets.get(m.sourceId) ?? 0, this.expansionStock.get(m.sourceId) ?? Infinity) - m.count);
              this.expansionPending.set(m.sourceId, (this.expansionPending.get(m.sourceId) ?? 0) + 1);
            }
            this.inventoryRevision++; this.expansionDelay = 0;
            if (job.campaignKind) {
              this.campaignPlanner(job).launched(job, fresh); this.logisticsRevision++; this.nextLogistics = 0;
              for (const m of contributions) {
                this.logisticsReservations.set(m.sourceId, Math.max(0, (this.logisticsReservations.get(m.sourceId) ?? 0) - m.count));
                const reserved = this.logistics[job.campaignSlot!].reserves; reserved.set(m.sourceId, Math.max(0, (reserved.get(m.sourceId) ?? 0) - m.count));
              }
            }
            if (job.kind === 'sun-supply' || job.kind === 'expansion-supply') {
              // Friendly supply is tracked by its campaign, not as an occupation of the hub.
            } else if (job.kind === 'upgrade') this.upgrades.launched(job);
            else {
              this.flights.set(jobKey(job), { mode, job, due: Date.now() + Math.max(60000, completionMs(job) + 15000) });
            }
            if (job.kind !== 'upgrade') this.states.expansion.sent += contributions.length;
            this.journal.sent(job); this.states.expansion.metrics = this.journal.snapshot();
            this.states.expansion.flights = this.flightCount(mode);
            this.states.expansion.queue = this.states.expansion.queue.filter(queued => queued !== job);
            let receipt: Promise<void>;
            try { receipt = job.kind === 'upgrade' ? world.upgrade!(job.sourceId)
              : job.targetKind && job.targetKind !== 'planet' ? world.launchBody!(job)
              : job.kind === 'sun-supply' || job.kind === 'expansion-supply' || job.support?.length ? world.launchGroup!(job) : world.launch(job.sourceId, job.targetId, job.count); }
            catch (error) { receipt = Promise.reject(error); }
            this.emit(mode, `已提交${job.kind === 'upgrade' ? '升级' : '发射'} → ${targetLabel(job)}；后台确认，继续下一项`, 'sent');
            const observer = this.observeExpansion(world, config, job, receipt).finally(() => { this.expansionObservers.delete(observer); this.emit('expansion'); });
            this.expansionObservers.add(observer);
          };
        }, this.expansionDelay, current, signal);
      } finally {
        if (!submitted && skipReason && current()) {
          if (job.targetKind === 'comet') this.states.expansion.meteorites = [{ targetId: job.targetId, reason: skipReason }, ...(this.states.expansion.meteorites ?? []).filter(r => r.targetId !== job.targetId)].slice(0, 6);
          this.emit('expansion', `跳过${targetLabel(job)}：${skipReason}`, 'waiting');
        }
        this.states.expansion.work = { ...this.states.expansion.work, dispatch: undefined }; this.emit('expansion');
        this.states.expansion.queue = this.states.expansion.queue.filter(queued => queued !== job);
        if (!submitted && job.campaignKind) this.nextLogistics = 0;
      }
      return;
    }
    let actual: Assignment | undefined;
    let allocationReleased = false;
    const releaseAllocation = () => {
      if (allocationReleased || this.configs.attack !== config) return;
      allocationReleased = true;
      for (const m of members(job)) {
        const left = Math.max(0, (this.attackReservations.get(m.sourceId) ?? 0) - m.count);
        if (left) this.attackReservations.set(m.sourceId, left); else this.attackReservations.delete(m.sourceId);
      }
      this.inventoryRevision++;
    };
    let supplyDeliveries: { count: number; travelMs: number }[] = [];
    try { await dispatch(() => {
      const fresh = world.read();
      if (!current() || this.scanning || this.coveredRevision !== dispatchRevision || this.flights.has(jobKey(job)) || this.pendingTargets.has(jobKey(job))) return null;
      const target = fresh.planets.find(p => p.planetId === job.targetId);
      if (!target || !inZone(target, config.policy.zone)) return null;
      const available = this.budgets(fresh);
      for (const [id, count] of this.logisticsReservations) available.set(id, Math.max(0, (available.get(id) ?? 0) - count));
      const allocated = new Map(members(job).map(m => [m.sourceId, m.count]));
      const spendable = new Map(available);
      for (const [id, count] of this.attackReservations) spendable.set(id, Math.max(0, (available.get(id) ?? 0) - Math.max(0, count - (allocated.get(id) ?? 0))));
      if (members(job).some(m => !fresh.owned.some(p => p.planetId === m.sourceId && inZone(p, config.policy.zone)))) return null;
      const source = fresh.owned.find(p => p.planetId === job.sourceId)!;
      const refreshed = job.kind === 'reinforce' ? this.offensive.refresh(world, fresh, config, available, job)
        : attackQuote(world, fresh, source, target, config);
      // Rally refresh must see actual hub stock to notice that supplies already
      // arrived. Only outgoing members spend this job's reserved allocation.
      if (!refreshed || members(refreshed).some(m => m.count > (spendable.get(m.sourceId) ?? 0))) return null;
      actual = refreshed;
      for (const m of members(actual)) {
        this.pendingSources.add(m.sourceId);
        this.debits.set(m.sourceId, (this.debits.get(m.sourceId) ?? 0) + m.count);
      }
      releaseAllocation();
      this.pendingTargets.add(jobKey(actual)); this.inventoryRevision++;
      if (refreshed.kind === 'reinforce') supplyDeliveries = members(refreshed).map(m => ({ count: arriving(m.count, world.route!(m.sourceId, refreshed.targetId)!.lossPct), travelMs: m.travelMs }));
      return () => {
        this.states[mode].work = { ...this.states[mode].work, dispatch: `等待服务器确认 → #${refreshed.targetId}` };
        this.emit(mode, `正在${refreshed.kind === 'reinforce' ? `集结 ${members(refreshed).length} 颗来源` : '发送'} → #${refreshed.targetId}，${totalCount(refreshed)} 探针；等待服务器确认`, 'sending');
        return refreshed.support?.length ? world.launchGroup!(refreshed) : world.launch(refreshed.sourceId, refreshed.targetId, refreshed.count);
      };
    }, config.settings.intervalMs, current, mode, signal);
    if (actual) {
      if (actual.kind === 'reinforce') this.supplies.push({ hub: actual.targetId, deliveries: supplyDeliveries.map(s => ({ count: s.count, arrival: Date.now() + s.travelMs })) });
      else this.flights.set(jobKey(actual), { mode, job: actual, due: Date.now() + completionMs(actual) });
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
      this.states.attack.queue = this.states.attack.queue.filter(queued => queued !== job);
      // Release the planned allocation, even if the fresh quote changed or the
      // job became invalid. Other queue entries retain their concrete budgets.
      releaseAllocation();
      if (actual) {
        for (const m of members(actual)) this.pendingSources.delete(m.sourceId);
        this.pendingTargets.delete(jobKey(actual)); this.inventoryRevision++;
        this.nextPlan = { expansion: 0, attack: 0 };
        // Releasing an attack inventory barrier can make nearby captures viable
        // immediately. Wake bounded fast checks instead of waiting for a new round.
        this.nextFrontier = 0; this.nextMeteorite = 0; this.wake?.();
      }
      this.nextPlan[mode] = 0;
    }
  }
  private async observeExpansion(world: ExpansionWorld, config: ModeConfig, job: Assignment, receipt: Promise<void>, batch?: Assignment[]) {
    const active = () => this.configs.expansion === config && !this.failure;
    let acknowledged = false;
    try {
      await within(receipt, 15000); acknowledged = true;
      const flight = this.flights.get(jobKey(job));
      if (flight?.job === job) flight.due = Date.now() + completionMs(job);
      if (job.kind === 'upgrade' && !batch) { this.journal.upgraded(); this.states.expansion.metrics = this.journal.snapshot(); }
      if (active()) this.emit('expansion', batch ? `已确认批量升级请求：${batch.length} 颗；同步库存并核实等级` : job.kind === 'upgrade' ? `已确认升级星球 #${job.sourceId}；同步库存`
        : job.kind === 'sun-supply' || job.kind === 'expansion-supply' ? `已确认扩张补给 → 星球 #${job.targetId}；等待到账后单星出击`
        : `已确认发射 → ${targetLabel(job)}；等待抵达和占领确认`, 'sent');
    } catch (error) {
      if (active()) this.emit('expansion', `${batch ? `批量升级 ${batch.length} 颗` : `发射 → #${job.targetId}`}回执未确认：${error instanceof Error ? error.message : String(error)}；已跳过，继续其他目标`, 'waiting');
    }
    const sources = (batch ?? members(job)).map(m => m.sourceId);
    let synchronized = false;
    try {
      if (world.syncInventory) {
        await within(world.syncInventory(sources), 12000); synchronized = true;
        if (batch && acknowledged) {
          const fresh = world.read(), levels = new Map(fresh.owned.map(p => [p.planetId, p.level ?? 0]));
          const confirmed = batch.filter(item => (levels.get(item.sourceId) ?? 0) > item.expectedLevel!);
          for (const _item of confirmed) this.journal.upgraded();
          this.states.expansion.metrics = this.journal.snapshot();
          if (active()) this.emit('expansion', `批量升级核实：${confirmed.length}/${batch.length} 颗等级已提升${confirmed.length < batch.length ? '；其余未确认，不自动重发' : ''}`, 'sent');
        }
      }
    } catch {
      if (active()) this.emit('expansion', '库存同步暂不可用，保留本地扣账并在后台重试；其他任务继续', 'waiting');
    } finally {
      for (const id of sources) {
        const remaining = (this.expansionPending.get(id) ?? 1) - 1;
        if (remaining) this.expansionPending.set(id, remaining); else this.expansionPending.delete(id);
        if (synchronized && !remaining) { this.expansionStock.delete(id); this.inventoryDirty.delete(id); }
        else this.inventoryDirty.add(id);
      }
      this.inventoryRevision++; this.nextPlan = { expansion: 0, attack: 0 };
      if (!this.active || this.states.expansion.queue.length) this.wake?.();
    }
  }
  private retryInventory(world: ExpansionWorld) {
    if (!world.syncInventory || this.inventoryRecovery || Date.now() < this.nextInventoryRetry) return;
    const sources = [...this.inventoryDirty].filter(id => !this.expansionPending.has(id)).slice(0, 24);
    if (!sources.length) return;
    this.nextInventoryRetry = Date.now() + 5000;
    this.inventoryRecovery = within(world.syncInventory(sources), 12000).then(() => {
      for (const id of sources) if (!this.expansionPending.has(id)) { this.expansionStock.delete(id); this.inventoryDirty.delete(id); }
      this.inventoryRevision++; this.nextPlan = { expansion: 0, attack: 0 }; this.wake?.();
    }, () => { /* Retain conservative local stock and retry later without resending. */ }).finally(() => { this.inventoryRecovery = undefined; });
  }
}
