'use strict';
// Read-only verification of an already running local service; never saves an HTML response.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {RawClient}=require('./raw-client');
const {EXPECTED_HASH}=require('../server');
const port=Number(process.argv[2]||8787);
function get(route,method='GET'){return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:route,method},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();
});}
async function main(){
  const html=await get('/'),net=await get('/net.js');assert.equal(html.status,200);assert.equal(net.status,200);
  const original=html.body.toString().replace(/<script src="\/net.js" data-build="[a-f0-9]+"><\/script>\n/,'');
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'),EXPECTED_HASH);
  const files=['combat.js','flow-shared.js','flow-coop.js','net.js'];
  const expected=files.map(name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8')).join('\n;\n');
  assert.equal(net.body.toString(),expected);
  assert.equal((await get('/','HEAD')).status,200);assert.equal((await get('/net.js','HEAD')).status,200);
  assert.equal((await get('/flow-coop.js')).status,404);
  const c=new RawClient(port);let hello,error;
  try{hello=await c.next('hello');assert.equal(hello.v,3);c.send({v:2,type:'join'});error=await c.next('error');assert.equal(error.code,'versionMismatch');}
  finally{c.destroy();}
  const report={at:new Date().toISOString(),port,protocol:hello.v,build:hello.build,sourceSha256:EXPECTED_HASH,modules:files,oldPageRejected:error.reason,verified:true};
  fs.writeFileSync(path.join(__dirname,'live-d-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
