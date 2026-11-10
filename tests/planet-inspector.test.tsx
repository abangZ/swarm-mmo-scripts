import { onCleanup } from './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { totalIncoming, watchIncoming } from '../src/game/incoming-fleets';
import { readPlanetMenu, type PlanetMenu } from '../src/game/planet-menu';
import { PlanetInspector } from '../src/app/planet-inspector';
import { mountInspector } from '../src/app/mount-inspector';
import { inspectorPosition } from '../src/ui/PlanetIncoming';
import { fixture, planet } from './helpers/fixtures';
import type { Swarm } from '../src/game/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const owner = (id: string) => ({ toHexString: () => id });
function setup() {
  const f = fixture([planet(1n, 0, 0), planet(2n, 1, 0)]);
  const rows: Swarm[] = [];
  const clans = [{ playerId: owner('me'), clanId: 1n }, { playerId: owner('friend'), clanId: 1n }];
  f.session.conn.db.swarm = { iter: () => rows };
  f.session.conn.db.clan_member2 = { iter: () => clans };
  const subscriptions: { apply(): void; error(): void; unsubscribe: ReturnType<typeof mock.fn>; active: boolean; query: string }[] = [];
  f.session.conn.subscriptionBuilder = () => {
    let applied = () => {}, error = () => {};
    const builder = {
      onApplied(fn: () => void) { applied = fn; return builder; },
      onError(fn: () => void) { error = fn; return builder; },
      subscribe(query: string) {
        const sub = { apply() { sub.active = true; applied(); }, error() { error(); }, unsubscribe: mock.fn(() => { sub.active = false; }), active: false, query };
        subscriptions.push(sub);
        return { unsubscribe: sub.unsubscribe, isActive: () => sub.active };
      },
    };
    return builder;
  };
  const menu: PlanetMenu = { conn: f.session.conn, identity: 'me', planetId: 1n, bounds: { left: 200, top: 100, right: 400, bottom: 350 }, zIndex: 100 };
  const add = (id: bigint, who: string, count?: number, target = 1n) => rows.push({ swarmId: id, ownerId: owner(who), targetPlanetId: target, probeCount: count });
  return { ...f, conn: f.session.conn, rows, clans, subscriptions, menu, add };
}

test('incoming totals count only the target, separate allies, deduplicate fleets and preserve unknown counts', () => {
  const f = setup();
  f.add(1n, 'me', 8000); f.add(2n, 'foe', 12000); f.add(3n, 'friend', 200);
  f.add(4n, 'foe'); f.add(5n, 'me', 9000, 2n); f.rows.push(f.rows[0]);
  assert.deepEqual(totalIncoming(f.conn, 'me', 1n), {
    mine: { probes: '8000', fleets: 1, unknown: 0 }, enemy: { probes: '12000', fleets: 2, unknown: 1 }, ally: { probes: '200', fleets: 1, unknown: 0 },
  });
  f.clans.splice(0);
  assert.equal(totalIncoming(f.conn, 'me', 1n).enemy.probes, '12200');
  f.rows.splice(0);
  assert.equal(totalIncoming(f.conn, 'me', 1n).mine.probes, '0');
});

test('both subscriptions must apply before zero can be shown; updates and removals use current rows', () => {
  const f = setup(), watch = watchIncoming(f.conn, 'me', 1n); onCleanup(watch.dispose);
  assert.equal(watch.read().status, 'loading');
  assert.deepEqual(f.subscriptions.map(s => s.query), ['SELECT * FROM swarm WHERE target_planet_id = 1', 'SELECT * FROM clan_member2']);
  f.subscriptions[0].apply(); assert.equal(watch.read().status, 'loading');
  f.subscriptions[1].apply(); assert.equal(watch.read().status, 'ready');
  f.add(1n, 'me', 55);
  assert.equal((watch.read() as any).totals.mine.probes, '55');
  f.rows.pop(); assert.equal((watch.read() as any).totals.mine.probes, '0');
  f.subscriptions[0].active = false;
  assert.equal(watch.read().status, 'error');
  assert.ok(f.subscriptions.every(s => s.unsubscribe.mock.callCount() === 1));
});

