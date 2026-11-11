'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createLanServer, MAX_MESSAGE, EXPECTED_HASH } = require('../server');
const { RawClient, clientFrame } = require('./raw-client');

const map = { schema: 'static-v1', boxes: 'a'.repeat(64), nav: 'b'.repeat(64), boxCount: 100, navWidth: 142, navHeight: 124 };
const joinData = (extra = {}) => ({ type: 'join', room: 'TEST', nickname: '猫', mode: 'pvp', seed: 4207, eseed: 9001, map, ...extra });
const pose = (joined, seq, extra = {}) => ({ type: 'pose', roundId: joined.roundId, seq, pos: [1, 2, 3], yaw: 0, pitch: 0,
  ads: 0, crouching: false, sprinting: false, alive: true, reloading: false, ...extra });

async function fixture(t, options) {
  const app = createLanServer(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => { for (const client of clients) client.destroy(); await app.stop(); });
  const port = app.server.address().port;
  return { app, port, async connect(opts) {
    const client = new RawClient(port, opts); clients.push(client);
    await client.next('$http');
    return client;
  }, async join(extra, opts) {
    const client = new RawClient(port, opts); clients.push(client);
    await client.next('hello'); client.send(joinData(extra));
    client.joined = await client.next('joined'); return client;
  } };
}
function get(port, route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    }); request.on('error', reject); request.end();
  });
}

test('HTTP only serves two routes; response-only injection preserves original bytes/hash', async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(path.join(__dirname, '../../几猫国产3A大作_V1.html'));
  const response = await get(f.port, '/?seed=4207');
  assert.equal(response.status, 200);
  assert.equal(response.body.replace(`<script src="/net.js" data-build="${f.app.build}"></script>\n`, ''), original.toString());
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), EXPECTED_HASH);
  assert.equal((await get(f.port, '/net.js')).status, 200);
  for (const route of ['/server.js', '/test/server.test.js', '/favicon.ico', '/../几猫国产3A大作_V1.html', '/%2e%2e/', '/net.js/']) {
    assert.equal((await get(f.port, encodeURI(route))).status, 404);
  }
  assert.equal((await get(f.port, '/', 'POST')).status, 405);
});

test('RFC6455 handshake accept, required origin, path, key and wire version checks', async t => {
  const f = await fixture(t);
  const good = await f.connect();
  const expected = crypto.createHash('sha1').update(good.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.ok(good.header.includes(`Sec-WebSocket-Accept: ${expected}`));
  assert.equal((await good.next('hello')).build, EXPECTED_HASH.slice(0, 16));
  for (const options of [{ origin: 'http://evil.example' }, { origin: null }, { path: '/net.js' }, { key: 'bad' }, { version: '12' }]) {
    const bad = await f.connect(options); assert.ok(!bad.header.startsWith('HTTP/1.1 101'));
  }
});

test('single join, sanitized nickname, stable ID and leave delete empty room', async t => {
  const f = await fixture(t), client = await f.join({ nickname: '\u0000\u202e<img src=x>' + '猫'.repeat(30) });
  const j = client.joined;
  assert.equal(j.hostId, j.playerId); assert.equal(j.players[0].team, 0);
  assert.equal(Array.from(j.players[0].nickname).length, 20);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(j.players[0].nickname));
  client.send(pose(j, 1, { playerId: 'spoofed' }));
  client.send({ type: 'leave', roundId: j.roundId });
  assert.equal((await client.next('$close')).code, 1000);
  assert.equal(f.app.rooms.size, 0);
});

test('20 players, balanced two teams, player 21 rejected; host moves in join order', async t => {
  const f = await fixture(t), clients = [];
  for (let i = 0; i < 20; i++) clients.push(await f.join({ nickname: `猫${i}` }));
  const room = f.app.rooms.get('TEST');
  assert.equal(room.players.size, 20);
  assert.equal([...room.players.values()].filter(p => p.team === 0).length, 10);
  assert.equal([...room.players.values()].filter(p => p.team === 1).length, 10);
  assert.equal(new Set([...room.players.keys()]).size, 20);
  const extra = await f.connect(); extra.send(joinData());
  assert.equal((await extra.next('error')).code, 'roomFull');
  clients[0].send({ type: 'leave', roundId: room.roundId });
  const leave = await clients[1].next('leave'); assert.equal(leave.playerId, clients[0].joined.playerId);
  const promoted = await clients[1].next('roster', m => m.hostId === clients[1].joined.playerId);
  assert.equal(promoted.players.length, 19);
  assert.equal(promoted.roundId, clients[0].joined.roundId);
  const replacement = await f.join(); assert.equal(replacement.joined.players.at(-1).team, 0);
});

