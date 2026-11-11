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
      typeof p.reloading !== 'boolean' || !count(p.ackShot,Number.MAX_SAFE_INTEGER) || !stats ||
      !count(p.deaths??0,10000000) || (p.respawnIn!=null&&(!Number.isFinite(p.respawnIn)||p.respawnIn<0||p.respawnIn>60)) ||
      (p.invuln!==undefined&&typeof p.invuln!=='boolean')) return null;
  return { playerId:p.playerId, health:p.health, alive:p.alive, ammo:p.ammo, reserve:p.reserve,
    reloading:p.reloading, ackShot:p.ackShot, stats, deaths:p.deaths??0,respawnIn:p.respawnIn??null,invuln:p.invuln??false };
}
const unit=n=>Number.isFinite(n)&&n>=0&&n<=1;
const timer=n=>Number.isFinite(n)&&n>=0&&n<=10000000;
/** Coop state contains only bounded numerical state and known objective IDs. */
function cleanFlow(f) {
  if(!f||f.kind!=='coop'||!['active','extract','complete','failed'].includes(f.phase)||!timer(f.time)||
      !Array.isArray(f.relays)||f.relays.length<1||f.relays.length>16||!count(f.cut,16)||f.total!==f.relays.length||
      !count(f.wave,1000)||!timer(f.waveHot)||typeof f.allCut!=='boolean'||!count(f.pursuitLeft,1000))return null;
  const seen=new Set(),relays=[];
  for(const r of f.relays) {
    if(!r||!id(r.id)||r.id.length>32||seen.has(r.id)||typeof r.cut!=='boolean'||!unit(r.t)||!count(r.cutters,20)||(r.cut&&r.t!==1))return null;
    seen.add(r.id);relays.push({id:r.id,cut:r.cut,t:r.t,cutters:r.cutters});
  }
  if(f.cut!==relays.filter(r=>r.cut).length||f.allCut!==(f.cut===f.total)||(['extract','complete'].includes(f.phase)&&!f.allCut))return null;
  const e=f.extraction;
  if(!e||typeof e.open!=='boolean'||e.open!==f.allCut||!count(e.inZone,20)||!count(e.needed,20)||e.inZone>e.needed||!unit(e.hold))return null;
  let result=null;
  if(f.result!==null) {
    const r=f.result;
    if(!r||!timer(r.time)||!['shots','hits','kills','respawns'].every(k=>count(r[k],10000000))||r.hits>r.shots||
        !count(r.rating,5)||(r.accuracy!==null&&!unit(r.accuracy)))return null;
    result={time:r.time,shots:r.shots,hits:r.hits,kills:r.kills,respawns:r.respawns,rating:r.rating,accuracy:r.accuracy};
  }
  if(['complete','failed'].includes(f.phase)!==(result!==null))return null;
  return {kind:'coop',phase:f.phase,time:f.time,relays,cut:f.cut,total:f.total,wave:f.wave,waveHot:f.waveHot,
    allCut:f.allCut,pursuitLeft:f.pursuitLeft,extraction:{open:e.open,inZone:e.inZone,needed:e.needed,hold:e.hold},result};
}
function cleanOptions(options,mode) {
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['friendlyFire','npcs','scoreLimit','timeLimitSec','respawnSec','rebalance'].includes(k)))return null;
  for(const key of ['friendlyFire','rebalance'])if(options[key]!==undefined&&typeof options[key]!=='boolean')return null;
  if(options.npcs!==undefined&&!['off','both'].includes(options.npcs))return null;
  for(const [key,min,max] of [['scoreLimit',5,200],['timeLimitSec',60,3600],['respawnSec',1,60]]) {
    if(options[key]!==undefined&&(!Number.isInteger(options[key])||options[key]<min||options[key]>max))return null;
  }
  if(mode==='coop')return {respawnSec:options.respawnSec??10};
  return {...options}; // E will apply these options; D preserves C's PvP behaviour.
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
  const flow=data.flow===undefined?undefined:cleanFlow(data.flow);
  if(data.flow!==undefined&&!flow)return null;
  return { enemies, players, bolts,...(flow?{flow}:{}) };
}
/** Validate only presentation/confirmation events, never arbitrary game-bus payloads. */
function cleanEvent(e, playerIds) {
  if (!e || typeof e !== 'object') return null;
  if(e.kind==='respawn'&&playerIds.has(e.playerId)&&vec(e.pos)&&Number.isFinite(e.yaw)&&Math.abs(e.yaw)<=100000&&timer(e.invulnSec)&&e.invulnSec<=60)
    return {kind:e.kind,playerId:e.playerId,pos:copy(e.pos),yaw:e.yaw,invulnSec:e.invulnSec};
  if(e.kind==='objectiveDone'&&typeof e.objectiveId==='string'&&/^[a-zA-Z0-9_-]{1,32}$/.test(e.objectiveId)&&count(e.total,16)&&e.total>0&&count(e.index,e.total)&&e.index>0)
    return {kind:e.kind,objectiveId:e.objectiveId,index:e.index,total:e.total};
  if(e.kind==='waveWarning'&&vec(e.centroid))return {kind:e.kind,centroid:copy(e.centroid)};
  if(e.kind==='radio'&&['intro','contact','cut1','cut2','all','low','done'].includes(e.key))return {kind:e.kind,key:e.key};
  if(e.kind==='phase'&&['active','extract','complete','failed'].includes(e.phase))return {kind:e.kind,phase:e.phase};
  if(e.kind==='roundEnd'&&['complete','failed'].includes(e.result)&&(e.winnerTeam===undefined||e.winnerTeam===null))return {kind:e.kind,result:e.result,winnerTeam:null};
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
module.exports = { cleanWorld, cleanEvent, cleanFlow,cleanOptions,boneCounts };
