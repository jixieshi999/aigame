'use strict';
// Positions/aim, passive NPCs and short reset options are explicit fixtures; authority and input stay real.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createLanServer}=require('../server');
const {chromium,executablePath}=require('./browser-runtime');
const output=path.join(__dirname,'artifacts-d');fs.mkdirSync(output,{recursive:true});
async function main(){
  const app=createLanServer();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const report={at:new Date().toISOString(),checks:[],errors:[],fixtures:['public position/yaw and enabled for fixed relay/extraction positions','passive:true on original NPC spawn','real WebSocket flow requests; respawnSec=1 for reset fixtures','2Hz render only while loading another page']};
  const browser=await chromium.launch({headless:true,executablePath,args:['--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const pages=[],snap=p=>p.evaluate(()=>__LAN.snapshot()),check=s=>{report.checks.push(s);console.log('PASS: '+s);};
  async function open(name){
    console.log('载入合作页面：'+name);
    for(const p of pages)await p.evaluate(()=>{const f=__G.render.frame;window.__restore=()=>__G.render.frame=f;let last=0;__G.render.frame=function(dt){if(performance.now()-last<500)return;last=performance.now();return f.call(this,dt);};});
    try{
      const context=await browser.newContext({viewport:{width:800,height:600}}),p=await context.newPage();
      await p.addInitScript(()=>{const Base=window.WebSocket;window.WebSocket=class extends Base{constructor(...args){super(...args);window.__testWire=this;}};});
      p.on('pageerror',e=>report.errors.push({name,message:e.message}));
      await p.goto(`http://127.0.0.1:${app.server.address().port}/?q=low&noaudio=1&autostart=1&lanAuto=1&lanRoom=FLOW&lanName=${encodeURIComponent(name)}`,{waitUntil:'domcontentloaded',timeout:120000});
      await p.waitForFunction(()=>window.__LAN&&(__LAN.snapshot().fatal||__LAN.snapshot().combat?.state==='active'),null,{timeout:120000});
      assert.equal((await snap(p)).fatal,false);pages.push(p);return p;
    }finally{for(const p of pages)await p.evaluate(()=>{window.__restore?.();delete window.__restore;});}
  }
  async function send(p,message){await p.evaluate(m=>__testWire.send(JSON.stringify({v:3,roundId:__LAN.snapshot().roundId,...m})),message);}
  async function place(p,pos){await p.evaluate(pos=>{__G.player.enabled=false;__G.player.pos.fromArray(pos);__G.player.vel.set(0,0,0);__G.player.yaw=0;},pos);await p.waitForTimeout(250);}
  async function relayPlace(p,id,dx=0){const pos=await p.evaluate(({id,dx})=>{const p=__G.level.objectives.find(o=>o.id===id).pos;return [p.x+dx,p.y,p.z+1.4];},{id,dx});await place(p,pos);}
  async function hold(p,id,on=true){await p.evaluate(({id,on})=>{
    clearInterval(window.__hold);window.__interactSeq=window.__interactSeq||100;
    function send(active){__testWire.send(JSON.stringify({v:3,type:'interact',roundId:__LAN.snapshot().roundId,seq:++window.__interactSeq,objectiveId:id,active}));}
    send(on);if(on)window.__hold=setInterval(()=>send(true),200);
  },{id,on});}
  async function reset(a){const old=(await snap(a)).roundId;
    for(const p of pages)await p.evaluate(()=>{window.__oldLanEntities=__G.scene.children.filter(o=>o.userData.lanEnemy);});
    await send(a,{type:'roundReset',options:{respawnSec:1}});
    for(const p of pages)await p.waitForFunction(old=>__LAN.snapshot().roundId!==old&&__LAN.snapshot().combat.state==='active',old,{timeout:30000});
    const coopRules=require('../flow-coop').RULES,counts=require('../flow-coop').scaled(coopRules.patrol,pages.length),expected=counts.gull+counts.hound;
    for(const p of pages){
      await p.waitForFunction(expected=>__LAN.snapshot().combat.enemies.filter(e=>e.alive).length===expected,expected);
      assert.ok(await p.evaluate(()=>__oldLanEntities.every(o=>!o.parent&&!__G.scene.children.includes(o))),'重开必须移除旧轮的全部显示实体');
    }
    report.resetBeforeFixtureClear=(report.resetBeforeFixtureClear||[]).concat([{expected,roundId:(await snap(a)).roundId}]);
    await a.evaluate(()=>__G.enemies.clear());
  }
  async function sameEnemies(a,b){
    const ids=(await snap(a)).combat.enemies.map(e=>e.id).sort();
    await b.waitForFunction(ids=>JSON.stringify(__LAN.snapshot().combat.enemies.map(e=>e.id).sort())===JSON.stringify(ids),ids);
    assert.ok(ids.length<=18);return ids;
  }
  try{
    const a=await open('房主甲');await a.evaluate(()=>{
      __G.enemies.clear();const spawn=__G.enemies.spawn;__G.enemies.spawn=function(type,pos,opts){return spawn.call(this,type,pos,{...opts,passive:true});};
      window.__cuts=[];const original=__G.hud.radio;__G.hud.radio=function(text,...args){__cuts.push(text);return original.call(this,text,...args);};
    });
    const b=await open('<img onerror=alert(1)>');
    await a.waitForFunction(()=>__LAN.snapshot().combat.players.length===2);
    const initial=[await a.evaluate(()=>__G.player.pos.toArray()),await b.evaluate(()=>__G.player.pos.toArray())];
    assert.ok(Math.hypot(initial[0][0]-initial[1][0],initial[0][2]-initial[1][2])>=.8);report.initialSpawn=initial;
    check('两个页面开局出生不重叠，客户端无本地AI');
    await relayPlace(a,'relay_a',-.5);await relayPlace(b,'relay_a',.5);
    await hold(a,'relay_a');await hold(b,'relay_a');
    await a.waitForFunction(()=>__LAN.snapshot().combat.flow.relays[0].cutters===2);
    await b.waitForFunction(()=>__LAN.snapshot().combat.flow.cut===1);
    await hold(a,'relay_a',false);await hold(b,'relay_a',false);
    await a.waitForTimeout(500);assert.equal((await snap(a)).combat.flow.wave,1);
    await hold(a,'relay_a');await a.waitForTimeout(600);await hold(a,'relay_a',false);
    assert.equal((await snap(a)).combat.flow.cut,1);assert.equal((await snap(a)).combat.flow.wave,1);
    await a.waitForTimeout(5500);report.waveIds=await sameEnemies(a,b);assert.ok(report.waveIds.length>0);
    report.concurrent={a:await snap(a),b:await snap(b)};
    check('并发切同一中继显示2人协作且只生效一次；波次enemyId和数量两端一致');
    const c=await open('晚加入丙');await c.waitForFunction(()=>__LAN.snapshot().combat.flow.cut===1&&__LAN.snapshot().combat.flow.wave===1);
    report.late=await snap(c);assert.equal(report.late.combat.sourceActive,0);assert.ok(report.late.combat.enemies.length>0);
    await c.evaluate(()=>{window.__relayStates=[];for(const o of __G.level.objectives){const f=o.object.userData.setState;o.object.userData.setState=function(s){__relayStates.push([o.id,s]);return f.call(this,s);};}});
    await c.waitForFunction(()=>__relayStates.some(([id,state])=>id==='relay_a'&&state==='cut'));
    check('晚加入直接看到已切中继外观、HUD、波次和当前敌人');
    await c.close();pages.splice(pages.indexOf(c),1);
    const cutBefore=(await snap(a)).combat.flow.cut,enemiesBefore=await sameEnemies(a,b);
    await a.waitForTimeout(3200);await b.evaluate(()=>__G.player.damage(100));
    await b.waitForSelector('#lan-life:not([hidden])');assert.equal(await b.locator('#lan-respawn').isDisabled(),true);
    await b.waitForFunction(()=>!document.getElementById('lan-respawn').disabled,null,{timeout:20000});
    await b.bringToFront();await b.locator('#lan-respawn').click();await b.waitForFunction(()=>__G.player.alive&&__G.game.state==='playing');
    const before=await b.evaluate(()=>({pos:__G.player.pos.toArray(),yaw:__G.player.yaw,pitch:__G.player.pitch}));
    await b.mouse.move(280,260,{steps:10});await b.waitForTimeout(200);await b.keyboard.down('KeyD');await b.waitForTimeout(750);await b.keyboard.up('KeyD');
    const after=await b.evaluate(()=>({pos:__G.player.pos.toArray(),yaw:__G.player.yaw,pitch:__G.player.pitch}));
    const distance=Math.hypot(...after.pos.map((n,i)=>n-before.pos[i])),look=Math.abs(after.yaw-before.yaw)+Math.abs(after.pitch-before.pitch);
    assert.ok(distance>.5&&look>.01);report.revive={distance,look,snapshot:await snap(b)};
    assert.equal((await snap(a)).combat.flow.cut,cutBefore);assert.deepEqual(await sameEnemies(a,b),enemiesBefore);
    check(`第二玩家点击复活后真实移动${distance.toFixed(2)}m/转向${look.toFixed(3)}rad，中继敌人和队友未重置`);
    for(const id of ['relay_b','relay_c']){
      await relayPlace(a,id);await hold(a,id);await a.waitForFunction(id=>__LAN.snapshot().combat.flow.relays.find(r=>r.id===id).cut,id);await hold(a,id,false);
    }
    await b.waitForFunction(()=>__LAN.snapshot().combat.flow.phase==='extract');
    assert.equal((await snap(a)).combat.flow.wave,3);check('三处中继全切，两端进入撤离且每次只触发一波');
    await place(a,[28,0,20]);await place(b,[-31,0,6]);await a.waitForTimeout(1700);
    assert.equal((await snap(a)).combat.flow.phase,'extract');assert.equal((await snap(a)).combat.flow.extraction.hold,0);
    await place(b,[28,0,20]);await a.waitForFunction(()=>__LAN.snapshot().combat.flow.extraction.hold>.1);
    await place(b,[-31,0,6]);await a.waitForTimeout(200);assert.equal((await snap(a)).combat.flow.extraction.hold,0);
    await place(b,[28,0,20]);await b.waitForSelector('#lan-result:not([hidden])');await a.waitForSelector('#lan-result:not([hidden])');
    const doneA=await snap(a),doneB=await snap(b);assert.equal(doneA.combat.flow.phase,'complete');assert.deepEqual(doneA.combat.flow.result,doneB.combat.flow.result);
    assert.equal(await a.evaluate(()=>__G.game.menus.screen),'none');assert.equal(await b.evaluate(()=>__G.game.menus.screen),'none');
    assert.equal(await b.locator('#lan-result img').count(),0);report.complete={a:doneA,b:doneB};
    await a.screenshot({path:path.join(output,'complete.png')});check('撤离须全体存活队员入圈连续1.5秒，离圈清零，两端同一结算且无原单机菜单');
    await reset(a);const fresh=await snap(a);assert.equal(fresh.combat.flow.cut,0);assert.equal(fresh.combat.flow.wave,0);assert.equal(fresh.combat.flow.result,null);
    assert.ok(fresh.combat.players.every(p=>p.deaths===0));assert.equal(await b.locator('#lan-result').isVisible(),false);
    check('房主重开清空中继波次死亡结算，原轮实体不残留');
    await a.bringToFront();await a.evaluate(()=>{document.getElementById('lan-panel').hidden=true;});
    if(await a.evaluate(()=>__G.game.state==='paused'))await a.locator('[data-act="resume"]').click();
    else await a.locator('#view').click({position:{x:180,y:250}});
    await relayPlace(a,'relay_a');await a.keyboard.down('KeyE');
    try{await a.waitForFunction(()=>__LAN.snapshot().combat.flow.cut===1,null,{timeout:15000});}finally{await a.keyboard.up('KeyE');}
    await b.waitForFunction(()=>__LAN.snapshot().combat.flow.cut===1);
    check('真实按住E经客户端200ms心跳切断中继，另一端同步');
    await a.waitForTimeout(3200);await a.evaluate(()=>__G.game.pause());const seq=(await snap(a)).combat.worldSeq;await a.waitForTimeout(400);assert.ok((await snap(a)).combat.worldSeq>seq);
    await a.evaluate(()=>__G.player.damage(100));await a.waitForSelector('#lan-life:not([hidden])');const deadSeq=(await snap(a)).combat.worldSeq;
    await a.waitForTimeout(400);assert.ok((await snap(a)).combat.worldSeq>deadSeq);assert.equal((await snap(b)).combat.flow.phase,'active');
    await b.evaluate(()=>__G.player.damage(100));await b.waitForSelector('#lan-result:not([hidden])');await a.waitForSelector('#lan-result:not([hidden])');
    assert.equal((await snap(a)).combat.flow.phase,'failed');assert.equal((await snap(b)).combat.flow.phase,'failed');
    check('房主暂停和个人死亡不停止世界，全员倒地（含待复活）即失败');
    await a.close();pages.splice(pages.indexOf(a),1);await b.waitForFunction(()=>__LAN.snapshot().combat.state==='ended');
    await reset(b);assert.equal((await snap(b)).combat.flow.phase,'active');check('房主离线结束本轮，顺延房主必须明确重开');
    assert.deepEqual(report.errors,[]);assert.equal(app.metrics.invalid,0);report.metrics={...app.metrics};report.passed=true;
  }catch(e){report.failure=e.stack;report.final=[];for(const p of pages)if(!p.isClosed())report.final.push(await snap(p).catch(()=>null));throw e;}
  finally{fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));await browser.close();await app.stop();}
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,metrics:report.metrics},null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
