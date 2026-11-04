import type { WorldSnapshot } from './world';
import { members, type Assignment } from './types';
import { fingerprint } from '../../shared/fingerprint';

export const globalQuoteRules = (snapshot: WorldSnapshot) => snapshot.quoteGlobalVersion ?? snapshot.quoteVersion;
export const sourceQuoteRules = (snapshot: WorldSnapshot, source: bigint) => snapshot.sourceQuoteVersions?.get(source) ?? snapshot.quoteVersion;
export const jobQuoteRules = (snapshot: WorldSnapshot, job: Assignment) => fingerprint([
  snapshot.identity, ...members(job).map(m => [m.sourceId, sourceQuoteRules(snapshot, m.sourceId)]),
]);
export const sameJobRules = (before: WorldSnapshot, after: WorldSnapshot, job: Assignment) => jobQuoteRules(before, job) === jobQuoteRules(after, job);