test('coop uses team zero and rooms have independent round IDs', async t => {
  const f = await fixture(t), a = await f.join({ mode: 'coop' }), b = await f.join({ mode: 'coop' });
  assert.ok(b.joined.players.every(p => p.team === 0));
  const c = await f.join({ room: 'OTHER' }); assert.notEqual(a.joined.roundId, c.joined.roundId);
});

test('seed/eseed and mode are host-owned; mismatch rejects with correction', async t => {
  const f = await fixture(t); await f.join();
  for (const extra of [{ seed: 99 }, { eseed: 42 }, { mode: 'coop' }]) {
    const c = await f.connect(); c.send(joinData(extra));
    const error = await c.next('error'); assert.equal(error.code, extra.mode ? 'modeMismatch' : 'seedMismatch');
    if (!extra.mode) { assert.equal(error.seed, 4207); assert.equal(error.eseed, 9001); }
  }
  assert.equal(f.app.rooms.get('TEST').players.size, 1);
});

test('map mismatch broadcasts to both sides and clears after mismatched client leaves', async t => {
  const f = await fixture(t), a = await f.join(), b = await f.join({ map: { ...map, boxes: 'c'.repeat(64) } });
  for (const c of [a, b]) assert.ok((await c.next('mapMismatch')).mismatched.includes(b.joined.playerId));
  b.destroy(); await a.next('leave');
  assert.equal((await a.next('mapStatus', m => m.ok)).ok, true);
});

test('version mismatch rejected with explicit reason', async t => {
  const f = await fixture(t), c = await f.connect(); c.send({ ...joinData(), v: 1 });
  assert.equal((await c.next('error')).code, 'versionMismatch');
  assert.equal((await c.next('$close')).code, 1008);
});

test('invalid JSON/types/round/pose ignored; allowed fields and source identity enforced', async t => {
  const f = await fixture(t), a = await f.join(), b = await f.join();
  a.socket.write(clientFrame(1, '{')); await a.next('error');
  a.send({ type: 'enemy:alert', roundId: a.joined.roundId }); await a.next('error');
  a.send(pose(a.joined, 1, { pos: ['1', 2, 3] })); await a.next('error');
  a.send(pose(a.joined, 1, { roundId: 'stale' })); await a.next('error');
  a.send(pose(a.joined, 2, { playerId: b.joined.playerId, team: 1, damage: 999 }));
  const received = await b.next('pose'); assert.equal(received.playerId, a.joined.playerId);
  assert.equal(received.damage, undefined); assert.equal(received.team, undefined);
  assert.equal(f.app.metrics.invalid, 4);
});

test('pose 20Hz token bucket and shot bucket discard bursts', async t => {
  const f = await fixture(t), a = await f.join();
  const frames = [];
  for (let i = 0; i < 60; i++) frames.push(clientFrame(1, JSON.stringify({ v: 3, ...pose(a.joined, i) })));
  const poseAt=performance.now();
  a.socket.write(Buffer.concat(frames)); a.socket.write(clientFrame(9, 'barrier'));
  await a.next('$pong');
  // CPU contention can suspend the parser and legitimately refill tokens within one TCP read.
  const poseBudget=4+Math.ceil((performance.now()-poseAt)*20/1000);
  assert.ok(f.app.metrics.poses<=poseBudget);assert.ok(f.app.metrics.poseLimited>=60-poseBudget);assert.ok(f.app.metrics.poseLimited>0);
  const shots = [];
  for (let i = 0; i < 20; i++) shots.push(clientFrame(1, JSON.stringify({ v: 3, type: 'shot', roundId: a.joined.roundId,
    seq: i, origin: [0, 1, 0], muzzle: [0, 1, -.5], dir: [0, 0, -1] })));
  const shotAt=performance.now();
  a.socket.write(Buffer.concat(shots)); a.socket.write(clientFrame(9, 'barrier2'));
  await a.next('$pong');
  const shotBudget=6+Math.ceil((performance.now()-shotAt)*15/1000);
  assert.ok(f.app.metrics.shots<=shotBudget);assert.ok(f.app.metrics.shotLimited>=20-shotBudget);assert.ok(f.app.metrics.shotLimited>0);
});