test('rapid menu changes cancel pending handles and late callbacks cannot publish old totals', () => {
  const f = setup(); let menu: PlanetMenu | null = f.menu;
  const controller = new PlanetInspector(() => [], () => menu); onCleanup(() => controller.dispose());
  controller.refresh();
  assert.equal(f.subscriptions.length, 0);
  controller.load(f.menu);
  menu = { ...f.menu, planetId: 2n }; controller.refresh();
  assert.ok(f.subscriptions.slice(0, 2).every(s => s.unsubscribe.mock.callCount() === 1));
  f.subscriptions[0].apply(); f.subscriptions[1].error();
  assert.equal(controller.getSnapshot()!.incoming.status, 'idle');
  assert.equal(f.subscriptions.length, 2);
  controller.load(menu);
  f.subscriptions[2].apply(); f.subscriptions[3].apply(); controller.refresh();
  assert.equal(controller.getSnapshot()!.menu.planetId, 2n);
  assert.equal(controller.getSnapshot()!.incoming.status, 'ready');
  menu = null; controller.refresh();
  assert.equal(controller.getSnapshot(), null);
  assert.ok(f.subscriptions.every(s => s.unsubscribe.mock.callCount() === 1));
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});

test('timeout and subscription failure show unavailable, release handles and do not retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(), watch = watchIncoming(f.conn, 'me', 1n); onCleanup(watch.dispose);
  t.mock.timers.tick(12000);
  assert.equal(watch.read().status, 'error'); assert.equal(f.subscriptions.length, 2);
  f.subscriptions[0].apply(); f.subscriptions[1].apply();
  assert.equal(watch.read().status, 'error');
  const second = watchIncoming(f.conn, 'me', 2n); onCleanup(second.dispose);
  f.subscriptions[2].error(); assert.equal(second.read().status, 'error');
  assert.ok(f.subscriptions.every(s => s.unsubscribe.mock.callCount() === 1));
});

test('connection/identity changes require a new click without touching another owner', () => {
  const f = setup(), other = setup(); let menu = f.menu;
  const controller = new PlanetInspector(() => [], () => menu); onCleanup(() => controller.dispose());
  const external = f.conn.subscriptionBuilder().subscribe('external');
  controller.refresh(); controller.load(menu); menu = { ...other.menu, identity: 'new' }; controller.refresh();
  assert.equal(f.subscriptions[0].unsubscribe.mock.callCount(), 0);
  assert.ok(f.subscriptions.slice(1).every(s => s.unsubscribe.mock.callCount() === 1));
  assert.equal(other.subscriptions.length, 0);
  controller.load(menu); assert.equal(other.subscriptions.length, 2);
  external.unsubscribe();
});

test('only an explicit current-target click subscribes; duplicate clicks and stale clicks cannot request', () => {
  const f = setup(); let menu: PlanetMenu | null = f.menu;
  const controller = new PlanetInspector(() => [], () => menu); onCleanup(() => controller.dispose());
  for (let i = 0; i < 5; i++) controller.refresh();
  assert.equal(f.subscriptions.length, 0);
  menu = { ...f.menu, planetId: 2n };
  controller.load(f.menu);
  assert.equal(f.subscriptions.length, 0, 'click from the old target must not query either target');
  controller.load(menu); controller.load(menu);
  assert.equal(f.subscriptions.length, 2);
  f.subscriptions.forEach(s => s.apply()); controller.refresh(); controller.load(menu);
  assert.equal(f.subscriptions.length, 2, 'ready data continues using existing subscriptions');
  menu = null; controller.refresh(); menu = f.menu; controller.refresh();
  assert.equal(controller.getSnapshot()!.incoming.status, 'idle');
  assert.equal(f.subscriptions.length, 2, 'reopening does not request');
  controller.dispose(); controller.load(f.menu);
  assert.equal(f.subscriptions.length, 2);
});

