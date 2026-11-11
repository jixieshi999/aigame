/* Host-owned cooperative controller; original single-player flow stays disabled. */
(function () {
  'use strict';
  const shortName=(id,index)=>(/([a-z0-9])$/i.exec(id)||[0,String.fromCharCode(65+index)])[1].toUpperCase();
  function createFlow(objectives) {
    return {kind:'coop',phase:'active',time:0,relays:objectives.map((o,i)=>({id:o.id,cut:false,t:0,cutters:0})),
      cut:0,total:objectives.length,wave:0,waveHot:0,allCut:false,pursuitLeft:0,
      extraction:{open:false,inZone:0,needed:0,hold:0},result:null};
  }
  const objectiveText=flow=>flow.allCut?'前往撤离艇':flow.cut===0?'切断三处上行中继':flow.total-flow.cut===1?'切断最后一处中继':`切断剩余 ${flow.total-flow.cut} 处中继`;
  const array=p=>Array.isArray(p)?p:[p.x,p.y,p.z];
  function validInteraction(actor,objective,relay) {
    if(!actor||actor.health<=0||relay.cut)return false;
    const a=array(actor.pos),b=array(objective.pos),dx=b[0]-a[0],dz=b[2]-a[2],d=Math.hypot(dx,dz);
    return d<=2.2&&Math.abs(a[1]-b[1])<=2.5&&(d<=.9||(-dx*Math.sin(actor.yaw)-dz*Math.cos(actor.yaw))/d>=.45);
  }
  function advanceRelay(relay,cutters,dt) {
    if(relay.cut)return {...relay,cutters:0};
    const t=Math.max(0,Math.min(1,relay.t+dt*(cutters?Math.min(2.5,1+.5*(cutters-1))/2.4:-1.6)));
    return {...relay,t,cut:t>=1,cutters:t>=1?0:cutters};
  }
  function commitRelay(flow,id) {
    const relay=flow.relays.find(r=>r.id===id);
    if(!relay||!relay.cut||flow.cut>=flow.relays.filter(r=>r.cut).length)return false;
    flow.cut++;flow.allCut=flow.cut===flow.total;flow.extraction.open=flow.allCut;
    if(flow.allCut)flow.phase='extract';
    return true;
  }
  const RADIO=Object.freeze({
    intro:'几猫队员，这里是指挥中心。港区主控已封锁泊位。切断堆场、仓库、码头的三处中继。',
    contact:'你已被发现！空中有机械飞鸥，地面有机械猎犬。消灭它们。',
    cut1:'第一处中继已断开。敌方已察觉，机械守卫正在赶来。',
    cut2:'第二处中继已断开。敌方正全力围攻，小心应对。',
    all:'三处中继全部断开！撤离艇在码头南端的舷梯旁，快撤！',
    low:'伤势严重！找掩体躲避，稍作恢复。',done:'几猫队员已登船，港区封锁解除。干得漂亮！'
  });
  const RULES=Object.freeze({patrol:{gull:2,hound:1},waves:[{gull:3,hound:1},{gull:3,hound:2},{gull:4,hound:3}],stagger:.85,
    firstSpawn:1.6,spawnFar:18,pursuitEvery:7,pursuitMinAlive:4,pursuitExtra:5});
  const multiplier=n=>Math.min(3,1+.5*(Math.max(1,n)-1));
  const maxAlive=n=>Math.min(18,9+2*(Math.max(1,n)-1));
  const scaled=(counts,n)=>({gull:Math.min(10,Math.ceil(counts.gull*multiplier(n))),hound:Math.min(8,Math.ceil(counts.hound*multiplier(n)))});
  function waveQueue(counts,time) {
    const types=Array(counts.gull).fill('gull');
    for(let i=0;i<counts.hound;i++)types.splice(Math.min(types.length,1+i*2),0,'hound');
    return types.map((type,i)=>({type,at:time+RULES.firstSpawn+i*RULES.stagger,tries:0}));
  }
  function dueSpawn(queue,time,alive,limit) {
    const index=queue.findIndex(item=>item.at<=time);
    return index<0?null:{index,blocked:alive>=limit};
  }
  function queueAttempt(queue,index,success,time,blocked=false) {
    return queue.flatMap((item,i)=>i!==index?[{...item}]:blocked?[{...item,at:time+1}]:success||item.tries+1>=6?[]:[{...item,tries:item.tries+1,at:time+1.5}]);
  }
  function pursuitStep(timer,left,dt,queueLength,alive) {
    timer-=dt;
    if(timer>0)return {timer,left,add:false,alert:false};
    if(left>0&&!queueLength&&alive<RULES.pursuitMinAlive)return {timer:RULES.pursuitEvery,left:left-1,add:true,alert:true};
    return {timer:4,left,add:false,alert:true};
  }
  function spawnScore(point,players,visible,recent,time,minDist=RULES.spawnFar,jitter=0) {
    const live=players.filter(a=>a.health>0),p=array(point);
    const distance=live.length?Math.min(...live.map(a=>Math.hypot(p[0]-array(a.pos)[0],p[2]-array(a.pos)[2]))):100;
    return jitter+(distance>=minDist?2+Math.min(1,(distance-minDist)/30)*.5:-(minDist-distance)/4)+
      (live.every(a=>!visible(p,array(a.pos)))?2.5:0)+(recent!==undefined&&time-recent<6?-3:0);
  }
  function summarize(time,actors) {
    const totals=actors.reduce((s,a)=>({shots:s.shots+a.stats.shots,hits:s.hits+a.stats.hits,kills:s.kills+a.stats.kills,respawns:s.respawns+(a.respawns||0)}),{shots:0,hits:0,kills:0,respawns:0});
    const accuracy=totals.shots?Math.min(1,totals.hits/totals.shots):null;
    const rating=(time<270?2:time<400?1:0)+(accuracy>=.5?2:accuracy>=.3?1:0)+(totals.respawns===0?1:0);
    return {time,...totals,accuracy,rating};
  }
  const api={createFlow,shortName,objectiveText,validInteraction,advanceRelay,commitRelay,RULES,multiplier,maxAlive,scaled,waveQueue,dueSpawn,queueAttempt,pursuitStep,spawnScore,summarize};
  if(typeof window==='undefined'){module.exports=api;return;}
  function create(ctx) {
    const {G}=ctx;
    let enabled=false,state=null,seq=0,holding=null,lastHeartbeat=0,queue=[],pursuitT=12,patrolPending=false,contactSaid=false;
    const holds=new Map();
    const used=new Map(),T=G.THREE;
    const livePlayers=()=>[...ctx.actors.values()].filter(a=>a.health>0);
    function selectSpawn(type,minDist=RULES.spawnFar) {
      const candidates=G.level.enemySpawns.filter(p=>p.type===(type==='gull'?'air':'ground'));
      let chosen=null,score=-Infinity;
      const visible=(p,a)=>G.physics.lineOfSight(new T.Vector3(...p).add(new T.Vector3(0,type==='gull'?0:1,0)),new T.Vector3(...a).add(new T.Vector3(0,1.4,0)));
      for(const candidate of candidates){const value=spawnScore(candidate.pos,livePlayers(),visible,used.get(candidate),state.time,minDist,G.rng()*1.5);if(value>score){score=value;chosen=candidate;}}
      if(!chosen)return null;
      used.set(chosen,state.time);const point=chosen.pos.clone(),dx=(G.rng()-.5)*2.4,dz=(G.rng()-.5)*2.4;
      if(type==='gull'||G.physics.nav.isWalkable(point.x+dx,point.z+dz)){point.x+=dx;point.z+=dz;}
      if(type==='gull'&&point.y<2.5)point.y=6+G.rng()*3;
      return point;
    }
    function spawn(type,pos,patrol=false) {
      if(!pos||ctx.aliveEnemies().length>=maxAlive(ctx.actors.size))return null;
      return G.enemies.spawn(type,pos,{state:patrol?'patrol':'alert',target:livePlayers()[0]?.pos||G.player.pos});
    }
    function startWave() {
      const items=waveQueue(scaled(RULES.waves[Math.min(state.cut-1,2)],ctx.actors.size),state.time);
      let center=new T.Vector3(),count=0;
      for(const item of items){const pos=selectSpawn(item.type);if(pos){item.pos=array(pos);center.add(pos);count++;}queue.push(item);}
      state.wave++;state.waveHot=30;
      if(count)ctx.emit({kind:'waveWarning',centroid:array(center.multiplyScalar(1/count))});
      if(state.allCut){state.pursuitLeft=Math.ceil(RULES.pursuitExtra*multiplier(ctx.actors.size));pursuitT=12;}
    }
    function enemiesTick(dt) {
      if(patrolPending){patrolPending=false;const counts=scaled(RULES.patrol,ctx.actors.size);
        for(const type of ['gull','hound'])for(let i=0;i<counts[type];i++)spawn(type,selectSpawn(type,32),true);
        ctx.emit({kind:'radio',key:'intro'});
      }
      const alive=ctx.aliveEnemies().length,due=dueSpawn(queue,state.time,alive,maxAlive(ctx.actors.size));
      if(due){const item=queue[due.index],pos=item.pos?new T.Vector3(...item.pos):selectSpawn(item.type);
        const enemy=!due.blocked&&spawn(item.type,pos);queue=queueAttempt(queue,due.index,!!enemy,state.time,due.blocked);
        if(enemy)for(const actor of livePlayers())ctx.alert(actor.pos,60);
      }
      if(state.allCut){const next=pursuitStep(pursuitT,state.pursuitLeft,dt,queue.length,alive);pursuitT=next.timer;state.pursuitLeft=next.left;
        if(next.add)queue.push({type:G.rng()<.6?'gull':'hound',at:state.time+.5,tries:0});
        if(next.alert)for(const actor of livePlayers())ctx.alert(actor.pos,90);
      }
      state.waveHot=Math.max(0,state.waveHot-dt);
      if(!contactSaid&&ctx.aliveEnemies().some(e=>['alert','attack','chase'].includes(e.state))){contactSaid=true;ctx.emit({kind:'radio',key:'contact'});}
    }
    function apply(flow) {
      if(!enabled||!flow||flow.kind!=='coop')return;
      state=JSON.parse(JSON.stringify(flow));
      for(const relay of state.relays) {
        const objective=G.level.objectives.find(o=>o.id===relay.id);
        objective?.object?.userData?.setState?.(relay.cut?'cut':relay.cutters?'cutting':'live');
      }
      G.hud.setRelays(state.cut,state.total);G.hud.setObjective(objectiveText(state));
      const markers=state.relays.filter(r=>!r.cut).map((r,i)=>({id:r.id,short:shortName(r.id,i),label:G.level.objectives.find(o=>o.id===r.id)?.label||'中继',pos:G.level.objectives.find(o=>o.id===r.id).pos,kind:'relay'}));
      if(state.allCut)markers.push({id:'extract',short:'撤离',label:'撤离艇',pos:G.level.extraction.pos,kind:'extract'});
      G.hud.setMarkers(markers);
    }
    function finish(phase) {
      state.phase=phase;state.result=summarize(state.time,[...ctx.actors.values()]);queue=[];holds.clear();
      state.relays.forEach(r=>r.cutters=0);
      ctx.emit({kind:'phase',phase});ctx.emit({kind:'roundEnd',result:phase,winnerTeam:null});
    }
    return {
      initialize(data){enabled=data.mode==='coop';state=enabled?createFlow(G.level.objectives):null;seq=0;holding=null;holds.clear();used.clear();queue=[];pursuitT=12;contactSaid=false;
        patrolPending=enabled&&ctx.isHost();if(enabled){G.enemies.clear();apply(state);}},
      tick(dt){
        if(!enabled||!ctx.isHost()||['complete','failed'].includes(state.phase))return;
        state.time+=dt;
        if(window.LanFlowShared.allDown([...ctx.actors.values()])){finish('failed');apply(state);return;}
        for(let i=0;i<state.relays.length;i++) {
          const relay=state.relays[i];if(relay.cut)continue;
          const objective=G.level.objectives.find(o=>o.id===relay.id);
          const cutters=[...holds.entries()].filter(([id,h])=>h.objectiveId===relay.id&&Date.now()-h.at<=400&&validInteraction(ctx.actors.get(id),objective,relay)).length;
          state.relays[i]=advanceRelay(relay,cutters,dt);
          if(state.relays[i].cut&&commitRelay(state,relay.id)) {
            ctx.emit({kind:'objectiveDone',objectiveId:relay.id,index:state.cut,total:state.total});
            ctx.emit({kind:'radio',key:state.allCut?'all':state.cut===1?'cut1':'cut2'});
            startWave();
            if(state.allCut)ctx.emit({kind:'phase',phase:'extract'});
          }
        }
        enemiesTick(dt);
        apply(state);
      },apply,
      snapshot:()=>state&&JSON.parse(JSON.stringify(state)),
      active:()=>enabled,terminal:()=>enabled&&['complete','failed'].includes(state.phase),
      intent(message){
        if(!enabled||message.type!=='interactIntent')return;
        if(message.active)holds.set(message.playerId,{objectiveId:message.objectiveId,at:Date.now()});else holds.delete(message.playerId);
      },
      present(event){if(!enabled)return;if(event.kind==='radio'&&RADIO[event.key])G.hud.radio(RADIO[event.key],event.key==='all'?4.5:3.6);
        if(event.kind==='waveWarning'){const d=event.centroid,dx=d[0]-G.player.pos.x,dz=d[2]-G.player.pos.z;
          const bearing=(Math.atan2(dx,-dz)*180/Math.PI+360)%360;
          G.hud.warn('发现敌情 · '+['北方','东北方','东方','东南方','南方','西南方','西方','西北方'][Math.round(bearing/45)%8],3.4);}},
      render(now){
        if(!enabled||!state)return;
        const actor={health:G.player.alive?G.player.health:0,pos:G.player.pos,yaw:G.player.yaw};
        const choices=G.game.state==='playing'?state.relays.filter(r=>validInteraction(actor,G.level.objectives.find(o=>o.id===r.id),r)):[];
        choices.sort((a,b)=>G.level.objectives.find(o=>o.id===a.id).pos.distanceToSquared(G.player.pos)-G.level.objectives.find(o=>o.id===b.id).pos.distanceToSquared(G.player.pos));
        const relay=choices[0],next=relay&&G.input.down('interact')?relay.id:null;
        if(holding&&holding!==next)ctx.send({type:'interact',seq:++seq,objectiveId:holding,active:false});
        if(next&&(next!==holding||now-lastHeartbeat>=200)){ctx.send({type:'interact',seq:++seq,objectiveId:next,active:true});lastHeartbeat=now;}
        holding=next;
        G.hud.setPrompt(relay?`切断中继 ${shortName(relay.id,state.relays.indexOf(relay))}${relay.cutters>1?` · ${relay.cutters}人协作`:''}`:null,relay?.t||0);
      },
      detach(){enabled=false;state=null;holds.clear();holding=null;G.hud.setPrompt(null);},destroy(){}
    };
  }
  window.LanFlowCoop=Object.freeze({...api,create});
})();
