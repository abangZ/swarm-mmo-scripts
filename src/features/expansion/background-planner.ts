import type { ExpansionWorld, WorldSnapshot } from './world';
import type { ModeConfig } from '../commander/types';
import { expansionProposalSteps } from './proposals';
import { expansionPlanSteps } from './planner';
import type { Assignment } from './types';
import { runPlanning, planningTiming } from '../../runtime/planning';
import { fingerprint } from '../../shared/fingerprint';
import type { ExpansionProposals } from './proposals';
import { CandidateSearch } from './candidate-search';
import { globalQuoteRules } from './quote-rules';

// The game's CSP disallows blob workers. Keep planning independent of dispatch,
// but cooperate with the page scheduler instead of starting a blocked worker.
export class BackgroundPlanner {
  private revision = 0;
  timing = planningTiming();
  resetTiming() { this.timing = planningTiming(); }
  private previous?: { key: string; result: ExpansionProposals; expires: number };
  private search = new CandidateSearch();
  private searchKey?: string;
  dispose() { this.revision++; this.previous = undefined; this.search = new CandidateSearch(); this.searchKey = undefined; }
  private run<T>(steps: Generator<void, T>, signal: AbortSignal, current: () => boolean, refresh = () => {}) {
    const revision = this.revision;
    const active = () => !signal.aborted && revision === this.revision && current();
    if (active()) refresh();
    return runPlanning(steps, active, refresh, undefined, 8, this.timing, 12);
  }
  async proposals(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>, signal: AbortSignal, current: () => boolean, progress?: (completed: number, total: number) => void) {
    const revision = this.revision;
    const key = snapshot.quoteVersion === undefined ? undefined : fingerprint([snapshot.quoteVersion, config, snapshot.planets, snapshot.owned,
      [...budgets], [...snapshot.productionTicks ?? []], [...locked], [...snapshot.incoming], snapshot.fleets, [...snapshot.fleetsByTarget ?? []], snapshot.attackMultiplierUpperBound, [...snapshot.automated ?? []], snapshot.intelligence, snapshot.identity, [...snapshot.allies ?? []]]);
    if (!this.search.pending && key && this.previous?.key === key && this.previous.expires > Date.now() && !signal.aborted && current()) {
      progress?.(this.previous.result.sources.length, this.previous.result.sources.length);
      return this.previous.result;
    }
    const searchKey = fingerprint([globalQuoteRules(snapshot), snapshot.identity, config]);
    const search = (searchKey === this.searchKey ? this.search : new CandidateSearch()).fork(snapshot.owned);
    const result = await this.run(expansionProposalSteps(world, snapshot, config, budgets, locked, progress, search), signal, current, () => world.refreshQuotes?.());
    if (result && revision === this.revision && !signal.aborted && current()) {
      this.search = search; this.searchKey = searchKey;
      this.previous = key ? { key, result, expires: Date.now() + (snapshot.fleets?.length ? 1000 : 30000) } : undefined;
    }
    return result;
  }
  plan(_world: ExpansionWorld, edges: Assignment[], budgets: Map<bigint, number>, interval: number, horizon: number, travel: number, delay: number, signal: AbortSignal, current: () => boolean) {
    return this.run(expansionPlanSteps(edges, budgets, interval, horizon, travel, delay), signal, current);
  }
}