function nativeMenu(f: ReturnType<typeof setup>, dial = false) {
  const element = document.createElement('div');
  element.style.zIndex = '140';
  if (dial) element.className = 'gesture-surface'; else element.dataset.testid = 'radial-menu';
  const button = document.createElement('button');
  if (dial) button.dataset.testid = 'dial-slider';
  button.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200 }) as DOMRect;
  element.append(button); document.body.append(element);
  const parent: any = { memoizedProps: { conn: f.conn, myIdentity: 'me', planetId: 2n, screenX: 200, screenY: 200 } };
  (element as any).__reactFiber$inspector = { return: parent };
  return { element, parent };
}

test('native action menu uses its own planet, not selected sources; unrelated menus are ignored', () => {
  const f = setup(), native = nativeMenu(f);
  assert.equal(readPlanetMenu()!.planetId, 2n);
  assert.equal(readPlanetMenu()!.zIndex, 140);
  delete native.parent.memoizedProps.planetId;
  native.parent.memoizedProps.sunId = 2n;
  assert.equal(readPlanetMenu(), null);
});

test('native menu follows the committed React alternate after reusing a DOM node', () => {
  const f = setup(), native = nativeMenu(f);
  const currentRoot: any = { stateNode: {} }, oldRoot: any = { stateNode: { current: currentRoot } };
  currentRoot.stateNode.current = currentRoot;
  native.parent.return = oldRoot;
  const current = { return: { memoizedProps: { ...native.parent.memoizedProps, planetId: 1n }, return: currentRoot } };
  (native.element as any).__reactFiber$inspector.alternate = current;
  assert.equal(readPlanetMenu()!.planetId, 1n);
});

test('send dial identifies destination from the map route and excludes sun destinations', () => {
  const f = setup(), native = nativeMenu(f, true);
  const route = { descriptor: { targetKind: 'planet' }, targetId: 2n, screenX: 200, screenY: 200 };
  native.parent.memoizedProps = { onSend() {}, x: 200, y: 200 };
  native.parent.return = { memoizedProps: { conn: f.conn, myIdentity: 'me' }, memoizedState: { memoizedState: route } };
  assert.equal(readPlanetMenu()!.planetId, 2n);
  route.descriptor.targetKind = 'sun'; assert.equal(readPlanetMenu(), null);
});

