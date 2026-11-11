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
  const api={createFlow,shortName,objectiveText};
  if(typeof window==='undefined'){module.exports=api;return;}
  function create(ctx) {
    const {G}=ctx;
    let enabled=false,state=null;
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
      initialize(data){enabled=data.mode==='coop';state=enabled?createFlow(G.level.objectives):null;if(enabled)apply(state);},
      tick(dt){if(enabled)state.time+=dt;},apply,
      snapshot:()=>state&&JSON.parse(JSON.stringify(state)),
      active:()=>enabled,terminal:()=>enabled&&['complete','failed'].includes(state.phase),
      intent(){},present(){},render(){},detach(){enabled=false;state=null;G.hud.setPrompt(null);},destroy(){}
    };
  }
  window.LanFlowCoop=Object.freeze({...api,create});
})();
