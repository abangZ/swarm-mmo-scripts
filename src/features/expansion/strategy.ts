import type { Planet } from '../../game/types';
import { distance } from '../../shared/distance';
import { PlanetIndex } from '../../shared/planet-index';
import { hostile } from '../commander/safety';
import { inZone, type ModeConfig } from '../commander/types';
import { bodyFleetsFor, bodyFor, fleetsFor, type WorldSnapshot } from './world';
import { maxUpgradeBatch, jobKey, targetLabel, type Assignment } from './types';
import { finishPlanning } from '../../runtime/planning';

/** A geographic pressure signal, not a prediction of an enemy launch or ETA. */
export function riskEvaluator(snapshot: WorldSnapshot, config: ModeConfig) {
  const enemies = new PlanetIndex(snapshot.planets.filter(p => hostile(p, snapshot)));
  const friends = new PlanetIndex(snapshot.owned.filter(p => inZone(p, config.policy.zone)));
  return (target: Pick<Planet, 'positionX' | 'positionY'>): 'unknown' | 'low' | 'exposed' => {
    if (!snapshot.intelligence) return 'unknown';
    const nearby = enemies.near(target, config.policy.threatRadius);
    if (!nearby.length) return 'low';
    const enemyDistance = Math.min(...nearby.map(p => distance(p, target)));
    const friendDistance = Math.min(...friends.near(target, Math.max(8, config.policy.threatRadius)).map(p => distance(p, target)));
    return friendDistance > 8 && enemyDistance < friendDistance ? 'exposed' : 'low';
  };
}

export interface StrategyMetrics {
  sentProbes: number; planets: number; suns: number; meteorites: number; upgrades: number; addedBaseProduction: number;
  retention30: { held: number; total: number }; retention60: { held: number; total: number }; tracked: number;
}
interface Capture { job: Assignment; at: number; held: boolean; checked30: boolean }
/** Bounded session records. Meteorite expiry is not a territorial loss. */
export class ExpansionJournal {
  private captures = new Map<string, Capture>();
  private sequence = 0;
  private metrics: StrategyMetrics = { sentProbes: 0, planets: 0, suns: 0, meteorites: 0, upgrades: 0, addedBaseProduction: 0,
    retention30: { held: 0, total: 0 }, retention60: { held: 0, total: 0 }, tracked: 0 };
  sent(job: Assignment) { if (job.kind !== 'upgrade') this.metrics.sentProbes += job.count + (job.support ?? []).reduce((n, m) => n + m.count, 0); }
  upgraded() { this.metrics.upgrades++; }
  captured(job: Assignment, snapshot: WorldSnapshot) {
    if (job.targetKind === 'sun') this.metrics.suns++;
    else if (job.targetKind === 'comet') { this.metrics.meteorites++; return; }
    else { this.metrics.planets++; this.metrics.addedBaseProduction += snapshot.planets.find(p => p.planetId === job.targetId)?.level ?? 1; }
    if (this.captures.size >= 1000) this.captures.delete(this.captures.keys().next().value!);
    for (const capture of this.captures.values()) if (jobKey(capture.job) === jobKey(job)) capture.held = false;
    this.captures.set(`${jobKey(job)}:${++this.sequence}`, { job, at: Date.now(), held: true, checked30: false });
  }
  observe(snapshot: WorldSnapshot) {
    const owned = new Set((snapshot.allOwned ?? snapshot.owned).map(p => p.planetId));
    for (const [key, capture] of this.captures) {
      const { job } = capture;
      const held = job.targetKind === 'sun' ? !!snapshot.identity && bodyFor(snapshot, job.targetId, 'sun')?.ownerId?.toHexString() === snapshot.identity : owned.has(job.targetId);
      capture.held &&= held;
      const age = Date.now() - capture.at;
      if (age >= 1800000 && !capture.checked30) { this.metrics.retention30.total++; if (capture.held) this.metrics.retention30.held++; capture.checked30 = true; }
      if (age >= 3600000) { this.metrics.retention60.total++; if (capture.held) this.metrics.retention60.held++; this.captures.delete(key); }
    }
  }
  snapshot(): StrategyMetrics { return { ...this.metrics, retention30: { ...this.metrics.retention30 }, retention60: { ...this.metrics.retention60 }, tracked: this.captures.size }; }
}