test('inspector UI shows loading, totals, unknown, failures and cleans its root on disposal', async () => {
  const f = setup(); let menu: PlanetMenu | null = f.menu;
  const controller = new PlanetInspector(() => [], () => menu);
  let dispose!: () => void;
  await act(async () => { dispose = mountInspector(controller); });
  onCleanup(() => act(async () => dispose()));
  const root = document.getElementById('swarm-helper-incoming')!.shadowRoot!;
  assert.equal(root.querySelector('button')!.getAttribute('aria-label'), '查询在途兵力');
  assert.equal(root.querySelector('button')!.title, '查询在途兵力');
  assert.match(root.querySelector('header')!.textContent!, /星球 #1/);
  assert.equal(f.subscriptions.length, 0);
  const click = () => act(async () => { root.querySelector('button')!.click(); });
  await click();
  assert.ok(root.querySelector('header'));
  assert.match(root.textContent!, /加载中/); assert.doesNotMatch(root.textContent!, /敌方在途/);
  f.add(1n, 'foe', 12350); f.add(2n, 'me', 8600); f.add(3n, 'friend', 2); f.add(4n, 'foe');
  await act(async () => { f.subscriptions.forEach(s => s.apply()); controller.refresh(); });
  assert.match(root.textContent!, /敌方在途≥ 12,350兵 · 2 支/);
  assert.match(root.textContent!, /我的在途8,600兵 · 1 支/);
  assert.match(root.textContent!, /盟友在途2兵 · 1 支/);
  assert.match(root.textContent!, /部分舰队兵力未知/);
  await act(async () => { menu = null; controller.refresh(); });
  assert.equal(root.querySelector('section'), null);
  await act(async () => { menu = f.menu; controller.refresh(); });
  assert.equal(f.subscriptions.length, 2);
  await click();
  await act(async () => { f.subscriptions.at(-1)!.error(); controller.refresh(); });
  assert.match(root.textContent!, /数据不可用/);
  assert.match(root.textContent!, /重新查询/);
  await click();
  assert.equal(f.subscriptions.length, 6);
  assert.match(root.textContent!, /加载中/);
});

test('query button isolates pointer and keyboard events from game controls and removes listeners', async () => {
  const f = setup(), controller = new PlanetInspector(() => [], () => f.menu);
  let dispose!: () => void;
  await act(async () => { dispose = mountInspector(controller); });
  onCleanup(() => act(async () => dispose()));
  const gameEvent = mock.fn();
  const types = ['click', 'pointerdown', 'mousedown', 'keydown', 'keyup'];
  for (const type of types) window.addEventListener(type, gameEvent, type.startsWith('key'));
  onCleanup(() => { for (const type of types) window.removeEventListener(type, gameEvent, type.startsWith('key')); });
  const button = document.getElementById('swarm-helper-incoming')!.shadowRoot!.querySelector('button')!;
  await act(async () => {
    for (const type of types) button.dispatchEvent(new window.Event(type, { bubbles: true, composed: true }));
  });
  assert.equal(gameEvent.mock.callCount(), 0);
  assert.equal(f.subscriptions.length, 2);
  await act(async () => dispose());
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
  assert.equal(gameEvent.mock.callCount(), 1);
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});

test('overlay stays below the menu when possible and inside viewport near edges', () => {
  assert.deepEqual(inspectorPosition({ left: 300, right: 500, top: 200, bottom: 400 }, 270, 130, 1000, 800), { left: 265, top: 408 });
  assert.deepEqual(inspectorPosition({ left: 300, right: 500, top: 400, bottom: 600 }, 270, 130, 1000, 650), { left: 265, top: 262 });
  const position = inspectorPosition({ left: 0, right: 200, top: 50, bottom: 250 }, 270, 130, 375, 300);
  assert.ok(position.left >= 8 && position.left + 270 <= 367);
  assert.ok(position.top >= 8 && position.top + 130 <= 292);
});

test('menu shows the full log ID and refreshes plans for the open planet without querying fleets', async () => {
  const f = setup(), id = 18446744073709551615n;
  let menu = { ...f.menu, planetId: id }, plan = '扩张 · 派 12 探针占领星球 #2';
  const inspector = new PlanetInspector(current => current.planetId === id ? [plan] : ['当前没有针对本星的任务'], () => menu);
  let dispose!: () => void;
  await act(async () => { dispose = mountInspector(inspector); });
  onCleanup(() => act(async () => dispose()));
  const root = document.getElementById('swarm-helper-incoming')!.shadowRoot!;
  assert.equal(root.querySelector('header')!.textContent, `星球 #${id}`);
  assert.match(root.querySelector('ul')!.textContent!, /派 12 探针/);
  await act(async () => { plan = '进攻 · 等待发射回执'; inspector.refresh(); });
  assert.equal(root.querySelector('li')!.textContent, plan);
  await act(async () => { menu = f.menu; inspector.refresh(); });
  assert.equal(root.querySelector('header')!.textContent, '星球 #1');
  assert.equal(root.querySelector('li')!.textContent, '当前没有针对本星的任务');
  assert.equal(f.subscriptions.length, 0);
  assert.equal(f.launchSwarm.mock.callCount(), 0);
});
