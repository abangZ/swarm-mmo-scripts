import { onCleanup } from './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mountPanel } from '../src/app/mount';
import { AppController } from '../src/app/controller';
import { defaults } from '../src/features/expansion/types';
import { settle, fakeWorld } from './helpers/fixtures';
import { appVersion } from '../src/app/version';

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

test('fast-expansion strategy controls persist special targets and stable upgrades without starting on toggle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const f = fakeWorld(), controller = new AppController(() => f.world), ui = await panel(controller);
  await ui.click('toggle');
  assert.equal(ui.element<HTMLSelectElement>('cautiousExpansion').value, '0');
  for (const key of ['captureSuns', 'captureMeteorites', 'upgradeStable']) assert.equal(ui.element<HTMLInputElement>(key).checked, true);
  await ui.click('upgradeStable'); await ui.select('cautiousExpansion', '1');
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  await ui.click('start');
  const saved = JSON.parse(localStorage.getItem('swarm-helper-expansion-settings')!);
  assert.equal(saved.upgradeStable, 0); assert.equal(saved.cautiousExpansion, 1); assert.equal(saved.captureSuns, 1);
  assert.equal(saved.economicHorizonMs, 10800000);
  for (const key of ['captureSuns', 'captureMeteorites', 'upgradeStable']) assert.equal(ui.element<HTMLInputElement>(key).disabled, true);
  await act(async () => { ui.dispose(); t.mock.timers.tick(500); await settle(); });
});

