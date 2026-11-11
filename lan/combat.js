/* Phase C adapter for the hash-locked original game. Served before net.js at /net.js. */
(function () {
  'use strict';
  const boneCounts = { gull:13, hound:20 };
  const values = v => [v.x,v.y,v.z];
  const qvalues = q => [q.x,q.y,q.z,q.w];
  const rounded = n => Math.round(n*1000)/1000;
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub = (a,b) => a.map((n,j)=>n-b[j]);
  function sphereHit(origin,dir,center,radius,range) {
    const offset=sub(origin,center), b=dot(offset,dir), c=dot(offset,offset)-radius*radius;
    if (c<=0) return 0;
    const h=b*b-c;
    if (h<0) return null;
    const t=-b-Math.sqrt(h);
    return t>=0 && t<=range ? t : null;
  }
  /** Nearest ray/capsule intersection, including endpoints and origins inside the capsule. */
  function capsuleHit(origin,dir,low,high,radius,range) {
    const ba=sub(high,low), oa=sub(origin,low), baba=dot(ba,ba), bard=dot(ba,dir), baoa=dot(ba,oa);
    const a=baba-bard*bard, b=baba*dot(dir,oa)-baoa*bard, c=baba*dot(oa,oa)-baoa*baoa-radius*radius*baba;
    let nearest=null;
    const along=baba ? Math.max(0,Math.min(1,baoa/baba)) : 0;
    const center=low.map((n,j)=>n+ba[j]*along);
    if (dot(sub(origin,center),sub(origin,center))<=radius*radius) return 0;
    const h=b*b-a*c;
    if (Math.abs(a)>1e-9 && h>=0) {
      const t=(-b-Math.sqrt(h))/a, y=baoa+t*bard;
      if (t>=0 && t<=range && y>=0 && y<=baba) nearest=t;
    }
    for (const point of [low,high]) {
      const t=sphereHit(origin,dir,point,radius,range);
      if (t!==null && (nearest===null || t<nearest)) nearest=t;
    }
    return nearest;
  }
  function encodeBytes(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let text=''; for (const byte of bytes) text+=String.fromCharCode(byte);
    return btoa(text);
  }
  function decodeBytes(text) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(text,'base64'));
    return Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  }
  /** Pack sorted bone transforms as LE int16: millimetres, quaternion/32767, scale/1000. */
  function packBones(bones) {
    const bytes=new Uint8Array(bones.length*20), view=new DataView(bytes.buffer);
    bones.forEach((bone,j)=> {
      const data=[...values(bone.position),...qvalues(bone.quaternion),...values(bone.scale)];
      data.forEach((n,k)=>view.setInt16(j*20+k*2,Math.max(-32767,Math.min(32767,Math.round(n*(k>=3&&k<=6?32767:1000)))),true));
    });
    return encodeBytes(bytes);
  }
  function unpackBones(text,count) {
    const bytes=decodeBytes(text);
    if (bytes.length!==count*20) throw new Error('骨架数据长度不符');
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), output=new Float32Array(count*10);
    for (let i=0;i<output.length;i++) output[i]=view.getInt16(i*2,true)/(i%10>=3&&i%10<=6?32767:1000);
    return output;
  }
  function takeFireToken(actor,now) {
    actor.fireTokens=Math.min(3,actor.fireTokens+Math.max(0,now-actor.fireAt)*12/1000); actor.fireAt=now;
    if (actor.fireTokens<1) return false;
    actor.fireTokens--; return true;
  }
  if (typeof window==='undefined') { module.exports={ capsuleHit,packBones,unpackBones,takeFireToken }; return; }

  function create(context) {
    const { G,send,onStatus }=context, T=G.THREE, player=G.player;
    const pools=[...G.enemies.debug.gulls,...G.enemies.debug.hounds];
    const actors=new Map(), puppets=new Map(), boneOrders=new Map(), pendingShots=new Set(), removers=[];
    const saved={}, changedButtons=new Map();
    let attached=false, initializing=false, mapOk=false, selfId=null, hostId=null, roundId=null, state='waiting';
    let lastTick=performance.now(), accumulator=0, snapshotAt=0, worldSeq=0, eventSeq=0, lastWorldSeq=-1, lastEventSeq=-1;
    let reloadSeq=0, hazardSeq=0, currentEnemy=null, currentAttacker=null, offset=null, latestWorld=null, replaying=false;
    let projectiles=[], boltCounter=0;
    let mode='pvp',shared=null,coop=null;
    const saturation=G.render.post?.saturation??1;
    const stats={ simulations:0, worldsSent:0, worldsReceived:0, acceptedShots:0, rejectedShots:0, damage:0,
      explosions:0, remoteExplosions:0, boltHits:0, disposed:0, identityLeaks:0 };
    const projectileRoot=new T.Group(); projectileRoot.name='LAN authoritative projectiles'; projectileRoot.layers.set(0);
    const boltGeometry=new T.BoxGeometry(.045,.045,.7), boltMaterial=new T.MeshBasicMaterial({ color:0xff9955,toneMapped:false });
    const boltMeshes=[];
    for (let i=0;i<32;i++) { const mesh=new T.Mesh(boltGeometry,boltMaterial); mesh.visible=false; mesh.layers.set(0); projectileRoot.add(mesh); boltMeshes.push(mesh); }
    G.scene.add(projectileRoot);
    const zAxis=new T.Vector3(0,0,1), temp=new T.Vector3();
    const isHost=()=>attached&&selfId===hostId;
    const running=()=>attached&&mapOk&&state!=='ended';
    const fighting=()=>running()&&!coop?.terminal();
    function replace(object,key,fn) { const original=object[key]; object[key]=fn(original); removers.push(()=>{ object[key]=original; }); return original; }
    function warn(text) { onStatus(text); }
    function netEvent(event) { if (isHost()&&mapOk&&state!=='ended') send({type:'combatEvent',roundId,seq:++eventSeq,event}); }
    function makeActor(info) {
      const now=Date.now(), pos=info.pose?.pos || values(G.level.playerStart.pos);
      const actor={ id:info.playerId, pos:new T.Vector3(...pos), eye:new T.Vector3(), vel:new T.Vector3(),
        health:100, ammo:30,reserve:150,reloadUntil:0,ackShot:0,stats:{shots:0,hits:0,kills:0},
        lastDamage:now,lastPose:now,lastHazard:-1,lastReload:-1,fireTokens:3,fireAt:now,crouching:false,speed:0,
        nickname:info.nickname,team:info.team,deaths:0,respawns:0,respawnAt:null,invulnUntil:0,lastAttacker:null,spawnSlot:null,
        needsSpawn:mode==='coop',yaw:info.pose?.yaw||0,ignorePoseUntil:0 };
      actor.proxy={ pos:actor.pos, eye:actor.eye, vel:actor.vel, get alive(){return actor.health>0&&Date.now()-actor.lastPose<3000;},
        get health(){return actor.health;}, get crouching(){return actor.crouching;}, get speed(){return actor.speed;},
        damage(amount,from){damage(actor,amount,from);} };
      actor.eye.copy(actor.pos).add(new T.Vector3(0,1.68,0)); return actor;
    }
    function roster(players) {
      const ids=new Set(players.map(p=>p.playerId));
      for (const id of actors.keys()) if (!ids.has(id)) actors.delete(id);
      for (const info of players) {
        if (!actors.has(info.playerId)) actors.set(info.playerId,makeActor(info));
        Object.assign(actors.get(info.playerId),{nickname:info.nickname,team:info.team});
        if (info.pose) pose(info.pose);
      }
    }
    function pose(data) {
      const actor=actors.get(data.playerId); if (!actor) return;
      if(Date.now()<actor.ignorePoseUntil)return;
      const now=Date.now(), seconds=Math.max(.025,Math.min(.3,(now-actor.lastPose)/1000));
      const next=new T.Vector3(...data.pos);
      actor.vel.copy(next).sub(actor.pos).multiplyScalar(1/seconds); actor.speed=Math.min(12,Math.hypot(actor.vel.x,actor.vel.z));
      actor.pos.copy(next); actor.crouching=!!data.crouching; actor.eye.copy(next); actor.eye.y+=actor.crouching?1.05:1.68;
      actor.lastPose=now;actor.yaw=data.yaw;
    }
    function localPose() {
      const actor=actors.get(selfId); if (!actor) return;
      actor.pos.copy(player.pos); actor.eye.copy(player.eye); actor.vel.copy(player.vel); actor.speed=player.speed;
      actor.crouching=player.crouching; actor.lastPose=Date.now();actor.yaw=player.yaw;
    }
    function actorState(actor) {
      return { playerId:actor.id,health:rounded(actor.health),alive:actor.health>0,ammo:actor.ammo,reserve:actor.reserve,
        reloading:actor.reloadUntil>Date.now(),ackShot:actor.ackShot,stats:{...actor.stats},deaths:actor.deaths,
        respawnIn:window.LanFlowShared.respawnRemaining(actor,Date.now()),invuln:Date.now()<actor.invulnUntil };
    }
    function applySelf(data,from) {
      if (!data||data.playerId!==selfId) return;
      shared.applyPlayer(data);
      for (const seq of pendingShots) if (seq<=data.ackShot) pendingShots.delete(seq);
      const lost=player.health-data.health;
      if (lost>0 && player.alive) {
        player.invulnerable=false;
        saved.damage.call(player,lost,from||null);
      }
      player.health=data.health; player.alive=data.alive; player.invulnerable=!!data.invuln;
      G.weapon.ammo=Math.max(0,data.ammo-pendingShots.size); G.weapon.reserve=data.reserve;
      Object.assign(G.combat.stats,data.stats);
    }
    function damage(actor,amount,from) {
      if (!isHost()||!fighting()||actor.health<=0||!(amount>0)) return;
      const next=window.LanFlowShared.damageState(actor,amount,Date.now(),shared.options().respawnSec||10);
      if(!next)return;
      const applied=actor.health-next.health;Object.assign(actor,next);actor.lastDamage=Date.now();stats.damage++;
      const source=from ? values(from) : values(actor.pos);
      netEvent({kind:'hurt',playerId:actor.id,health:rounded(actor.health),amount:applied,from:source});
      if (actor.id===selfId) applySelf(actorState(actor),new T.Vector3(...source));
    }
    // Every original AI read sees the same selected actor during this synchronous call.
    // The hash lock and try/finally prevent leaking this temporary context into the frame loop.
    function withActor(actor,fn) {
      const previous=G.player, speed=G.enemies.debug.ctx.playerSpeed;
      G.player=actor?actor.proxy:null; G.enemies.debug.ctx.playerSpeed=actor?.speed||0;
      try { return fn(); } finally { G.player=previous; G.enemies.debug.ctx.playerSpeed=speed; }
    }
    function selectActor(enemy) {
      let nearest=null, score=Infinity;
      for (const actor of actors.values()) {
        if (!actor.proxy.alive) continue;
        const distance=enemy.pos.distanceToSquared(actor.pos);
        const visible=G.physics.lineOfSight(enemy.sensor||enemy.pos,actor.eye);
        const value=distance*(visible?1:4)*(enemy.lanTarget===actor.id ? .85 : 1);
        if (value<score) { nearest=actor;score=value; }
      }
      const forced=actors.get(enemy.lanProvoker);
      if (forced?.proxy.alive && Date.now()<(enemy.lanProvokeUntil||0)) nearest=forced;
      enemy.lanTarget=nearest?.id||null; return nearest;
    }
    function hitActors(origin,dir,range) {
      let selected=null, nearest=range;
      for (const actor of actors.values()) {
        if (!actor.proxy.alive) continue;
        const low=[actor.pos.x,actor.pos.y+.35,actor.pos.z], high=[actor.pos.x,actor.pos.y+(actor.crouching?1:1.5),actor.pos.z];
        const distance=capsuleHit(values(origin),values(dir),low,high,.36,nearest);
        if (distance!==null && distance<=nearest) { nearest=distance; selected=actor; }
      }
      return selected ? {actor:selected,distance:nearest} : null;
    }
    function staticPrediction(origin,dir,range=300) {
      const hit=G.physics.raycast(origin,dir,range);
      return hit ? {point:hit.point,normal:hit.normal,dist:hit.dist,surface:hit.surface,enemy:null} : null;
    }
    saved.damage=replace(player,'damage',original=>function(amount,from) {
      if (!attached) return original.call(this,amount,from);
      const actor=actors.get(selfId);
      if (isHost()&&actor) damage(actor,Math.min(100,amount),from);
      else if (running()&&amount>0) send({type:'hazard',roundId,seq:++hazardSeq,amount:Math.min(100,amount),reason:amount===12?'rescue':'fall'});
    });
    replace(player,'heal',original=>function(amount) { if (!attached) return original.call(this,amount); });
    saved.playerReset=replace(player,'reset',original=>function(...args) { if (!attached||initializing) return original.apply(this,args); });
    replace(player,'update',original=>function(dt) {
      if (!attached) return original.call(this,dt);
      original.call(this,dt);
      const authoritative=isHost()?actors.get(selfId)&&actorState(actors.get(selfId)):latestWorld?.players.find(p=>p.playerId===selfId);
      // Original regeneration writes health directly, so restore authoritative health after update.
      if (authoritative) { player.health=authoritative.health;player.alive=authoritative.alive; }
    });
    replace(G.combat,'playerShot',original=>function(origin,dir,opts) {
      if (!attached) return original.call(this,origin,dir,opts);
      return staticPrediction(origin,dir,Math.min(opts?.range||300,300));
    });
    replace(G.combat,'enemyShot',original=>function(origin,dir,opts={}) {
      if (!attached) return original.call(this,origin,dir,opts);
       if (!isHost()||!fighting()) return false;
      const wall=G.physics.raycast(origin,dir,opts.range||200), hit=hitActors(origin,dir,wall?Math.max(0,wall.dist-.001):opts.range||200);
      if (hit) { damage(hit.actor,opts.damage??6,origin); return true; }
      return false;
    });
    replace(G.combat,'explode',original=>function(pos,radius=5,amount=80,source='player') {
      if (!attached) return original.call(this,pos,radius,amount,source);
      if (!isHost()||!fighting()) return;
      stats.explosions++;
      const credited=currentAttacker||actors.get(currentEnemy?.lanProvoker)||(source==='player'?actors.get(selfId):null);
      for (const enemy of [...G.enemies.list]) {
        if (!enemy.alive) continue;
        const distance=enemy.pos.distanceTo(pos), center=enemy.pos.clone().setY(enemy.pos.y+.5);
        if (distance<radius&&G.physics.lineOfSight(pos,center)) {
          if (credited) enemy.lanProvoker=credited.id;
          if (enemy.damage(amount*(1-distance/radius),enemy.pos,enemy.pos.clone().sub(pos).normalize(),'body')===true&&credited) credited.stats.kills++;
        }
      }
      for (const actor of actors.values()) {
        if (!actor.proxy.alive) continue;
        const center=actor.pos.clone().setY(actor.pos.y+1), distance=center.distanceTo(pos);
        if (distance<radius&&G.physics.lineOfSight(pos,center)) damage(actor,amount*.5*(1-distance/radius),pos);
      }
      const own=actors.get(selfId); if (own) applySelf(actorState(own));
    });
    saved.clear=replace(G.enemies,'clear',original=>function() {
      if (!attached||initializing||isHost()) { projectiles=[]; return original.call(this); }
    });
    replace(G.enemies,'spawn',original=>function(...args) {
      if (attached&&!isHost()) return null;
      const enemy=original.apply(this,args);
      if (enemy) {enemy.lanTarget=null;enemy.lanProvoker=null;enemy.lanProvokeUntil=0;}
      return enemy;
    });
    saved.alert=replace(G.enemies,'alert',original=>function(...args) { if (!attached) return original.apply(this,args); });
    saved.enemyUpdate=replace(G.enemies,'update',original=>function(dt) { if (!attached) return original.call(this,dt); });
    for (const enemy of pools) {
      boneOrders.set(enemy,Object.keys(enemy.rig.bones).sort().map(name=>enemy.rig.bones[name]));
      replace(enemy,'_update',original=>function(dt) {
        if (!attached) return original.call(this,dt);
        if (!isHost()||!fighting()) return;
        const previous=currentEnemy;currentEnemy=enemy;
        try { return withActor(selectActor(enemy),()=>original.call(this,dt)); } finally {currentEnemy=previous;}
      });
    }
    replace(G.enemies.debug.ctx,'fireBolt',original=>function(pos,dir) {
      if (!attached) return original.call(this,pos,dir);
      if (isHost()&&running()&&projectiles.length<32) projectiles.push({id:`b${++boltCounter}`,pos:pos.clone(),dir:dir.clone().normalize(),from:pos.clone(),life:1.3});
    });
    saved.gameStart=replace(G.game,'start',original=>function(...args) {
      if (!attached||initializing) return original.apply(this,args);
      if (isHost()) send({type:'roundReset',roundId}); else warn('只有房主可以重开战斗');
    });
    replace(G.game,'debugCut',original=>function(...args) { if (!attached) return original.apply(this,args);warn('联机中继需在场景内按住交互键切断'); });
    replace(G.game,'update',original=>function(dt) {
      if (!attached) return original.call(this,dt);
      if(coop?.active()&&(coop.terminal()||G.game.state==='dead')){G.game.menus.show('none');return !coop.terminal();}
      // Ending shared combat must not stop the local movement/look frame loop.
      if (G.game.state==='playing') {
        G.game.run.time+=dt;
        if (G.input.pressed('pause')) {G.game.pause();return false;}
        return true; // Single-player objectives/wave/reset logic is not a multiplayer controller.
      }
      return original.call(this,dt);
    });
    function preventReset(event) {
      const button=event.target.closest?.('.menu [data-act]');
      if (attached&&button&&['deploy','restart','retry','redeploy'].includes(button.dataset.act)) {
        event.preventDefault();event.stopImmediatePropagation();warn('联机战斗请由房主在大厅重开');
      }
    }
    window.addEventListener('click',preventReset,true);
    function lockMenus(lock) {
      for (const button of document.querySelectorAll('.menu [data-act]')) {
        if (!['deploy','restart','retry','redeploy'].includes(button.dataset.act)) continue;
        if (lock) {
          if (!changedButtons.has(button)) changedButtons.set(button,{disabled:button.disabled,text:button.textContent});
          button.disabled=true;button.textContent='请由房主在联机大厅重开';
        } else if (changedButtons.has(button)) {
          const old=changedButtons.get(button);button.disabled=old.disabled;button.textContent=old.text;
        }
      }
      if (!lock) changedButtons.clear();
    }
    removers.push(G.events.on('enemy:killed',event=> {
      if (!isHost()||!event?.enemy) return;
      const enemy=event.enemy;
      if (enemy.type==='hound') enemy.rig.group.visible=false;
      netEvent({kind:'enemyDeath',enemyId:`e${enemy.id}`,enemyType:enemy.type});
    }));
    removers.push(G.events.on('enemy:fire',event=> {
      if (isHost()&&event?.enemy&&event.pos&&event.dir) netEvent({kind:'enemyFire',enemyId:`e${event.enemy.id}`,enemyType:event.type,pos:values(event.pos),dir:values(event.dir)});
    }));
    removers.push(G.events.on('explosion',event=> {
      if (!isHost()||replaying||!event?.pos) return;
      saved.alert.call(G.enemies,event.pos,30);
      netEvent({kind:'explosion',pos:values(event.pos),size:Math.max(.4,Math.min(4,event.size||1))});
    }));
    removers.push(G.events.on('weapon:reload',event=> {
      if (attached&&running()&&event?.phase==='start') send({type:'reload',roundId,seq:++reloadSeq});
    }));
    function finishReload(actor,now) {
      if (actor.reloadUntil&&now>=actor.reloadUntil) {
        const loaded=Math.min(30-actor.ammo,actor.reserve);actor.ammo+=loaded;actor.reserve-=loaded;actor.reloadUntil=0;
      }
    }
    function intent(message) {
      if (!isHost()||!fighting()) return;
      localPose();const actor=actors.get(message.playerId); if (!actor) return;
      if(message.type==='interactIntent'){coop.intent(message);return;}
      if(message.type==='respawnIntent'){shared.intent(message);return;}
      finishReload(actor,Date.now());
      if (message.type==='reloadIntent') {
        if (message.seq<=actor.lastReload) return;actor.lastReload=message.seq;
        if (actor.health>0&&!actor.reloadUntil&&actor.ammo<30&&actor.reserve>0) actor.reloadUntil=message.at+(actor.ammo===0?2720:2100);
        return;
      }
      if (message.type==='hazardIntent') {
        if (message.seq<=actor.lastHazard) return;actor.lastHazard=message.seq;
        damage(actor,message.reason==='rescue'?12:Math.min(100,message.amount),actor.pos);return;
      }
      if (message.type!=='shotIntent'||message.seq<=actor.ackShot) return;
      actor.ackShot=message.seq;
      const origin=new T.Vector3(...message.origin),dir=new T.Vector3(...message.dir).normalize();
      const result={kind:'shotResult',playerId:actor.id,shotSeq:message.seq,accepted:false,hit:false,killed:false,enemyId:null,part:null,
        point:values(origin.clone().addScaledVector(dir,300)),normal:values(dir.clone().negate())};
      if (actor.proxy.alive&&!actor.reloadUntil&&actor.ammo>0&&origin.distanceTo(actor.eye)<3&&takeFireToken(actor,message.at)) {
        result.accepted=true;actor.ammo--;actor.stats.shots++;stats.acceptedShots++;
        const wall=G.physics.raycast(origin,dir,300), hit=G.enemies.raycast(origin,dir,wall?wall.dist:300);
        if (wall) {result.point=values(wall.point);result.normal=values(wall.normal);}
        if (hit&&hit.enemy.alive) {
          const enemy=hit.enemy;actor.stats.hits++;result.hit=true;result.enemyId=`e${enemy.id}`;result.part=hit.part;
          result.point=values(hit.point);result.normal=values(hit.normal||dir.clone().negate());
          enemy.lanProvoker=actor.id;enemy.lanProvokeUntil=Date.now()+4000;
          const previous=currentAttacker;currentAttacker=actor;
          try {result.killed=withActor(actor,()=>enemy.damage(26*(hit.part==='weak'?2.2:1),hit.point,dir,hit.part))===true;}
          finally {currentAttacker=previous;}
          if (result.killed) actor.stats.kills++;
        }
        saved.alert.call(G.enemies,origin,45);
      } else stats.rejectedShots++;
      netEvent(result);presentEvent(result);
      const own=actors.get(selfId);if (own) applySelf(actorState(own));
    }
    function clonePuppet(record) {
      const template=(record.kind==='gull'?G.enemies.debug.gulls:G.enemies.debug.hounds)[0], source=template.rig.group, root=source.clone(true);
      const mapping=new Map(), mats=new Map(), skeletons=new Map();
      function pair(a,b) {mapping.set(a,b);for(let j=0;j<a.children.length;j++)pair(a.children[j],b.children[j]);}
      pair(source,root);
      source.traverse(original=> {
        const clone=mapping.get(original);clone.layers.set(0);clone.castShadow=false;clone.receiveShadow=false;
        if (original.material) {
          const copyMaterial=material=>{if(!mats.has(material))mats.set(material,material.clone());return mats.get(material);};
          clone.material=Array.isArray(original.material)?original.material.map(copyMaterial):copyMaterial(original.material);
        }
        if (original.isSkinnedMesh) {
          if (!skeletons.has(original.skeleton)) {
            const bones=original.skeleton.bones.map(bone=>mapping.get(bone));
            if (bones.some(bone=>!bone)) throw new Error('克隆骨架仍引用源树');
            skeletons.set(original.skeleton,new T.Skeleton(bones,original.skeleton.boneInverses.map(matrix=>matrix.clone())));
          }
          clone.bindMode=original.bindMode;clone.bind(skeletons.get(original.skeleton),original.bindMatrix.clone());
        }
      });
      root.name=`LAN ${record.kind} ${record.id}`;root.userData.lanEnemy=record.id;root.visible=true;G.scene.add(root);
      const bones=Object.keys(template.rig.bones).sort().map(name=>mapping.get(template.rig.bones[name]));
      return {root,bones,mats,skeletons,lens:mats.get(template.lens),samples:[],qa:new T.Quaternion(),qb:new T.Quaternion(),va:new T.Vector3(),vb:new T.Vector3()};
    }
    function removePuppet(id) {
      const puppet=puppets.get(id);if(!puppet)return;
      puppet.root.removeFromParent();for(const material of puppet.mats.values())material.dispose();
      for(const skeleton of puppet.skeletons.values())skeleton.dispose();
      puppets.delete(id);stats.disposed++;
    }
    function clearPuppets() {for(const id of [...puppets.keys()])removePuppet(id);}
    function world(message) {
      if (!attached||isHost()||message.seq<=lastWorldSeq)return;
      lastWorldSeq=message.seq;latestWorld=message;stats.worldsReceived++;
      const observed=performance.now()-message.at;offset=offset===null?observed:Math.min(offset+.1,observed);
      const seen=new Set();
      for(const record of message.enemies) {
        seen.add(record.id);
        if(!puppets.has(record.id))puppets.set(record.id,clonePuppet(record));
        const puppet=puppets.get(record.id);
        puppet.samples.push({...record,at:message.at,decoded:unpackBones(record.bones,boneCounts[record.kind])});
        if(puppet.samples.length>6)puppet.samples.shift();
        if(puppet.lens)puppet.lens.color.setRGB(...record.lens);
      }
      for(const id of [...puppets.keys()])if(!seen.has(id))removePuppet(id);
      for(const data of message.players)applySelf(data);
      if(message.flow)coop.apply(message.flow);
      warn(`已同步 ${message.enemies.filter(e=>e.alive).length} 个敌人 · 生命 ${Math.ceil(player.health)}`);
    }
    function presentEvent(event) {
      shared.present(event);coop.present(event);
      if(event.kind==='shotResult') {
        if(event.hit) {
          G.fx.sparks(new T.Vector3(...event.point),new T.Vector3(...event.normal),event.killed?12:5);
          G.audio.play('impact_enemy',{pos:new T.Vector3(...event.point),gain:.75});
          if(event.playerId===selfId)G.hud.hitmarker(event.killed?'kill':event.part==='weak'?'weak':'hit');
        }
      } else if(event.kind==='enemyDeath') {
        if(event.enemyType==='hound')removePuppet(event.enemyId);
      } else if(event.kind==='hurt') {
        if(event.playerId===selfId&&!isHost()) {
          const old=latestWorld?.players.find(p=>p.playerId===selfId);
          if(old) {old.health=event.health;old.alive=event.health>0;applySelf(old,new T.Vector3(...event.from));}
        }
      } else if(event.kind==='enemyFire') {
        const origin=new T.Vector3(...event.pos), dir=new T.Vector3(...event.dir).normalize();
        if(origin.distanceToSquared(G.camera.position)>10000)return;
        G.fx.muzzleFlash(origin,dir,{scale:.8});
        if(event.enemyType==='hound') {
          const hit=G.physics.raycast(origin,dir,200);G.fx.tracer(origin,origin.clone().addScaledVector(dir,hit?hit.dist:90),{trail:false});
        }
        G.audio.play(event.enemyType==='hound'?'hound_fire':'gull_fire',{pos:origin,gain:.8});
      } else if(event.kind==='explosion'&&!isHost()) {
        replaying=true;try{G.fx.explosion(new T.Vector3(...event.pos),event.size);stats.remoteExplosions++;}finally{replaying=false;}
      }
    }
    function event(message) {if(message.seq<=lastEventSeq)return;lastEventSeq=message.seq;presentEvent(message.event);}
    function updateBolts(dt) {
      const remaining=[];
      for(const bolt of projectiles) {
        bolt.life-=dt;if(bolt.life<=0)continue;
        const distance=G.enemies.TUNE.gull.boltSpeed*dt, wall=G.physics.raycast(bolt.pos,bolt.dir,distance);
        const hit=hitActors(bolt.pos,bolt.dir,wall?Math.max(0,wall.dist-.001):distance);
        if(hit) {damage(hit.actor,G.enemies.TUNE.gull.boltDamage,bolt.from);stats.boltHits++;continue;}
        if(wall)continue;
        bolt.pos.addScaledVector(bolt.dir,distance);remaining.push(bolt);
      }
      projectiles=remaining;
    }
    function captureWorld() {
      const enemies=[];
      for(const enemy of G.enemies.list) {
        if(!enemy.active||!enemy.rig.group.visible)continue;
        enemies.push({id:`e${enemy.id}`,kind:enemy.type,pos:values(enemy.pos).map(rounded),quat:qvalues(enemy.rig.group.quaternion).map(rounded),
          hp:Math.max(0,rounded(enemy.hp)),alive:enemy.alive,bones:packBones(boneOrders.get(enemy)),
          lens:[enemy.lens.color.r,enemy.lens.color.g,enemy.lens.color.b].map(rounded),targetId:enemy.lanTarget||null});
      }
      return {type:'world',roundId,seq:++worldSeq,enemies,players:[...actors.values()].map(actorState),
        bolts:projectiles.map(b=>({id:b.id,pos:values(b.pos).map(rounded),dir:values(b.dir).map(rounded)})),
        ...(coop.active()?{flow:coop.snapshot()}:{})};
    }
    function tick() {
      const now=performance.now(),elapsed=Math.min(.1,Math.max(0,(now-lastTick)/1000));lastTick=now;
      if(!attached)return;
       G.weapon.debug.noFire=!fighting()||state!=='active';
      if(!isHost()||!running())return;
      localPose();accumulator+=elapsed;
      while(accumulator>=1/30) {
        if(!coop.terminal()){shared.tick();coop.tick(1/30);}
        accumulator-=1/30;
        if(!fighting())continue;
        saved.enemyUpdate.call(G.enemies,1/30);updateBolts(1/30);stats.simulations++;
        for(const actor of actors.values()) {
          finishReload(actor,Date.now());
          if(actor.health>0&&Date.now()-actor.lastDamage>G.player.tuning.regenDelay*1000)actor.health=Math.min(100,actor.health+G.player.tuning.regenRate/30);
        }
      }
      if(G.player!==player) {stats.identityLeaks++;G.player=player;throw new Error('AI上下文未恢复');}
      if(now-snapshotAt>=100) {
        snapshotAt=now;const data=captureWorld();latestWorld={...data,at:Date.now()};send(data);stats.worldsSent++;
        const own=actors.get(selfId);if(own)applySelf(actorState(own));
        warn(`房主：统一模拟 ${data.enemies.filter(e=>e.alive).length} 个敌人 · 生命 ${Math.ceil(player.health)}`);
      }
    }
    function emit(event){netEvent(event);presentEvent(event);}
    function resetSelf(event) {
      const wasDead=!player.alive||G.game.state==='dead';
      initializing=true;
      try{saved.playerReset.call(player,{pos:new T.Vector3(...event.pos),yaw:event.yaw});G.weapon.reset();}
      finally{initializing=false;}
      player.ads=0;player.enabled=true;
      pendingShots.clear();
      const old=latestWorld?.players.find(p=>p.playerId===selfId);
      if(old)Object.assign(old,{health:100,alive:true,ammo:30,reserve:150,reloading:false,respawnIn:null,invuln:true});
      if(wasDead) {
        if(G.render.post){G.render.post.fade=0;G.render.post.saturation=saturation;}
        G.game.state='paused';G.game.resume();
      }
      if(coop.active())coop.apply(coop.snapshot());
    }
    const flowContext={G,actors,emit,resetSelf,send:message=>send({...message,roundId}),self:()=>selfId,isHost,
      states:()=>isHost()?[...actors.values()].map(actorState):latestWorld?.players||[],
      aliveEnemies:()=>G.enemies.list.filter(e=>e.active&&e.alive),alert:(pos,radius)=>saved.alert.call(G.enemies,pos,radius)};
    shared=window.LanFlowShared.create(flowContext);
    coop=window.LanFlowCoop.create({...flowContext,shared});
    const timer=setInterval(tick,1000/30);
    function render(now) {
      if(!attached)return;
      coop.render(now);
      shared.render(coop.snapshot());
      const target=now-(offset||0)-100;
      for(const puppet of puppets.values()) {
        let left=puppet.samples[0],right=left;
        for(const sample of puppet.samples) {if(sample.at<=target)left=sample;right=sample;if(sample.at>=target)break;}
        if(!left)continue;
        const alpha=right.at>left.at?Math.max(0,Math.min(1,(target-left.at)/(right.at-left.at))):0;
        puppet.root.position.fromArray(left.pos).lerp(puppet.va.fromArray(right.pos),alpha);
        puppet.root.quaternion.fromArray(left.quat).normalize().slerp(puppet.qa.fromArray(right.quat).normalize(),alpha);
        for(let j=0;j<puppet.bones.length;j++) {
          const bone=puppet.bones[j],k=j*10;
          bone.position.fromArray(left.decoded,k).lerp(puppet.va.fromArray(right.decoded,k),alpha);
          bone.quaternion.fromArray(left.decoded,k+3).normalize().slerp(puppet.qa.fromArray(right.decoded,k+3).normalize(),alpha);
          bone.scale.fromArray(left.decoded,k+7).lerp(puppet.va.fromArray(right.decoded,k+7),alpha);
        }
        puppet.root.updateMatrixWorld(true);
      }
      const bolts=isHost()?projectiles:latestWorld?.bolts||[];
      for(let j=0;j<boltMeshes.length;j++) {
        const mesh=boltMeshes[j],bolt=bolts[j];mesh.visible=!!bolt&&state!=='ended';
        if(bolt) {if(isHost()){mesh.position.copy(bolt.pos);temp.copy(bolt.dir);}else{mesh.position.fromArray(bolt.pos);temp.fromArray(bolt.dir);}mesh.quaternion.setFromUnitVectors(zAxis,temp.normalize());}
      }
    }
    function initialize(data) {
      attached=true;selfId=data.playerId||selfId;hostId=data.hostId;roundId=data.roundId;state=data.combatStatus||'waiting';mapOk=false;mode=data.mode||mode;
      actors.clear();roster(data.players);clearPuppets();pendingShots.clear();projectiles=[];latestWorld=null;
      worldSeq=eventSeq=reloadSeq=hazardSeq=0;lastWorldSeq=lastEventSeq=-1;offset=null;snapshotAt=0;accumulator=0;lastTick=performance.now();
      initializing=true;
      try {
        saved.clear.call(G.enemies);saved.gameStart.call(G.game,{skipIntro:true});
        if (state==='ended') saved.clear.call(G.enemies);
      }
      finally {initializing=false;}
      shared.initialize({...data,mode});coop.initialize({...data,mode});
      lockMenus(true);G.weapon.debug.noFire=true;
      if(!coop.active()){G.hud.setObjective('联机战斗：消灭港区机械守卫');G.hud.setMarkers([]);}
      warn(state==='ended'?'本轮已结束，仍可移动；房主按 F2 重开战斗':isHost()?'房主：等待地图校验':'等待房主同步敌人');
    }
    function detach(resume=true) {
      if(!attached)return;
      attached=false;mapOk=false;clearPuppets();projectiles=[];actors.clear();pendingShots.clear();latestWorld=null;
      shared.detach();coop.detach();
      for(const mesh of boltMeshes)mesh.visible=false;
      G.weapon.debug.noFire=false;lockMenus(false);saved.clear.call(G.enemies);
      if(resume)saved.gameStart.call(G.game,{skipIntro:true});
    }
    return { initialize,detach,roster,pose,render,intent,world,event,
      noteShot(seq){pendingShots.add(seq);},
      setMap(ok){mapOk=ok;},
      status(data){hostId=data.hostId;state=data.status;if(state==='ended'){clearPuppets();projectiles=[];latestWorld=null;saved.clear.call(G.enemies);}if(data.reason)warn(data.reason);},
      snapshot(){return {attached,isHost:isHost(),state,roundId,sourceActive:G.enemies.list.filter(e=>e.active&&e.alive).length,puppetCount:puppets.size,
        enemies:(isHost()?G.enemies.list.filter(e=>e.active&&e.rig.group.visible).map(e=>({id:`e${e.id}`,kind:e.type,hp:e.hp,alive:e.alive,pos:values(e.pos),targetId:e.lanTarget||null})):latestWorld?.enemies.map(e=>({id:e.id,kind:e.kind,hp:e.hp,alive:e.alive,pos:e.pos,targetId:e.targetId}))||[]),
        players:latestWorld?.players.map(p=>({...p,stats:{...p.stats}}))||[],flow:coop.snapshot(),spawn:shared.snapshot(),stats:{...stats},worldSeq:isHost()?worldSeq:lastWorldSeq,
        independentSkeletons:[...puppets.values()].every(p=>[...p.skeletons.values()].every(s=>s.bones.every(b=>p.bones.includes(b))))};},
      destroy(){detach(false);shared.destroy();coop.destroy();clearInterval(timer);window.removeEventListener('click',preventReset,true);for(const remove of removers.reverse())remove();projectileRoot.removeFromParent();boltGeometry.dispose();boltMaterial.dispose();}
    };
  }
  window.LanCombat=Object.freeze({create});
})();
