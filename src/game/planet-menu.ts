import type { Connection, Session } from './types';

interface Hook { memoizedState?: unknown; next?: Hook }
interface Fiber {
  memoizedProps?: Record<string, unknown>;
  memoizedState?: Hook;
  return?: Fiber;
  alternate?: Fiber;
  stateNode?: { current?: Fiber };
}
export interface MenuBounds { left: number; right: number; top: number; bottom: number }
export interface PlanetMenu extends Session { planetId: bigint; bounds: MenuBounds; zIndex: number }

// React keeps both trees. DOM keys may still point at the previous committed tree.
function currentFiber(element: Element): Fiber | undefined {
  const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
  let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined;
  let root = fiber;
  while (root?.return) root = root.return;
  if (root?.stateNode?.current && root.stateNode.current !== root) fiber = fiber?.alternate;
  return fiber;
}
function bounds(elements: Element[]): MenuBounds | null {
  const rects = elements.map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  return rects.length ? {
    left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)),
    top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)),
  } : null;
}
const validId = (id: unknown): id is bigint => typeof id === 'bigint' && id > 0n && id <= 0xffffffffffffffffn;

/** Read the open menu's target, never the independently selected sending sources. */
export function readPlanetMenu(): PlanetMenu | null {
  const radial = document.querySelector('[data-testid="radial-menu"]');
  const slider = document.querySelector('[data-testid="dial-slider"]');
  const element = radial ?? slider?.closest('.gesture-surface');
  if (!element) return null;
  const rect = bounds([...element.querySelectorAll(radial ? 'button, [data-testid="radial-detail"]' : 'button, [data-testid="dial-slider"]')]);
  if (!rect) return null;
  const zIndex = Number(window.getComputedStyle(element).zIndex) || 100;
  for (let fiber = currentFiber(element), depth = 0; fiber && depth < 80; fiber = fiber.return, depth++) {
    const props = fiber.memoizedProps;
    const conn = props?.conn as Connection | undefined;
    const identity = props?.myIdentity;
    if (!conn?.isActive || !conn.db?.swarm || typeof identity !== 'string') continue;
    let planetId: unknown;
    if (radial) {
      // The native planet action menu owns planetId; sun/base/emote menus don't.
      if (typeof props?.screenX === 'number' && typeof props.screenY === 'number') planetId = props.planetId;
    } else {
      // The send dial receives counts, not the target ID. Its map owner's state
      // contains the route descriptor and target; match the visible dial position.
      let dial: Record<string, unknown> | undefined;
      for (let child = currentFiber(element), n = 0; child && n < 80; child = child.return, n++) {
        if (typeof child.memoizedProps?.onSend === 'function') { dial = child.memoizedProps; break; }
      }
      for (let hook = fiber.memoizedState, n = 0; hook && n < 200; hook = hook.next, n++) {
        const state = hook.memoizedState as { targetId?: unknown; descriptor?: { targetKind?: string }; screenX?: number; screenY?: number } | null;
        if (state?.descriptor?.targetKind === 'planet' && dial && state.screenX === dial.x && state.screenY === dial.y) {
          planetId = state.targetId; break;
        }
      }
    }
    if (validId(planetId) && conn.db.planet.planetId.find(planetId)) return { conn, identity, planetId, bounds: rect, zIndex };
  }
  return null;
}
