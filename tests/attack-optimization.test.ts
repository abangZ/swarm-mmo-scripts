import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { planet, identity, settle, fakeWorld } from './helpers/fixtures';
import { defaults, members } from '../src/features/expansion/types';
import { defaultPolicy, type ModeConfig } from '../src/features/commander/types';
import { reserveFor, availableBudgets } from '../src/features/commander/safety';
import { Commander } from '../src/features/commander/engine';
import { OffensivePlanner } from '../src/features/attack/rally';
import { attackQuote, planAttack } from '../src/features/attack/planner';
import { attackStartupIssue } from '../src/features/attack/diagnostics';
import type { ExpansionWorld, WorldSnapshot } from '../src/features/expansion/world';
import { withControl } from '../src/runtime/operations';
import { loadPolicies, policyForm, parsePolicy } from '../src/app/regions';
import { AppController } from '../src/app/controller';

const enemy = 'a'.repeat(64);
const config = (): ModeConfig => ({ settings: { ...defaults, radius: 64 }, policy: { ...defaultPolicy, zone: { x: 40, y: 0, radius: 100 }, frontlinePercent: 0 } });
const pending = () => ({ count: 0, arrival: Date.now() });
const guard = () => ({ percent: 0, deficit: 0 });
function fronts(defenders = 100, donors = 24, stock = 50) {
  const hubs = [0, 40, 80].map((x,i) => { const p = planet(BigInt(i+1), x, 0, true); p.level=1; p.probeCount=0; return p; });
  const targets = hubs.map((p,i) => { const t=planet(BigInt(i+11), p.positionX+1,0); t.ownerId={toHexString:()=>enemy};t.level=1;t.probeCount=defenders;t.lastUpdateTick={toMillis:()=>Date.now()};return t; });
  const rear = Array.from({length:donors},(_,i)=>{const p=planet(BigInt(100+i),i%80,2,true);p.level=1;p.probeCount=stock;return p;});
  const owned=[...hubs,...rear];
  const snapshot: WorldSnapshot={planets:[...owned,...targets],owned,allOwned:owned,budgets:new Map(owned.map(p=>[p.planetId,p.probeCount])),identity:'me',intelligence:true,allies:new Set(['me']),incoming:new Set(),fleets:[],automated:new Set()};
  const world: ExpansionWorld={scan:mock.fn(async()=>{}),read:()=>snapshot,dispose:mock.fn(),
    route:(s,t)=>({travelMs:t<10n?2000:s===t-10n?1000:2000000,lossPct:0}),
    quote:(s,t)=>t<10n?null:(snapshot.budgets.get(s)??0)>defenders?{count:defenders+2,travelMs:s===t-10n?1000:2000000}:null,
    launch:mock.fn(async()=>{}),launchGroup:mock.fn(async()=>{})};
  return {hubs,targets,rear,snapshot,world};
}

test('a zero-source attack is rejected after coverage without stopping or spending expansion resources', async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const f=fakeWorld(); f.target.probeCount=10; Object.assign(f.snapshot,{intelligence:true,identity:'me',allies:new Set(['me']),fleets:[],automated:new Set()});
  const attack=config(); attack.policy.zone={x:100,y:0,radius:32};
  assert.match(attackStartupIssue(f.snapshot,attack)!,/距离|距中心 100/);
  const commander=new Commander(()=>{},()=>f.world), run=commander.start('expansion',{settings:defaults,policy:defaultPolicy});
  t.after(async()=>{commander.stop();await run;});
  commander.start('attack',attack); await settle();t.mock.timers.tick(250);await settle();
  assert.equal(commander.states.attack.running,false);assert.match(commander.states.attack.phase,/己方星球为 0/);
  assert.equal(commander.states.attack.ownedCount,0);assert.equal(commander.states.expansion.running,true);
  t.mock.timers.tick(250);await settle(); // Remaining expansion coverage is confirmed on the next tick.
  assert.equal((f.world.launch as any).mock.callCount(),1);
  commander.stop();await run;await withControl(async()=>{});
});

