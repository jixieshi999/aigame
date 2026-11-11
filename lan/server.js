'use strict';

// Runtime dependencies are exclusively Node built-ins. The source HTML is read only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { cleanWorld, cleanEvent,cleanOptions } = require('./combat-protocol');

const VERSION = 3;
const EXPECTED_HASH = '9e55b5200b088adaf8e1152da04efc0d3b25e236e6baf2dee96f81e23e084966';
const MAX_MESSAGE = 65536;
const MAX_PLAYERS = 20;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function frame(opcode, payload = Buffer.alloc(0)) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  header[1] = payload.length < 126 ? payload.length : payload.length < 65536 ? 126 : 127;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function bucket(capacity, rate) {
  let tokens = capacity;
  let at = performance.now();
  return () => {
    const now = performance.now();
    tokens = Math.min(capacity, tokens + (now - at) * rate / 1000);
    at = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const integer = value => Number.isSafeInteger(value) && value >= 0;
const seedValue = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const vector = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) <= 10000);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validMap(map) {
  return map && map.schema === 'static-v1' && digest(map.boxes) && digest(map.nav) &&
    integer(map.boxCount) && map.boxCount <= 100000 && integer(map.navWidth) &&
    map.navWidth > 0 && map.navWidth <= 2048 && integer(map.navHeight) && map.navHeight > 0 && map.navHeight <= 2048;
}
function cleanMap(map) {
  return { schema: map.schema, boxes: map.boxes, nav: map.nav, boxCount: map.boxCount, navWidth: map.navWidth, navHeight: map.navHeight };
}
function cleanName(value) {
  return Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()).slice(0, 20).join('') || '无名猫';
}
function sameMap(a, b) {
  return ['schema', 'boxes', 'nav', 'boxCount', 'navWidth', 'navHeight'].every(key => a[key] === b[key]);
}

