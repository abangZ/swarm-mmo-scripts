import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planetPlanLines } from '../src/features/commander/planet-plan';
import { idleState } from '../src/features/commander/engine';
import type { Assignment } from '../src/features/expansion/types';

test('source, support and destination see their own assignments without matching another body type', () => {
  const id = 9007199254740993n;
  const supply: Assignment = { sourceId: 2n, targetId: 3n, count: 10, kind: 'sun-supply', travelMs: 5000, support: [{ sourceId: id, count: 8, travelMs: 1000 }] };
  const sun: Assignment = { sourceId: 3n, targetId: id, targetKind: 'sun', count: 18, travelMs: 2000 };
  const state = { ...idleState(), queue: [supply, sun] };
  assert.deepEqual(planetPlanLines(id, 'expansion', state, []), ['扩张 · 待执行 · 派 8 探针补给星球 #3']);
  assert.deepEqual(planetPlanLines(3n, 'expansion', state, []), [
    `扩张 · 待执行 · #2 + #${id} 派 18 探针补给本星`, `扩张 · 待执行 · 派 18 探针占领恒星 #${id}`]);
  state.queue = [];
  assert.deepEqual(planetPlanLines(id, 'expansion', state, [sun]), []);
  assert.match(planetPlanLines(3n, 'expansion', state, [sun])[0], /已提交.*待核实占领/);
});

test('attack shows refreshed dispatch counts, rally roles and saving goals', () => {
  const job = { sourceId: 1n, targetId: 2n, count: 10, travelMs: 1000 };
  const state = { ...idleState(), queue: [job], confirming: { ...job, count: 14 }, rallies: [{ hub: 1n, target: 2n, required: 14, available: 8, incoming: 6, sources: 1 }] };
  assert.deepEqual(planetPlanLines(2n, 'attack', state, []), ['进攻 · 等待发射回执 · #1 派 14 探针进攻本星', '进攻 · 中转星 #1 正为进攻本星集结（8/14）']);
  assert.match(planetPlanLines(1n, 'attack', { ...idleState(), saving: job }, [])[0], /#1 正为进攻 #2 攒兵/);
});