test('fragmented UTF-8 join, interleaved ping and arbitrary TCP splits', async t => {
  const f = await fixture(t), c = await f.connect();
  const text = Buffer.from(JSON.stringify({ v: 3, ...joinData({ nickname: '猫猫' }) }));
  const split = text.indexOf(Buffer.from('猫')) + 1;
  const first = clientFrame(1, text.subarray(0, split), { fin: false });
  c.socket.write(first.subarray(0, 1)); c.socket.write(first.subarray(1));
  c.socket.write(clientFrame(9, 'hello'));
  c.socket.write(clientFrame(0, text.subarray(split)));
  assert.equal((await c.next('$pong')).payload.toString(), 'hello');
  assert.equal((await c.next('joined')).players[0].nickname, '猫猫');
});

test('oversized single frame, 64-bit advertised length and fragmented aggregate rejected', async t => {
  const f = await fixture(t);
  for (const variant of [0, 1, 2]) {
    const c = await f.connect();
    if (variant === 0) c.socket.write(clientFrame(1, '', { length: MAX_MESSAGE + 1 }));
    if (variant === 1) c.socket.write(clientFrame(1, '', { length: 100000 }));
    if (variant === 2) {
      c.socket.write(clientFrame(1, 'x'.repeat(MAX_MESSAGE/2+1), { fin: false }));
      c.socket.write(clientFrame(0, 'x'.repeat(MAX_MESSAGE/2+1)));
    }
    assert.equal((await c.next('$close')).code, 1009);
  }
});

test('invalid mask/RSV/continuation/control/binary/UTF-8/close rejected', async t => {
  const f = await fixture(t);
  const variants = [
    [clientFrame(1, '{}', { mask: false }), 1002], [clientFrame(1, '{}', { rsv: 64 }), 1002],
    [clientFrame(0, '{}'), 1002], [clientFrame(9, '', { fin: false }), 1002],
    [clientFrame(9, 'x'.repeat(126)), 1002], [clientFrame(2, 'binary'), 1003],
    [clientFrame(1, Buffer.from([0xff])), 1007], [clientFrame(8, Buffer.from([0])), 1002],
    [clientFrame(8, Buffer.from([3, 237])), 1002]
  ];
  for (const [wire, code] of variants) { const c = await f.connect(); c.socket.write(wire); assert.equal((await c.next('$close')).code, code); }
});

test('close frame echoed, transport loss leaves room and broadcasts once', async t => {
  const f = await fixture(t), a = await f.join(), b = await f.join();
  a.socket.write(clientFrame(8, Buffer.from([3, 232])));
  assert.equal((await a.next('$close')).code, 1000); await b.next('leave');
  assert.equal(f.app.rooms.get('TEST').hostId, b.joined.playerId);
  b.destroy(); await b.next('$tcpClose');
  // Barrier through another real handshake ensures the server has processed the FIN/RST.
  const c = await f.connect(); await c.next('hello'); assert.equal(f.app.rooms.size, 0);
});

test('server heartbeat ping/pong keeps live peer and reaps half-open peer', async t => {
  const f = await fixture(t, { heartbeatMs: 10, pingIntervalMs: 30, pongTimeoutMs: 40 });
  const a = await f.join(), b = await f.join({}, { autoPong: false });
  await a.next('$ping'); await b.next('$tcpClose'); await a.next('leave');
  assert.equal(f.app.peers.size, 1); assert.equal(f.app.rooms.get('TEST').players.size, 1);
});