test('all automated sources are diagnosed, and preview validity never arms a mode',()=>{
  const f=fronts(); f.snapshot.automated=new Set(f.snapshot.owned.map(p=>p.planetId));
  assert.match(attackStartupIssue(f.snapshot,config())!,/原生自动/);
  f.snapshot.automated.clear();assert.equal(attackStartupIssue(f.snapshot,config()),undefined);
});

test('attack can dispatch a 15-minute route inside a 120-second queue window but respects the independent cap',()=>{
  const f=fronts(), c=config();f.snapshot.budgets.set(1n,1000);
  f.world.route=()=>({travelMs:900000,lossPct:0}); f.world.quote=()=>({count:10,travelMs:900000});
  const plan=planAttack(f.world,f.snapshot,c,f.snapshot.budgets,new Set());
  assert.ok(plan.jobs!.length);assert.equal(plan.jobs![0].travelMs,900000);
  c.settings.maxTravelMs=600000;
  assert.equal(planAttack(f.world,f.snapshot,c,f.snapshot.budgets,new Set()).jobs!.length,0);
  assert.equal(attackQuote(f.world,f.snapshot,f.hubs[0],f.targets[0],c),null);
});

test('unusable cheap or near targets do not occupy the only direct attack candidate slot',()=>{
  const f=fronts(),c=config();c.settings.candidates=1;f.snapshot.budgets.set(1n,1000);
  f.world.route=(_s,t)=>({travelMs:t===13n?10000:2000000,lossPct:0});f.world.quote=()=>({count:10,travelMs:10000});
  const plan=planAttack(f.world,f.snapshot,c,f.snapshot.budgets,new Set());
  assert.equal(plan.job?.targetId,13n);assert.ok(plan.diagnostics!.tooSlow>0);
  f.snapshot.incoming.add(13n);
  const blocked=planAttack(f.world,f.snapshot,c,f.snapshot.budgets,new Set());
  assert.equal(blocked.diagnostics!.blocked,1);assert.equal(blocked.jobs!.length,0);
});

test('sources whose targets are outside search distance get an actionable waiting reason',()=>{
  const f=fronts(),c=config();c.settings.radius=1;
  for(const p of f.targets)p.positionX++;
  const plan=planAttack(f.world,f.snapshot,c,f.snapshot.budgets,new Set());
  assert.equal(plan.jobs!.length,0);assert.ok(plan.diagnostics!.noTargets>0);assert.match(plan.waiting,/最大搜索距离内无可选目标/);
});

test('a reachable forward hub is considered even behind eight richer hubs with invalid attack routes',()=>{
  const f=fronts(); for(const p of f.rear.slice(0,10)) f.snapshot.budgets.set(p.planetId,500);
  const c=config();c.policy.rallyHubs=1;
  const plan=new OffensivePlanner().plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.ok(plan.rally);assert.ok([1n,2n,3n].includes(plan.rally!.targetId));
});

test('hub selection minimizes gathering plus attack travel, not only the first supply arrival',()=>{
  const f=fronts(10),c=config();c.policy.rallyHubs=1;
  f.world.route=(s,t)=>({travelMs:t<10n?t===1n?1000:20000:s===1n&&t===11n?300000:s===2n&&t===12n?10000:2000000,lossPct:0});
  const plan=new OffensivePlanner().plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.equal(plan.rallyState!.hub,2n,'20s supply + 10s attack beats 1s supply + 300s attack');
  assert.equal(plan.exact,false,'bounded gathering is not an exact global optimum');
});

test('gathering consumes queue slots and displaced direct attacks release their budget',()=>{
  const f=fronts(),c=config();c.settings.horizonMs=10000;c.settings.intervalMs=1000;
  const sniper=planet(500n,10,0,true);sniper.level=1;
  f.snapshot.planets.push(sniper);f.snapshot.owned.push(sniper);f.snapshot.budgets.set(500n,10000);
  for(let i=0;i<15;i++){const t=planet(BigInt(600+i),10,i);t.level=1;t.ownerId={toHexString:()=>enemy};t.lastUpdateTick={toMillis:()=>Date.now()};f.snapshot.planets.push(t);}
  c.settings.candidates=20;
  const quote=f.world.quote,route=f.world.route!;
  f.world.quote=(s,t)=>s===500n&&t>=600n?{count:10,travelMs:1000}:quote(s,t);
  f.world.route=(s,t)=>t>=600n?{travelMs:s===500n?1000:2000000,lossPct:0}:route(s,t);
  const plan=new OffensivePlanner().plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.equal(plan.jobs!.length,11);assert.equal(plan.jobs!.filter(j=>j.kind==='reinforce').length,3);
  assert.equal(plan.reservations.get(500n),plan.jobs!.filter(j=>j.sourceId===500n).reduce((n,j)=>n+j.count,0));
});

