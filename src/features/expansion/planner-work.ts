import type { Planet } from '../../game/types';
import type { ModeConfig } from '../commander/types';
import type { ExpansionWorld, WorldSnapshot } from './world';
import { expansionProposalWork, type ExpansionProposals, type QuoteRequest } from './proposals';
import { expansionPlanSteps } from './planner';
import { finishPlanning } from '../../runtime/planning';
import type { Assignment, Plan } from './types';

// Only data crosses the worker boundary; game objects, methods and connections stay on the page.
export function planningSnapshot(snapshot: WorldSnapshot) {
  return {
    planets: snapshot.planets.map(p => ({ planetId: p.planetId, positionX: p.positionX, positionY: p.positionY,
      probeCount: p.probeCount, galaxyId: p.galaxyId, level: p.level, owner: p.ownerId?.toHexString() })),
    owned: snapshot.owned.map(p => p.planetId), incoming: snapshot.incoming,
    identity: snapshot.identity, allies: snapshot.allies, intelligence: snapshot.intelligence,
    fleets: snapshot.fleets, fleetsByTarget: snapshot.fleetsByTarget,
  };
}
export interface QuoteRow { target: bigint; quote: ReturnType<ExpansionWorld['quote']>; route: ReturnType<NonNullable<ExpansionWorld['route']>> }
export type PlanningRequest =
  | { type: 'proposals'; snapshot: ReturnType<typeof planningSnapshot>; config: ModeConfig; budgets: Map<bigint, number>; locked: Set<bigint>; groups: boolean }
  | { type: 'quotes'; rows: QuoteRow[] }
  | { type: 'plan'; edges: Assignment[]; budgets: Map<bigint, number>; interval: number; horizon: number; travel: number; delay: number };
export type PlanningResponse = { type: 'quotes'; request: QuoteRequest } | { type: 'proposals'; result: ExpansionProposals }
  | { type: 'plan'; result: Plan } | { type: 'error'; message: string };

/** A single request stream, cancelled by terminating the worker. No network access. */
export function planningWorker(send: (message: PlanningResponse) => void) {
  let steps: Generator<void | QuoteRequest, ExpansionProposals> | undefined;
  let quotes = new Map<bigint, QuoteRow>();
  const advance = () => {
    while (steps) {
      const step = steps.next();
      if (step.done) { steps = undefined; send({ type: 'proposals', result: step.value }); }
      else if (step.value) { send({ type: 'quotes', request: step.value }); return; }
    }
  };
  return (message: PlanningRequest) => {
    try {
      if (message.type === 'proposals') {
        const data = message.snapshot;
        const planets: Planet[] = data.planets.map(({ owner, ...p }) => ({ ...p, ownerId: owner === undefined ? undefined : { toHexString: () => owner } }));
        const owned = new Set(data.owned);
        const snapshot: WorldSnapshot = { ...data, planets, owned: planets.filter(p => owned.has(p.planetId)), budgets: message.budgets };
        const world: ExpansionWorld = {
          scan: async () => {}, read: () => snapshot, dispose() {}, launch: async () => {},
          quote: (_, target) => quotes.get(target)?.quote ?? null,
          route: (_, target) => quotes.get(target)?.route ?? null,
          launchGroup: message.groups ? async () => {} : undefined,
        };
        steps = expansionProposalWork(world, snapshot, message.config, message.budgets, message.locked);
        advance();
      } else if (message.type === 'quotes') {
        quotes = new Map(message.rows.map(row => [row.target, row])); advance();
      } else {
        send({ type: 'plan', result: finishPlanning(expansionPlanSteps(message.edges, message.budgets, message.interval, message.horizon, message.travel, message.delay)) });
      }
    } catch (error) { steps = undefined; send({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  };
}