test('tabs replace manual actions and support keyboard navigation without starting expansion', async () => {
  const create = mock.fn(() => fakeWorld().world);
  const ui = await panel(new AppController(create));
  assert.equal(ui.element('panel').hidden, true);
  assert.equal(ui.root.querySelector('.app-version')!.textContent, `Swarm 助手 v${appVersion}`);
  assert.equal(ui.root.querySelector('.app-version')!.closest('[hidden]'), null);
  assert.match(ui.element('toggle').textContent!, /未启动/);
  assert.match(ui.element('compact-log').textContent!, /尚无运行日志/);
  await ui.click('toggle');
  assert.equal(ui.root.querySelector('.app-version')!.closest('[hidden]'), null);
  assert.equal(ui.root.activeElement, ui.element('collapse'));
  assert.equal(ui.root.getElementById('manual'), null);
  assert.equal(ui.root.getElementById('send'), null);
  assert.equal(ui.element('tab-expansion').getAttribute('aria-selected'), 'true');
  await act(async () => ui.element('tab-expansion').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  assert.equal(ui.element('attack').hidden, false);
  assert.equal(ui.element('expansion').hidden, true);
  assert.equal(ui.root.activeElement, ui.element('tab-attack'));
  assert.match(ui.element('attack').textContent!, /开始进攻/);
  assert.equal(ui.element<HTMLInputElement>('attack-x').value, '');
  assert.equal(create.mock.callCount(), 0);
  await ui.click('collapse');
  assert.equal(ui.root.activeElement, ui.element('toggle'));
});

test('saved settings migrate into controlled fields and save seconds as milliseconds', async () => {
  localStorage.setItem('swarm-helper-expansion-settings', JSON.stringify({ ...defaults, maxSources: undefined, scanMs: 15000, candidates: 7 }));
  const f = fakeWorld();
  f.world.read = () => { throw new Error('test stop'); };
  const controller = new AppController(() => f.world);
  const ui = await panel(controller);
  await ui.click('toggle');
  assert.equal(ui.element<HTMLSelectElement>('scanMs').value, '10');
  assert.equal(ui.element<HTMLInputElement>('maxSources').value, '3');
  assert.equal(ui.element<HTMLInputElement>('maxSources').type, 'number');
  assert.equal(ui.element<HTMLInputElement>('maxSources').max, '10');
  assert.equal(ui.element<HTMLInputElement>('candidates').value, '7');
  assert.equal(ui.element<HTMLInputElement>('maxTravelMs').value, '1800');
  assert.match(ui.root.textContent!, /规划队列窗口.*不限制航行时间/);
  await ui.select('scanMs', '30');
  await act(async () => controller.setSetting('maxSources', '10'));
  assert.equal(ui.element<HTMLInputElement>('maxSources').value, '10');
  await ui.click('start');
  const saved = JSON.parse(localStorage.getItem('swarm-helper-expansion-settings')!);
  assert.equal(saved.scanMs, 30000);
  assert.equal(saved.maxSources, 10);
  assert.equal(saved.intervalMs, 1500);
  assert.equal(saved.candidates, 7);
  assert.match(ui.element('auto-status').textContent!, /test stop/);
  assert.match(ui.element('activity-log').textContent!, /test stop/);
  await ui.click('collapse');
  assert.match(ui.element('toggle').textContent!, /暂缓操作/);
  assert.match(ui.element('compact-log').textContent!, /test stop/);
});

test('idle source details explain available stock and the separate travel limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const f = fakeWorld();
  f.world.quote = () => ({ count: 7, travelMs: 1900000 });
  f.world.route = () => ({ travelMs: 1900000, lossPct: 0 });
  const ui = await panel(new AppController(() => f.world));
  await ui.click('toggle'); await ui.click('start');
  assert.match(ui.root.textContent!, /未派兵原因/);
  assert.match(ui.root.textContent!, /#1 \(0, 0\) · 可用 20/);
  assert.match(ui.root.textContent!, /1900 秒.*1800 秒/);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  await act(async () => { ui.dispose(); t.mock.timers.tick(500); await settle(); });
});

test('starting folds settings; tabs and collapse keep one engine; unmount cancels pending scan', async () => {
  const f = fakeWorld();
  let finish!: () => void;
  f.world.scan = () => new Promise<void>(resolve => { finish = resolve; });
  const createWorld = mock.fn(() => f.world);
  const ui = await panel(new AppController(createWorld));
  await ui.click('toggle');
  assert.equal(ui.element('expansion-settings').hidden, false);
  await act(async () => { ui.element('start').click(); ui.element('start').click(); await settle(); });
  assert.equal(createWorld.mock.callCount(), 1);
  assert.equal(ui.element('expansion-settings').hidden, true);
  assert.equal(ui.element('start').disabled, true);
  await ui.click('settings-toggle');
  assert.equal(ui.element('expansion-settings').hidden, false);
  assert.equal(ui.element<HTMLSelectElement>('scanMs').disabled, true);
  await ui.click('collapse');
  assert.match(ui.element('toggle').textContent!, /扫描中/);
  assert.match(ui.element('compact-log').textContent!, /正在扫描/);
  await ui.click('toggle');
  await ui.click('tab-attack');
  assert.match(ui.element('attack').textContent!, /自动扩张仍在运行/);
  await ui.click('tab-expansion');
  assert.equal(createWorld.mock.callCount(), 1);
  await act(async () => { ui.dispose(); finish(); await settle(); });
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('running panel reports pending confirmation, scan timing, latest log while collapsed, and stopped state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const f = fakeWorld();
  let scanDone!: () => void;
  f.world.scan = () => new Promise<void>(resolve => { scanDone = resolve; });
  let acknowledge!: () => void;
  f.world.launch = mock.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const ui = await panel(new AppController(() => f.world));
  await ui.click('toggle'); await ui.click('start');
  await act(async () => { t.mock.timers.tick(700); scanDone(); await settle(); });
  assert.match(ui.element('auto-status').textContent!, /后台确认/);
  assert.match(ui.element('activity-log').textContent!, /扫描完成/);
  assert.equal(ui.element('next-scan').textContent, '10 秒后');
  await ui.click('collapse');
  assert.match(ui.element('toggle').textContent!, /运行中/);
  await act(async () => { acknowledge(); await settle(); });
  assert.match(ui.element('compact-log').textContent!, /已确认发射/);
  await act(async () => { t.mock.timers.tick(2000); await settle(); });
  await ui.click('toggle');
  assert.equal(ui.element('next-scan').textContent, '8 秒后');
  assert.match(ui.element('auto-counts').textContent!, /1已发舰队/);
  await ui.click('stop');
  await act(async () => { t.mock.timers.tick(500); await settle(); });
  assert.equal(ui.element('start').disabled, false);
  assert.equal(ui.element('stop').disabled, true);
  await ui.click('collapse');
  assert.match(ui.element('toggle').textContent!, /已停止/);
});

test('uncertain outcome disables dispatch until explicit review, without starting automation', async () => {
  localStorage.setItem('swarm-helper-uncertain-v1', JSON.stringify({ attack: 'pending' }));
  const createWorld = mock.fn(() => fakeWorld().world);
  const ui = await panel(new AppController(createWorld));
  assert.match(ui.element('toggle').textContent!, /结果未知/);
  await ui.click('toggle');
  assert.equal(ui.element('start').disabled, true);
  await ui.click('unlock');
  assert.match(ui.element('unlock-status').textContent!, /勾选确认/);
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), JSON.stringify({ attack: 'pending' }));
  await ui.click('reviewed'); await ui.click('unlock');
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
  assert.equal(ui.element('start').disabled, false);
  assert.equal(createWorld.mock.callCount(), 0);
});

test('an old expansion timeout leaves the start button available and clears automatically on explicit start', async () => {
  localStorage.setItem('swarm-helper-uncertain-v1', JSON.stringify({ expansion: 'old-timeout' }));
  const f = fakeWorld(), controller = new AppController(() => f.world);
  const ui = await panel(controller);
  assert.equal(ui.element('start').disabled, false);
  assert.equal(ui.root.getElementById('reviewed'), null);
  assert.equal((f.world.launch as any).mock.callCount(), 0, 'loading the new panel never auto-starts');
  await ui.click('toggle'); await ui.click('start');
  assert.equal(localStorage.getItem('swarm-helper-uncertain-v1'), null);
  assert.equal((f.world.launch as any).mock.callCount(), 1);
  await ui.click('stop');
});

