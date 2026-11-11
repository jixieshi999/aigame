'use strict';
// Wire schemas for the host-authoritative combat channel. No game objects cross this boundary.
const scalar = n => Number.isFinite(n) && Math.abs(n) <= 10000;
const vec = v => Array.isArray(v) && v.length === 3 && v.every(scalar);
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const count = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
const copy = v => v.slice();
const boneCounts = { gull: 13, hound: 20 };
function statistics(s) {
  return s && ['shots','hits','kills'].every(k => count(s[k], 10000000)) ? { shots:s.shots, hits:s.hits, kills:s.kills } : null;
}
function cleanPlayer(p, playerIds) {
  const stats = p && statistics(p.stats);
  if (!p || !playerIds.has(p.playerId) || !scalar(p.health) || p.health < 0 || p.health > 100 ||
      typeof p.alive !== 'boolean' || p.alive !== (p.health > 0) || !count(p.ammo,30) || !count(p.reserve,150) ||
      typeof p.reloading !== 'boolean' || !count(p.ackShot,Number.MAX_SAFE_INTEGER) || !stats) return null;
  return { playerId:p.playerId, health:p.health, alive:p.alive, ammo:p.ammo, reserve:p.reserve,
    reloading:p.reloading, ackShot:p.ackShot, stats };
}
/** Return a detached, allowlisted world, or null on malformed authority data. */
function cleanWorld(data, playerIds) {
  if (!Array.isArray(data.enemies) || data.enemies.length > 18 || !Array.isArray(data.players) || data.players.length > 20 ||
      !Array.isArray(data.bolts) || data.bolts.length > 32) return null;
  const enemies = [], players = [], bolts = [], enemyIds = new Set(), actorIds = new Set(), boltIds = new Set();
  for (const e of data.enemies) {
    if (!e || !id(e.id) || enemyIds.has(e.id) || !Object.hasOwn(boneCounts,e.kind) || !vec(e.pos) ||
        !Array.isArray(e.quat) || e.quat.length !== 4 || !e.quat.every(scalar) || Math.abs(Math.hypot(...e.quat)-1) > .1 ||
        !scalar(e.hp) || e.hp < 0 || e.hp > 140 || typeof e.alive !== 'boolean' || !vec(e.lens) ||
        typeof e.bones !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(e.bones) || e.bones.length > 1024 ||
        Buffer.from(e.bones,'base64').length !== boneCounts[e.kind]*20) return null;
    enemyIds.add(e.id);
    enemies.push({ id:e.id, kind:e.kind, pos:copy(e.pos), quat:copy(e.quat), hp:e.hp, alive:e.alive,
      bones:e.bones, lens:copy(e.lens), targetId: playerIds.has(e.targetId) ? e.targetId : null });
  }
  for (const player of data.players) {
    const clean = cleanPlayer(player,playerIds);
    if (!clean || actorIds.has(clean.playerId)) return null;
    actorIds.add(clean.playerId); players.push(clean);
  }
  for (const b of data.bolts) {
    if (!b || !id(b.id) || boltIds.has(b.id) || !vec(b.pos) || !vec(b.dir) || Math.abs(Math.hypot(...b.dir)-1) > .1) return null;
    boltIds.add(b.id); bolts.push({ id:b.id, pos:copy(b.pos), dir:copy(b.dir) });
  }
  return { enemies, players, bolts };
}
/** Validate only presentation/confirmation events, never arbitrary game-bus payloads. */
function cleanEvent(e, playerIds) {
  if (!e || typeof e !== 'object') return null;
  if (e.kind === 'hurt' && playerIds.has(e.playerId) && scalar(e.health) && e.health >= 0 && e.health <= 100 &&
      scalar(e.amount) && e.amount > 0 && e.amount <= 100 && vec(e.from)) {
    return { kind:e.kind, playerId:e.playerId, health:e.health, amount:e.amount, from:copy(e.from) };
  }
  if (e.kind === 'enemyFire' && id(e.enemyId) && ['gull','hound'].includes(e.enemyType) && vec(e.pos) && vec(e.dir)) {
    return { kind:e.kind, enemyId:e.enemyId, enemyType:e.enemyType, pos:copy(e.pos), dir:copy(e.dir) };
  }
  if (e.kind === 'enemyDeath' && id(e.enemyId) && ['gull','hound'].includes(e.enemyType)) {
    return { kind:e.kind, enemyId:e.enemyId, enemyType:e.enemyType };
  }
  if (e.kind === 'explosion' && vec(e.pos) && scalar(e.size) && e.size >= .4 && e.size <= 4) {
    return { kind:e.kind, pos:copy(e.pos), size:e.size };
  }
  if (e.kind === 'shotResult' && playerIds.has(e.playerId) && count(e.shotSeq,Number.MAX_SAFE_INTEGER) &&
      typeof e.accepted === 'boolean' && typeof e.hit === 'boolean' && typeof e.killed === 'boolean' &&
      (e.enemyId === null || id(e.enemyId)) && ['body','weak',null].includes(e.part) && vec(e.point) && vec(e.normal)) {
    return { kind:e.kind, playerId:e.playerId, shotSeq:e.shotSeq, accepted:e.accepted, hit:e.hit, killed:e.killed,
      enemyId:e.enemyId, part:e.part, point:copy(e.point), normal:copy(e.normal) };
  }
  return null;
}
module.exports = { cleanWorld, cleanEvent, boneCounts };
