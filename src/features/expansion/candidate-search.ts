import type { Planet } from '../../game/types';
import { fingerprint } from '../../shared/fingerprint';

interface Cursor {
  rules: string;
  stock: number;
  next?: bigint;
  offset: number;
  keep: bigint[];
  pending: boolean;
}

/** Search hints only. Prices, routes, locks and budgets are revalidated by proposals. */
export class CandidateSearch {
  private cursors = new Map<bigint, Cursor>();
  pending = false;
  deferredSources = 0;
  fork(owned: Planet[]) {
    const draft = new CandidateSearch();
    for (const p of owned) {
      const cursor = this.cursors.get(p.planetId);
      if (cursor) draft.cursors.set(p.planetId, cursor);
    }
    return draft;
  }
  source(source: Planet, available: number, ordered: Planet[], quota: number, quoteRules?: string) {
    const rules = fingerprint([quoteRules, source.planetId, source.ownerId, source.positionX, source.positionY, source.galaxyId, source.level]);
    let previous = this.cursors.get(source.planetId);
    if (previous?.rules !== rules || available - previous.stock >= Math.max(20, previous.stock * 0.1)) previous = undefined;
    const keep = new Set(previous?.keep);
    const found = previous?.next === undefined ? -1 : ordered.findIndex(p => p.planetId === previous.next);
    const start = found >= 0 ? found : Math.min(previous?.offset ?? 0, ordered.length);
    // Recheck the closest neighbors as well as the saved shortlist. With n=1,
    // leave the sole slot to the cursor so a failed near target cannot starve it.
    const prefix = new Set(ordered.slice(0, Math.min(2, quota - 1)).map(p => p.planetId));
    for (const id of keep) prefix.add(id);
    const visits = [
      ...ordered.filter(p => prefix.has(p.planetId)).map(target => ({ target, offset: -1 })),
      ...ordered.slice(start).flatMap((target, i) => prefix.has(target.planetId) ? [] : [{ target, offset: start + i }]),
    ];
    let used = 0, next: number | undefined;
    return {
      visits,
      // Retained candidates cost at most n extra checks; every other native
      // evaluation, including a failed route/quote, consumes this pass's quota.
      allow: (id: bigint, offset: number) => {
        if (keep.has(id)) return true;
        if (used < quota) { used++; return true; }
        if (offset >= 0) next ??= offset;
        return false;
      },
      settled: !previous?.pending,
      get deferred() { return next !== undefined; },
      finish: (selected: bigint[]) => {
        this.pending ||= next !== undefined;
        if (next !== undefined) this.deferredSources++;
        this.cursors.set(source.planetId, { rules, stock: Math.min(previous?.stock ?? available, available),
          next: next === undefined ? undefined : ordered[next]?.planetId, offset: next ?? 0, keep: selected, pending: next !== undefined });
      },
    };
  }
}