test('map-based regions and enemy picker remain independent, and preview never starts automation', async () => {
  const f = fakeWorld();
  const enemy = 'a'.repeat(64);
  f.target.ownerId = { toHexString: () => enemy };
  Object.assign(f.snapshot, { identity: 'me', allies: new Set(['me']), intelligence: true, players: new Map([[enemy, '邻居甲']]) });
  const point = mock.fn(() => ({ x: 1, y: 0 })), focus = mock.fn();
  const controller = new AppController(() => f.world, { point, focus });
  const ui = await panel(controller);
  await ui.click('toggle'); await ui.click('tab-attack'); await ui.click('attack-pick-view');
  assert.equal(ui.element<HTMLInputElement>('attack-x').value, '1');
  assert.equal(ui.element<HTMLInputElement>('attack-y').value, '0');
  assert.equal(controller.getSnapshot().policies.expansion.scope, 'all');
  await ui.click('attack-preview');
  assert.match(ui.element('attack-preview-status').textContent!, /敌方 1/);
  assert.match(ui.element('attack-enemy').textContent!, /邻居甲/);
  await ui.select('attack-enemy', enemy);
  assert.equal(controller.getSnapshot().policies.attack.enemy, enemy);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(controller.getSnapshot().attack.running, false);
  const ids = [...ui.root.querySelectorAll('[id]')].map(el => el.id);
  assert.equal(new Set(ids).size, ids.length, 'hidden tabs must not duplicate DOM ids');
});

test('attack requires a fixed zone and unknown results disable both start buttons', async () => {
  const create = mock.fn(() => fakeWorld().world);
  const ui = await panel(new AppController(create));
  await ui.click('toggle'); await ui.click('tab-attack'); await ui.click('attack-start');
  assert.match(ui.element('attack-auto-status').textContent!, /选取战区/);
  assert.equal(create.mock.callCount(), 0);
  await act(async () => ui.dispose());
  localStorage.setItem('swarm-helper-uncertain-v1', JSON.stringify({ attack: 'pending' }));
  const next = await panel(new AppController(create));
  assert.equal(next.element('start').disabled, true);
  assert.equal(next.element('attack-start').disabled, true);
});

test('obsolete region preview is discarded after editing and is cleaned up on unmount', async () => {
  const f = fakeWorld(); let finish!: () => void;
  f.world.scan = () => new Promise<void>(resolve => { finish = resolve; });
  const controller = new AppController(() => f.world, { point: () => ({ x: 1, y: 0 }), focus: () => {} });
  const ui = await panel(controller);
  await ui.click('toggle'); await ui.click('tab-attack'); await ui.click('attack-pick-view');
  await act(async () => { void controller.previewRegion('attack'); await settle(); });
  assert.equal(controller.getSnapshot().previews.attack.busy, true);
  await act(async () => { controller.setPolicy('attack', 'x', '100'); finish(); await settle(); });
  assert.equal(controller.getSnapshot().previews.attack.enemies.length, 0);
  assert.equal(controller.getSnapshot().previews.attack.message, '');
  assert.equal((f.world.dispose as any).mock.callCount(), 1);
});

test('hub selection preserves bigint identity and never moves the fixed war zone', async () => {
  const f = fakeWorld(), id = '9007199254740993';
  const controller = new AppController(() => f.world, { point: () => ({ x: 3, y: 4, planetId: id }), focus: () => {} });
  const ui = await panel(controller);
  await ui.click('toggle'); await ui.click('tab-attack'); await ui.click('attack-pick-view');
  const zone = { x: controller.getSnapshot().policies.attack.x, y: controller.getSnapshot().policies.attack.y };
  assert.equal(ui.element<HTMLInputElement>('attack-maxTravelMs').value, '1800');
  assert.equal(ui.element<HTMLSelectElement>('attack-rallyHubs').value, '3');
  await ui.select('attack-rallyHubs', '2');
  await ui.click('attack-pick-hub');
  assert.equal(ui.element<HTMLSelectElement>('attack-rallyId').value, id);
  assert.equal(ui.element<HTMLSelectElement>('attack-rallyHubs').value, '1');
  assert.equal(ui.element<HTMLSelectElement>('attack-rallyHubs').disabled, true);
  await ui.select('attack-rallyId', '');
  assert.equal(ui.element<HTMLSelectElement>('attack-rallyHubs').value, '2');
  assert.equal(ui.element<HTMLSelectElement>('attack-rallyHubs').disabled, false);
  await ui.select('attack-advanceHub', 'no');
  assert.equal(controller.getSnapshot().policies.attack.advanceHub, 'no');
  assert.deepEqual({ x: controller.getSnapshot().policies.attack.x, y: controller.getSnapshot().policies.attack.y }, zone);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
});
