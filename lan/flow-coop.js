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
  const api={createFlow,shortName,objectiveText,validInteraction,advanceRelay,commitRelay};
  if(typeof window==='undefined'){module.exports=api;return;}
  function create(ctx) {
    const {G}=ctx;
    let enabled=false,state=null,seq=0,holding=null,lastHeartbeat=0;
    const holds=new Map();
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
    return {
      initialize(data){enabled=data.mode==='coop';state=enabled?createFlow(G.level.objectives):null;seq=0;holding=null;holds.clear();if(enabled)apply(state);},
      tick(dt){
        if(!enabled||!ctx.isHost()||['complete','failed'].includes(state.phase))return;
        state.time+=dt;
        for(let i=0;i<state.relays.length;i++) {
          const relay=state.relays[i];if(relay.cut)continue;
          const objective=G.level.objectives.find(o=>o.id===relay.id);
          const cutters=[...holds.entries()].filter(([id,h])=>h.objectiveId===relay.id&&Date.now()-h.at<=400&&validInteraction(ctx.actors.get(id),objective,relay)).length;
          state.relays[i]=advanceRelay(relay,cutters,dt);
          if(state.relays[i].cut&&commitRelay(state,relay.id)) {
            ctx.emit({kind:'objectiveDone',objectiveId:relay.id,index:state.cut,total:state.total});
            ctx.emit({kind:'radio',key:state.allCut?'all':state.cut===1?'cut1':'cut2'});
            if(state.allCut)ctx.emit({kind:'phase',phase:'extract'});
          }
        }
        apply(state);
      },apply,
      snapshot:()=>state&&JSON.parse(JSON.stringify(state)),
      active:()=>enabled,terminal:()=>enabled&&['complete','failed'].includes(state.phase),
      intent(message){
        if(!enabled||message.type!=='interactIntent')return;
        if(message.active)holds.set(message.playerId,{objectiveId:message.objectiveId,at:Date.now()});else holds.delete(message.playerId);
      },
      present(event){if(!enabled)return;if(event.kind==='radio'&&RADIO[event.key])G.hud.radio(RADIO[event.key],event.key==='all'?4.5:3.6);},
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