test('unjoined sockets time out and generic frame flood is bounded', async t => {
  const f = await fixture(t, { heartbeatMs: 10, joinTimeoutMs: 50 });
  const a = await f.connect(); assert.equal((await a.next('$close')).code, 1008);
  const b = await f.join(), c = await f.join();
  c.socket.write(Buffer.concat(Array.from({ length: 200 }, () => clientFrame(9, 'x'))));
  assert.equal((await c.next('$close')).code, 1008);
  b.socket.write(Buffer.concat(Array.from({ length: 900 }, () => clientFrame(9, 'x'))));
  assert.equal((await b.next('$close')).code, 1008);
});

const actorState = playerId => ({ playerId,health:100,alive:true,ammo:30,reserve:150,reloading:false,ackShot:0,stats:{shots:0,hits:0,kills:0} });
const enemyState = (id='e1',kind='hound') => ({ id,kind,pos:[0,0,0],quat:[0,0,0,1],hp:kind==='hound'?140:45,alive:true,
  bones:Buffer.alloc((kind==='hound'?20:13)*20).toString('base64'),lens:[1,1,1],targetId:null });
const worldData = (roundId,players,extra={}) => ({ type:'world',roundId,seq:1,enemies:[enemyState()],players:players.map(actorState),bolts:[],...extra });

test('phase C authority budget carries a room of shot confirmations while guest flood remains bounded',async t=> {
  const f=await fixture(t),a=await f.join(),b=await f.join();
  for(let seq=1;seq<=300;seq++)a.send({type:'combatEvent',roundId:a.joined.roundId,seq,
    event:{kind:'shotResult',playerId:b.joined.playerId,shotSeq:seq,accepted:true,hit:false,killed:false,enemyId:null,part:null,point:[0,0,0],normal:[0,1,0]}});
  for(let seq=1;seq<=300;seq++)assert.equal((await b.next('combatEvent')).seq,seq);
  assert.equal(f.app.metrics.combatEvents,300);assert.equal(f.app.peers.size,2);
});

test('phase C authority world is allowlisted and late joins receive the cached full snapshot', async t => {
  const f=await fixture(t),a=await f.join(),b=await f.join();
  a.send(worldData(a.joined.roundId,[a.joined.playerId,b.joined.playerId],{injected:'no'}));
  const first=await b.next('world');assert.equal(first.enemies[0].id,'e1');assert.equal(first.injected,undefined);
  const c=await f.join();const late=await c.next('world');assert.deepEqual(late.enemies,first.enemies);
  b.send(worldData(b.joined.roundId,[b.joined.playerId]));
  assert.match((await b.next('error')).reason,/房主/);assert.equal(f.app.metrics.worlds,1);
});

test('phase C departure prunes cached and in-flight actors without accepting unknown identities',async t=> {
  const f=await fixture(t),a=await f.join(),b=await f.join(),round=a.joined.roundId,ids=[a.joined.playerId,b.joined.playerId];
  a.send(worldData(round,ids,{enemies:[{...enemyState(),targetId:b.joined.playerId}]}));await b.next('world');
  b.destroy();await a.next('leave');
  assert.deepEqual(f.app.rooms.get('TEST').world.players.map(p=>p.playerId),[a.joined.playerId]);
  a.send(worldData(round,ids,{seq:2}));a.socket.write(clientFrame(9,'departure-barrier'));await a.next('$pong');
  assert.equal(f.app.metrics.invalid,0);assert.equal(f.app.metrics.worlds,2);
  const c=await f.join(),cached=await c.next('world');assert.deepEqual(cached.players.map(p=>p.playerId),[a.joined.playerId]);
  a.send(worldData(round,['forged-actor'],{seq:3}));assert.match((await a.next('error')).reason,/字段/);
});

