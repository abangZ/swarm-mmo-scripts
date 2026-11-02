import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppController } from './controller';
import { mountInspector } from './mount-inspector';

const isolatedEvents = ['keydown', 'keyup', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel'];

/** The returned disposer owns React, listeners, subscriptions and unsent operations. */
export function mountPanel(controller = new AppController()): () => void {
  if (document.getElementById('swarm-helper-root')) {
    controller.dispose();
    return () => {};
  }
  const host = document.createElement('div');
  host.id = 'swarm-helper-root';
  const shadow = host.attachShadow({ mode: 'open' });
  const stopPropagation = (event: Event) => event.stopPropagation();
  for (const event of isolatedEvents) host.addEventListener(event, stopPropagation);
  const root = createRoot(shadow, { onUncaughtError: error => {
    controller.dispose();
    console.error('[Swarm MMO 助手] 面板渲染失败，已停止未发射操作。', error);
  } });
  const disposeInspector = mountInspector();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.dispose();
    disposeInspector();
    root.unmount();
    window.removeEventListener('pagehide', dispose);
    for (const event of isolatedEvents) host.removeEventListener(event, stopPropagation);
    host.remove();
  };
  window.addEventListener('pagehide', dispose, { once: true });
  document.body.append(host);
  root.render(<App controller={controller} />);
  return dispose;
}
