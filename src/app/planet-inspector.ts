import { readPlanetMenu, type PlanetMenu } from '../game/planet-menu';
import { watchIncoming, type IncomingState } from '../game/incoming-fleets';

export interface InspectorSnapshot { menu: PlanetMenu; incoming: IncomingState }
export class PlanetInspector {
  private snapshot: InspectorSnapshot | null = null;
  private listeners = new Set<() => void>();
  private watcher?: ReturnType<typeof watchIncoming>;
  private timer?: ReturnType<typeof setInterval>;
  private lastRead = 0;
  constructor(private readMenu = readPlanetMenu, private watch = watchIncoming) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start() { if (!this.timer) { this.refresh(); this.timer = setInterval(this.refresh, 250); } }
  refresh = () => {
    let menu: PlanetMenu | null;
    try { menu = this.readMenu(); } catch { menu = null; }
    const old = this.snapshot;
    if (!menu) {
      this.watcher?.dispose(); this.watcher = undefined;
      if (old) { this.snapshot = null; this.emit(); }
      return;
    }
    const changed = !old || old.menu.conn !== menu.conn || old.menu.identity !== menu.identity || old.menu.planetId !== menu.planetId;
    if (changed) { this.watcher?.dispose(); this.watcher = this.watch(menu.conn, menu.identity, menu.planetId); }
    const read = changed || !old || old.incoming.status === 'loading' || Date.now() - this.lastRead >= 1000;
    const incoming = read ? this.watcher!.read() : old.incoming;
    if (read) this.lastRead = Date.now();
    if (changed || JSON.stringify([old?.menu.bounds, old?.menu.zIndex, old?.incoming]) !== JSON.stringify([menu.bounds, menu.zIndex, incoming])) {
      this.snapshot = { menu, incoming }; this.emit();
    }
  };
  private emit() { for (const listener of this.listeners) listener(); }
  dispose() { clearInterval(this.timer); this.timer = undefined; this.watcher?.dispose(); this.watcher = undefined; this.snapshot = null; this.listeners.clear(); }
}
