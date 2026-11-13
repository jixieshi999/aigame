/* E-stage PvP flow. Pure rules stay usable by node --test without THREE/window. */
(function () {
  'use strict';
  const DEFAULTS = Object.freeze({ friendlyFire:false, npcs:'both', scoreLimit:30, timeLimitSec:600, respawnSec:5, rebalance:true });
  function options(value) {
    const input=value&&typeof value==='object'?value:{};
    return { ...DEFAULTS, friendlyFire:input.friendlyFire===true, npcs:input.npcs==='off'?'off':'both',
      scoreLimit:Number.isInteger(input.scoreLimit)?input.scoreLimit:DEFAULTS.scoreLimit,
      timeLimitSec:Number.isInteger(input.timeLimitSec)?input.timeLimitSec:DEFAULTS.timeLimitSec,
      respawnSec:Number.isInteger(input.respawnSec)?input.respawnSec:DEFAULTS.respawnSec,
      rebalance:input.rebalance!==false };
  }
  function createFlow(opts={}) {
    const o=options(opts);
    return {kind:'pvp',phase:'active',time:0,timeLimit:o.timeLimitSec,scoreLimit:o.scoreLimit,scores:[0,0],winner:null,options:o,result:null};
  }
  function hitPart(hitY,baseY,crouching=false) {
    const head=baseY+(crouching?.95:1.45);
    return hitY>=head?'head':'body';
  }
  function damageFor(part,body=22,headMultiplier=1.75) { return part==='head'?body*headMultiplier:body; }
  function recordKill(flow,killerTeam,victimTeam,friendlyFire=false) {
    const next={...flow,scores:flow.scores.slice()};
    if (killerTeam===undefined||killerTeam===null||victimTeam===undefined||victimTeam===null) return next;
    if (killerTeam===victimTeam&&friendlyFire) next.scores[killerTeam]=Math.max(0,next.scores[killerTeam]-1);
    else if (killerTeam!==victimTeam) next.scores[killerTeam]++;
    const reached=next.scores.findIndex(score=>score>=next.scoreLimit);
    if (reached>=0) { next.phase='ended';next.winner=reached;next.result='score'; }
    return next;
  }
  function tickFlow(flow,dt) {
    if (!flow||flow.phase!=='active') return flow;
    const next={...flow,time:Math.min(flow.time+Math.max(0,dt),flow.timeLimit),scores:flow.scores.slice()};
    if (next.time>=next.timeLimit) { next.phase='ended';next.result='time';next.winner=next.scores[0]===next.scores[1]?-1:(next.scores[0]>next.scores[1]?0:1); }
    return next;
  }
  function canHit(shooter,victim,opts) {
    return !!shooter&&!!victim&&shooter.id!==victim.id&&victim.health>0&&Date.now()>= (victim.invulnUntil||0) &&
      (opts.friendlyFire||shooter.team!==victim.team);
  }
  const api={DEFAULTS,options,createFlow,hitPart,damageFor,recordKill,tickFlow,canHit};
  if (typeof window==='undefined') { module.exports=api; return; }
  function create(ctx) {
    const {G}=ctx;
    let enabled=false,state=null,lastEvent='';
    let hud=null;
    function makeHud() {
      if (hud) return hud;
      hud=document.createElement('div');hud.id='lan-pvp-hud';hud.setAttribute('aria-live','polite');
      hud.style.cssText='position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147482990;padding:5px 12px;border:1px solid #55718d;border-radius:7px;background:#091522d9;color:#edf5ff;font:600 14px/1.4 "Microsoft YaHei",sans-serif;pointer-events:none';
      document.body.appendChild(hud);return hud;
    }
    function apply(flow) {
      if (!enabled||!flow||flow.kind!=='pvp') return;
      state=JSON.parse(JSON.stringify(flow));
      const h=makeHud();h.textContent=`蓝 ${state.scores[0]} : ${state.scores[1]} 橙 · ${Math.max(0,state.timeLimit-state.time).toFixed(0)}秒`;
      h.hidden=state.phase!=='active';
    }
    return {
      initialize(data){enabled=data.mode==='pvp';state=enabled?createFlow(data.options):null;lastEvent='';if(enabled)apply(state);else if(hud)hud.hidden=true;},
      tick(dt){if(!enabled||!ctx.isHost()||!state||state.phase!=='active')return;const next=tickFlow(state,dt);if(next!==state){state=next;apply(state);if(state.phase==='ended')ctx.emit({kind:'roundEnd',result:'pvp',winnerTeam:state.winner});}},
      apply, snapshot:()=>state&&JSON.parse(JSON.stringify(state)), active:()=>enabled, terminal:()=>enabled&&state?.phase==='ended', options:()=>state?.options||options(),
      onKill(killer,victim,part){if(!enabled||!state||state.phase!=='active')return;state=recordKill(state,killer?.team,victim?.team,state.options.friendlyFire);apply(state);if(state.phase==='ended')ctx.emit({kind:'roundEnd',result:'pvp',winnerTeam:state.winner});},
      present(event){if(!enabled||!event)return;if(event.kind==='roundEnd'&&event.result==='pvp'){lastEvent=event.winnerTeam===-1?'平局':`阵营${event.winnerTeam+1}获胜`;ctx.onStatus?.(`对抗结束 · ${lastEvent}`);}},
      render(){if(enabled&&state)apply(state);},
      detach(){enabled=false;state=null;if(hud)hud.hidden=true;},
      destroy(){hud?.remove();hud=null;}
    };
  }
  window.LanFlowPvp=Object.freeze({...api,create});
})();
