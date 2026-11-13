'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../flow-shared'),C=require('../flow-coop'),P=require('../combat-protocol'),V=require('../flow-pvp');
test('E PvP hit, friendly-fire and score rules stay deterministic',()=>{
  const flow=V.createFlow({scoreLimit:2});
  assert.equal(V.hitPart(1.5,0,false),'head');assert.equal(V.damageFor('head'),38.5);assert.equal(V.damageFor('body'),22);
  assert.equal(V.canHit({id:'a',team:0},{id:'b',team:0,health:100},{friendlyFire:false}),false);
  assert.equal(V.canHit({id:'a',team:0},{id:'b',team:1,health:100},{friendlyFire:false}),true);
  const scored=V.recordKill(flow,0,1,false);assert.deepEqual(scored.scores,[1,0]);
  const won=V.recordKill(scored,0,1,false);assert.equal(won.phase,'ended');assert.equal(won.winner,0);
  assert.deepEqual(V.recordKill(flow,0,0,true).scores,[0,0]);
  assert.equal(V.tickFlow({...flow,time:599.9},.2).winner,-1);
});
test('E PvP flow and events are allowlisted',()=>{
  const f=V.createFlow({scoreLimit:5}),clean=P.cleanFlow(f);assert.ok(clean);assert.equal(clean.kind,'pvp');
  assert.equal(P.cleanFlow({...f,options:{...f.options,scoreLimit:999}}),null);
  const ids=new Set(['a','b']);assert.deepEqual(P.cleanEvent({kind:'playerKill',killerId:'a',victimId:'b',part:'head',cause:'shot'},ids).part,'head');
  assert.equal(P.cleanEvent({kind:'playerKill',killerId:'a',victimId:'b',part:'head',cause:'fall'},ids),null);
  assert.equal(P.cleanEvent({kind:'shotResult',playerId:'a',shotSeq:1,accepted:true,hit:true,killed:false,enemyId:null,victimId:'b',part:'body',point:[0,0,0],normal:[0,1,0]},ids).victimId,'b');
});
test('D1 deterministic pools retain 24 spaced walkable covered slots per team',()=>{
  const walk=(x,z)=>Math.abs(x)<50&&Math.abs(z)<50,visible=()=>false;
  const pools=S.buildSpawnPools(walk,visible);assert.deepEqual(pools,S.buildSpawnPools(walk,visible));
  for(const points of [pools.coop,...pools.teams]){
    assert.equal(points.length,24);
    points.forEach((p,i)=>{assert.ok(S.clearPoint(p,walk));points.slice(i+1).forEach(q=>assert.ok(S.distance(p,q)>=1.2));});
  }
  pools.teams[0].forEach(p=>pools.teams[1].forEach(q=>assert.ok(S.distance(p,q)>=40&&!visible(p,q))));
  assert.throws(()=>S.buildSpawnPools(()=>false,visible));
});
test('D1 spawn scoring avoids overlap, threats, sight and recently used slots',()=>{
  const points=[[0,0,0],[20,0,0],[40,0,0]],npc=[{pos:[1,0,0]}];
  assert.deepEqual(S.chooseSpawn(points,[{health:100,pos:[40,0,0]}],npc,[],100,()=>false),[20,0,0]);
  assert.deepEqual(S.chooseSpawn(points,[],[],[{pos:[0,0,0],at:90}],100,()=>false),[20,0,0]);
  assert.deepEqual(S.chooseSpawn(points,[],npc,[],100,(a)=>a[0]===40),[20,0,0]);
  assert.throws(()=>S.chooseSpawn([[0,0,0]],[{health:100,pos:[.2,0,0]}],[],[],0,()=>false));
});
test('D1 flow/player/event schemas copy only bounded allowed data',()=>{
  const f=C.createFlow([{id:'relay_a'},{id:'relay_b'},{id:'relay_c'}]);
  f.injected='<img>';const clean=P.cleanFlow(f);assert.ok(clean);assert.equal(clean.injected,undefined);
  assert.equal(P.cleanFlow({...f,time:NaN}),null);assert.equal(P.cleanFlow({...f,relays:Array(17).fill(f.relays[0])}),null);
  assert.equal(P.cleanFlow({...f,phase:'complete'}),null);
  assert.deepEqual(P.cleanOptions({respawnSec:1,npcs:'both',friendlyFire:true},'coop'),{respawnSec:1});
  assert.equal(P.cleanOptions({respawnSec:0},'coop'),null);assert.equal(P.cleanOptions({extra:1},'coop'),null);
  const ids=new Set(['p']);
  for(const event of [{kind:'respawn',playerId:'p',pos:[1,0,1],yaw:0,invulnSec:3},
    {kind:'objectiveDone',objectiveId:'relay_a',index:1,total:3},{kind:'waveWarning',centroid:[1,0,2]},
    {kind:'radio',key:'all'},{kind:'phase',phase:'extract'},{kind:'roundEnd',result:'failed'}])assert.ok(P.cleanEvent(event,ids));
  assert.equal(P.cleanEvent({kind:'radio',key:'<img>'},ids),null);
  assert.equal(P.cleanEvent({kind:'waveWarning',centroid:[Infinity,0,0]},ids),null);
  assert.equal(P.cleanEvent({kind:'respawn',playerId:'forged',pos:[0,0,0],yaw:0,invulnSec:3},ids),null);
  assert.ok(Buffer.byteLength(JSON.stringify(clean))<2048);
});
test('D2 interaction enforces live actor, distance, height and yaw boundaries',()=>{
  const relay={cut:false},o={pos:[0,0,0]},a={health:100,pos:[0,0,2.2],yaw:0};
  assert.ok(C.validInteraction(a,o,relay));assert.ok(!C.validInteraction({...a,pos:[0,0,2.201]},o,relay));
  assert.ok(C.validInteraction({...a,pos:[0,2.5,2]},o,relay));assert.ok(!C.validInteraction({...a,pos:[0,2.501,2]},o,relay));
  assert.ok(!C.validInteraction({...a,yaw:Math.PI},o,relay));
  assert.ok(C.validInteraction({...a,pos:[0,0,.9],yaw:Math.PI},o,relay));
  assert.ok(!C.validInteraction({...a,health:0},o,relay));assert.ok(!C.validInteraction(a,o,{cut:true}));
});
test('D2 single/multiple cutters, capped speed, release decay and completion are idempotent',()=>{
  const r={id:'relay_a',cut:false,t:0,cutters:0};
  assert.equal(C.advanceRelay(r,1,1.2).t,.5);assert.equal(C.advanceRelay(r,2,1.2).t,.75);
  assert.equal(C.advanceRelay(r,20,.48).t,.5);assert.equal(C.advanceRelay({...r,t:.5},0,.2).t,.17999999999999994);
  const f=C.createFlow([{id:'relay_a'}]);f.relays[0]=C.advanceRelay(r,1,2.4);
  assert.ok(C.commitRelay(f,'relay_a'));assert.equal(f.phase,'extract');assert.equal(C.commitRelay(f,'relay_a'),false);
  assert.ok(P.cleanFlow(f));assert.equal(C.advanceRelay(f.relays[0],0,10).t,1);
});
test('D3 population scaling at 1/2/4/20 respects type pools and total limits',()=>{
  assert.deepEqual([1,2,4,20].map(C.multiplier),[1,1.5,2.5,3]);
  assert.deepEqual([1,2,4,20].map(C.maxAlive),[9,11,15,18]);
  assert.deepEqual([1,2,4,20].map(n=>C.scaled(C.RULES.waves[2],n)),[{gull:5,hound:4},{gull:8,hound:6},{gull:10,hound:8},{gull:10,hound:8}]);
  assert.deepEqual(C.scaled(C.RULES.patrol,20),{gull:9,hound:6});
});
test('D3 staggered interleaving, one-at-a-time dequeue, capacity delay and six retries',()=>{
  let q=C.waveQueue({gull:3,hound:2},10);assert.deepEqual(q.map(i=>i.type),['gull','hound','gull','hound','gull']);
  assert.equal(C.dueSpawn(q,11.5,0,9),null);assert.deepEqual(C.dueSpawn(q,11.6,9,9),{index:0,blocked:true});
  q=C.queueAttempt(q,0,false,11.6,true);assert.equal(q[0].at,12.6);
  q=C.queueAttempt(q,0,true,20);assert.equal(q.length,4);
  let one=[{type:'gull',at:0,tries:0}];for(let i=1;i<=6;i++){one=C.queueAttempt(one,0,false,i*2);assert.equal(one.length,i===6?0:1);}
});
test('D3 pursuit waits for empty queue and low alive count; spawn score considers every live player',()=>{
  assert.equal(C.pursuitStep(0,5,.1,1,0).add,false);assert.equal(C.pursuitStep(0,5,.1,0,4).add,false);
  assert.deepEqual(C.pursuitStep(0,5,.1,0,3),{timer:7,left:4,add:true,alert:true});
  assert.equal(C.pursuitStep(0,0,.1,0,0).add,false);
  const players=[{health:100,pos:[0,0,0]},{health:100,pos:[40,0,0]}];
  assert.ok(C.spawnScore([20,0,0],players,()=>false,undefined,0)>C.spawnScore([39,0,0],players,()=>false,undefined,0));
  assert.ok(C.spawnScore([20,0,0],players,()=>false,undefined,0)>C.spawnScore([20,0,0],players,()=>true,0,1));
});
test('D4 authority death, respawn countdown, protection and all-down rules',()=>{
  const a={health:100,deaths:2,respawnAt:null,invulnUntil:3000};assert.equal(S.damageState(a,100,2000),null);
  const dead={...a,...S.damageState(a,100,4000,10)};assert.equal(dead.health,0);assert.equal(dead.deaths,3);
  assert.equal(S.respawnRemaining(a,4000),null);assert.equal(S.respawnRemaining(dead,4500),9.5);
  assert.equal(S.canRespawn(dead,13999),false);assert.equal(S.canRespawn(dead,14000),true);
  assert.equal(S.damageState(dead,100,5000),null);assert.ok(S.allDown([dead,{...dead,respawnAt:99999}]));
  assert.equal(S.allDown([dead,a]),false);assert.equal(S.allDown([]),false);
  assert.equal(S.canRespawn(a,99999),false);
});
test('D5 extraction requires all living actors for 1.5 seconds, resets on exit and excludes dead actors',()=>{
  const zone={pos:[29,0,20],radius:2.5},a={health:100,pos:[29,0,20]},b={health:100,pos:[31.5,0,20]},dead={health:0,pos:[0,0,0]};
  let e={hold:0};e=C.extractionStep(e,[a,b,dead],zone,1);assert.equal(e.hold,0);assert.equal(e.inZone,1);assert.equal(e.needed,2);
  e=C.extractionStep(e,[a,dead],zone,.75);assert.equal(e.hold,.5);e=C.extractionStep(e,[a,dead],zone,.75);assert.equal(e.hold,1);
  assert.equal(C.extractionStep(e,[b],zone,.01).hold,0);assert.equal(C.extractionStep(e,[dead],zone,10).hold,0);
  assert.equal(C.extractionStep(e,[{...a,pos:[29,3.5,20]}],zone,.1).hold,0);
});
test('D5 team result aggregates shots/hits/kills/respawns with original rating thresholds',()=>{
  const actors=[{stats:{shots:8,hits:4,kills:2},respawns:0},{stats:{shots:2,hits:2,kills:1},respawns:0}];
  assert.deepEqual(C.summarize(200,actors),{time:200,shots:10,hits:6,kills:3,respawns:0,accuracy:.6,rating:5});
  assert.equal(C.summarize(270,actors).rating,4);assert.equal(C.summarize(400,actors).rating,3);
  assert.equal(C.summarize(200,[{stats:{shots:0,hits:0,kills:0},respawns:1}]).rating,2);
  assert.equal(C.summarize(200,[{stats:{shots:10,hits:3,kills:0},respawns:1}]).rating,3);
  const f=C.createFlow([{id:'relay_a'}]);f.relays[0]={...f.relays[0],t:1};C.commitRelay(f,'relay_a');
  f.phase='complete';f.result=C.summarize(200,actors);assert.ok(P.cleanFlow(f));
});
test('D2 relay IDs stay idempotent even while another relay is ready to commit',()=>{
  const f=C.createFlow([{id:'relay_a'},{id:'relay_b'}]);f.relays.forEach(r=>r.t=1);
  assert.ok(C.commitRelay(f,'relay_a'));assert.equal(C.commitRelay(f,'relay_a'),false);
  assert.equal(f.cut,1);assert.ok(C.commitRelay(f,'relay_b'));assert.equal(f.cut,2);
  assert.ok(P.cleanFlow(f));
});
test('D1 the same spawn allocator accommodates twenty living actors without overlap',()=>{
  const points=S.buildSpawnPools(()=>true,()=>false).coop,players=[],used=[];
  for(let i=0;i<20;i++){
    const pos=S.chooseSpawn(points,players,[],used,1000,()=>false);
    assert.ok(players.every(p=>S.distance(pos,p.pos)>=.8));players.push({health:100,pos});used.push({pos,at:1000});
  }
  assert.equal(players.length,20);
});
test('D2 missing heartbeat expires after 400ms and dead/departed/wrong-objective holders never count',()=>{
  const relay={id:'relay_a',cut:false},o={pos:[0,0,0]},actor={health:100,pos:[0,0,1],yaw:0};
  const holds=new Map([['a',{objectiveId:'relay_a',at:1000}],['b',{objectiveId:'relay_a',at:1000}],['gone',{objectiveId:'relay_a',at:1000}],['wrong',{objectiveId:'relay_b',at:1000}]]);
  const actors=new Map([['a',actor],['b',{...actor,health:0}],['wrong',actor]]);
  assert.equal(C.countCutters(holds,actors,o,relay,1400),1);assert.equal(C.countCutters(holds,actors,o,relay,1401),0);
});
