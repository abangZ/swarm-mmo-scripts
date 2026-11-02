export interface ExpansionSettings { scanMs: number; intervalMs: number; candidates: number; radius: number; horizonMs: number; maxTravelMs: number; reserve: number; maxSources: number }
export const scanIntervals = [10000, 30000, 60000, 120000] as const;
export const captureMargin = 1;
export const defaults: ExpansionSettings = { scanMs: 10000, intervalMs: 1500, candidates: 10, radius: 32, horizonMs: 120000, maxTravelMs: 1800000, reserve: 0, maxSources: 3 };
export function validateSettings(s: ExpansionSettings): void {
  if (!scanIntervals.some(interval => interval === s.scanMs)) throw new Error('扫描间隔请选择 10、30、60 或 120 秒。');
  const ranges: [keyof ExpansionSettings, number, number][] = [['scanMs', 10000, 120000], ['intervalMs', 1000, 2000], ['candidates', 1, 50], ['radius', 1, 128], ['horizonMs', 10000, 600000], ['maxTravelMs', 10000, 14400000], ['reserve', 0, 0xffffffff], ['maxSources', 1, 3]];
  for (const [key, min, max] of ranges) if (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`设置 ${key} 应为 ${min}–${max} 范围内的整数。`);
}
export interface Contribution { sourceId: bigint; count: number; travelMs: number }
export interface Assignment extends Contribution { targetId: bigint; support?: Contribution[]; value?: number; kind?: 'reinforce' }
export function members(job: Assignment): Contribution[] { return [job, ...(job.support ?? [])]; }
export function sourceLabel(job: Assignment): string { const sources = members(job); return sources.slice(0, 3).map(m => `#${m.sourceId}`).join(' + ') + (sources.length > 3 ? ` 等 ${sources.length} 颗` : ''); }
export function totalCount(job: Assignment): number { return members(job).reduce((sum, m) => sum + m.count, 0); }
export function completionMs(job: Assignment): number { return Math.max(...members(job).map(m => m.travelMs)); }
export interface Plan { jobs: Assignment[]; exact: boolean }
