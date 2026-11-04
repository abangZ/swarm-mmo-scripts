import { onCleanup } from './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mountPanel } from '../src/app/mount';
import { AppController } from '../src/app/controller';
import { defaults } from '../src/features/expansion/types';
import { settle, fakeWorld } from './helpers/fixtures';
import { appVersion } from '../src/app/version';
import { createRoot } from 'react-dom/client';
import { idleState } from '../src/features/commander/engine';
import { RunStatus } from '../src/ui/RunStatus';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test('meteorite diagnostics stay in an expandable section and preserve full bigint ids', async () => {
  const host = document.createElement('div'), root = createRoot(host);
  try {
    await act(async () => root.render(<RunStatus state={{ ...idleState(), meteorites: [{ targetId: 9007199254740993n, reason: '可用兵力不足：需 300，可用 200' }] }} uncertain={false} />));
    const details = [...host.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent?.includes('陨石快速检查'))!;
    assert.equal(details.open, false);
    assert.match(details.textContent!, /9007199254740993/); assert.match(details.textContent!, /需 300，可用 200/);
  } finally { await act(async () => root.unmount()); }
});
test('setting help belongs to its heading and does not toggle the adjacent checkbox', async () => {
  const ui = await panel();
  await ui.click('toggle');
  const heading = ui.element('intervalMs').previousElementSibling!;
  const help = heading.querySelector('button')!;
  assert.equal(heading.querySelector('[role="tooltip"]'), null);
  await act(async () => help.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.match(heading.querySelector('[role="tooltip"]')!.textContent!, /1.0～1.4 秒/);
  assert.equal(ui.element('reserve').previousElementSibling!.querySelector('[role="tooltip"]'), null);
  await act(async () => help.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(heading.querySelector('[role="tooltip"]'), null);
  const checkbox = ui.element<HTMLInputElement>('upgradeStable');
  const upgradeHelp = checkbox.closest('.setting-heading')!.querySelector('button')!;
  const before = checkbox.checked;
  await act(async () => { upgradeHelp.click(); upgradeHelp.click(); });
  assert.equal(checkbox.checked, before);
  const tooltip = checkbox.closest('.setting-heading')!.querySelector('[role="tooltip"]')!;
  assert.match(tooltip.textContent!, /1→2/);
  assert.equal(upgradeHelp.getAttribute('aria-describedby'), tooltip.id);
  await act(async () => { upgradeHelp.focus(); upgradeHelp.blur(); });
  assert.equal(checkbox.closest('.setting-heading')!.querySelector('[role="tooltip"]'), null);
});

test('live work shows planning stage and elapsed time instead of a stale upgrade event', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); onCleanup(() => act(async () => root.unmount()));
  const state = { ...idleState(), running: true, activity: 'sent' as const, phase: '已确认升级星球 #7；同步库存',
    work: { plan: { startedAt: 90000, stage: '筛选附近目标与合兵' }, background: 2 } };
  await act(async () => root.render(<RunStatus state={state} uncertain={false} />));
  assert.equal(host.querySelector('.status-badge')!.textContent, '规划中');
  assert.equal(host.querySelector('#auto-status')!.textContent, '正在筛选附近目标与合兵');
  assert.match(host.textContent!, /已耗时 10 秒/);
  assert.match(host.textContent!, /后台回执 \/ 同步 2 项/);
  assert.match(host.textContent!, /最近事件：已确认升级/);
  assert.equal(host.querySelector('#next-scan')!.textContent, '本轮规划后计时');
  await act(async () => t.mock.timers.tick(2000));
  assert.match(host.textContent!, /已耗时 12 秒/);
  await act(async () => root.render(<RunStatus state={{ ...state, running: false, activity: 'stopped', phase: '已停止' }} uncertain={false} />));
  assert.equal(host.querySelector('#auto-status')!.textContent, '已停止');
  assert.doesNotMatch(host.textContent!, /全局规划/);
});

test('short frontline checks keep the main status and row structure stable, while slow checks remain observable', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); onCleanup(() => act(async () => root.unmount()));
  const state = { ...idleState(), running: true, activity: 'sent' as const,
    work: { plan: { startedAt: 90000, stage: '筛选附近目标与合兵' } } };
  const render = (frontier?: number) => act(async () => root.render(<RunStatus state={{ ...state, work: { ...state.work, frontier } }} uncertain={false} />));
  await render();
  const progress = host.querySelector('.expansion-progress')!;
  const rows = [...progress.children];
  const text = host.querySelector('#auto-status')!.textContent;
  for (let i = 0; i < 3; i++) {
    await render(Date.now());
    assert.equal(host.querySelector('.status-badge')!.textContent, '规划中');
    assert.equal(host.querySelector('#auto-status')!.textContent, text);
    assert.equal(host.querySelector('.frontier-status')!.textContent, '前线监测：已开启');
    await act(async () => t.mock.timers.tick(100));
    await render();
    assert.deepEqual([...progress.children], rows);
  }
  await render(Date.now());
  await act(async () => t.mock.timers.tick(3000));
  assert.match(host.querySelector('.frontier-status')!.textContent!, /正在检查 · [23] 秒/);
  assert.deepEqual([...progress.children], rows);
  await render();
  assert.equal(host.querySelector('.frontier-status')!.textContent, '前线监测：已开启');
  await act(async () => root.render(<RunStatus state={{ ...state, running: false, activity: 'stopped', phase: '已停止' }} uncertain={false} />));
  assert.equal(host.querySelector('.frontier-status'), null);
  assert.equal(host.querySelector('#auto-status')!.textContent, '已停止');
});

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
  const windowHeading = ui.element('horizonMs').previousElementSibling!;
  assert.match(windowHeading.textContent!, /规划队列窗口/);
  await act(async () => windowHeading.querySelector('button')!.click());
  assert.match(windowHeading.querySelector('[role="tooltip"]')!.textContent!, /不是扫描间隔或航行截止时间/);
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
  assert.match(ui.element('toggle').textContent!, /后台确认中/);
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
