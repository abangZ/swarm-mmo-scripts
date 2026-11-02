import { planningSnapshot, type PlanningRequest, type PlanningResponse, type QuoteRow } from './planner-work';
import type { ExpansionWorld, WorldSnapshot } from './world';
import type { ModeConfig } from '../commander/types';
import type { ExpansionProposals } from './proposals';
import type { Assignment, Plan } from './types';
import { runPlanning } from '../../runtime/planning';

declare const __EXPANSION_WORKER__: string;

export class BackgroundPlanner {
  private worker?: Worker;
  dispose() { this.worker?.terminate(); this.worker = undefined; }
  private request<T>(message: PlanningRequest, world: ExpansionWorld, signal: AbortSignal, current: () => boolean): Promise<T | undefined> {
    if (signal.aborted || !current()) return Promise.resolve(undefined);
    if (!this.worker) {
      const url = URL.createObjectURL(new Blob([__EXPANSION_WORKER__], { type: 'text/javascript' }));
      try { this.worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { finished = true; signal.removeEventListener('abort', abort); worker.onmessage = null; worker.onerror = null; };
      const abort = () => { if (finished) return; cleanup(); this.dispose(); resolve(undefined); };
      const fail = (error: unknown) => { if (finished) return; cleanup(); this.dispose(); reject(error); };
      signal.addEventListener('abort', abort, { once: true });
      worker.onerror = event => fail(new Error(event.message || '后台规划线程异常'));
      worker.onmessage = async (event: MessageEvent<PlanningResponse>) => {
        if (!current()) { abort(); return; }
        const reply = event.data;
        try {
          if (reply.type === 'error') throw new Error(reply.message);
          if (reply.type === 'quotes') {
            // quoteSend reads the native in-memory map. Each batch is bounded and
            // refreshed after yielding; no extra subscriptions or HTTP requests.
            const rows: QuoteRow[] = [];
            const request = reply.request;
            world.refreshQuotes?.();
            function* collect() {
              for (const target of request.targets) {
                rows.push({ target, route: world.route?.(request.source, target) ?? null, quote: world.quote(request.source, target) });
                yield;
              }
              return rows;
            }
            const result = await runPlanning(collect(), current, () => world.refreshQuotes?.());
            if (finished) return;
            if (!result || !current()) { abort(); return; }
            worker.postMessage({ type: 'quotes', rows: result } satisfies PlanningRequest);
          } else { cleanup(); resolve(reply.result as T); }
        } catch (error) { fail(error); }
      };
      try { worker.postMessage(message); } catch (error) { fail(error); }
    });
  }
  proposals(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<bigint>, signal: AbortSignal, current: () => boolean) {
    return this.request<ExpansionProposals>({ type: 'proposals', snapshot: planningSnapshot(snapshot), config, budgets, locked,
      groups: !!world.launchGroup && world.supportsGroup?.() !== false }, world, signal, current);
  }
  plan(world: ExpansionWorld, edges: Assignment[], budgets: Map<bigint, number>, interval: number, horizon: number, travel: number, delay: number, signal: AbortSignal, current: () => boolean) {
    return this.request<Plan>({ type: 'plan', edges, budgets, interval, horizon, travel, delay }, world, signal, current);
  }
}
