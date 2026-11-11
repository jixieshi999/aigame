'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {createLanServer}=require('../server');
const {chromium,executablePath}=require('./browser-runtime');
async function main(){
  const app=createLanServer();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath,args:['--enable-unsafe-swiftshader']});
  const output=path.join(__dirname,'artifacts-spawn');fs.mkdirSync(output,{recursive:true});
  try{
    const page=await browser.newPage({viewport:{width:800,height:600}});
    await page.goto(`http://127.0.0.1:${app.server.address().port}/?q=low&noaudio=1`,{waitUntil:'domcontentloaded',timeout:120000});
    await page.waitForFunction(()=>window.__G&&window.LanFlowShared&&__G.level?.objectives,{timeout:120000});
    const result=await page.evaluate(()=>{
      const G=__G,T=G.THREE,S=LanFlowShared;
      const walk=(x,z)=>G.physics.nav.isWalkable(x,z);
      const visible=(a,b)=>G.physics.lineOfSight(new T.Vector3(...a).add(new T.Vector3(0,1.4,0)),new T.Vector3(...b).add(new T.Vector3(0,1.4,0)));
      const pools=S.buildSpawnPools(walk,visible),again=S.buildSpawnPools(walk,visible);
      const spacing=points=>Math.min(...points.flatMap((p,i)=>points.slice(i+1).map(q=>S.distance(p,q))));
      return {pools,deterministic:JSON.stringify(pools)===JSON.stringify(again),spacing:[pools.coop,...pools.teams].map(spacing),
        walkable:[pools.coop,...pools.teams].every(points=>points.every(p=>S.clearPoint(p,walk))),
        minDistance:Math.min(...pools.teams[0].flatMap(p=>pools.teams[1].map(q=>S.distance(p,q)))),
        visiblePairs:pools.teams[0].reduce((n,p)=>n+pools.teams[1].filter(q=>visible(p,q)).length,0)};
    });
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
    assert.ok(result.deterministic&&result.walkable);assert.equal(result.visiblePairs,0);
    assert.ok(result.spacing.every(n=>n>=1.2));assert.ok(result.minDistance>=40);
    assert.ok([result.pools.coop,...result.pools.teams].every(p=>p.length>=24));
    console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();await app.stop();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
