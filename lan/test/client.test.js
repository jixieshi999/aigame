'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sha256, summarizeMap, effectiveSeed, interpolate } = require('../net');

test('HTTP-compatible SHA-256 matches Node crypto across padding boundaries and Unicode', () => {
  for (const text of ['', 'abc', '几猫🐈', ...[55,56,63,64,65,1000,20000].map(n => 'x'.repeat(n))]) {
    assert.equal(sha256(text), crypto.createHash('sha256').update(text).digest('hex'));
  }
});
test('static map hash is order independent, quantized and detects collision/nav flags', () => {
  const box = { min: { x: 1, y: 0, z: -1 }, max: { x: 2, y: 3, z: 4 }, tag: '中文', surface: 'metal' };
  const second = { ...box, min: { ...box.min, x: 4 } };
  const grid = { blocked: new Uint8Array([0,1,1,0]), w: 2, h: 2, minX: -1, minZ: 0, cell: .5 };
  const physics = { boxes: [box, second], nav: { _grid: () => grid } };
  const baseline = summarizeMap(physics);
  physics.boxes = [second, { ...box, min: { ...box.min, x: 1.0001 } }];
  assert.deepEqual(summarizeMap(physics), baseline);
  physics.boxes[1].bulletOnly = true;
  assert.notEqual(summarizeMap(physics).boxes, baseline.boxes);
  grid.blocked[0] = 1;
  assert.notEqual(summarizeMap(physics).nav, baseline.nav);
});
test('effective seed follows original integer PRNG conversion, including explicit zero', () => {
  assert.equal(effectiveSeed(undefined,4207),4207); assert.equal(effectiveSeed('0',4207),0);
  assert.equal(effectiveSeed('4294967295',4207),-1); assert.equal(effectiveSeed('42.9',4207),42);
  assert.throws(() => effectiveSeed('NaN',4207));
});
test('interpolation crosses angle wrap, absorbs sparse snapshots and freezes bounded extrapolation', () => {
  const a = { at: 1000, pos: [0,0,0], yaw: Math.PI-.1, pitch: 0, ads: 0, alive: true };
  const b = { at: 1100, pos: [2,0,0], yaw: -Math.PI+.1, pitch: 1, ads: 1, alive: true };
  const result = interpolate([a,b],1050);
  assert.equal(result.pos[0],1); assert.ok(Math.abs(result.yaw-Math.PI)<1e-9);
  assert.equal(result.pitch,.5); assert.equal(result.ads,.5);
  assert.equal(interpolate([a,b],5000).pos[0],3);
  assert.deepEqual(interpolate([a],5000).pos,[0,0,0]); assert.equal(interpolate([],1000),null);
});