test('phase C shot/reload/hazard intentions use bound identity and go only to host', async t => {
  const f=await fixture(t),a=await f.join(),b=await f.join();
  a.send(worldData(a.joined.roundId,[a.joined.playerId,b.joined.playerId]));await b.next('world');
  b.send(pose(b.joined,1,{pos:[0,0,0]}));await a.next('pose');
  b.send({type:'shot',roundId:b.joined.roundId,seq:1,playerId:'spoof',origin:[0,1.5,0],muzzle:[0,1.5,-.5],dir:[0,0,-1]});
  assert.equal((await a.next('shotIntent')).playerId,b.joined.playerId);
  b.send({type:'reload',roundId:b.joined.roundId,seq:1});assert.equal((await a.next('reloadIntent')).playerId,b.joined.playerId);
  b.send({type:'hazard',roundId:b.joined.roundId,seq:1,reason:'fall',amount:10});assert.equal((await a.next('hazardIntent')).amount,10);
  b.send({type:'shot',roundId:b.joined.roundId,seq:2,origin:[99,99,99],muzzle:[99,99,99],dir:[0,0,-1]});
  assert.match((await b.next('error')).reason,/原点/);
});

test('phase C malformed enemy/skeleton/player/event data are discarded, combat events require host', async t => {
  const f=await fixture(t),a=await f.join(),b=await f.join();const ids=[a.joined.playerId,b.joined.playerId];
  for(const extra of [{enemies:[enemyState(),enemyState()]},{enemies:[{...enemyState(),bones:'AAAA'}]},
    {players:[{...actorState(a.joined.playerId),health:999}]},{bolts:Array(33).fill({id:'b1',pos:[0,0,0],dir:[0,0,-1]})}]) {
    a.send(worldData(a.joined.roundId,ids,extra));await a.next('error');
  }
  b.send({type:'combatEvent',roundId:b.joined.roundId,seq:1,event:{kind:'explosion',pos:[0,0,0],size:1}});await b.next('error');
  a.send({type:'combatEvent',roundId:a.joined.roundId,seq:1,event:{kind:'weapon:fire'}});await a.next('error');
  a.send({type:'combatEvent',roundId:a.joined.roundId,seq:2,event:{kind:'explosion',pos:[0,0,0],size:1,damage:999}});
  assert.equal((await b.next('combatEvent')).event.damage,undefined);
});

test('phase C reset replaces round and snapshots; old packets cannot damage the new round', async t => {
  const f=await fixture(t),a=await f.join(),b=await f.join();const oldRound=a.joined.roundId;
  a.send(worldData(oldRound,[a.joined.playerId,b.joined.playerId]));await b.next('world');
  b.send({type:'roundReset',roundId:oldRound});await b.next('error');
  a.send({type:'roundReset',roundId:oldRound});const reset=await b.next('combatReset');assert.notEqual(reset.roundId,oldRound);
  a.send(worldData(oldRound,[a.joined.playerId]));
  a.send(worldData(reset.roundId,[a.joined.playerId,b.joined.playerId]));
  assert.equal((await b.next('world',m=>m.roundId===reset.roundId)).seq,1);
});

test('phase C host loss stops combat; promoted owner explicitly resets before publishing', async t => {
  const f=await fixture(t),a=await f.join(),b=await f.join();
  a.send(worldData(a.joined.roundId,[a.joined.playerId,b.joined.playerId]));await b.next('world');a.destroy();
  const ended=await b.next('authorityStatus',m=>m.status==='ended');assert.equal(ended.hostId,b.joined.playerId);
  b.send(worldData(b.joined.roundId,[b.joined.playerId],{seq:2}));await b.next('error');
  b.send({type:'roundReset',roundId:b.joined.roundId});const reset=await b.next('combatReset');
  b.send(worldData(reset.roundId,[b.joined.playerId]));await b.next('authorityStatus',m=>m.status==='active');
});

test('RFC6455 minimal 64-bit length accepts a bounded 65536-byte UTF-8 message', async t => {
  const f=await fixture(t),c=await f.connect();const json=JSON.stringify({v:3,...joinData()});
  const data=Buffer.from(json+' '.repeat(MAX_MESSAGE-Buffer.byteLength(json)));assert.equal(data.length,65536);
  c.socket.write(clientFrame(1,data));assert.ok((await c.next('joined')).playerId);
});

