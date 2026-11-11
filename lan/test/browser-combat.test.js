'use strict';
// Real game modules and real mouse firing; isolated host fixtures make damage paths repeatable.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createLanServer}=require('../server');
const {chromium,executablePath}=require('./browser-runtime');
const output=path.join(__dirname,'artifacts-c');fs.mkdirSync(output,{recursive:true});
async function main() {
  const app=createLanServer();await new Promise(resolve=>app.server.listen(0,'0.0.0.0',resolve));const port=app.server.address().port;
  let browser;
  const report={at:new Date().toISOString(),build:app.build,executablePath,checks:[],errors:[],rejectedRequests:[]};
  app.server.on('request',(req,res)=>res.on('finish',()=>{if(res.statusCode>=400)report.rejectedRequests.push({url:req.url,status:res.statusCode});}));
  const snap=page=>page.evaluate(()=>__LAN.snapshot());
  const check=text=>{report.checks.push(text);console.log(`PASS: ${text}`);};
  async function open(name) {
    console.log(`载入真实游戏：${name}`);
    const older=browser.contexts().flatMap(context=>context.pages());
    // Avoid GPU contention during another full procedural boot. Simulation/network timers continue.
    for(const page of older)await page.evaluate(()=>{if(!window.__ready)return;const frame=__G.render.frame;window.__restoreLanRender=()=>{__G.render.frame=frame;};let last=0;__G.render.frame=function(dt){if(performance.now()-last<500)return;last=performance.now();return frame.call(this,dt);};});
    report.renderThrottleDuringLoad=true;
    try {
    const context=await browser.newContext({viewport:{width:720,height:520}}),page=await context.newPage();
    page.on('pageerror',error=>report.errors.push({name,message:error.message}));
    page.on('console',message=>{if(message.type()==='error')report.errors.push({name,console:message.text(),location:message.location()});});
    // C's original three-NPC fixtures run in the unchanged display-only PvP mode.
    await page.goto(`http://127.0.0.1:${port}/?q=low&autostart=1&seed=4207&eseed=9001&lanAuto=1&lanMode=pvp&lanRoom=COMBAT&lanName=${encodeURIComponent(name)}`,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.__LAN&&(__LAN.snapshot().fatal||__LAN.snapshot().combat?.state==='active'),null,{timeout:120000});
    const data=await snap(page);assert.equal(data.fatal,false,JSON.stringify(data));assert.equal(data.connected,true);
    return page;
    } finally {for(const page of older)if(!page.isClosed())await page.evaluate(()=>{window.__restoreLanRender?.();delete window.__restoreLanRender;});}
  }
  async function reset(a,b) {
    const old=(await snap(a)).roundId;
    await a.bringToFront();
    if(await a.evaluate(()=>!!document.pointerLockElement))await a.keyboard.press('F2');
    else await a.evaluate(()=>{document.getElementById('lan-panel').hidden=false;});
    await a.waitForFunction(()=>!document.pointerLockElement);
    await a.locator('#lan-reset').click();
    await a.waitForFunction(old=>__LAN.snapshot().roundId!==old&&__LAN.snapshot().combat.state==='active',old);
    if(b)await b.waitForFunction(old=>__LAN.snapshot().roundId!==old&&__LAN.snapshot().combat.worldSeq>0,old);
    await a.waitForTimeout(200);
  }
  async function spawn(a,kind,pos,options={}) {
    const info=await a.evaluate(({kind,pos,options})=> {
      __G.enemies.clear();
      const location=new __G.THREE.Vector3(...pos);
      const enemy=__G.enemies.spawn(kind,location,{passive:true,patrolRadius:.01,patrolLine:[location.clone()],hover:pos[1],...options});
      return {id:`e${enemy.id}`,kind,pos:enemy.pos.toArray()};
    },{kind,pos,options});
    await a.waitForTimeout(350);return info;
  }
  async function aimFire(page,point,duration=650) {
    await page.bringToFront();await page.evaluate(()=>{document.getElementById('lan-panel').hidden=true;});
    const state=await page.evaluate(()=>__G.game.state);
    if(state==='paused')await page.locator('[data-act="resume"]').click();
    else await page.locator('#view').click({position:{x:180,y:260}});
    // The stock shot camera is applied after weapon.update, so aim the public player angles.
    await page.evaluate(point=>{__setShot({cam:''});const d=new __G.THREE.Vector3(...point).sub(__G.player.eye).normalize();__G.player.yaw=Math.atan2(-d.x,-d.z);__G.player.pitch=Math.asin(d.y);},point);
    await page.waitForTimeout(200);
    report.aimDiagnostics=report.aimDiagnostics||[];
    report.aimDiagnostics.push(await page.evaluate(point=>{const g=__G,d=new g.THREE.Vector3(...point).sub(g.player.eye).normalize(),wall=g.physics.raycast(g.player.eye,d,300),enemy=g.enemies.raycast(g.player.eye,d,wall?wall.dist:300);return {state:g.game.state,eye:g.player.eye.toArray(),camera:g.camera.position.toArray(),dir:g.camera.getWorldDirection(new g.THREE.Vector3()).toArray(),target:point,wall:wall&&{dist:wall.dist,point:wall.point.toArray()},enemy:enemy&&{id:enemy.enemy.id,part:enemy.part,dist:enemy.dist},snapshot:__LAN.snapshot()};},point));
    await page.evaluate(point=>{window.__combatAim=setInterval(()=>{const d=new __G.THREE.Vector3(...point).sub(__G.player.eye).normalize();__G.player.yaw=Math.atan2(-d.x,-d.z);__G.player.pitch=Math.asin(d.y);},100);},point);
    try {await page.mouse.down();await page.waitForTimeout(duration);await page.mouse.up();}
    finally {await page.evaluate(()=>clearInterval(window.__combatAim));}
    await page.waitForTimeout(300);
  }
  function actor(snapshot,id){return snapshot.combat.players.find(p=>p.playerId===id);}
  try {
    browser=await chromium.launch({headless:true,executablePath,args:['--enable-unsafe-swiftshader','--disable-background-timer-throttling',
      '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--autoplay-policy=no-user-gesture-required']});
    const a=await open('房主甲');await a.evaluate(()=>__G.enemies.clear());
    const b=await open('玩家乙');await reset(a,b);
    await b.waitForFunction(()=>__LAN.snapshot().combat.puppetCount===3);
    report.initial={a:await snap(a),b:await snap(b)};
    assert.equal(report.initial.a.combat.sourceActive,3);assert.equal(report.initial.b.combat.sourceActive,0);
    assert.equal(report.initial.b.combat.independentSkeletons,true);
    assert.deepEqual(report.initial.a.combat.enemies.map(e=>e.id).sort(),report.initial.b.combat.enemies.map(e=>e.id).sort());
    check('同一round只有房主运行3个原生敌人，客户端原敌人池0活动，3个纯显示模型使用独立骨架');

    const hound=await spawn(a,'hound',[-26,0,6]);
    await b.waitForFunction(id=>__LAN.snapshot().combat.enemies.some(e=>e.id===id),hound.id);
    const target=await a.evaluate(()=>__G.enemies.list.find(e=>e.alive).headPos.toArray());
    await aimFire(a,target,850);
    await a.waitForFunction(id=>!__LAN.snapshot().combat.enemies.some(e=>e.id===id),hound.id);
    await b.waitForFunction(id=>!__LAN.snapshot().combat.enemies.some(e=>e.id===id),hound.id);
    report.hostKill={a:await snap(a),b:await snap(b),houndVisible:await a.evaluate(()=>__G.enemies.list.filter(e=>e.type==='hound'&&!e.alive).map(e=>e.rig.group.visible))};
    assert.ok(report.hostKill.houndVisible.every(v=>v===false));
    assert.equal(actor(report.hostKill.a,report.hostKill.a.playerId).stats.kills,1);
    assert.equal(actor(report.hostKill.b,report.hostKill.b.playerId).stats.kills,0);
    check('房主真实鼠标击杀猎犬后，两端同一enemyId均消失；房主仅记1次击杀');

    await reset(a,b);const remoteTarget=await spawn(a,'hound',[-26,0,6]);
    await aimFire(b,[-26,.6,6],1400);
    await b.waitForFunction(id=>!__LAN.snapshot().combat.enemies.some(e=>e.id===id),remoteTarget.id);
    await a.waitForFunction(id=>!__LAN.snapshot().combat.enemies.some(e=>e.id===id),remoteTarget.id);
    report.clientKill={a:await snap(a),b:await snap(b)};
    assert.equal(actor(report.clientKill.a,report.clientKill.a.playerId).stats.kills,0);
    assert.equal(actor(report.clientKill.b,report.clientKill.b.playerId).stats.kills,1);
    check('第二玩家真实射击由房主结算；客户端没有本地伤害副本，击杀仅归第二玩家');

    // Reload uses the original weapon animation/event and the host's independent inventory clock.
    const beforeReload=actor(await snap(b),(await snap(b)).playerId);
    await b.evaluate(()=>__G.weapon.reloadNow());await b.waitForTimeout(2400);
    report.reload=actor(await snap(b),(await snap(b)).playerId);
    assert.equal(report.reload.ammo,30);assert.equal(report.reload.reserve,beforeReload.reserve-(30-beforeReload.ammo));
    check('换弹请求由房主计时并补充弹药，弹匣与备弹守恒');

    // A low, close gull falls within blast range. A high gull carries the shot impulse ~4m away.
    await reset(a,b);const falling=await spawn(a,'gull',[-31,.7,6]);
    await a.evaluate(()=>{const explode=__G.combat.explode;__G.combat.explode=function(pos,radius,amount,source){const center=__G.player.pos.clone().add(new __G.THREE.Vector3(0,1,0));window.__blastProbe={pos:pos.toArray(),radius,amount,source,center:center.toArray(),distance:pos.distanceTo(center),los:__G.physics.lineOfSight(pos,center)};return explode.apply(this,arguments);};});
    const beforeBlast={a:await snap(a),b:await snap(b)};
    await aimFire(a,[-31,.7,6],650);
    await a.waitForFunction(()=>__LAN.snapshot().combat.stats.explosions>0,null,{timeout:20000});
    await b.waitForFunction(()=>__LAN.snapshot().combat.stats.remoteExplosions>0);
    await a.waitForTimeout(300);report.gullCrash={before:beforeBlast,a:await snap(a),b:await snap(b),probe:await a.evaluate(()=>window.__blastProbe)};
    const explosionCount=report.gullCrash.a.combat.stats.explosions-beforeBlast.a.combat.stats.explosions;
    assert.equal(explosionCount,1);
    assert.equal(report.gullCrash.b.combat.stats.explosions-beforeBlast.b.combat.stats.explosions,0);
    assert.ok(actor(report.gullCrash.a,report.gullCrash.a.playerId).health<100);
    assert.ok(actor(report.gullCrash.b,report.gullCrash.b.playerId).health<100);
    await b.waitForFunction(id=>!__LAN.snapshot().combat.enemies.some(e=>e.id===id),falling.id);
    check('飞鸥坠毁只在房主结算1次爆炸，两位玩家均受伤；客户端仅回放1次爆炸表现');

    await reset(a,b);
    await a.evaluate(()=>{__G.enemies.clear();__setShot({cam:''});__G.player.pos.set(-37,0,2);__G.player.vel.set(0,0,0);});
    await b.evaluate(()=>{__setShot({cam:''});__G.player.pos.set(-30,0,6);__G.player.vel.set(0,0,0);});
    await b.waitForTimeout(300);
    const melee=await spawn(a,'hound',[-28.9,0,6],{passive:false});
    const bId=(await snap(b)).playerId;
    await b.waitForFunction(id=>__LAN.snapshot().combat.players.some(p=>p.playerId===id&&p.health<100),bId,{timeout:20000});
    report.melee={a:await snap(a),b:await snap(b),gamePlayerHealth:await b.evaluate(()=>__G.player.health)};
    assert.ok(report.melee.a.combat.enemies.some(e=>e.id===melee.id&&e.targetId===bId));
    assert.ok(report.melee.gamePlayerHealth<100);assert.equal(actor(report.melee.a,report.melee.a.playerId).health,100);
    check('原生猎犬AI选择第二位玩家，近战伤害通过代理只扣对应玩家生命');

    await a.evaluate(()=>__G.enemies.clear());await b.waitForTimeout(300);
    const beforeBolt=actor(await snap(b),bId).health,beforeBoltHits=(await snap(a)).combat.stats.boltHits;
    await a.evaluate(id=> {
      const pose=__LAN.snapshot().members.find(p=>p.playerId===id);
      const p=__LAN.snapshot().combat.players.find(p=>p.playerId===id);void pose;void p;
      __G.enemies.debug.ctx.fireBolt(new __G.THREE.Vector3(-30,1.1,3),new __G.THREE.Vector3(0,0,1));
    },bId);
    await b.waitForFunction(({id,health})=>__LAN.snapshot().combat.players.some(p=>p.playerId===id&&p.health<health),{id:bId,health:beforeBolt});
    report.bolt={before:beforeBolt,a:await snap(a),b:await snap(b)};
    assert.ok(Math.abs(actor(report.bolt.b,bId).health-(beforeBolt-7))<.01);
    assert.equal(report.bolt.a.combat.stats.boltHits-beforeBoltHits,1);
    await b.evaluate(()=>{__G.player.health=100;});await b.waitForTimeout(200);
    assert.ok(await b.evaluate(()=>__G.player.health)<100);
    check('飞鸥弹丸检查全体玩家并命中第二位玩家，伤害7且只结算一次；本机自行回血写入被权威状态覆盖');

    const beforeRay=actor(await snap(b),bId).health;
    assert.equal(await a.evaluate(()=>__G.combat.enemyShot(new __G.THREE.Vector3(-30,1.1,3),new __G.THREE.Vector3(0,0,1),{damage:6,range:20})),true);
    await b.waitForFunction(({id,hp})=>__LAN.snapshot().combat.players.some(p=>p.playerId===id&&p.health<hp),{id:bId,hp:beforeRay});
    report.ray={before:beforeRay,a:await snap(a),b:await snap(b)};
    assert.ok(Math.abs(actor(report.ray.b,bId).health-(beforeRay-6))<.01);
    report.occludedRay=await a.evaluate(()=>{
      const g=__G,box=g.physics.addBox([-31,0,4.5],[-29,2,4.8],{bulletOnly:true,noNav:true,tag:'C-test-occluder'});
      const origin=new g.THREE.Vector3(-30,1.1,3),dir=new g.THREE.Vector3(0,0,1);
      try {return {fixture:'temporary bulletOnly box through original physics',block:g.physics.raycast(origin,dir,20).dist,hit:g.combat.enemyShot(origin,dir,{damage:6,range:20})};}
      finally {g.physics.removeBox(box);}
    });
    assert.equal(report.occludedRay.hit,false);await b.waitForTimeout(200);
    assert.equal(actor(await snap(b),bId).health,actor(report.ray.b,bId).health);
    await b.evaluate(()=>{__G.combat.enemyShot(new __G.THREE.Vector3(-30,1,3),new __G.THREE.Vector3(0,0,1),{damage:99});__G.combat.explode(__G.player.pos,3,99);});
    await b.waitForTimeout(200);assert.equal(actor(await snap(b),bId).health,actor(report.ray.b,bId).health);
    check('猎犬射线可命中第二玩家，保留真实静态遮挡；客户端自行调用敌方射线/爆炸不结算伤害');

    const beforeHazard=actor(await snap(b),bId).health;
    await b.evaluate(()=>__G.player.damage(12,__G.player.pos));
    await b.waitForFunction(({id,hp})=>__LAN.snapshot().combat.players.some(p=>p.playerId===id&&p.health<hp),{id:bId,hp:beforeHazard});
    assert.ok(Math.abs(actor(await snap(b),bId).health-(beforeHazard-12))<.01);
    check('第二玩家原落地/救援受伤入口提交身份绑定请求，由房主扣血12一次');

    // Capture an actual partial-health enemy before bringing in a late joiner.
    const lateEnemy=await spawn(a,'hound',[-26,0,6]);
    await a.evaluate(()=>{const e=__G.enemies.list.find(e=>e.alive);e.damage(26,e.pos,new __G.THREE.Vector3(1,0,0),'body');});
    const c=await open('晚加入丙');
    await c.waitForFunction(id=>__LAN.snapshot().combat.enemies.some(e=>e.id===id&&e.hp===114),lateEnemy.id);
    report.lateJoin=await snap(c);assert.equal(report.lateJoin.combat.sourceActive,0);assert.equal(report.lateJoin.combat.independentSkeletons,true);
    check('晚加入浏览器直接得到当前enemyId和114血量，未重建独立AI或满血敌人');
    await c.close();

    await a.evaluate(()=>__G.game.pause());const pausedBefore=await snap(a);await a.waitForTimeout(450);
    const pausedAfter=await snap(a);assert.ok(pausedAfter.combat.worldSeq>pausedBefore.combat.worldSeq);
    await a.evaluate(()=>__G.player.damage(100,__G.player.pos));
    const deadBefore=await snap(a);await a.waitForTimeout(450);report.hostDead={a:await snap(a),b:await snap(b)};
    assert.ok(report.hostDead.a.combat.worldSeq>deadBefore.combat.worldSeq);
    assert.equal(actor(report.hostDead.a,report.hostDead.a.playerId).alive,false);
    check('房主暂停或个人死亡后，独立敌人模拟与完整快照继续更新');

    // Inspect the rendered clone with the stock debug camera; no source HTML edits.
    await b.evaluate(()=>{document.getElementById('lan-panel').hidden=true;__setShot({cam:'-29,2.2,10,-26,0.8,6'});});
    await b.waitForTimeout(350);await b.screenshot({path:path.join(output,'client-enemy.png')});
    report.beforeHostLeave=await snap(b);await a.close();
    await b.waitForFunction(()=>__LAN.snapshot().combat.state==='ended');report.hostLeave=await snap(b);
    assert.equal(report.hostLeave.combat.sourceActive,0);assert.equal(report.hostLeave.combat.puppetCount,0);
    await reset(b);await b.waitForFunction(()=>__LAN.snapshot().combat.sourceActive===3);
    report.newHost=await snap(b);assert.equal(report.newHost.combat.isHost,true);
    check('房主离线停止战斗并回收显示；顺延房主明确重开后才启动新round和单份AI');
    assert.equal(report.newHost.combat.stats.identityLeaks,0);
    assert.ok(report.errors.every(e=>!e.message),JSON.stringify(report.errors));
    report.serverMetrics={...app.metrics};assert.equal(report.serverMetrics.invalid,0,'正常战斗与加入/离开不应产生非法协议消息');report.passed=true;
  } catch(error) {report.failure=error.stack;report.finalPages=[];if(browser)for(const context of browser.contexts())for(const page of context.pages()){try{report.finalPages.push(await page.evaluate(()=>({snapshot:__LAN.snapshot(),game:__G.game.state,health:__G.player.health,enemies:__G.enemies.list.map(e=>({id:e.id,hp:e.hp,alive:e.alive,pos:e.pos.toArray(),visible:e.rig.group.visible}))})));}catch{}}throw error;}
  finally {
    fs.writeFileSync(path.join(output,'browser-combat-results.json'),JSON.stringify(report,null,2));
    if(browser)await browser.close();await app.stop();
  }
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,serverMetrics:report.serverMetrics,rejectedRequests:report.rejectedRequests},null,2));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
