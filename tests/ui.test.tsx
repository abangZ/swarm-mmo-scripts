import { onCleanup } from './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mountPanel } from '../src/app/mount';
import { AppController } from '../src/app/controller';
import { defaults } from '../src/features/expansion/types';
import { fixture, planet, settle, fakeWorld } from './helpers/fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
async function panel(controller?: AppController) {
  let dispose!: () => void;
  await act(async () => { dispose = mountPanel(controller); });
  onCleanup(() => act(async () => dispose()));
  const root = document.getElementById('swarm-helper-root')!.shadowRoot!;
  const element = <T extends HTMLElement = HTMLButtonElement>(id: string) => root.getElementById(id) as T;
  const click = (id: string) => act(async () => { element(id).click(); await settle(); });
  const select = (id: string, value: string) => act(async () => {
    const input = element<HTMLSelectElement>(id);
    input.value = value;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  return { root, element, click, select, dispose };
}

test('React panel finds a target, prevents duplicate clicks and releases the subscription', async () => {
  const f = fixture([planet(1n, 0, 0, true), planet(2n, 3, 4)]);
  let resolve!: () => void;
  f.launchSwarm.mock.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
  const ui = await panel();
  assert.equal(ui.element('panel').hidden, true);
  await ui.click('toggle');
  assert.equal(ui.root.activeElement, ui.element('collapse'));
  await ui.click('search');
  assert.equal(ui.element('send').disabled, false);
  assert.match(ui.element('target').textContent!, /5.00/);
  await act(async () => { ui.element('send').click(); ui.element('send').click(); await settle(); });
  assert.equal(f.launchSwarm.mock.callCount(), 1);
  await act(async () => { resolve(); await settle(); });
  assert.match(ui.element('status').textContent!, /服务器已确认/);
  assert.equal(ui.element('send').disabled, true);
  await ui.click('collapse');
  assert.equal(ui.element('toggle').hidden, false);
  assert.equal(ui.root.activeElement, ui.element('toggle'));
  assert.equal(f.handles[0].isActive(), false);
});

test('saved settings migrate into controlled fields and save seconds as milliseconds', async () => {
  localStorage.setItem('swarm-helper-expansion-settings', JSON.stringify({ ...defaults, maxSources: undefined, scanMs: 15000, candidates: 7 }));
  const f = fakeWorld();
  f.world.read = () => { throw new Error('test stop'); };
  const ui = await panel(new AppController(() => f.world));
  await ui.click('toggle');
  await ui.select('action', 'expansion');
  assert.equal(ui.element('manual').hidden, true);
  assert.equal(ui.element('expansion').hidden, false);
  assert.equal(ui.element<HTMLSelectElement>('scanMs').value, '10');
  assert.equal(ui.element<HTMLSelectElement>('maxSources').value, '3');
  assert.equal(ui.element<HTMLInputElement>('candidates').value, '7');
  await ui.select('scanMs', '30');
  await ui.select('maxSources', '2');
  await ui.click('start');
  const saved = JSON.parse(localStorage.getItem('swarm-helper-expansion-settings')!);
  assert.equal(saved.scanMs, 30000);
  assert.equal(saved.maxSources, 2);
  assert.equal(saved.intervalMs, 1500);
  assert.equal(saved.candidates, 7);
  assert.match(ui.element('auto-status').textContent!, /test stop/);
});

test('collapse and mode changes retain one engine; unmount stops it before pending scan dispatches', async () => {
  const f = fakeWorld();
  let finish!: () => void;
  f.world.scan = () => new Promise<void>(resolve => { finish = resolve; });
  const createWorld = mock.fn(() => f.world);
  const ui = await panel(new AppController(createWorld));
  assert.equal(createWorld.mock.callCount(), 0); // Mount never starts automation.
  await ui.click('toggle');
  await ui.select('action', 'expansion');
  await ui.click('start');
  assert.equal(ui.element('start').disabled, true);
  assert.equal(ui.element<HTMLSelectElement>('scanMs').disabled, true);
  await ui.click('collapse');
  assert.match(ui.element('toggle').textContent!, /扩张中/);
  await ui.click('toggle');
  await ui.select('action', 'manual');
  assert.equal(ui.element('search').disabled, true);
  await ui.select('action', 'expansion');
  assert.equal(createWorld.mock.callCount(), 1);
  await act(async () => { ui.dispose(); finish(); await settle(); });
  assert.equal(document.getElementById('swarm-helper-root'), null);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('unmount during manual search releases its late subscription and stops further searches', async () => {
  const f = fixture([planet(1n, 0, 0, true)]);
  let applied!: () => void;
  const unsubscribe = mock.fn();
  const subscribe = mock.fn(() => ({ unsubscribe, isActive: () => true }));
  f.session.conn.subscriptionBuilder = () => {
    const builder = { onApplied(callback: () => void) { applied = callback; return builder; }, onError() { return builder; }, subscribe };
    return builder;
  };
  const ui = await panel();
  await ui.click('toggle');
  await ui.click('search');
  await act(async () => { ui.dispose(); applied(); await settle(); });
  assert.equal(subscribe.mock.callCount(), 1);
  assert.equal(unsubscribe.mock.callCount(), 1);
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});

test('unmount during manual rate-limit wait cancels unsent operations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = fixture([planet(1n, 0, 0, true), planet(2n, 1, 0)]);
  const ui = await panel();
  await ui.click('toggle'); await ui.click('search'); await ui.click('send');
  await act(async () => { ui.dispose(); t.mock.timers.tick(1500); await settle(); });
  assert.equal(f.launchSwarm.mock.callCount(), 0);
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
});

test('uncertain outcome disables dispatch until explicit review, without starting automation', async () => {
  localStorage.setItem('swarm-helper-uncertain-v1', 'pending');
  const createWorld = mock.fn(() => fakeWorld().world);
  const ui = await panel(new AppController(createWorld));
  await ui.click('toggle');
  assert.equal(ui.element('search').disabled, true);
  assert.equal(ui.element('start').disabled, true);
  await ui.click('unlock');
  assert.match(ui.element('unlock-status').textContent!, /勾选确认/);
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), 'pending');
  await ui.click('reviewed'); await ui.click('unlock');
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
  assert.equal(ui.element('start').disabled, false);
  assert.equal(createWorld.mock.callCount(), 0);
});
