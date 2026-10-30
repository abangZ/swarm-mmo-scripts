import { GameWorld } from '../game/expansion-world';
import { ExpansionEngine, type ExpansionState } from '../features/expansion/engine';
import type { ExpansionWorld } from '../features/expansion/world';
import type { ExpansionSettings } from '../features/expansion/types';
import { unresolved, unlockAfterReview } from '../runtime/operations';
import { loadSettings, saveSettings, type SettingsForm } from './settings';

export type Mode = 'expansion' | 'attack';
export interface ActivityLog {
  id: number;
  time: number;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}
export interface AppState {
  expanded: boolean;
  mode: Mode;
  settingsOpen: boolean;
  uncertain: boolean;
  settings: SettingsForm;
  expansion: ExpansionState;
  logs: ActivityLog[];
  reviewed: boolean;
  unlocking: boolean;
  unlockStatus: string;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns side effects once per mounted panel, independently of React renders. */
export class AppController {
  private listeners = new Set<() => void>();
  private engine: ExpansionEngine;
  private disposed = false;
  private logId = 0;
  private state: AppState;

  constructor(createWorld: () => ExpansionWorld = () => new GameWorld()) {
    this.engine = new ExpansionEngine(expansion => this.onExpansionUpdate(expansion), createWorld);
    this.state = {
      expanded: false, mode: 'expansion', settingsOpen: true, uncertain: unresolved(), settings: loadSettings(),
      expansion: { ...this.engine.state }, logs: [], reviewed: false, unlocking: false, unlockStatus: '',
    };
  }
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
  private onExpansionUpdate(expansion: ExpansionState): void {
    if (this.disposed) return;
    const changed = expansion.phase !== this.state.expansion.phase || expansion.activity !== this.state.expansion.activity;
    const level: ActivityLog['level'] = expansion.activity === 'error' ? 'error'
      : expansion.activity === 'paused' || expansion.activity === 'stopping' ? 'warning'
      : expansion.activity === 'sent' || expansion.activity === 'captured' ? 'success' : 'info';
    const logs = changed ? [...this.state.logs, { id: ++this.logId, time: Date.now(), message: expansion.phase, level }].slice(-100) : this.state.logs;
    this.patch({ expansion, uncertain: unresolved(), logs });
  }
  expand = (): void => { this.patch({ expanded: true }); };
  collapse = (): void => { this.patch({ expanded: false }); };
  setMode = (mode: Mode): void => { this.patch({ mode }); };
  toggleSettings = (): void => { this.patch({ settingsOpen: !this.state.settingsOpen }); };
  setSetting = (key: keyof ExpansionSettings, value: string): void => {
    if (!this.engine.running) this.patch({ settings: { ...this.state.settings, [key]: value } });
  };
  setReviewed = (reviewed: boolean): void => { this.patch({ reviewed }); };
  start = (): void => {
    if (this.disposed || this.state.uncertain || this.engine.running) return;
    try {
      const settings = saveSettings(this.state.settings);
      this.patch({ settingsOpen: false });
      void this.engine.start(settings);
    } catch (error) {
      this.onExpansionUpdate({ ...this.state.expansion, activity: 'error', phase: errorText(error) });
    }
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
    this.listeners.clear();
  };
}
