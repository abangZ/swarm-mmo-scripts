import { GameWorld } from '../game/expansion-world';
import type { ExpansionState } from '../features/expansion/engine';
import type { ExpansionWorld } from '../features/expansion/world';
import type { ExpansionSettings } from '../features/expansion/types';
import { Commander } from '../features/commander/engine';
import { inZone, type Mode } from '../features/commander/types';
import { hostile } from '../features/commander/safety';
import { unresolved, unlockAfterReview } from '../runtime/operations';
import { loadSettings, parseSettings, saveSettings, type SettingsForm } from './settings';
import { loadPolicies, parsePolicy, savePolicies, type PolicyForm, type RegionPreview, type EnemyOption } from './regions';
import { readMapPoint, focusMap } from '../game/map-selection';

export type { Mode } from '../features/commander/types';
export interface ActivityLog { id: number; time: number; message: string; level: 'info' | 'success' | 'warning' | 'error'; mode?: Mode }
export interface AppState {
  expanded: boolean; mode: Mode; settingsOpen: boolean; attackSettingsOpen: boolean;
  uncertain: boolean; settings: SettingsForm; attackSettings: SettingsForm;
  policies: Record<Mode, PolicyForm>; previews: Record<Mode, RegionPreview>;
  expansion: ExpansionState; attack: ExpansionState; logs: ActivityLog[];
  reviewed: boolean; unlocking: boolean; unlockStatus: string;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const attackStorage = 'swarm-helper-attack-settings';

/** Owns side effects once per mounted panel, independently of React renders. */
export class AppController {
  private listeners = new Set<() => void>();
  private engine: Commander;
  private disposed = false;
  private logId = 0;
  private state: AppState;
  private previewVersions: Record<Mode, number> = { expansion: 0, attack: 0 };
  private previews = new Set<ExpansionWorld>();
  constructor(private createWorld: () => ExpansionWorld = () => new GameWorld(), private mapActions = { point: readMapPoint, focus: focusMap }) {
    this.engine = new Commander((mode, state) => this.onUpdate(mode, state), createWorld);
    this.state = {
      expanded: false, mode: 'expansion', settingsOpen: true, attackSettingsOpen: true, uncertain: unresolved(),
      settings: loadSettings(), attackSettings: { ...loadSettings(attackStorage), maxSources: '1', intervalMs: '1' }, policies: loadPolicies(),
      previews: { expansion: { busy: false, message: '', enemies: [] }, attack: { busy: false, message: '', enemies: [] } },
      expansion: { ...this.engine.states.expansion }, attack: { ...this.engine.states.attack }, logs: [], reviewed: false, unlocking: false, unlockStatus: '',
    };
  }
  getSnapshot = (): AppState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<AppState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private onUpdate(mode: Mode, state: ExpansionState): void {
    if (this.disposed) return;
    const previous = this.state[mode];
    const changed = state.phase !== previous.phase || state.activity !== previous.activity;
    const level: ActivityLog['level'] = state.activity === 'error' ? 'error'
      : state.activity === 'paused' || state.activity === 'stopping' ? 'warning'
      : state.activity === 'sent' || state.activity === 'captured' ? 'success' : 'info';
    const logs = changed ? [...this.state.logs, { id: ++this.logId, time: Date.now(), message: state.phase, level, mode }].slice(-100) : this.state.logs;
    this.patch({ [mode]: state, uncertain: unresolved(), logs });
  }
  expand = (): void => { this.patch({ expanded: true }); };
  collapse = (): void => { this.patch({ expanded: false }); };
  setMode = (mode: Mode): void => { this.patch({ mode }); };
  toggleSettings = (): void => { this.patch({ settingsOpen: !this.state.settingsOpen }); };
  toggleAttackSettings = (): void => { this.patch({ attackSettingsOpen: !this.state.attackSettingsOpen }); };
  setSetting = (key: keyof ExpansionSettings, value: string): void => { if (!this.state.expansion.running) this.patch({ settings: { ...this.state.settings, [key]: value } }); };
  setAttackSetting = (key: keyof ExpansionSettings, value: string): void => { if (key !== 'intervalMs' && !this.state.attack.running) this.patch({ attackSettings: { ...this.state.attackSettings, [key]: value } }); };
  setPolicy = (mode: Mode, key: keyof PolicyForm, value: string): void => {
    if (this.state[mode].running) return;
    this.patch({ policies: { ...this.state.policies, [mode]: { ...this.state.policies[mode], [key]: value } } });
    if (['scope', 'x', 'y', 'radius'].includes(key)) {
      this.previewVersions[mode]++;
      this.patchPreview(mode, { busy: false, message: '', enemies: [], hubs: [] });
    }
  };
  private patchPreview(mode: Mode, preview: Partial<RegionPreview>) { this.patch({ previews: { ...this.state.previews, [mode]: { ...this.state.previews[mode], ...preview } } }); }
  pickCenter = (mode: Mode, kind: 'selection' | 'view'): void => {
    if (this.state[mode].running) return;
    try {
      const point = this.mapActions.point(kind);
      this.previewVersions[mode]++;
      this.patch({ policies: { ...this.state.policies, [mode]: { ...this.state.policies[mode], scope: 'circle', x: String(point.x), y: String(point.y) } } });
      this.patchPreview(mode, { busy: false, message: '中心已选定，可调整半径后加载区域概览。', enemies: [], hubs: [] });
    } catch (error) { this.patchPreview(mode, { message: errorText(error) }); }
  };
  pickHub = (): void => {
    if (this.state.attack.running) return;
    try {
      const point = this.mapActions.point('selection');
      if (!point.planetId) throw new Error('请先在游戏中单选一颗己方行星，作为初始中转星。');
      this.setPolicy('attack', 'rallyId', point.planetId);
      this.patchPreview('attack', { message: `已选中转星 #${point.planetId} (${point.x}, ${point.y})；启动时会核实归属和战区范围。` });
    } catch (error) { this.patchPreview('attack', { message: errorText(error) }); }
  };
  focusRegion = (mode: Mode): void => {
    try { const policy = parsePolicy(this.state.policies[mode], mode); if (!policy.zone) throw new Error('请先选择固定区域。'); this.mapActions.focus(policy.zone.x, policy.zone.y); }
    catch (error) { this.patchPreview(mode, { message: errorText(error) }); }
  };
  focusEnemy = (id: string): void => {
    const enemy = this.state.previews.attack.enemies.find(e => e.id === id);
    if (enemy) try { this.mapActions.focus(enemy.x, enemy.y); } catch (error) { this.patchPreview('attack', { message: errorText(error) }); }
  };
  previewRegion = async (mode: Mode): Promise<void> => {
    if (this.disposed || this.state.previews[mode].busy) return;
    const version = ++this.previewVersions[mode];
    let world: ExpansionWorld | undefined;
    try {
      const config = { settings: parseSettings(mode === 'attack' ? this.state.attackSettings : this.state.settings), policy: parsePolicy(this.state.policies[mode], mode) };
      if (!config.policy.zone) throw new Error('请先选择固定区域，再加载概览。');
      this.patchPreview(mode, { busy: true, message: '正在加载区域情报…' });
      world = this.createWorld(); this.previews.add(world); world.configure?.([config]);
      const alive = () => !this.disposed && this.previewVersions[mode] === version;
      await world.scan(config.settings, alive);
      if (!alive()) return;
      const snapshot = world.read(), planets = snapshot.planets.filter(p => inZone(p, config.policy.zone));
      const enemies = new Map<string, EnemyOption>();
      for (const p of planets.filter(p => hostile(p, snapshot))) {
        const id = p.ownerId!.toHexString(), enemy = enemies.get(id) ?? { id, name: snapshot.players?.get(id) || id.slice(0, 12), count: 0, x: p.positionX, y: p.positionY };
        enemy.count++; enemies.set(id, enemy);
      }
      const hubs = snapshot.owned.filter(p => inZone(p, config.policy.zone) && !snapshot.automated?.has(p.planetId)).map(p => ({ id: String(p.planetId), x: p.positionX, y: p.positionY, probes: snapshot.budgets.get(p.planetId) ?? 0 })).sort((a, b) => b.probes - a.probes);
      this.patchPreview(mode, { busy: false, message: `区域内：己方 ${snapshot.owned.filter(p => inZone(p, config.policy.zone)).length} · 无主 ${planets.filter(p => !p.ownerId).length} · 敌方 ${[...enemies.values()].reduce((n, e) => n + e.count, 0)} 颗；${enemies.size} 位敌人`, enemies: [...enemies.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)), hubs });
    } catch (error) { if (version === this.previewVersions[mode]) this.patchPreview(mode, { busy: false, message: errorText(error) }); }
    finally { world?.dispose(); if (world) this.previews.delete(world); }
  };
  setReviewed = (reviewed: boolean): void => { this.patch({ reviewed }); };
  private startMode(mode: Mode): void {
    if (this.disposed || this.state.uncertain || this.state[mode].running) return;
    try {
      const policy = parsePolicy(this.state.policies[mode], mode);
      const settings = saveSettings(mode === 'attack' ? this.state.attackSettings : this.state.settings, mode === 'attack' ? attackStorage : undefined);
      savePolicies(this.state.policies);
      this.patch(mode === 'attack' ? { attackSettingsOpen: false } : { settingsOpen: false });
      void this.engine.start(mode, { settings, policy });
    } catch (error) { this.onUpdate(mode, { ...this.state[mode], activity: 'error', phase: errorText(error) }); }
  }
  start = (): void => { this.startMode('expansion'); };
  startAttack = (): void => { this.startMode('attack'); };
  stop = (): void => { this.engine.stop('expansion'); };
  stopAttack = (): void => { this.engine.stop('attack'); };
  stopAll = (): void => { this.engine.stop(); };
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
    this.disposed = true; this.engine.stop();
    for (const world of this.previews) world.dispose();
    this.listeners.clear();
  };
}
