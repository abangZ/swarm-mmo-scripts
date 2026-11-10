import { readPlanetMenu, type PlanetMenu } from '../game/planet-menu';
import { watchIncoming, type IncomingState } from '../game/incoming-fleets';

export interface InspectorSnapshot { menu: PlanetMenu; plan: string[]; incoming: IncomingState | { status: 'idle' } }
const sameTarget = (a: PlanetMenu, b: PlanetMenu) => a.conn === b.conn && a.identity === b.identity && a.planetId === b.planetId;
export class PlanetInspector {
  private snapshot: InspectorSnapshot | null = null;
  private listeners = new Set<() => void>();
  private watcher?: ReturnType<typeof watchIncoming>;
  private timer?: ReturnType<typeof setInterval>;
  private lastRead = 0;
  private disposed = false;
  constructor(private readPlan: (menu: PlanetMenu) => string[], private readMenu = readPlanetMenu, private watch = watchIncoming) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start() { if (!this.disposed && !this.timer) { this.refresh(); this.timer = setInterval(this.refresh, 250); } }
  load = (expected: PlanetMenu) => {
    // Re-read before requesting: a click on an old button must not load a new target.
    this.refresh();
    const current = this.snapshot;
    if (this.disposed || !current || !sameTarget(current.menu, expected)) return;
    if (this.watcher && current.incoming.status !== 'error') return;
    this.watcher?.dispose();
    this.watcher = this.watch(current.menu.conn, current.menu.identity, current.menu.planetId);
    this.lastRead = Date.now();
    this.snapshot = { ...current, incoming: this.watcher.read() };
    this.emit();
  };
  refresh = () => {
    if (this.disposed) return;
    let menu: PlanetMenu | null;
    try { menu = this.readMenu(); } catch { menu = null; }
    const old = this.snapshot;
    if (!menu) {
      this.watcher?.dispose(); this.watcher = undefined;
      if (old) { this.snapshot = null; this.emit(); }
      return;
    }
    const changed = !old || !sameTarget(old.menu, menu);
    if (changed) { this.watcher?.dispose(); this.watcher = undefined; }
    const read = !!this.watcher && (!old || old.incoming.status === 'loading' || Date.now() - this.lastRead >= 1000);
    const incoming: InspectorSnapshot['incoming'] = read ? this.watcher!.read() : changed ? { status: 'idle' } : old.incoming;
    if (read) this.lastRead = Date.now();
    const plan = this.readPlan(menu);
    if (changed || JSON.stringify([old?.menu.bounds, old?.menu.zIndex, old?.incoming, old?.plan]) !== JSON.stringify([menu.bounds, menu.zIndex, incoming, plan])) {
      this.snapshot = { menu, incoming, plan }; this.emit();
    }
  };
  private emit() { for (const listener of this.listeners) listener(); }
  dispose() { this.disposed = true; clearInterval(this.timer); this.timer = undefined; this.watcher?.dispose(); this.watcher = undefined; this.snapshot = null; this.listeners.clear(); }
}
