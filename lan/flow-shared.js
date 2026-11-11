/* Shared spawn/life rules. Pure exports also run under Node, without THREE or a DOM. */
(function () {
  'use strict';
  const RULES = Object.freeze({ respawnSec:10, invulnSec:3, spawnSpacing:1.3, wallMargin:.6, overlap:.8 });
  const distance = (a,b) => Math.hypot(a[0]-b[0],a[2]-b[2]);
  const array = p => Array.isArray(p) ? p : [p.x,p.y,p.z];
  function clearPoint(point,walkable) {
    return [-.6,0,.6].every(x=>[-.6,0,.6].every(z=>walkable(point[0]+x,point[2]+z)));
  }
  function spawnCandidates(bounds,walkable) {
    const output=[];
    for(let x=bounds[0]+.65;x<=bounds[1]-.65;x+=RULES.spawnSpacing) {
      for(let z=bounds[2]+.65;z<=bounds[3]-.65;z+=RULES.spawnSpacing) {
        const point=[Math.round(x*1000)/1000,0,Math.round(z*1000)/1000];
        if(clearPoint(point,walkable))output.push(point);
      }
    }
    return output;
  }
  function nearest(points,anchor) {
    return points.slice().sort((a,b)=>distance(a,anchor)-distance(b,anchor)||a[0]-b[0]||a[2]-b[2]);
  }
  /** Deterministic 24-slot pools; cross-team sight checks are supplied by the caller. */
  function buildSpawnPools(walkable,visible) {
    const gate=spawnCandidates([-40,-24,-30,30],walkable);
    const quay=spawnCandidates([18,29,-28,26],walkable);
    if(gate.length<24||quay.length<24)throw new Error('可走出生点不足24个');
    const coop=nearest(gate,[-32,0,6]).slice(0,24);
    const anchors=[coop[0],...gate.filter((_,i)=>i%4===0)];
    for(const anchor of anchors) {
      const blue=nearest(gate,anchor).slice(0,24);
      const orange=quay.filter(point=>blue.every(other=>distance(point,other)>=40&&!visible(point,other)));
      if(orange.length>=24)return {coop,teams:[blue,nearest(orange,[24,0,-20]).slice(0,24)]};
    }
    throw new Error('无法构造间隔40米且相互遮挡的两队出生池');
  }
  /** Reject overlap first; rank safety, cover and recent use without mutating inputs. */
  function chooseSpawn(points,players,npcs,used,now,visible) {
    const live=players.filter(p=>p.health>0), enemies=npcs.filter(p=>p.alive!==false);
    let best=null,bestScore=-Infinity;
    for(const point of points) {
      if(live.some(p=>distance(point,array(p.pos))<RULES.overlap))continue;
      const threats=[...live.filter(p=>p.enemy),...enemies];
      const closest=threats.length?Math.min(...threats.map(p=>distance(point,array(p.pos)))):100;
      const hidden=threats.every(p=>!visible(point,array(p.pos)));
      const recent=used.find(item=>distance(point,item.pos)<.1&&now-item.at<10000);
      const score=Math.min(100,closest)+(closest>=15?200:0)+(hidden?100:0)-(recent?60:0);
      if(score>bestScore){bestScore=score;best=point;}
    }
    if(!best)throw new Error('没有不重叠的出生点');
    return best.slice();
  }
  function nearbySpawns(allies,walkable) {
    const points=[];
    for(const ally of allies.filter(a=>a.health>0))for(const radius of [6,8,10,12])for(let angle=0;angle<16;angle++) {
      const origin=array(ally.pos),point=[origin[0]+Math.cos(angle*Math.PI/8)*radius,origin[1],origin[2]+Math.sin(angle*Math.PI/8)*radius];
      if(clearPoint(point,walkable))points.push(point);
    }
    return points;
  }
  const respawnRemaining=(actor,now)=>actor.health>0?null:Math.max(0,((actor.respawnAt??now)-now)/1000);
  const allDown=actors=>actors.length>0&&actors.every(actor=>actor.health<=0);
  const api={RULES,distance,clearPoint,spawnCandidates,buildSpawnPools,chooseSpawn,nearbySpawns,respawnRemaining,allDown};
  if(typeof window==='undefined'){module.exports=api;return;}

  function create(ctx) {
    const {G,actors,emit,resetSelf}=ctx,T=G.THREE;
    let enabled=false,pools=null,used=[],options={};
    const visible=(a,b)=>G.physics.lineOfSight(new T.Vector3(...a).add(new T.Vector3(0,1.4,0)),new T.Vector3(...b).add(new T.Vector3(0,1.4,0)));
    const walkable=(x,z)=>G.physics.nav.isWalkable(x,z);
    function place(actor,revive=false) {
      if(!enabled)return;
      const now=Date.now(),others=[...actors.values()].filter(a=>a.id!==actor.id);
      const npcs=G.enemies.list.filter(e=>e.active&&e.alive);
      let points=pools.coop;
      if(revive) {
        const near=nearbySpawns(others,walkable).filter(p=>npcs.every(e=>distance(p,array(e.pos))>=15&&!visible(p,array(e.pos))));
        if(near.length)points=near;
      }
      const pos=chooseSpawn(points,others,npcs,used,now,visible);
      used=used.filter(item=>now-item.at<10000);used.push({pos,at:now});
      actor.pos.fromArray(pos);actor.eye.copy(actor.pos).add(new T.Vector3(0,1.68,0));actor.vel.set(0,0,0);
      actor.health=100;actor.ammo=30;actor.reserve=150;actor.reloadUntil=0;actor.respawnAt=null;
      actor.invulnUntil=now+RULES.invulnSec*1000;actor.spawnSlot=pools.coop.findIndex(p=>distance(p,pos)<.1);
      actor.needsSpawn=false;actor.ignorePoseUntil=now+500;actor.lastPose=now;actor.yaw=-Math.PI/2;
      if(revive)actor.respawns++;
      emit({kind:'respawn',playerId:actor.id,pos,yaw:actor.yaw,invulnSec:RULES.invulnSec});
    }
    return {
      initialize(data){enabled=data.mode==='coop';options=data.options||{};used=[];if(enabled&&!pools)pools=buildSpawnPools(walkable,visible);},
      place,
      tick(){if(enabled)for(const actor of actors.values())if(actor.needsSpawn)place(actor);},
      present(event){if(enabled&&event.kind==='respawn'&&event.playerId===ctx.self())resetSelf(event);},
      options:()=>options,
      snapshot:()=>({enabled,pools:pools&&JSON.parse(JSON.stringify(pools))}),
      detach(){enabled=false;used=[];},destroy(){}
    };
  }
  window.LanFlowShared=Object.freeze({...api,create});
})();