test('three campaigns reserve disjoint amounts and round-robin unfinished bulk batches',()=>{
  const f=fronts(300,220,10),c=config(),planner=new OffensivePlanner();
  const supplies=new Map<bigint,number>();const supply=(hub:bigint)=>({count:supplies.get(hub)??0,arrival:Date.now()+2000});
  const sent:bigint[]=[];
  for(let i=0;i<3;i++){
    const plan=planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),supply,guard);
    assert.equal(plan.rallyStates!.length,3);assert.equal(new Set(plan.rallyStates!.map(r=>r.target)).size,3);
    for(const [id,n] of plan.reservations) assert.ok(n<=f.snapshot.budgets.get(id)!,`overdraw ${id}`);
    const job=plan.next!;assert.equal(job.kind,'reinforce');assert.equal(members(job).length,50);sent.push(job.targetId);
    for(const m of members(job)){f.snapshot.budgets.set(m.sourceId,f.snapshot.budgets.get(m.sourceId)!-m.count);supplies.set(job.targetId,(supplies.get(job.targetId)??0)+m.count);}
    planner.launched(job,c);
  }
  assert.equal(new Set(sent).size,3,'the first hub still needs more than its first 50 donors, but the other hubs must get turns');
});

test('a chosen hub restricts gathering to one campaign while unrelated direct attacks remain available',()=>{
  const f=fronts(),c=config();c.policy.rallyId='1';f.snapshot.budgets.set(2n,1000);
  const plan=new OffensivePlanner().plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.equal(plan.rallyStates!.length,1);assert.equal(plan.rallyState!.hub,1n);
  assert.ok(plan.jobs!.some(j=>j.sourceId===2n&&j.targetId===12n));
});

test('a known incoming hostile wave excludes the hub even when its donor army can afford the target',()=>{
  const f=fronts(),c=config();f.snapshot.fleets=[{id:1n,owner:enemy,target:1n,count:5,arrival:Date.now()+600000,arriving:5}];
  const plan=new OffensivePlanner().plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.ok(plan.rallyStates!.every(s=>s.hub!==1n));assert.ok(plan.rallyStates!.length>=1);
});

test('capturing one campaign relocates only its own slot and preserves the other staged targets',()=>{
  const f=fronts(),c=config(),planner=new OffensivePlanner();
  const initial=planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.equal(initial.rallyStates!.length,3);
  planner.launched({sourceId:1n,targetId:11n,count:200,travelMs:1000},c);
  f.targets[0].ownerId=identity;f.snapshot.owned.push(f.targets[0]);f.snapshot.budgets.set(11n,0);
  planner.captured(11n,c);
  const route=f.world.route!;
  // The advanced hub can also stage an attack on the second campaign's target.
  // That campaign has already paid for 200 probes which are still travelling.
  f.world.route=(s,t)=>t===11n?{travelMs:2000,lossPct:0}:s===11n&&t===12n?{travelMs:1000,lossPct:0}:route(s,t);
  const supply=(hub:bigint)=>({count:hub===2n?200:0,arrival:Date.now()+2000});
  const next=planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),supply,guard);
  assert.ok(next.rallyStates!.some(s=>s.hub===2n&&s.target===12n));
  assert.ok(next.rallyStates!.some(s=>s.hub===3n&&s.target===13n));
  assert.ok(!next.jobs!.some(j=>j.kind==='reinforce'&&j.targetId===11n),'do not fund a second hub for an already staged target');
  const topUp=next.jobs!.find(j=>j.kind==='reinforce'&&j.targetId===2n)!;
  assert.ok(members(topUp).reduce((n,m)=>n+m.count,0)<25,'only the existing campaign deficit is funded');
  for(const [id,n] of next.reservations)assert.ok(n<=(f.snapshot.budgets.get(id)??0));
});