/** Create an unbound HTTP/WebSocket room server. Options only tune lifecycle timing for tests. */
function createLanServer(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', '几猫国产3A大作_V1.html'));
  const sha256 = crypto.createHash('sha256').update(source).digest('hex');
  if (sha256 !== EXPECTED_HASH) throw new Error('原 HTML 构建哈希与已核验版本不同，拒绝接入。');
  const html = source.toString('utf8');
  const bodyAt = html.toLowerCase().lastIndexOf('</body>');
  if (bodyAt < 0) throw new Error('原 HTML 缺少 </body>');
  const build = sha256.slice(0, 16);
  const injected = html.slice(0, bodyAt) + `<script src="/net.js" data-build="${build}"></script>\n` + html.slice(bodyAt);
  const rooms = new Map();
  const peers = new Set();
  const upgrades = new Map();
  const metrics = { invalid: 0, poseLimited: 0, shotLimited: 0, poses: 0, shots: 0, worlds: 0, combatEvents: 0 };
  let shuttingDown = false;

  const server = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }); res.end(); return;
    }
    if (route !== '/' && route !== '/net.js') { res.writeHead(404, headers); res.end('Not found'); return; }
    let content;
    try { content = route === '/' ? injected : ['combat.js','flow-shared.js','flow-coop.js','net.js'].map(file=>fs.readFileSync(path.join(__dirname,file),'utf8')).join('\n;\n'); }
    catch (error) { console.error(`读取联机脚本失败：${error.message}`); res.writeHead(500, headers); res.end('Script unavailable'); return; }
    res.writeHead(200, { ...headers, 'Content-Type': route === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.on('clientError', (_error, socket) => socket.destroy());

  function send(peer, data, transient = false) {
    if (peer.closed || peer.socket.destroyed || peer.socket.writableEnded) return;
    if (peer.socket.writableLength > 1024 * 1024) { close(peer, 1013, '接收过慢'); return; }
    if (transient && peer.socket.writableLength > 256 * 1024) return;
    peer.socket.write(frame(1, JSON.stringify({ ...data, v: VERSION })));
  }
  function broadcast(room, data, except = null, transient = false) {
    for (const player of room.players.values()) if (player.peer !== except) send(player.peer, data, transient);
  }
  function publicPlayer(player) {
    return { playerId: player.id, nickname: player.nickname, team: player.team, build, map: player.map, pose: player.pose };
  }
  function roster(room) {
    broadcast(room, { type: 'roster', roundId: room.roundId, hostId: room.hostId,mode:room.mode,options:{...room.options}, players: [...room.players.values()].map(publicPlayer) });
  }
  function authorityStatus(room, reason = '') {
    broadcast(room, { type:'authorityStatus', roundId:room.roundId, hostId:room.hostId, status:room.combatStatus, reason });
  }
  function maps(room) {
    const values = [...room.players.values()];
    const mismatch = values.filter(player => !sameMap(values[0].map, player.map)).map(player => player.id);
    room.mapOk = mismatch.length === 0;
    broadcast(room, { type: room.mapOk ? 'mapStatus' : 'mapMismatch', roundId: room.roundId,
      ok: room.mapOk, baselineId: values[0].id, mismatched: mismatch, build,
      reason: room.mapOk ? '静态碰撞盒和导航网格一致' : '静态地图摘要不一致；远程位置可能错位，请核对构建与参数后重新加载' });
  }
  function cleanup(peer) {
    if (peer.cleaned) return;
    peer.cleaned = true;
    peers.delete(peer);
    const room = peer.room;
    if (!room || !room.players.delete(peer.playerId)) return;
    // A world already in flight may still include a member whose socket just closed.
    // Only IDs actually removed from this round get this bounded grace period.
    const now = Date.now();
    for (const [id, at] of room.departed) if (now-at>5000) room.departed.delete(id);
    room.departed.set(peer.playerId,now);
    if (room.departed.size>128) room.departed.delete(room.departed.keys().next().value);
    if (room.world) {
      room.world.players = room.world.players.filter(player => player.playerId !== peer.playerId);
      room.world.enemies = room.world.enemies.map(enemy => enemy.targetId === peer.playerId ? {...enemy,targetId:null} : enemy);
    }
    broadcast(room, { type: 'leave', playerId: peer.playerId, roundId: room.roundId });
    if (!room.players.size) { rooms.delete(room.id); return; }
    if (room.hostId === peer.playerId) {
      room.hostId = room.players.keys().next().value;
      room.combatStatus = 'ended'; room.world = null;
      authorityStatus(room, '房主离开，本轮战斗停止；新房主可点击重开战斗');
    }
    roster(room);
    maps(room);
  }
  function close(peer, code = 1000, reason = '', echo = null) {
    if (peer.closed) return;
    peer.closed = true;
    cleanup(peer);
    let payload = echo;
    if (!payload) {
      const text = Buffer.from(reason).subarray(0, 120);
      payload = Buffer.alloc(2 + text.length); payload.writeUInt16BE(code); text.copy(payload, 2);
    }
    if (!peer.socket.destroyed) peer.socket.end(frame(8, payload));
    const timer = setTimeout(() => peer.socket.destroy(), 500);
    timer.unref();
  }
  function reject(peer, code, reason, extra = {}) {
    send(peer, { type: 'error', code, reason, ...extra });
    close(peer, 1008, reason);
  }
  function invalid(peer, reason) {
    metrics.invalid++;
    peer.invalid++;
    if (peer.invalid >= 8) reject(peer, 'invalidMessages', '非法消息过多');
    else send(peer, { type: 'error', code: 'invalidMessage', reason });
  }

  function join(peer, message) {
    if (peer.room || typeof message.room !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(message.room) ||
        typeof message.nickname !== 'string' || message.nickname.length > 512 || !['coop', 'pvp'].includes(message.mode) ||
        !seedValue(message.seed) || !seedValue(message.eseed) || !validMap(message.map)) {
      invalid(peer, '加入参数无效'); return;
    }
    const id = message.room.toUpperCase();
    let room = rooms.get(id);
    if (room && room.mode !== message.mode) { reject(peer, 'modeMismatch', '房间模式与房主不同', { mode: room.mode }); return; }
    if (room && (room.seed !== message.seed || room.eseed !== message.eseed)) {
      reject(peer, 'seedMismatch', '地图种子与房主不同，请使用推荐链接重新加载', { seed: room.seed, eseed: room.eseed, room: id, mode: room.mode }); return;
    }
    if (room && room.players.size >= MAX_PLAYERS) { reject(peer, 'roomFull', '房间已满（最多20人）'); return; }
    const playerId = crypto.randomUUID();
    if (!room) {
      room = { id, roundId: crypto.randomUUID(), hostId: playerId, mode: message.mode,
        seed: message.seed, eseed: message.eseed, players: new Map(), mapOk: true, world:null,
        worldSeq:-1, eventSeq:-1, combatStatus:'waiting', lastWorldAt:Date.now(), previousRounds:[], departed:new Map(),options:cleanOptions({},message.mode) };
      rooms.set(id, room);
    }
    const teams = [0, 0];
    for (const player of room.players.values()) teams[player.team]++;
    const team = room.mode === 'coop' || teams[0] <= teams[1] ? 0 : 1;
    const player = { id: playerId, nickname: cleanName(message.nickname), team, map: cleanMap(message.map), pose: null, peer };
    peer.playerId = playerId; peer.room = room; room.players.set(playerId, player);
    send(peer, { type: 'joined', playerId, roundId: room.roundId, hostId: room.hostId, room: id,
      mode: room.mode,options:{...room.options},seed: room.seed, eseed: room.eseed, build, combatStatus:room.combatStatus,
      players: [...room.players.values()].map(publicPlayer) });
    roster(room); maps(room);
    if (room.world) send(peer,room.world);
  }

  function message(peer, payload) {
    let data;
    try { data = JSON.parse(utf8.decode(payload)); }
    catch (error) {
      if (error instanceof TypeError) { close(peer, 1007, '无效UTF-8'); return; }
      invalid(peer, 'JSON格式错误'); return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { invalid(peer, '需要消息对象'); return; }
    if (data.v !== VERSION) { reject(peer, 'versionMismatch', `协议版本不兼容，需要版本${VERSION}`); return; }
    if (data.type === 'join') { join(peer, data); return; }
    if (!peer.room) { invalid(peer, '请先加入房间'); return; }
    const room = peer.room;
    if (data.roundId !== room.roundId) {
      if (!room.previousRounds.includes(data.roundId)) invalid(peer, 'roundId无效');
      return;
    }
    if (data.type === 'pose') {
      if (!peer.poseToken()) { metrics.poseLimited++; return; }
      if (!integer(data.seq) || data.seq <= peer.poseSeq || !vector(data.pos) || !Number.isFinite(data.yaw) ||
          Math.abs(data.yaw) > 100000 || !Number.isFinite(data.pitch) || Math.abs(data.pitch) > Math.PI ||
          !Number.isFinite(data.ads) || data.ads < 0 || data.ads > 1 ||
          !['crouching', 'sprinting', 'alive', 'reloading'].every(key => typeof data[key] === 'boolean')) {
        invalid(peer, '位姿字段无效'); return;
      }
      peer.poseSeq = data.seq;
      // Identity and timing come from the connection/server, never from client-supplied IDs.
      const pose = { type: 'pose', playerId: peer.playerId, roundId: room.roundId, seq: data.seq, at: Date.now(),
        pos: data.pos.slice(), yaw: data.yaw, pitch: data.pitch, ads: data.ads,
        crouching: data.crouching, sprinting: data.sprinting,
        alive: room.world?.players.find(p => p.playerId === peer.playerId)?.alive ?? data.alive, reloading: data.reloading };
      room.players.get(peer.playerId).pose = pose;
      metrics.poses++; broadcast(room, pose, peer, true);
    } else if (data.type === 'shot') {
      if (!peer.shotToken()) { metrics.shotLimited++; return; }
      const length = vector(data.dir) ? Math.hypot(...data.dir) : 0;
      if (!integer(data.seq) || data.seq <= peer.shotSeq || !vector(data.origin) || !vector(data.muzzle) || length < .9 || length > 1.1) {
        invalid(peer, '射击字段无效'); return;
      }
      peer.shotSeq = data.seq; metrics.shots++;
      if (!room.mapOk || room.combatStatus !== 'active') return;
      const pose = room.players.get(peer.playerId).pose;
      if (!pose || Math.hypot(...data.origin.map((n,j)=>n-pose.pos[j]-(j===1?1.4:0))) > 3 ||
          Math.hypot(...data.muzzle.map((n,j)=>n-data.origin[j])) > 2) { invalid(peer,'射击原点偏离玩家'); return; }
      const shot = { type:'shot', roundId:room.roundId, playerId:peer.playerId, seq:data.seq, at:Date.now(),
        origin:data.origin.slice(), muzzle:data.muzzle.slice(), dir:data.dir.map(n=>n/length) };
      broadcast(room,shot,peer,true);
      send(room.players.get(room.hostId).peer,{ ...shot, type:'shotIntent' });
    } else if (data.type==='interact'||data.type==='respawn') {
      if(room.mode!=='coop'){invalid(peer,'合作流程请求只适用于合作房间');return;}
      const key=data.type+'Seq',limiter=data.type==='interact'?peer.interactToken:peer.respawnToken;
      if(!limiter())return;
      if(!integer(data.seq)||(data.type==='interact'&&(typeof data.objectiveId!=='string'||!/^[a-zA-Z0-9_-]{1,32}$/.test(data.objectiveId)||typeof data.active!=='boolean'))) {
        invalid(peer,'流程请求字段无效');return;
      }
      if(data.seq<=peer[key])return;
      peer[key]=data.seq;
      if(room.mapOk&&room.combatStatus==='active')send(room.players.get(room.hostId).peer,
        {type:data.type+'Intent',roundId:room.roundId,playerId:peer.playerId,seq:data.seq,at:Date.now(),
          ...(data.type==='interact'?{objectiveId:data.objectiveId,active:data.active}:{})});
    } else if (data.type === 'reload' || data.type === 'hazard') {
      const limiter = data.type === 'reload' ? peer.reloadToken : peer.hazardToken;
      const key = data.type === 'reload' ? 'reloadSeq' : 'hazardSeq';
      if (!limiter()) return;
      if (!integer(data.seq) || data.seq <= peer[key] || (data.type === 'hazard' &&
          (!['fall','rescue'].includes(data.reason) || !Number.isFinite(data.amount) || data.amount <= 0 || data.amount > 100))) {
        invalid(peer,'战斗请求无效'); return;
      }
      peer[key] = data.seq;
      if (room.mapOk && room.combatStatus === 'active') send(room.players.get(room.hostId).peer,
        { type:data.type+'Intent', roundId:room.roundId, playerId:peer.playerId, seq:data.seq, at:Date.now(),
          ...(data.type === 'hazard' ? { reason:data.reason, amount:data.amount } : {}) });
    } else if (data.type === 'world' || data.type === 'combatEvent') {
      if (peer.playerId !== room.hostId || room.combatStatus === 'ended') { invalid(peer,'只有当前房主可以发布战斗状态'); return; }
      if (!peer.authorityToken()) return;
      if (!integer(data.seq) || data.seq <= room[data.type === 'world' ? 'worldSeq' : 'eventSeq']) { invalid(peer,'战斗序号无效'); return; }
      const ids = new Set(room.players.keys());
      const authorityData = data.type === 'world' && Array.isArray(data.players) && data.players.length<=MAX_PLAYERS
        ? {...data,players:data.players.filter(player => !room.departed.has(player?.playerId) || Date.now()-room.departed.get(player.playerId)>5000)}
        : data;
      const clean = data.type === 'world' ? cleanWorld(authorityData,ids) : cleanEvent(data.event,ids);
      if (!clean) { invalid(peer,'战斗状态字段无效'); return; }
      if (!room.mapOk) return;
      if (data.type === 'world') {
        room.worldSeq = data.seq; room.lastWorldAt = Date.now(); metrics.worlds++;
        room.world = { type:'world', roundId:room.roundId, hostId:room.hostId, seq:data.seq, at:Date.now(), ...clean };
        if (room.combatStatus !== 'active') { room.combatStatus = 'active'; authorityStatus(room); }
        broadcast(room,room.world,peer,true);
      } else {
        room.eventSeq = data.seq; metrics.combatEvents++;
        broadcast(room,{ type:'combatEvent', roundId:room.roundId, hostId:room.hostId, seq:data.seq, at:Date.now(), event:clean },peer);
      }
    } else if (data.type === 'roundReset') {
      if (peer.playerId !== room.hostId || !peer.resetToken()) { invalid(peer,'只有房主可以重开战斗，且不能频繁重开'); return; }
      const options=cleanOptions(data.options===undefined?room.options:data.options,room.mode);
      if(!options){invalid(peer,'房间选项无效');return;}room.options=options;
      room.previousRounds.push(room.roundId); room.previousRounds = room.previousRounds.slice(-4);
      room.roundId = crypto.randomUUID(); room.world = null; room.worldSeq = room.eventSeq = -1;
      room.departed.clear();
      room.combatStatus = 'waiting'; room.lastWorldAt = Date.now();
      for (const player of room.players.values()) {
        player.pose = null;
        for (const key of ['poseSeq','shotSeq','reloadSeq','hazardSeq','interactSeq','respawnSeq']) player.peer[key] = -1;
      }
      broadcast(room,{ type:'combatReset', roundId:room.roundId, hostId:room.hostId,mode:room.mode,options:{...room.options}, players:[...room.players.values()].map(publicPlayer) });
      maps(room);
    } else if (data.type === 'leave') close(peer, 1000, '已离开');
    else invalid(peer, '不支持的消息类型');
  }

  function receive(peer, chunk) {
    if (peer.closed) return;
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    while (!peer.closed && peer.buffer.length >= 2) {
      const buffer = peer.buffer;
      const fin = !!(buffer[0] & 128), opcode = buffer[0] & 15;
      let length = buffer[1] & 127, offset = 2;
      const control = opcode >= 8;
      if ((buffer[0] & 112) || !(buffer[1] & 128) || ![0, 1, 2, 8, 9, 10].includes(opcode) || (control && (!fin || length > 125))) {
        close(peer, 1002, '帧格式错误'); return;
      }
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
        if (length < 126) { close(peer, 1002, '非最短长度编码'); return; }
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const large = buffer.readBigUInt64BE(2);
        if (large >> 63n) { close(peer, 1002, '无效64位长度'); return; }
        if (large > BigInt(MAX_MESSAGE)) { close(peer, 1009, '消息过长'); return; }
        if (large < 65536n) { close(peer, 1002, '非最短长度编码'); return; }
        length = Number(large); offset = 10;
      }
      if (length > MAX_MESSAGE || (!control && length + peer.fragmentBytes > MAX_MESSAGE)) { close(peer, 1009, '消息过长'); return; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      for (let index = 0; index < length; index++) payload[index] ^= mask[index % 4];
      peer.buffer = buffer.subarray(offset + length);
      const frameToken = peer.room?.hostId === peer.playerId ? peer.hostFrameToken : peer.frameToken;
      if (!frameToken()) { close(peer, 1008, '消息频率过高'); return; }
      if (opcode === 8) {
        if (length === 1) { close(peer, 1002, '关闭帧无效'); return; }
        if (length >= 2) {
          const code = payload.readUInt16BE();
          if (!((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999))) {
            close(peer, 1002, '关闭码无效'); return;
          }
          try { utf8.decode(payload.subarray(2)); } catch { close(peer, 1007, '关闭原因UTF-8无效'); return; }
        }
        close(peer, 1000, '', payload); return;
      }
      if (opcode === 9) { peer.socket.write(frame(10, payload)); continue; }
      if (opcode === 10) { if (peer.ping && payload.equals(peer.ping)) peer.ping = null; continue; }
      if (opcode === 2) { close(peer, 1003, '只支持文本消息'); return; }
      if (opcode === 0) {
        if (!peer.fragments) { close(peer, 1002, '缺少分片起始帧'); return; }
        peer.fragments.push(payload); peer.fragmentBytes += length;
        if (fin) {
          const complete = Buffer.concat(peer.fragments); peer.fragments = null; peer.fragmentBytes = 0;
          message(peer, complete);
        }
      } else {
        if (peer.fragments) { close(peer, 1002, '分片尚未结束'); return; }
        if (fin) message(peer, payload);
        else { peer.fragments = [payload]; peer.fragmentBytes = length; }
      }
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const deny = (status, reason) => socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const address = socket.remoteAddress;
    const now = Date.now();
    let entry = upgrades.get(address);
    if (!entry || now - entry.at > 60000) { entry = { at: now, count: 0 }; upgrades.set(address, entry); }
    if (++entry.count > 120 || peers.size >= 256 || [...peers].filter(peer => peer.address === address).length >= 64) {
      deny(429, 'Too Many Requests'); return;
    }
    let origin;
    try { origin = new URL(req.headers.origin); } catch { deny(403, 'Forbidden'); return; }
    const key = req.headers['sec-websocket-key'];
    if (shuttingDown || req.method !== 'GET' || req.url !== '/' || origin.origin !== `http://${req.headers.host}` ||
        origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) { deny(403, 'Forbidden'); return; }
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') ||
        req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      deny(400, 'Bad Request'); return;
    }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true); socket.setKeepAlive(true, 15000);
    const peer = { socket, address, buffer: Buffer.alloc(0), fragments: null, fragmentBytes: 0, invalid: 0,
      poseSeq: -1, shotSeq: -1, reloadSeq:-1, hazardSeq:-1,interactSeq:-1,respawnSeq:-1,
      poseToken: bucket(4, 20), shotToken: bucket(6, 15), frameToken: bucket(160, 120),
      // A host also confirms shots/damage for all 20 members; retain the smaller guest budget.
      hostFrameToken:bucket(768,512), authorityToken:bucket(600,400),
      reloadToken:bucket(2,2), hazardToken:bucket(4,3), resetToken:bucket(1,.5),interactToken:bucket(6,10),respawnToken:bucket(1,1),
      joinedAt: now, lastPing: now, ping: null, closed: false, cleaned: false, room: null };
    peers.add(peer);
    socket.on('data', chunk => receive(peer, chunk));
    socket.on('error', () => { peer.closed = true; cleanup(peer); socket.destroy(); });
    socket.on('end', () => { peer.closed = true; cleanup(peer); socket.end(); });
    socket.on('close', () => { peer.closed = true; cleanup(peer); });
    send(peer, { type: 'hello', build, maxPlayers: MAX_PLAYERS, poseHz: 20, mapSchema: 'static-v1', combat:'host-v1' });
    if (head.length) receive(peer, head);
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) if (room.combatStatus === 'active' && now-room.lastWorldAt > 3000) {
      room.combatStatus = 'waiting'; authorityStatus(room,'房主暂时没有更新，等待恢复');
    }
    for (const [address, entry] of upgrades) if (now - entry.at > 60000) upgrades.delete(address);
    for (const peer of peers) {
      if (!peer.room && now - peer.joinedAt > (options.joinTimeoutMs ?? 15000)) { close(peer, 1008, '加入超时'); continue; }
      if (peer.ping && now - peer.lastPing > (options.pongTimeoutMs ?? 10000)) {
        cleanup(peer); peer.closed = true; peer.socket.destroy(); continue;
      }
      if (!peer.ping && now - peer.lastPing >= (options.pingIntervalMs ?? 15000)) {
        peer.ping = crypto.randomBytes(8); peer.lastPing = now; peer.socket.write(frame(9, peer.ping));
      }
    }
  }, options.heartbeatMs ?? 1000);
  heartbeat.unref();

  /** Close all sessions and listening sockets; used by tests and process signal handlers. */
  async function stop() {
    shuttingDown = true; clearInterval(heartbeat);
    for (const peer of [...peers]) close(peer, 1001, '服务器关闭');
    await new Promise(resolve => server.close(resolve));
  }
  return { server, stop, rooms, peers, metrics, build, sha256 };
}

if (require.main === module) {
  const port = Number(process.argv[2] ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('端口需为1到65535的整数'); process.exitCode = 1; }
  else {
    const app = createLanServer();
    app.server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
    app.server.listen(port, '0.0.0.0', () => {
      console.log(`几猫局域网 A/B/C/D 阶段 · 构建 ${app.build} · 协议 ${VERSION}`);
      console.log(`本机：http://localhost:${port}/`);
      for (const addresses of Object.values(os.networkInterfaces())) for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`局域网：http://${address.address}:${port}/`);
      }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.stop().catch(error => console.error(error.message)));
  }
}

module.exports = { createLanServer, VERSION, MAX_MESSAGE, EXPECTED_HASH };
