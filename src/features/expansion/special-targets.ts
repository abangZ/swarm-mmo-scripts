import { LogisticsPlanner } from './logistics';
import { distance } from '../../shared/distance';
import { bestCandidates } from '../../shared/best-candidates';
import { inZone, type ModeConfig } from '../commander/types';
import { bodyFleetsFor, type ExpansionWorld, type WorldSnapshot } from './world';
import { targetKey, type Assignment } from './types';
import { riskEvaluator } from './strategy';

export function* meteoriteProposals(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<string>): Generator<void, Assignment[]> {
  if (!config.settings.captureMeteorites || !world.quoteBody || !world.launchBody) return [];
  const risk = riskEvaluator(snapshot, config), jobs: Assignment[] = [];
  const targets = (snapshot.meteorites ?? []).filter(t => t.ownerId == null && inZone(t, config.policy.zone)
    && Number.isFinite(Number(t.expiresAt.toMillis())) && Number(t.expiresAt.toMillis()) > Date.now() + 5000
    && !locked.has(targetKey(t.meteoriteId, 'comet')) && !bodyFleetsFor(snapshot, t.meteoriteId, 'comet').length
    && (!config.settings.cautiousExpansion || risk(t) !== 'exposed'));
  for (const source of snapshot.owned) {
    yield;
    if (!inZone(source, config.policy.zone) || (budgets.get(source.planetId) ?? 0) <= 0) continue;
    const nearby = bestCandidates(targets.filter(t => distance(source, t) <= config.settings.radius), Math.max(8, config.settings.candidates * 2), t => distance(source, t));
    for (const [i, target] of nearby.entries()) {
      if (i % 8 === 0) yield;
      const quote = world.quoteBody(source.planetId, target.meteoriteId, 'comet');
      const expiresAt = Number(target.expiresAt.toMillis());
      if (!quote || quote.count > (budgets.get(source.planetId) ?? 0) || quote.travelMs > config.settings.maxTravelMs
        || Date.now() + quote.travelMs + 5000 >= expiresAt) continue;
      jobs.push({ ...quote, sourceId: source.planetId, targetId: target.meteoriteId, targetKind: 'comet', garrison: target.probeCount, expiresAt,
        value: 0, reason: '可在消失前抵达；陨石不计产能，收益需持有至到期' });
    }
  }
  return jobs;
}

// Compatibility entry point for the shared persistent logistics implementation.
export { LogisticsPlanner } from './logistics';
export type { LogisticsPlan as SunPlan } from './logistics';
export class SunPlanner extends LogisticsPlanner { constructor() { super('sun'); } }
