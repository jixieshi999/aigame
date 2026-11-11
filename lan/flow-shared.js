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
  const canRespawn=(actor,now)=>!!actor&&actor.health<=0&&actor.respawnAt!==null&&now>=actor.respawnAt;
  function damageState(actor,amount,now,respawnSec=RULES.respawnSec) {
    if(actor.health<=0||now<actor.invulnUntil||!(amount>0))return null;
    const health=Math.max(0,actor.health-Math.min(100,amount));
    return {health,deaths:actor.deaths+(health<=0?1:0),respawnAt:health<=0?now+respawnSec*1000:null};
  }
  const api={RULES,distance,clearPoint,spawnCandidates,buildSpawnPools,chooseSpawn,nearbySpawns,respawnRemaining,allDown,canRespawn,damageState};
  if(typeof window==='undefined'){module.exports=api;return;}

  function create(ctx) {
    const {G,actors,emit,resetSelf}=ctx,T=G.THREE;
    let enabled=false,pools=null,used=[],options={},local=null,respawnSeq=0,resultKey='';
    function element(tag,text,parent){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(parent)parent.appendChild(el);return el;}
    const style=element('style',undefined,document.head);
    style.textContent='#lan-life,#lan-result{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2147482990;background:#06111cb0;color:#edf5ff;font:16px/1.6 "Microsoft YaHei",sans-serif}#lan-life[hidden],#lan-result[hidden]{display:none!important}.lan-flow-card{padding:24px;max-width:90vw;max-height:80vh;overflow:auto;background:#101f30f2;border:1px solid #55718d;border-radius:12px;text-align:center}.lan-flow-card button{padding:10px 20px;color:#fff;background:#24597b;border:1px solid #82b4cd;border-radius:6px;cursor:pointer}.lan-flow-card button:disabled{opacity:.5}.lan-flow-card table{border-collapse:collapse;margin:12px auto}.lan-flow-card th,.lan-flow-card td{padding:4px 12px;border-bottom:1px solid #526475}';
    const life=element('section',undefined,document.body);life.id='lan-life';life.hidden=true;
    const card=element('div',undefined,life);card.className='lan-flow-card';
    const lifeText=element('p','已倒下',card);lifeText.id='lan-life-text';
    const reviveButton=element('button','点击或按 Enter 复活',card);reviveButton.id='lan-respawn';
    function hideLobby(){const panel=document.getElementById('lan-panel');if(panel)panel.hidden=true;}
    function requestRespawn(){
      if(life.hidden||reviveButton.disabled)return;
      // Request synchronously inside the user gesture, before the host round trip.
      G.input.requestLock();reviveButton.disabled=true;ctx.send({type:'respawn',seq:++respawnSeq});
    }
    reviveButton.addEventListener('click',requestRespawn);
    function key(event){if(event.code==='Enter'&&!event.repeat&&!life.hidden){event.preventDefault();requestRespawn();}}
    window.addEventListener('keydown',key);
    const result=element('section',undefined,document.body);result.id='lan-result';result.hidden=true;
    const resultCard=element('div',undefined,result);resultCard.className='lan-flow-card';
    function renderResult(flow){
      const terminal=flow&&['complete','failed'].includes(flow.phase);
      result.hidden=!terminal;if(!terminal){resultKey='';return;}
      if(!resultKey){hideLobby();G.player.enabled=false;G.input.setGameplay(false);G.input.exitLock();G.hud.show(false);G.hud.setPrompt(null);}
      G.game.menus.show('none');
      const rows=ctx.states(),key=JSON.stringify([flow.phase,flow.result,ctx.isHost(),rows.map(p=>[p.playerId,actors.get(p.playerId)?.nickname,p.stats,p.deaths])]);
      if(key===resultKey)return;resultKey=key;resultCard.replaceChildren();
      element('h2',flow.phase==='complete'?'合作撤离成功':'全员倒下 · 任务失败',resultCard);
      const r=flow.result;if(r){element('p',`用时 ${r.time.toFixed(1)} 秒 · 已切断 ${flow.cut}/${flow.total}`,resultCard);
        element('p',`全队命中率 ${r.accuracy===null?'—':(r.accuracy*100).toFixed(1)+'%'} · 击毁 ${r.kills} · 复活 ${r.respawns}`,resultCard);
        element('p',['险象环生','火力全开','稳扎稳打','干净利落','精准果断','完美突击'][r.rating],resultCard);}
      const table=element('table',undefined,resultCard),head=element('tr',undefined,element('thead',undefined,table));
      for(const title of ['队员','击杀','命中率','死亡'])element('th',title,head);
      const body=element('tbody',undefined,table);
      for(const p of rows){const row=element('tr',undefined,body),actor=actors.get(p.playerId);
        for(const value of [actor?.nickname||'队员',p.stats.kills,p.stats.shots?(p.stats.hits/p.stats.shots*100).toFixed(1)+'%':'—',p.deaths])element('td',String(value),row);}
      if(ctx.isHost()){const restart=element('button','房主重开战斗',resultCard);restart.id='lan-result-reset';restart.onclick=()=>ctx.send({type:'roundReset'});}
      else element('p','等待房主重开战斗',resultCard);
    }
    const visible=(a,b)=>G.physics.lineOfSight(new T.Vector3(...a).add(new T.Vector3(0,1.4,0)),new T.Vector3(...b).add(new T.Vector3(0,1.4,0)));
    const walkable=(x,z)=>G.physics.nav.isWalkable(x,z);
    function place(actor,revive=false) {
      if(!enabled)return;
      const now=Date.now(),others=[...actors.values()].filter(a=>a.id!==actor.id);
      const npcs=G.enemies.list.filter(e=>e.active&&e.alive);
      let points=pools.coop;
      if(revive) {
        const near=nearbySpawns(others,walkable).filter(p=>others.every(a=>a.health<=0||distance(p,array(a.pos))>=RULES.overlap)&&npcs.every(e=>distance(p,array(e.pos))>=15&&!visible(p,array(e.pos))));
        if(near.length)points=near;
      }
      const pos=chooseSpawn(points,others,npcs,used,now,visible);
      used=used.filter(item=>now-item.at<10000);used.push({pos,at:now});
      actor.pos.fromArray(pos);actor.eye.copy(actor.pos).add(new T.Vector3(0,1.68,0));actor.vel.set(0,0,0);
      actor.health=100;actor.ammo=30;actor.reserve=150;actor.reloadUntil=0;actor.respawnAt=null;
      actor.invulnUntil=now+RULES.invulnSec*1000;actor.lastDamage=now;actor.spawnSlot=pools.coop.findIndex(p=>distance(p,pos)<.1);
      actor.needsSpawn=false;actor.ignorePoseUntil=now+500;actor.lastPose=now;actor.yaw=-Math.PI/2;
      if(revive)actor.respawns++;
      emit({kind:'respawn',playerId:actor.id,pos,yaw:actor.yaw,invulnSec:RULES.invulnSec});
    }
    return {
      initialize(data){enabled=data.mode==='coop';options=data.options||{};used=[];local=null;life.hidden=result.hidden=true;resultKey='';respawnSeq=0;if(enabled&&!pools)pools=buildSpawnPools(walkable,visible);},
      place,
      tick(){if(enabled)for(const actor of actors.values())if(actor.needsSpawn)place(actor);},
      applyPlayer(data){if(enabled&&data.playerId===ctx.self())local={...data};},
      intent(message){if(enabled&&message.type==='respawnIntent'){const actor=actors.get(message.playerId);if(canRespawn(actor,Date.now()))place(actor,true);}},
      present(event){if(enabled&&event.kind==='respawn'&&event.playerId===ctx.self()){
        life.hidden=true;local=null;resetSelf(event);
      }},
      render(flow){
        if(!enabled){life.hidden=result.hidden=true;return;}
        const terminal=flow&&['complete','failed'].includes(flow.phase);renderResult(flow);
        const dead=local&&!local.alive&&!terminal;
        if(dead&&life.hidden)hideLobby();
        life.hidden=!dead;
        if(dead){G.game.menus.show('none');const remaining=local.respawnIn??0;
          lifeText.textContent=remaining>0?`已倒下 · ${Math.ceil(remaining)} 秒后可复活`:'已倒下 · 等待复活';
          reviveButton.disabled=remaining>0;
        }
      },
      options:()=>options,
      snapshot:()=>({enabled,pools:pools&&JSON.parse(JSON.stringify(pools))}),
      detach(){enabled=false;used=[];local=null;life.hidden=result.hidden=true;},
      destroy(){window.removeEventListener('keydown',key);style.remove();life.remove();result.remove();}
    };
  }
  window.LanFlowShared=Object.freeze({...api,create});
})();
