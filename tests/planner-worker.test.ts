import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { planningSnapshot, type PlanningRequest, type PlanningResponse } from '../src/features/expansion/planner-work';
import { expansionProposals, type ExpansionProposals } from '../src/features/expansion/proposals';
import { planExpansion } from '../src/features/expansion/planner';
import { defaults, type Plan } from '../src/features/expansion/types';
import { defaultPolicy } from '../src/features/commander/types';
import type { ExpansionWorld, WorldSnapshot } from '../src/features/expansion/world';

test('the bundled worker preserves bigint ids and matches local planning for 1311 sources / 566 targets', async t => {
  const owner = { toHexString: () => 'me' };
  const makePlanet = (i: number, owned: boolean) => ({ planetId: BigInt(i) + (owned ? 9007199254740993n : 10000n),
    positionX: i % 40 - 20, positionY: Math.floor(i / 40) - 10, galaxyId: 1n, probeCount: 30 + i % 13,
    level: i % 8 + 1, ownerId: owned ? owner : undefined });
  const owned = Array.from({ length: 1311 }, (_, i) => makePlanet(i, true));
  const snapshot: WorldSnapshot = { owned, planets: [...owned, ...Array.from({ length: 566 }, (_, i) => makePlanet(i, false))],
    budgets: new Map(owned.map(p => [p.planetId, 100])), incoming: new Set(), identity: 'me', intelligence: true, fleets: [] };
  let quoteCalls = 0;
  const world: ExpansionWorld = { read: () => snapshot, scan: async () => {}, dispose() {}, launch: async () => {}, launchGroup: async () => {},
    quote: (source, target) => { quoteCalls++; return { count: 32 + Number(target % 13n), travelMs: 60000 + Number((source + target) % 100n) * 1000 }; },
    route: (source, target) => ({ travelMs: 60000 + Number((source + target) % 100n) * 1000, lossPct: 0 }) };
  const config = { settings: { ...defaults, radius: 64, intervalMs: 1200 }, policy: defaultPolicy };
  const expected = expansionProposals(world, snapshot, config, snapshot.budgets, new Set());
  const originalQuoteCalls = quoteCalls; quoteCalls = 0;
  const bundle = await build({ entryPoints: ['src/features/expansion/planner.worker.ts'], bundle: true, write: false, format: 'iife', target: 'es2022' });
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = message => parentPort.postMessage(message);
    parentPort.on('message', data => globalThis.onmessage({ data }));\n${bundle.outputFiles[0].text}`, { eval: true });
  t.after(() => worker.terminate());
  const request = <T>(message: PlanningRequest) => new Promise<T>((resolve, reject) => {
    const receive = (reply: PlanningResponse) => {
      if (reply.type === 'quotes') {
        worker.postMessage({ type: 'quotes', rows: reply.request.targets.map(target => ({ target,
          quote: world.quote(reply.request.source, target), route: world.route!(reply.request.source, target) })) } satisfies PlanningRequest);
      } else {
        worker.off('message', receive); worker.off('error', reject);
        if (reply.type === 'error') reject(new Error(reply.message)); else resolve(reply.result as T);
      }
    };
    worker.on('message', receive); worker.once('error', reject); worker.postMessage(message);
  });
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 10); t.after(() => clearInterval(timer));
  const started = performance.now();
  const proposals = await request<ExpansionProposals>({ type: 'proposals', snapshot: planningSnapshot(snapshot), config,
    budgets: snapshot.budgets, locked: new Set(), groups: true });
  const planned = await request<Plan>({ type: 'plan', edges: proposals.edges, budgets: snapshot.budgets, interval: 1200, horizon: 120000, travel: 1800000, delay: 0 });
  const elapsed = performance.now() - started;
  assert.deepEqual(proposals, expected);
  assert.equal(quoteCalls, originalQuoteCalls, 'worker batching must not add native quote calls');
  assert.deepEqual(planned, planExpansion(expected.edges, snapshot.budgets, 1200, 120000, 1800000));
  assert.ok(heartbeats > 0, 'main thread timers keep running while the real worker computes');
  assert.equal(proposals.sources.length, 1311);
  t.diagnostic(`1311 sources / 566 targets: worker round ${elapsed.toFixed(0)} ms, ${planned.jobs.length} jobs, ${heartbeats} main-thread heartbeats; synthetic in-memory quotes`);
});