test('v3 binds and rate limits flow intents, validates options and caches flow across late joins',async t=>{
  const f=await fixture(t),a=await f.join({mode:'coop'}),b=await f.join({mode:'coop'}),round=a.joined.roundId;
  const flow=require('../flow-coop').createFlow([{id:'relay_a'},{id:'relay_b'},{id:'relay_c'}]);
  a.send(worldData(round,[a.joined.playerId,b.joined.playerId],{flow}));await b.next('world');
  b.send({type:'interact',roundId:round,seq:1,objectiveId:'relay_a',active:true,playerId:a.joined.playerId});
  assert.equal((await a.next('interactIntent')).playerId,b.joined.playerId);
  b.send({type:'respawn',roundId:round,seq:1,playerId:a.joined.playerId});
  assert.equal((await a.next('respawnIntent')).playerId,b.joined.playerId);
  for(let seq=2;seq<22;seq++)b.send({type:'interact',roundId:round,seq,objectiveId:'relay_a',active:true});
  b.send({type:'respawn',roundId:round,seq:2});b.socket.write(clientFrame(9,'flow-barrier'));await b.next('$pong');
  a.socket.write(clientFrame(9,'flow-host-barrier'));await a.next('$pong');
  assert.ok(a.messages.filter(m=>m.type==='interactIntent').length<=6);assert.equal(a.messages.filter(m=>m.type==='respawnIntent').length,0);
  assert.equal(b.messages.filter(m=>m.type==='interactIntent').length,0);
  const c=await f.join({mode:'coop'});assert.deepEqual((await c.next('world')).flow,flow);
  c.send({type:'interact',roundId:round,seq:1,objectiveId:'x'.repeat(33),active:true});await c.next('error');
  c.send({type:'interact',roundId:round,seq:2,objectiveId:'relay_a',active:'true'});await c.next('error');
  c.send({type:'combatEvent',roundId:round,seq:1,event:{kind:'phase',phase:'extract'}});await c.next('error');
  a.send({type:'roundReset',roundId:round,options:{respawnSec:1,npcs:'both'}});
  const reset=await b.next('combatReset');assert.deepEqual(reset.options,{respawnSec:1});
  b.send({type:'interact',roundId:round,seq:100,objectiveId:'relay_a',active:true});
  b.send({type:'respawn',roundId:round,seq:100});
  a.send(worldData(reset.roundId,[a.joined.playerId,b.joined.playerId,c.joined.playerId],{flow}));await b.next('world');
  const old=new RawClient(f.port);t.after(()=>old.destroy());await old.next('hello');old.send({...joinData(),v:2});
  assert.match((await old.next('error')).reason,/版本3/);
});
test('v3 caches terminal flow, ignores old-round flow requests and rejects malformed new actor fields',async t=>{
  const f=await fixture(t),a=await f.join({mode:'coop'}),b=await f.join({mode:'coop'}),round=a.joined.roundId;
  const C=require('../flow-coop'),flow=C.createFlow([{id:'relay_a'}]);flow.phase='failed';flow.result=C.summarize(30,[]);
  a.send(worldData(round,[a.joined.playerId,b.joined.playerId],{flow}));await b.next('world');
  const c=await f.join({mode:'coop'});assert.deepEqual((await c.next('world')).flow,flow);
  a.send(worldData(round,[],{seq:2,players:[{...actorState(a.joined.playerId),respawnIn:61}]}));await a.next('error');
  a.send(worldData(round,[],{seq:2,players:[{...actorState(a.joined.playerId),deaths:-1}]}));await a.next('error');
  a.send(worldData(round,[],{seq:2,players:[{...actorState(a.joined.playerId),invuln:'yes'}]}));await a.next('error');
  a.send({type:'roundReset',roundId:round,options:{respawnSec:1}});const reset=await b.next('combatReset');
  b.send({type:'interact',roundId:round,seq:1,objectiveId:'relay_a',active:true});b.send({type:'respawn',roundId:round,seq:1});
  b.socket.write(clientFrame(9,'old-flow-barrier'));await b.next('$pong');a.socket.write(clientFrame(9,'host-flow-barrier'));await a.next('$pong');
  assert.equal(a.messages.filter(m=>['interactIntent','respawnIntent'].includes(m.type)).length,0);
  assert.equal(f.app.rooms.get('TEST').roundId,reset.roundId);assert.equal(f.app.rooms.get('TEST').world,null);
});
