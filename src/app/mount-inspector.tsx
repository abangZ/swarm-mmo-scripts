import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanetInspector } from './planet-inspector';
import { PlanetIncoming } from '../ui/PlanetIncoming';

function Inspector({ controller }: { controller: PlanetInspector }) {
  return <PlanetIncoming snapshot={useSyncExternalStore(controller.subscribe, controller.getSnapshot)} />;
}
export function mountInspector(controller = new PlanetInspector()): () => void {
  const host = document.createElement('div');
  host.id = 'swarm-helper-incoming';
  host.style.pointerEvents = 'none';
  const root = createRoot(host.attachShadow({ mode: 'open' }), { onUncaughtError: () => controller.dispose() });
  document.body.append(host);
  root.render(<Inspector controller={controller} />);
  controller.start();
  return () => { controller.dispose(); root.unmount(); host.remove(); };
}
