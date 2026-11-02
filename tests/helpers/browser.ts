import { afterEach, beforeEach, mock } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<body></body>', { url: 'https://www.swarm-mmo.com/play' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Option: dom.window.Option, localStorage: dom.window.localStorage });
let locked = false;
const locks = { request: async (_name: string, _options: object, callback: (lock: object | null) => unknown) => {
  if (locked) return callback(null);
  locked = true;
  try { return await callback({}); } finally { locked = false; }
} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
const cleanups: (() => void | Promise<void>)[] = [];
// Unit tests advance their own timers; host CPU contention must not create unplanned
// cooperative yields. The planning tests explicitly advance this clock to test yields.
beforeEach(() => { mock.method(performance, 'now', () => 0); mock.method(Math, 'random', () => 0.5); });
export function onCleanup(cleanup: () => void | Promise<void>): void { cleanups.push(cleanup); }
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren(); localStorage.clear(); mock.restoreAll();
});