test('an empty campaign slot cannot take another funded hub to stage a different target',()=>{
  const f=fronts(),c=config(),planner=new OffensivePlanner();
  planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  planner.launched({sourceId:1n,targetId:11n,count:200,travelMs:1000},c);
  const target={...f.targets[1],planetId:14n,positionX:42};f.snapshot.planets.push(target);
  const route=f.world.route!;
  f.world.route=(s,t)=>t===14n?{travelMs:s===2n?500:s===1n?2000:2000000,lossPct:0}:route(s,t);
  const next=planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set([11n]),pending,guard);
  assert.ok(next.rallyStates!.some(s=>s.hub===1n&&s.target===14n));
  assert.ok(next.rallyStates!.some(s=>s.hub===2n&&s.target===12n));
  assert.ok(next.rallyStates!.some(s=>s.hub===3n&&s.target===13n));
});

test('a lost staging hub releases its target for another campaign instead of leaving a stale claim',()=>{
  const f=fronts(),c=config(),planner=new OffensivePlanner();
  planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  planner.launched({sourceId:1n,targetId:11n,count:200,travelMs:1000},c);
  f.targets[0].ownerId=identity;f.snapshot.owned.push(f.targets[0]);f.snapshot.budgets.set(11n,0);
  planner.captured(11n,c);
  f.hubs[1].ownerId=f.targets[1].ownerId;f.snapshot.owned=f.snapshot.owned.filter(p=>p.planetId!==2n);f.snapshot.budgets.delete(2n);
  const route=f.world.route!;
  f.world.route=(s,t)=>t===11n?{travelMs:2000,lossPct:0}:s===11n&&t===12n?{travelMs:1000,lossPct:0}:route(s,t);
  const next=planner.plan(f.world,f.snapshot,c,f.snapshot.budgets,new Set(),pending,guard);
  assert.ok(next.rallyStates!.some(s=>s.hub===11n&&s.target===12n));
  assert.ok(next.rallyStates!.every(s=>s.hub!==2n));
  assert.ok(next.rallyStates!.some(s=>s.hub===3n&&s.target===13n));
});

test('stopping sliced attack planning discards its draft and keeps expansion usable',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  let clock=0;t.mock.method(performance,'now',()=>clock+=10);
  const f=fronts();const neutral=planet(999n,1,1);f.snapshot.planets.push(neutral);
  const quote=f.world.quote;f.world.quote=(s,id)=>id===999n?{count:5,travelMs:1000}:quote(s,id);
  const commander=new Commander(()=>{},()=>f.world),c=config();
  const run=commander.start('expansion',c);commander.start('attack',c);
  t.after(async()=>{commander.stop();t.mock.timers.tick(0);await run;});
  await settle();t.mock.timers.tick(250);await settle();assert.equal((f.world.launchGroup as any).mock.callCount(),0);
  commander.stop('attack');
  t.mock.method(performance,'now',()=>0);t.mock.timers.tick(0);await settle();t.mock.timers.tick(250);await settle();
  assert.equal(commander.states.attack.running,false);assert.equal(commander.states.attack.rallies,undefined);
  assert.equal((f.world.launchGroup as any).mock.callCount(),0);
  assert.equal((f.world.launch as any).mock.callCount(),1);assert.equal(commander.states.expansion.running,true);
  commander.stop();await settle();
});

