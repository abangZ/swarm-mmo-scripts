import { dispatch, dispatchExpansion, expansionInterval, unresolved, withControl, within } from '../../runtime/operations';
import type { ExpansionWorld, WorldSnapshot } from '../expansion/world';
import { bodyFleetsFor, bodyFor } from '../expansion/world';
import { completionMs, jobKey, members, planetLocks, sourceLabel, targetLabel, totalCount, validateSettings, type Assignment } from '../expansion/types';
import type { ExpansionActivity, ExpansionState } from '../expansion/engine';
import { BackgroundPlanner } from '../expansion/background-planner';
import { runPlanning } from '../../runtime/planning';
import { attackStartupIssue } from '../attack/diagnostics';
import { attackQuote } from '../attack/planner';
import { OffensivePlanner, type Supply } from '../attack/rally';
import { arriving } from '../expansion/cooperation';
import { availableBudgets, hostile, reserveFor } from './safety';
import { distance } from '../../shared/distance';
import { inZone, validatePolicy, type Mode, type ModeConfig } from './types';
import { meteoriteProposals, SunPlanner } from '../expansion/special-targets';
import { decisionLabel, ExpansionJournal, StableUpgrades, validSpecialTarget } from '../expansion/strategy';

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
  private planningCancel?: AbortController;
  private planner = new BackgroundPlanner();
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
  private saving?: { key: string; until: number };
  private savingCooldown = 0;
  private offensive = new OffensivePlanner();
  private sunPlanner = new SunPlanner();
  private sunReservations = new Map<bigint, number>();
  private upgrades = new StableUpgrades();
  private journal = new ExpansionJournal();
  private supplies: { hub: bigint; deliveries: Supply[] }[] = [];
  constructor(private update: (mode: Mode, state: ExpansionState) => void, private createWorld: () => ExpansionWorld) {}
  private emit(mode: Mode, phase?: string, activity?: ExpansionActivity) {
    const state = this.states[mode];
    if (phase) state.phase = phase;
    if (activity) state.activity = activity;
    this.update(mode, { ...state, queue: [...state.queue] });
  }
  private interruptWaiting() { this.scanPlans.clear(); this.planningCancel?.abort(); for (const controller of this.cancellations.values()) controller.abort(); this.wake?.(); }
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
    if (mode === 'attack') config = { ...config, settings: { ...config.settings, intervalMs: 1000, captureSuns: 0, captureMeteorites: 0, upgradeStable: 0 } };
    validateSettings(config.settings); validatePolicy(config.policy, mode);
    if (mode === 'attack') this.offensive.reset();
    else { this.expansionDelay = 0; this.upgrades.reset(); this.journal = new ExpansionJournal(); }
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
      if (m === 'expansion') { this.sunReservations.clear(); this.upgrades.reset(); }
      if (m === 'attack') { this.attackReservations.clear(); this.saving = undefined; this.savingCooldown = 0; this.offensive.reset(); this.states.attack.rally = undefined; this.states.attack.rallies = undefined; }
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
  private recover(error: unknown) {
    if (!this.configs.expansion || unresolved()) { this.fail(error); return; }
    if (this.reconnectAt !== null) return;
    if (this.configs.attack) this.stop('attack');
    this.revision++; this.nextScan = 0; this.scanPlans.clear(); this.interruptWaiting();
    this.states.expansion.queue = []; this.states.expansion.nextScanAt = null;
    this.sunReservations.clear(); this.upgrades.reset();
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
                await this.scanTask; await this.planningTask;
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
          await this.scanTask; await this.planningTask;
          await Promise.all(this.expansionObservers);
          await this.inventoryRecovery;
        }
      });
    } catch (error) { this.fail(error); }
    finally {
      this.finishStopped();
      this.world?.dispose(); this.world = undefined; this.configs = {}; this.working = false;
      this.planner.dispose();
      this.reconnectAt = null; this.identity = undefined;
      this.saving = undefined; this.debits.clear(); this.pendingSources.clear(); this.pendingTargets.clear(); this.attackReservations.clear();
      this.expansionStock.clear(); this.expansionPending.clear(); this.inventoryDirty.clear(); this.expansionFleets.clear();
      this.sunReservations.clear(); this.upgrades.reset();
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
  private reconcile(snapshot: WorldSnapshot) {
    // Legacy adapters release settled debits at the scan barrier. Never clear an
    // in-flight debit when the other lane performs a periodic coverage scan.
    for (const id of this.debits.keys()) if (!this.pendingSources.has(id)) this.debits.delete(id);
    if (!this.world?.syncInventory) for (const id of this.inventoryDirty) if (!this.expansionPending.has(id)) {
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
  private flightCount(mode: Mode) { return [...this.flights.values()].filter(f => f.mode === mode).length + (mode === 'attack' ? this.supplies.length : this.sunPlanner.gathering ? 1 : 0); }
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
  private async scan(world: ExpansionWorld) {
      const revision = this.revision, configs = this.activeConfigs();
      const settings = { ...configs[0].settings, radius: Math.max(...configs.map(c => c.settings.radius)) };
      this.nextScan = Infinity; this.scanPlans.clear();
      for (const mode of modes) if (this.configs[mode]) this.states[mode].nextScanAt = null;
      world.configure?.(configs);
      for (const mode of modes) if (this.configs[mode]) this.emit(mode, '正在扫描内存情报与战区覆盖，已有队列继续执行…', 'scanning');
      this.scanning = true;
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
      this.scanPlans = new Set(modes.filter(mode => this.configs[mode] && (mode === 'expansion' || document.visibilityState !== 'hidden')));
      for (const mode of modes) if (this.configs[mode]) {
        const state = this.states[mode];
        state.lastScanAt = Date.now(); state.nextScanAt = null;
        state.ownedCount = snapshot.owned.filter(p => inZone(p, this.configs[mode]!.policy.zone)).length;
        this.emit(mode, `扫描完成：战区内 ${state.ownedCount} 颗己方星球，开始评估目标`, 'scanning');
      }
      this.nextPlan = { expansion: 0, attack: 0 };
  }
  private async tick() {
    const world = this.world!;
    this.retryInventory(world);
    if (document.visibilityState === 'hidden') this.planned('attack');
    if (!this.scanTask && !this.planningTask && !this.scanPlans.size && (Date.now() >= this.nextScan || world.needsScan?.())) {
      const revision = this.revision;
      this.scanTask = this.scan(world).catch(error => { if (this.active && revision === this.revision) this.recover(error); })
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
        if (!this.scanTask && !this.planningTask && Date.now() >= this.nextPlan.expansion && (this.scanPlans.has(mode)
          || this.states.expansion.queue.length <= Math.max(3, Math.ceil(this.planningMs / config.settings.intervalMs) + 3))) {
          const controller = new AbortController(); this.planningCancel = controller;
          this.planningTask = this.runLane(mode, config, controller.signal).catch(error => this.recover(error)).finally(() => {
            this.planningTask = undefined; this.planningCancel = undefined; this.wake?.();
          });
        }
        const job = this.states.expansion.queue[0];
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
        this.tasks.delete(mode); this.cancellations.delete(mode); this.finishStopped();
        if (!this.active || !this.configs[mode]) this.wake?.();
      });
      this.tasks.set(mode, task);
    }
  }
  private async runLane(mode: Mode, config: ModeConfig, signal: AbortSignal) {
    const world = this.world!, planningRevision = this.revision, inventoryRevision = this.inventoryRevision;
    const current = () => !signal.aborted && this.configs[mode] === config && !this.failure && this.reconnectAt === null && planningRevision === this.revision && (mode === 'expansion' || document.visibilityState !== 'hidden');
    const planningStarted = performance.now();
    const snapshot = world.read(), configs = this.activeConfigs();
    const budgets = this.budgets(snapshot);
    const bodyLocked = new Set([...this.flights.keys(), ...this.pendingTargets]);
    const retained = mode === 'expansion' ? [...this.states.expansion.queue] : [];
    for (const job of retained) bodyLocked.add(jobKey(job));
    const locked = planetLocks(bodyLocked);
    const interval = config.settings.intervalMs;
    let attack: Assignment | undefined;
    const attackConfig = mode === 'attack' ? config : undefined;
    if (attackConfig) {
      for (const [id, count] of this.sunReservations) budgets.set(id, Math.max(0, (budgets.get(id) ?? 0) - count));
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
      const left = new Map(budgets);
      for (const [id, count] of this.attackReservations) left.set(id, Math.max(0, (left.get(id) ?? 0) - count));
      for (const job of retained) for (const m of members(job)) left.set(m.sourceId, Math.max(0, (left.get(m.sourceId) ?? 0) - m.count));
      const sunDraft = this.sunPlanner.fork();
      const retainedSun = retained.some(job => job.kind === 'sun-supply' || job.targetKind === 'sun');
      const sun = retainedSun ? { reservations: new Map(this.sunReservations), job: undefined, sun: undefined, hub: undefined, waiting: undefined }
        : await runPlanning(sunDraft.steps(world, snapshot, config, left, bodyLocked, hub => Math.max(0,
        ...configs.filter(c => inZone(hub, c.policy.zone) && snapshot.planets.some(p => hostile(p, snapshot) && distance(p, hub) <= c.policy.threatRadius)).map(c => c.policy.frontlinePercent))), planningCurrent, () => world.refreshQuotes?.());
      if (!sun || !planningCurrent()) return;
      for (const [id, count] of sun.reservations) left.set(id, Math.max(0, (left.get(id) ?? 0) - count));
      const proposals = await this.planner.proposals(world, snapshot, expansionConfig, left, locked, signal, planningCurrent);
      if (!proposals || !planningCurrent()) return;
      const meteorites = await runPlanning(meteoriteProposals(world, snapshot, config, left, bodyLocked), planningCurrent, () => world.refreshQuotes?.());
      if (!meteorites || !planningCurrent()) return;
      const delay = (retained.length + (sun.job ? 1 : 0)) * interval;
      const plan = await this.planner.plan(world, [...proposals.edges, ...meteorites], left, interval,
        Math.max(0, expansionConfig.settings.horizonMs - delay), expansionConfig.settings.maxTravelMs, delay, signal, planningCurrent);
      if (!plan || !planningCurrent()) return;
      // A retained sun job can launch while we compute: preserve its live campaign.
      // Otherwise this is the only producer of sun work, so ordinary sends cannot
      // invalidate the draft's campaign state.
      const publishSun = !retainedSun;
      const captures = [...(publishSun && sun.job ? [sun.job] : []), ...plan.jobs];
      const protectedSources = new Set([...this.attackReservations.keys(), ...sun.reservations.keys(), ...captures.flatMap(job => members(job).map(m => m.sourceId))]);
      let maintenance = world.upgrade ? await runPlanning(this.upgrades.steps(snapshot, config, left, protectedSources), planningCurrent) : [];
      if (!maintenance || !planningCurrent()) return;
      if (inventoryRevision !== this.inventoryRevision) maintenance = [];
      const fresh = world.read(), available = this.budgets(fresh), seen = new Set([...this.flights.keys(), ...this.pendingTargets]);
      for (const [id, n] of this.attackReservations) available.set(id, Math.max(0, (available.get(id) ?? 0) - n));
      const candidates = [...this.states.expansion.queue, ...captures, ...maintenance];
      const isSun = (job: Assignment) => job.kind === 'sun-supply' || job.targetKind === 'sun';
      const hasSunJob = candidates.some(isSun);
      const proposedReservations = publishSun ? sun.reservations : this.sunReservations;
      const nextSunPlanner = publishSun ? sunDraft : this.sunPlanner;
      const reservations = new Map<bigint, number>();
      const reserveWaiting = () => {
        for (const [id, count] of proposedReservations) {
          const held = Math.min(count, available.get(id) ?? 0);
          if (held > 0) { reservations.set(id, held); available.set(id, available.get(id)! - held); }
        }
      };
      // An already launched supply campaign keeps only its funded hub reserve.
      if (!hasSunJob && nextSunPlanner.gathering) reserveWaiting();
      const jobs: Assignment[] = [], signatures = new Map<string, string>();
      for (const job of candidates) {
        const key = jobKey(job), signature = this.states.expansion.queue.includes(job) ? this.expansionFleets.get(key) : fleetState(snapshot, job);
        const target = bodyFor(fresh, job.targetId, job.targetKind);
        if (seen.has(key) || !target || signature !== fleetState(fresh, job) || (!job.kind && target.ownerId != null)) continue;
        if (job.kind === 'sun-supply' && !nextSunPlanner.validSupply(job, fresh, config)) continue;
        if (job.targetKind === 'sun' && !validSpecialTarget(job, fresh, config)) continue;
        const required = new Map(members(job).map(m => [m.sourceId, m.count]));
        if (job.kind === 'sun-supply') required.set(job.targetId, job.hubBudget ?? 0);
        if ([...required].some(([id, count]) => count > (available.get(id) ?? 0))) continue;
        jobs.push(job); seen.add(key); signatures.set(key, signature!);
        for (const [id, count] of required) {
          available.set(id, (available.get(id) ?? 0) - count);
          if (isSun(job)) reservations.set(id, count);
        }
        if (jobs.length >= Math.floor(config.settings.horizonMs / interval) + 1) break;
      }
      if (hasSunJob && !jobs.some(isSun) && nextSunPlanner.gathering) reserveWaiting();
      // Commit the selected jobs and their reserves together, without an await.
      // A rejected new sun cannot reserve stock or evict a valid retained job.
      this.sunPlanner = nextSunPlanner;
      if (reservations.size !== this.sunReservations.size || [...reservations].some(([id, n]) => n !== this.sunReservations.get(id))) this.inventoryRevision++;
      this.sunReservations = reservations;
      const assigned = new Set(plan.jobs.flatMap(job => members(job).map(m => m.sourceId)));
      for (const job of jobs) for (const member of members(job)) assigned.add(member.sourceId);
      const idle = proposals.sources.filter(source => !assigned.has(source.sourceId)).sort((a, b) => b.available - a.available).slice(0, 6);
      this.states.expansion.planning = { sources: proposals.sources.length, ready: proposals.readySources, assigned: assigned.size, idle };
      this.states.expansion.queue = jobs; this.states.expansion.exact = plan.exact && !retained.length && !sun.job && !maintenance.length; this.states.expansion.candidateCount = proposals.candidates + new Set(meteorites.map(job => job.targetId)).size + (sun.sun ? 1 : 0);
      this.states.expansion.decisions = jobs.slice(0, 5).map(decisionLabel);
      this.states.expansion.exposed = proposals.exposed;
      if (publishSun) this.states.expansion.sun = sun.sun !== undefined && (!sun.job || jobs.includes(sun.job)) ? { target: sun.sun, hub: sun.hub, waiting: sun.waiting } : undefined;
      this.expansionFleets = signatures;
      this.planningMs = performance.now() - planningStarted;
      if (jobs.length || this.scanPlans.has('expansion')) this.emit('expansion', `后台评估完成：${(this.planningMs / 1000).toFixed(1)} 秒，待执行 ${jobs.length} 项；队列已合并`, jobs.length ? 'queued' : 'waiting');
      expansion = jobs[0];
      if (!expansion) this.emit('expansion', sun.waiting ?? `暂无可执行扩张：${proposals.readySources}/${proposals.sources.length} 颗来源可出兵；${idle[0]?.reason ?? '战区内暂无己方来源'}`, 'waiting');
    }
    if (!current()) return;
    this.planned(mode);
    this.states[mode].flights = this.flightCount(mode); this.emit(mode);
    this.nextPlan[mode] = Date.now() + (inventoryRevision === this.inventoryRevision ? 1000 : 0);
    const job = mode === 'attack' ? attack : expansion;
    if (!job || mode === 'expansion') return;
    await this.executeJob(mode, config, signal, current, job);
  }
  private async executeJob(mode: Mode, config: ModeConfig, signal: AbortSignal, current: () => boolean, job: Assignment) {
    const world = this.world!;
    const dispatchRevision = this.revision;
    this.emit(mode, `准备${job.kind === 'upgrade' ? '升级 ' : job.kind ? '集结 ' : ' '}${sourceLabel(job)} → ${targetLabel(job)}，共 ${totalCount(job)} 探针；等待操作间隔`, 'queued');
    if (mode === 'expansion') {
      this.expansionDelay ||= expansionInterval(config.settings.intervalMs);
      let submitted = false;
      try {
        await dispatchExpansion(() => {
          const fresh = world.read();
          if (!current() || !this.states.expansion.queue.includes(job) || this.coveredRevision !== dispatchRevision || this.flights.has(jobKey(job)) || this.pendingTargets.has(jobKey(job))) return null;
          const target = bodyFor(fresh, job.targetId, job.targetKind);
          if (!target || !inZone(target, config.policy.zone) || this.expansionFleets.get(jobKey(job)) !== fleetState(fresh, job)) return null;
          if (job.kind === 'sun-supply') { if (!this.sunPlanner.validSupply(job, fresh, config)) return null; }
          else if (job.kind === 'upgrade') {
            this.upgrades.observe(fresh, config);
            const source = fresh.owned.find(p => p.planetId === job.sourceId);
            if (!source || source.level !== job.expectedLevel || this.attackReservations.has(job.sourceId) || this.sunReservations.has(job.sourceId) || !this.upgrades.eligible(source, fresh, config)) return null;
          } else if (job.targetKind && job.targetKind !== 'planet') { if (!validSpecialTarget(job, fresh, config)) return null; }
          else if (target.ownerId != null) return null;
          const contributions = members(job), sourceIds = new Set(contributions.map(m => m.sourceId));
          if (job.kind === 'sun-supply') sourceIds.add(job.targetId);
          const available = this.budgets(fresh, sourceIds);
          if (job.kind === 'sun-supply' && (available.get(job.targetId) ?? 0) - (this.attackReservations.get(job.targetId) ?? 0) < (job.hubBudget ?? 0)) return null;
          if (contributions.some(m => !fresh.owned.some(p => p.planetId === m.sourceId && inZone(p, config.policy.zone))
            || m.count > Math.max(0, (available.get(m.sourceId) ?? 0) - (this.attackReservations.get(m.sourceId) ?? 0)
              - (job.kind === 'sun-supply' || job.targetKind === 'sun' ? 0 : this.sunReservations.get(m.sourceId) ?? 0)))) return null;
          return () => {
            submitted = true;
            for (const m of contributions) {
              this.expansionStock.set(m.sourceId, Math.min(fresh.budgets.get(m.sourceId) ?? 0, this.expansionStock.get(m.sourceId) ?? Infinity) - m.count);
              this.expansionPending.set(m.sourceId, (this.expansionPending.get(m.sourceId) ?? 0) + 1);
            }
            this.inventoryRevision++; this.expansionDelay = 0;
            if (job.kind === 'sun-supply') {
              this.sunPlanner.launched(job);
              this.sunReservations = new Map([...this.sunReservations].filter(([id]) => id === job.targetId));
            } else if (job.kind === 'upgrade') this.upgrades.launched(job);
            else {
              this.flights.set(jobKey(job), { mode, job, due: Date.now() + Math.max(60000, completionMs(job) + 15000) });
              if (job.targetKind === 'sun') { this.sunPlanner.launched(job); this.sunReservations.clear(); }
            }
            if (job.kind !== 'upgrade') this.states.expansion.sent += contributions.length;
            this.journal.sent(job); this.states.expansion.metrics = this.journal.snapshot();
            this.states.expansion.flights = this.flightCount(mode);
            this.states.expansion.queue = this.states.expansion.queue.filter(queued => queued !== job);
            let receipt: Promise<void>;
            try { receipt = job.kind === 'upgrade' ? world.upgrade!(job.sourceId)
              : job.targetKind && job.targetKind !== 'planet' ? world.launchBody!(job)
              : job.support?.length ? world.launchGroup!(job) : world.launch(job.sourceId, job.targetId, job.count); }
            catch (error) { receipt = Promise.reject(error); }
            this.emit(mode, `已提交${job.kind === 'upgrade' ? '升级' : '发射'} → ${targetLabel(job)}；后台确认，继续下一项`, 'sent');
            const observer = this.observeExpansion(world, config, job, receipt).finally(() => this.expansionObservers.delete(observer));
            this.expansionObservers.add(observer);
          };
        }, this.expansionDelay, current, signal);
      } finally {
        this.states.expansion.queue = this.states.expansion.queue.filter(queued => queued !== job);
        if (!submitted && (job.kind === 'sun-supply' || job.targetKind === 'sun')
          && !this.states.expansion.queue.some(next => next.kind === 'sun-supply' || next.targetKind === 'sun')) this.sunReservations.clear();
      }
      return;
    }
    let actual: Assignment | undefined;
    let supplyDeliveries: { count: number; travelMs: number }[] = [];
    try { await dispatch(() => {
      const fresh = world.read();
      if (!current() || this.scanning || this.coveredRevision !== dispatchRevision || this.flights.has(jobKey(job)) || this.pendingTargets.has(jobKey(job))) return null;
      const target = fresh.planets.find(p => p.planetId === job.targetId);
      if (!target || !inZone(target, config.policy.zone)) return null;
      const available = this.budgets(fresh);
      for (const [id, count] of this.sunReservations) available.set(id, Math.max(0, (available.get(id) ?? 0) - count));
      if (members(job).some(m => !fresh.owned.some(p => p.planetId === m.sourceId && inZone(p, config.policy.zone)))) return null;
      const source = fresh.owned.find(p => p.planetId === job.sourceId)!;
      const refreshed = job.kind === 'reinforce' ? this.offensive.refresh(world, fresh, config, available, job)
        : attackQuote(world, fresh, source, target, config);
      if (!refreshed || members(refreshed).some(m => m.count > (available.get(m.sourceId) ?? 0))) return null;
      actual = refreshed;
      for (const m of members(actual)) {
        this.pendingSources.add(m.sourceId);
        this.debits.set(m.sourceId, (this.debits.get(m.sourceId) ?? 0) + m.count);
        if (mode === 'attack') this.attackReservations.set(m.sourceId, Math.max(0, (this.attackReservations.get(m.sourceId) ?? 0) - m.count));
      }
      this.pendingTargets.add(jobKey(actual)); this.inventoryRevision++;
      if (refreshed.kind === 'reinforce') supplyDeliveries = members(refreshed).map(m => ({ count: arriving(m.count, world.route!(m.sourceId, refreshed.targetId)!.lossPct), travelMs: m.travelMs }));
      return () => {
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
      if (actual) {
        for (const m of members(actual)) this.pendingSources.delete(m.sourceId);
        this.pendingTargets.delete(jobKey(actual)); this.inventoryRevision++;
        this.nextPlan = { expansion: 0, attack: 0 };
      }
      this.nextPlan[mode] = 0;
    }
  }
  private async observeExpansion(world: ExpansionWorld, config: ModeConfig, job: Assignment, receipt: Promise<void>) {
    const active = () => this.configs.expansion === config && !this.failure;
    try {
      await within(receipt, 15000);
      const flight = this.flights.get(jobKey(job));
      if (flight?.job === job) flight.due = Date.now() + completionMs(job);
      if (job.kind === 'upgrade') { this.journal.upgraded(); this.states.expansion.metrics = this.journal.snapshot(); }
      if (active()) this.emit('expansion', job.kind === 'upgrade' ? `已确认升级星球 #${job.sourceId}；同步库存`
        : job.kind === 'sun-supply' ? `已确认恒星补给 → 星球 #${job.targetId}；等待到账后单星出击`
        : `已确认发射 → ${targetLabel(job)}；等待抵达和占领确认`, 'sent');
    } catch (error) {
      if (active()) this.emit('expansion', `发射回执未确认 → #${job.targetId}：${error instanceof Error ? error.message : String(error)}；已跳过，继续其他目标`, 'waiting');
    }
    const sources = members(job).map(m => m.sourceId);
    let synchronized = false;
    try {
      if (world.syncInventory) { await within(world.syncInventory(sources), 12000); synchronized = true; }
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
