'use strict';
const assert=require('node:assert/strict');
const {createLanServer}=require('../server');
const {chromium,executablePath}=require('./browser-runtime');

async function main(){
  const app=createLanServer();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const port=app.server.address().port,browser=await chromium.launch({headless:true,executablePath,args:['--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
  const pages=[];const snap=p=>p.evaluate(()=>__LAN.snapshot());
  const mapArg=process.env.LAN_WAREHOUSE==='1'?'&lanMap=warehouse':'';
  async function open(name){
    const p=await (await browser.newContext({viewport:{width:800,height:600}})).newPage();
    await p.addInitScript(()=>{const Base=window.WebSocket;window.WebSocket=class extends Base{constructor(...args){super(...args);window.__testWire=this;}};});
    await p.goto(`http://127.0.0.1:${port}/?q=low&autostart=1&lanAuto=1&lanMode=pvp&lanRoom=PVPE2E&lanName=${encodeURIComponent(name)}${mapArg}`,{waitUntil:'domcontentloaded',timeout:120000});
    await p.waitForFunction(()=>window.__LAN&&__LAN.snapshot().combat?.state==='active',null,{timeout:120000});pages.push(p);return p;
  }
  async function setPose(p,pos){await p.evaluate(pos=>{__G.player.pos.fromArray(pos);__G.player.vel.set(0,0,0);__G.player.enabled=false;},pos);await p.waitForTimeout(350);}
  async function shoot(p,seq){await p.evaluate(seq=>{const s=__LAN.snapshot(),g=__G,enemy=s.combat.players.find(x=>x.playerId!==s.playerId);const target=g.THREE.Vector3?new g.THREE.Vector3(-28,1,6):null;const origin=g.player.eye.toArray(),dir=target.sub(g.player.eye).normalize().toArray();__testWire.send(JSON.stringify({v:3,type:'shot',roundId:s.roundId,seq,origin,dir,muzzle:origin}));},seq);}
  try{
    const host=await open('房主'),guest=await open('对手');
    await host.waitForFunction(()=>__LAN.snapshot().combat.players.length===2);await setPose(host,[-32,0,6]);await setPose(guest,[-28,0,6]);
    await host.waitForTimeout(3500);const guestId=(await snap(guest)).playerId;const before=(await snap(host)).combat.players.find(p=>p.playerId===guestId).health;
    for(let i=1;i<=5;i++){await shoot(host,i);await host.waitForTimeout(120);}
    await host.waitForFunction(id=>__LAN.snapshot().combat.players.some(p=>p.playerId===id&&p.health<100),guestId,{timeout:10000});
    const hs=await snap(host),gs=await snap(guest),victim=hs.combat.players.find(p=>p.playerId===gs.playerId);
    assert.ok(victim.health<before);assert.ok(hs.combat.players.find(p=>p.playerId===hs.playerId).stats.hits>0);
    console.log(JSON.stringify({passed:true,before,after:victim.health,host:hs.combat.flow,guest:gs.combat.players.find(p=>p.playerId===gs.playerId)},null,2));
  }finally{for(const p of pages)await p.close().catch(()=>{});await browser.close();await app.stop();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
