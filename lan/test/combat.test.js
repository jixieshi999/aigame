'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {capsuleHit,packBones,unpackBones,takeFireToken}=require('../combat');
const {cleanWorld,cleanEvent}=require('../combat-protocol');

test('capsule hit covers vertical/oblique rays, endpoints, inside origin and static obstruction',()=> {
  const low=[0,.35,0],high=[0,1.5,0];
  assert.ok(Math.abs(capsuleHit([0,1,-5],[0,0,1],low,high,.36,10)-4.64)<1e-6);
  assert.equal(capsuleHit([0,1,-5],[0,0,1],low,high,.36,4),null);
  assert.equal(capsuleHit([2,1,-5],[0,0,1],low,high,.36,10),null);
  assert.equal(capsuleHit([0,1,0],[0,1,0],low,high,.36,10),0);
  assert.ok(Math.abs(capsuleHit([0,5,0],[0,-1,0],low,high,.36,10)-3.14)<1e-6);
  assert.notEqual(capsuleHit([-.2,1,-5],[0,0,1],low,high,.36,10),null);
});
test('compact bone codec preserves independent transforms and zero-scale death parts',()=> {
  const bones=[{position:{x:.1234,y:-.5,z:1.2228},quaternion:{x:0,y:.707106,z:0,w:.707106},scale:{x:1,y:.0001,z:1}}];
  const text=packBones(bones),decoded=unpackBones(text,1);assert.equal(Buffer.from(text,'base64').length,20);
  assert.ok(Math.abs(decoded[0]-.123)<1e-6);assert.ok(Math.abs(decoded[4]-.707106)<.0001);assert.equal(decoded[8],0);
  assert.throws(()=>unpackBones(text,2));
});
test('authority fire cadence permits bounded catchup but rejects sustained overfire',()=> {
  const actor={fireTokens:3,fireAt:1000};
  assert.equal(Array.from({length:8},()=>takeFireToken(actor,1000)).filter(Boolean).length,3);
  assert.equal(takeFireToken(actor,1084),true);assert.equal(takeFireToken(actor,1084),false);
  assert.equal(takeFireToken(actor,900),false);
});
test('combat wire schema rejects forged players and nonfinite values',()=> {
  const ids=new Set(['one']);
  assert.equal(cleanWorld({enemies:[],players:[{playerId:'other'}],bolts:[]},ids),null);
  assert.equal(cleanEvent({kind:'hurt',playerId:'one',health:20,amount:NaN,from:[0,0,0]},ids),null);
  assert.deepEqual(cleanEvent({kind:'hurt',playerId:'one',health:20,amount:10,from:[0,0,0],source:'forged'},ids),
    {kind:'hurt',playerId:'one',health:20,amount:10,from:[0,0,0]});
});