test('three staging campaigns and expansion share authoritative inventory across independent queues',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const f=fronts(),c=config(),neutral=planet(999n,1,1);f.snapshot.planets.push(neutral);
  const route=f.world.route!,quote=f.world.quote;
  f.world.route=(s,id)=>id<10n?{travelMs:60000,lossPct:0}:route(s,id);
  f.world.quote=(s,id)=>id===999n?{count:5,travelMs:1000}:quote(s,id);
  const sent:{target:bigint;source:bigint;count:number}[]=[];
  const spend=(source:bigint,target:bigint,count:number)=>{assert.ok(count<=(f.snapshot.budgets.get(source)??0));f.snapshot.budgets.set(source,f.snapshot.budgets.get(source)!-count);sent.push({source,target,count});};
  f.world.launch=async(s,id,n)=>spend(s,id,n);
  f.world.launchGroup=async job=>{for(const m of members(job))spend(m.sourceId,job.targetId,m.count);};
  f.world.syncInventory=async()=>{};
  const commander=new Commander(()=>{},()=>f.world),run=commander.start('expansion',c);
  t.after(async()=>{commander.stop();await run;});commander.start('attack',c);await settle();
  for(let i=0;i<20;i++){t.mock.timers.tick(250);await settle();}
  assert.equal(new Set(sent.filter(j=>j.target<10n).map(j=>j.target)).size,3);
  assert.ok(sent.some(j=>j.target===999n));assert.equal(commander.states.attack.running,true);
  commander.stop('attack');await settle();assert.equal(commander.states.expansion.running,true);
  commander.stop();await run;await withControl(async()=>{});
});

test('time-aware reserve protects every arrival prefix, not just the final wave',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const f=fronts(),c=config(),p=f.hubs[0];p.level=10;f.snapshot.budgets.set(1n,200);
  f.snapshot.fleets=[{id:1n,owner:enemy,target:1n,count:20,arrival:110000,arriving:20},{id:2n,owner:enemy,target:1n,count:20,arrival:700000,arriving:20}];
  assert.equal(reserveFor(p,f.snapshot,[c]),42,'late production cannot fund the immediate 40-strength attack');
  assert.equal(availableBudgets(f.snapshot,[c],new Map([[1n,10]])).get(1n),148);
  t.mock.timers.tick(500000); // No credited future production has appeared in this mock cache.
  assert.equal(reserveFor(p,f.snapshot,[c]),82,'future credit disappears before an overdue wave');
});

test('defense forecasts ignore unknown supply and tech, retain the strict guard, and fail closed on missing threat data',t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const f=fronts(),c=config(),p=f.hubs[0];p.level=1;f.snapshot.budgets.set(1n,100);c.settings.reserve=10;
  f.snapshot.fleets=[{id:1n,owner:enemy,target:1n,count:10,arrival:Date.now()+120000,arriving:10},{id:2n,owner:'me',target:1n,count:1000,arrival:Date.now()+1000,arriving:1000}];
  assert.equal(reserveFor(p,f.snapshot,[c]),31);
  f.snapshot.fleets[0].arrival=null;assert.equal(reserveFor(p,f.snapshot,[c]),Infinity);
  f.snapshot.fleets[0].arrival=Date.now()+120000;f.snapshot.fleets[0].count=null;assert.equal(reserveFor(p,f.snapshot,[c]),Infinity);
});

test('legacy region settings gain three automatic hubs without changing saved coordinates or enemy',()=>{
  const form={...policyForm('attack'),x:'-2092',y:'6129',enemy};delete (form as any).rallyHubs;
  localStorage.setItem('swarm-helper-regions-v1',JSON.stringify({attack:form}));
  const saved=loadPolicies().attack;assert.equal(saved.rallyHubs,'3');assert.equal(saved.x,'-2092');assert.equal(saved.enemy,enemy);
  assert.equal(parsePolicy(saved,'attack').rallyHubs,3);
});

test('attack startup diagnosis stays visible while expansion logs continue, with bounded history',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const f=fakeWorld();const controller=new AppController(()=>f.world);
  t.after(async()=>{controller.stopAll();await settle();controller.dispose();});
  controller.setPolicy('attack','x','100');controller.setPolicy('attack','y','0');controller.start();controller.startAttack();await settle();
  for(let i=0;i<80;i++){t.mock.timers.tick(10000);await settle();}
  const state=controller.getSnapshot();assert.equal(state.attack.running,false);assert.equal(state.attackSettingsOpen,true);
  assert.ok(state.logs.some(l=>l.mode==='attack'&&l.message.includes('己方星球为 0')));assert.ok(state.logs.length<=100);
  controller.stopAll();await settle();controller.dispose();
});
