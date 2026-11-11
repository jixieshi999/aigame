'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const S=require('../flow-shared'),C=require('../flow-coop'),P=require('../combat-protocol');
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
  assert.deepEqual([1,2,4,20].map(n=>C.scaled(C.RULES.waves[2],n)),[{gull:4,hound:3},{gull:6,hound:5},{gull:10,hound:8},{gull:10,hound:8}]);
  assert.deepEqual(C.scaled(C.RULES.patrol,20),{gull:6,hound:3});
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
