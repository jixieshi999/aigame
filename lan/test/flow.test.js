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
