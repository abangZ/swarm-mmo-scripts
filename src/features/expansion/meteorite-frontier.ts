import type { ExpansionWorld, WorldSnapshot } from './world';
import { bodyFleetsFor } from './world';
import { targetKey, type Assignment } from './types';
import { inZone, type ModeConfig } from '../commander/types';
import { PlanetIndex } from '../../shared/planet-index';
import { bestCandidates } from '../../shared/best-candidates';
import { distance } from '../../shared/distance';
import { riskEvaluator } from './strategy';

export interface MeteoriteReport { targetId: bigint; reason: string }
/** Independent bounded, rotating search. Never sends or reserves inventory itself. */
export class MeteoriteFrontier {
  private offset = 0;
  private cursors = new Map<bigint, number>();
  private reports = new Map<bigint, MeteoriteReport>();
  fork() {
    const copy = new MeteoriteFrontier();
    copy.offset = this.offset; copy.cursors = new Map(this.cursors); copy.reports = new Map(this.reports);
    return copy;
  }
  *steps(world: ExpansionWorld, snapshot: WorldSnapshot, config: ModeConfig, budgets: Map<bigint, number>, locked: Set<string>, queueMs: number): Generator<void, { jobs: Assignment[]; reports: MeteoriteReport[] }> {
    const jobs: Assignment[] = [], available = new Map(budgets);
    const targets = [...snapshot.meteorites ?? []].sort((a, b) => Number(a.expiresAt.toMillis()) - Number(b.expiresAt.toMillis()));
    const ids = new Set(targets.map(t => t.meteoriteId));
    for (const id of this.cursors.keys()) if (!ids.has(id)) this.cursors.delete(id);
    for (const id of this.reports.keys()) if (!ids.has(id)) this.reports.delete(id);
    if (!config.settings.captureMeteorites) return { jobs, reports: [] };
    const index = new PlanetIndex(snapshot.owned.filter(p => inZone(p, config.policy.zone)));
    const risk = riskEvaluator(snapshot, config);
    const report = (id: bigint, reason: string) => {
      this.reports.delete(id); this.reports.set(id, { targetId: id, reason });
      if (this.reports.size > 128) this.reports.delete(this.reports.keys().next().value!);
    };
    const start = this.offset % Math.max(1, targets.length);
    for (let i = 0; i < Math.min(8, targets.length) && jobs.length < 3; i++) {
      yield;
      const target = targets[(start + i) % targets.length], id = target.meteoriteId;
      this.offset = (start + i + 1) % targets.length;
      const expires = Number(target.expiresAt.toMillis());
      const skip = (reason: string) => report(id, reason);
      if (!world.quoteBody || !world.launchBody) { skip('原生陨石报价 / 发射接口不可用'); continue; }
      if (target.ownerId != null) { skip('已有人占领'); continue; }
      if (!inZone(target, config.policy.zone)) { skip('目标不在固定战区内'); continue; }
      if (locked.has(targetKey(id, 'comet')) || bodyFleetsFor(snapshot, id, 'comet').length) { skip('已有舰队在途或任务排队，避免重复发射'); continue; }
      if (!Number.isFinite(expires) || expires <= Date.now() + 5000) { skip('已到期或剩余寿命不足 5 秒'); continue; }
      if (config.settings.cautiousExpansion && risk(target) === 'exposed') { skip('稳健扩张暂缓暴露目标'); continue; }
      const nearby = index.near(target, config.settings.radius);
      if (!nearby.length) { skip('搜索距离 / 战区内没有己方来源'); continue; }
      const sources = bestCandidates(nearby.filter(p => (available.get(p.planetId) ?? 0) > 0), nearby.length, p => distance(p, target));
      if (!sources.length) { skip('附近兵力已用于留守、进攻、补给或排队任务'); continue; }
      const offset = (this.cursors.get(id) ?? 0) % sources.length;
      // Revisit the nearest source promptly, while the other slots rotate through
      // every eligible source instead of permanently truncating to the first few.
      const visits = [...new Set([0, ...Array.from({ length: 4 }, (_, k) => (offset + k) % sources.length)])].slice(0, 4);
      const reasons = new Map<string, number>();
      for (const pos of visits) {
        yield;
        const source = sources[pos], sourceId = source.planetId;
        this.cursors.set(id, (pos + 1) % sources.length);
        const quote = world.quoteBody(sourceId, id, 'comet');
        let reason: string | undefined;
        if (!quote) reason = world.bodyQuoteIssue?.(sourceId, id, 'comet') ?? '原生报价不可行，未提供具体原因';
        else if (!Number.isSafeInteger(quote.count) || quote.count <= 0 || quote.count > 0xffffffff || !Number.isFinite(quote.travelMs) || quote.travelMs < 0) reason = '原生报价数量或航程无效';
        else if (quote.count > (available.get(sourceId) ?? 0)) reason = `可用兵力不足：需 ${quote.count}，可用 ${available.get(sourceId) ?? 0}`;
        else if (quote.travelMs > config.settings.maxTravelMs) reason = `航行 ${Math.ceil(quote.travelMs / 1000)} 秒，超过最长航行设置`;
        else if (Date.now() + queueMs + jobs.length * config.settings.intervalMs + quote.travelMs + 5000 >= expires) reason = '计入现有排队、航程及 5 秒余量后无法在消失前抵达';
        if (reason) { reasons.set(reason, (reasons.get(reason) ?? 0) + 1); continue; }
        if (!quote) continue;
        jobs.push({ ...quote, sourceId, targetId: id, targetKind: 'comet', expiresAt: expires, garrison: target.probeCount,
          reason: '陨石快速检查：附近可出兵，不等待全局规划' });
        available.set(sourceId, available.get(sourceId)! - quote.count);
        report(id, `已找到可行来源 #${sourceId}：需 ${quote.count}，航行 ${Math.ceil(quote.travelMs / 1000)} 秒`);
        break;
      }
      if (!jobs.some(job => job.targetId === id)) report(id, `${[...reasons].map(([reason, n]) => `${reason}（${n} 条）`).join('；')}；本次检查 ${visits.length}/${sources.length} 来源，其余续查`);
    }
    return { jobs, reports: [...this.reports.values()].slice(-6).reverse() };
  }
}
