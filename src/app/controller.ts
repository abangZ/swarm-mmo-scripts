import { findNearest, prepareSend, type SearchResult } from '../game/manual';
import { getSession, ownedPlanets } from '../game/session';
import { GameWorld } from '../game/expansion-world';
import type { Planet } from '../game/types';
import { ExpansionEngine, type ExpansionState } from '../features/expansion/engine';
import type { ExpansionWorld } from '../features/expansion/world';
import type { ExpansionSettings } from '../features/expansion/types';
import { dispatch, unresolved, unlockAfterReview, withControl } from '../runtime/operations';
import { distance } from '../shared/distance';
import { loadSettings, saveSettings, type SettingsForm } from './settings';

type Mode = 'manual' | 'expansion';
export interface AppState {
  expanded: boolean;
  mode: Mode;
  busy: boolean;
  uncertain: boolean;
  planets: Planet[];
  sourceId: string;
  count: string;
  target: string;
  canSend: boolean;
  status: string;
  settings: SettingsForm;
  expansion: ExpansionState;
  reviewed: boolean;
  unlocking: boolean;
  unlockStatus: string;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns side effects once per mounted panel, independently of React renders. */
export class AppController {
  private listeners = new Set<() => void>();
  private engine: ExpansionEngine;
  private result?: SearchResult;
  private disposed = false;
  private state: AppState;

  constructor(createWorld: () => ExpansionWorld = () => new GameWorld()) {
    this.engine = new ExpansionEngine(expansion => this.patch({ expansion, uncertain: unresolved() }), createWorld);
    this.state = {
      expanded: false, mode: 'manual', busy: false, uncertain: unresolved(), planets: [], sourceId: '', count: '',
      target: '尚未选择目标', canSend: false, status: '展开后刷新星球列表。', settings: loadSettings(),
      expansion: { ...this.engine.state }, reviewed: false, unlocking: false, unlockStatus: '',
    };
  }
  // Stable functions and immutable snapshots are required by useSyncExternalStore.
  getSnapshot = (): AppState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private patch(patch: Partial<AppState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private invalidate(): void {
    this.result?.release();
    this.result = undefined;
    this.patch({ canSend: false, target: '尚未选择目标' });
  }
  private async run(job: () => Promise<void>): Promise<void> {
    if (this.disposed || this.state.busy || this.state.uncertain || this.engine.running) return;
    this.patch({ busy: true });
    try { await job(); }
    catch (error) { this.patch({ status: errorText(error) }); this.invalidate(); }
    finally { this.patch({ busy: false, uncertain: unresolved() }); }
  }
  expand = (): void => {
    this.patch({ expanded: true });
    if (this.state.mode === 'manual') void this.refresh();
  };
  collapse = (): void => {
    this.patch({ expanded: false });
    if (!this.state.busy) this.invalidate();
  };
  setMode = (mode: Mode): void => { this.patch({ mode }); };
  setSource = (sourceId: string): void => { this.invalidate(); this.patch({ sourceId }); };
  setCount = (count: string): void => { this.patch({ count }); };
  setSetting = (key: keyof ExpansionSettings, value: string): void => {
    if (!this.engine.running) this.patch({ settings: { ...this.state.settings, [key]: value } });
  };
  setReviewed = (reviewed: boolean): void => { this.patch({ reviewed }); };
  refresh = (): Promise<void> => this.run(async () => {
    this.invalidate();
    const planets = ownedPlanets(getSession());
    const sourceId = planets.some(p => String(p.planetId) === this.state.sourceId) ? this.state.sourceId : String(planets[0]?.planetId ?? '');
    this.patch({ planets, sourceId, status: planets.length ? `已加载 ${planets.length} 颗己方行星。` : '暂无己方行星，请等待游戏数据加载后刷新。' });
  });
  search = (): Promise<void> => this.run(async () => {
    this.invalidate();
    if (!this.state.sourceId) throw new Error('请先刷新并选择出发星球。');
    this.patch({ status: '正在加载周围星球并寻找最近目标…' });
    const result = await findNearest(getSession(), BigInt(this.state.sourceId), () => !this.disposed);
    if (this.disposed) { result.release(); return; }
    this.result = result;
    const db = result.session.conn.db.planet;
    const from = db.planetId.find(result.sourceId), to = db.planetId.find(result.targetId);
    if (!from || !to) throw new Error('星球数据已变化，请重新搜索。');
    this.patch({
      canSend: true, count: String(from.probeCount),
      target: `目标 #${to.planetId} · (${to.positionX}, ${to.positionY})\n距离 ${distance(from, to).toFixed(2)} · 驻军 ${to.probeCount}`,
      status: from.galaxyId !== to.galaxyId ? '目标位于另一星系，可能存在航行限制和损耗；以服务器判定为准。' : '目标已找到。检查数量后点击发送。',
    });
  });
  send = (): Promise<void> => this.run(async () => {
    const planned = this.result;
    if (!planned) return;
    const count = Number(this.state.count);
    this.patch({ status: '正在发送，等待服务器确认…' });
    try {
      await withControl(() => dispatch(() => prepareSend(planned, count), 1500, () => !this.disposed && !this.engine.running));
      this.patch({ status: '服务器已确认发射。' });
    } finally { this.invalidate(); }
  });
  start = (): void => {
    if (this.disposed || this.state.busy || this.state.uncertain || this.engine.running) return;
    try {
      const settings = saveSettings(this.state.settings);
      this.invalidate();
      void this.engine.start(settings);
    } catch (error) { this.patch({ expansion: { ...this.state.expansion, phase: errorText(error) } }); }
  };
  stop = (): void => { this.engine.stop(); };
  unlock = async (): Promise<void> => {
    if (this.disposed || this.state.unlocking) return;
    this.patch({ unlocking: true });
    try {
      if (!this.state.reviewed) throw new Error('请先核实游戏日志，并勾选确认。');
      await unlockAfterReview();
      this.patch({ uncertain: false, reviewed: false, unlockStatus: '已解除锁定，可以手动重新启动。' });
    } catch (error) { this.patch({ unlockStatus: errorText(error) }); }
    finally { this.patch({ unlocking: false }); }
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.stop();
    this.invalidate();
    this.listeners.clear();
  };
}
