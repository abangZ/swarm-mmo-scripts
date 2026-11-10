import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanetInspector } from './planet-inspector';
import { PlanetIncoming } from '../ui/PlanetIncoming';

function Inspector({ controller }: { controller: PlanetInspector }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <PlanetIncoming snapshot={snapshot} onLoad={() => { if (snapshot) controller.load(snapshot.menu); }} />;
}
export function mountInspector(controller: PlanetInspector): () => void {
  const host = document.createElement('div');
  host.id = 'swarm-helper-incoming';
  host.style.pointerEvents = 'none';
  const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel'];
  const isolate = (event: Event) => event.stopPropagation();
  for (const type of events) host.addEventListener(type, isolate);
  // The native send dial listens for Enter at window capture. Install before it
  // opens so keyboard activation of our button cannot also submit a game action.
  const isolateKey = (event: Event) => { if (event.composedPath().includes(host)) event.stopImmediatePropagation(); };
  window.addEventListener('keydown', isolateKey, true);
  window.addEventListener('keyup', isolateKey, true);
  const root = createRoot(host.attachShadow({ mode: 'open' }), { onUncaughtError: () => controller.dispose() });
  document.body.append(host);
  root.render(<Inspector controller={controller} />);
  controller.start();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    controller.dispose(); root.unmount(); host.remove();
    for (const type of events) host.removeEventListener(type, isolate);
    window.removeEventListener('keydown', isolateKey, true);
    window.removeEventListener('keyup', isolateKey, true);
  };
}
