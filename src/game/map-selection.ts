import { getAutomationSession } from './session';

export function readMapPoint(kind: 'selection' | 'view'): { x: number; y: number; planetId?: string } {
  const { map } = getAutomationSession();
  const picked = kind === 'selection' ? map.getPickedBody?.() : null;
  const point = kind === 'selection' ? picked : map.getViewCenter?.();
  if (!point || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) throw new Error(kind === 'selection' ? '请先在游戏中选中一颗星球，再读取中心。' : '无法读取地图中心，请手动填写坐标。');
  return { x: point.x, y: point.y, ...(picked && !picked.isSun ? { planetId: String(picked.id) } : {}) };
}
export function focusMap(x: number, y: number) {
  const { map } = getAutomationSession();
  if (!map.focusPlanet) throw new Error('地图定位接口不可用。');
  map.focusPlanet(x, y);
}