/** Upgrade one level only after continuously observed peace and no nearby expansion opportunity. */
export class StableUpgrades {
  private safeSince = new Map<bigint, number>();
  private attempted = new Map<bigint, number>();
  reset() { this.safeSince.clear(); this.attempted.clear(); }
  observe(snapshot: WorldSnapshot, config: ModeConfig) {
    const enemies = new PlanetIndex(snapshot.planets.filter(p => hostile(p, snapshot)));
    const owned = new Set(snapshot.owned.map(p => p.planetId));
    for (const id of this.safeSince.keys()) if (!owned.has(id)) { this.safeSince.delete(id); this.attempted.delete(id); }
    for (const p of snapshot.owned) {
      const unsafe = !snapshot.intelligence || !inZone(p, config.policy.zone) || snapshot.automated?.has(p.planetId)
        || enemies.near(p, config.policy.threatRadius).length > 0 || fleetsFor(snapshot, p.planetId).length > 0;
      if (unsafe) this.safeSince.delete(p.planetId);
      else if (!this.safeSince.has(p.planetId)) this.safeSince.set(p.planetId, Date.now());
    }
  }
  eligible(p: Planet, snapshot: WorldSnapshot, config: ModeConfig): boolean {
    if (!config.settings.upgradeStable || !snapshot.intelligence || !Number.isInteger(p.level) || p.level! < 1 || p.level! >= 10
      || this.attempted.get(p.planetId) === p.level || Date.now() - (this.safeSince.get(p.planetId) ?? Infinity) < config.settings.stableMs) return false;
    const near = (target: Pick<Planet, 'positionX' | 'positionY'>) => inZone(target, config.policy.zone) && distance(p, target) <= config.settings.radius;
    // Even unaffordable neutral points keep a source in the expansion economy.
    if (snapshot.planets.some(t => t.ownerId == null && near(t))) return false;
    if (config.settings.captureSuns && snapshot.suns?.some(t => t.ownerId == null && near(t))) return false;
    if (config.settings.captureMeteorites && snapshot.meteorites?.some(t => t.ownerId == null && near(t) && Number(t.expiresAt.toMillis()) > Date.now() + 5000)) return false;
    return 100 * p.level! ** 2 * 60000 <= config.settings.economicHorizonMs;
  }
  plans(snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, protectedSources: Set<bigint>): Assignment[] {
    return finishPlanning(this.steps(snapshot, config, budgets, protectedSources));
  }
  *steps(snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, protectedSources: Set<bigint>): Generator<void, Assignment[]> {
    this.observe(snapshot, config);
    const jobs: Assignment[] = [];
    for (const p of snapshot.owned) {
      yield;
      if (protectedSources.has(p.planetId) || !this.eligible(p, snapshot, config)) continue;
      const cost = 100 * p.level! ** 2; // Undiscounted bound; never assume a technology discount.
      if (cost <= (budgets.get(p.planetId) ?? 0)) jobs.push({ sourceId: p.planetId, targetId: p.planetId, count: cost, travelMs: 0,
        kind: 'upgrade', expectedLevel: p.level, reason: `后方持续稳定 ${Math.floor(config.settings.stableMs / 60000)} 分钟，无附近无主目标；基础回本 ${cost} 分钟` });
      if (jobs.length === maxUpgradeBatch) break;
    }
    return jobs;
  }
  launched(job: Assignment) { if (job.expectedLevel !== undefined) this.attempted.set(job.sourceId, job.expectedLevel); }
}

export function validSpecialTarget(job: Assignment, snapshot: WorldSnapshot, config: ModeConfig): boolean {
  return specialTargetSkipReason(job, snapshot, config) === undefined;
}
export function specialTargetSkipReason(job: Assignment, snapshot: WorldSnapshot, config: ModeConfig): string | undefined {
  const target = bodyFor(snapshot, job.targetId, job.targetKind);
  if (!target) return '目标已消失或不在当前情报中';
  if (target.ownerId != null) return '目标已有人占领';
  if (!inZone(target, config.policy.zone)) return '目标不在固定战区内';
  if (bodyFleetsFor(snapshot, job.targetId, job.targetKind).length) return '目标已有其他舰队在途';
  if (job.garrison !== undefined && target.probeCount !== job.garrison) return `目标驻军已变化：${job.garrison} → ${target.probeCount}，需重新报价`;
  if (job.targetKind === 'comet') {
    const comet = snapshot.meteorites?.find(p => p.meteoriteId === job.targetId);
    const expires = comet ? Number(comet.expiresAt.toMillis()) : NaN;
    if (!Number.isFinite(expires)) return '目标到期时间不可用';
    if (expires <= Date.now() + job.travelMs + 5000) return `剩余寿命 ${Math.max(0, Math.floor((expires - Date.now()) / 1000))} 秒，不足航行 ${Math.ceil(job.travelMs / 1000)} 秒及 5 秒余量`;
  }
  return undefined;
}

export function decisionLabel(job: Assignment): string { return `${targetLabel(job)}：${job.reason ?? '增加占点数，同样占点数优先更早抵达，再减少舰队'}`; }
