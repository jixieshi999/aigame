'use strict';
// Optional integration test; uses an already installed Playwright and real game HTML.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createLanServer } = require('../server');
const { RawClient } = require('./raw-client');
const { chromium, executablePath } = require('./browser-runtime');
const output = path.join(__dirname, 'artifacts-ab-c');
fs.mkdirSync(output, { recursive: true });

async function main() {
  const app = createLanServer();
  await new Promise(resolve => app.server.listen(0, '0.0.0.0', resolve));
  const port = app.server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--enable-unsafe-swiftshader', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'] });
  const evidence = { at: new Date().toISOString(), stage:'AB regression on C', executablePath, build: app.build, checks: [], errors: [], failedResponses: [] };
  const contexts = [];
  async function pageFor(name, extra = '') {
    console.log(`浏览器检查：载入 ${name}`);
    const context = await browser.newContext({ viewport: { width: 640, height: 480 } }); contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', error => evidence.errors.push({ name, message: error.message }));
    page.on('console', message => { if (message.type() === 'error') evidence.errors.push({ name, console: message.text() }); });
    page.on('response', response => { if (response.status() >= 400) evidence.failedResponses.push({ url: response.url(), status: response.status() }); });
    await page.goto(`http://127.0.0.1:${port}/?q=low&autostart=1&seed=4207&eseed=9001&lanAuto=1&lanRoom=BROWSER&lanName=${encodeURIComponent(name)}${extra}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__LAN && (__LAN.snapshot().connected || __LAN.snapshot().fatal), null, { timeout: 120000 });
    const snapshot = await page.evaluate(() => __LAN.snapshot());
    assert.ok(snapshot.connected, JSON.stringify(snapshot)); console.log(`浏览器检查：${name} 已加入`);
    return page;
  }
  const snapshot = page => page.evaluate(() => __LAN.snapshot());
  try {
    const a = await pageFor('甲猫');
    // Keep this presentation regression free of ambient combat; C damage has its own suite.
    await a.evaluate(() => __G.enemies.clear());
    const b = await pageFor('<img onerror=alert(1)>');
    await a.waitForFunction(() => __LAN.snapshot().remoteCount === 1 && __LAN.snapshot().mapState.includes('一致'));
    await b.waitForFunction(() => __LAN.snapshot().remoteCount === 1);
    evidence.initial = { a: await snapshot(a), b: await snapshot(b) };
    assert.deepEqual(evidence.initial.a.map, evidence.initial.b.map);
    evidence.checks.push('两个真实游戏客户端完成构建/seed/eseed/碰撞盒/nav握手');
    assert.equal(await a.locator('#lan-panel img').count(), 0);
    // Introduce a synthetic digest disagreement through the actual wire protocol.
    const incompatible = new RawClient(port);
    await incompatible.next('hello');
    incompatible.send({ type: 'join', room: 'BROWSER', nickname: '摘要探针', mode: 'coop', seed: 4207, eseed: 9001,
      map: { ...evidence.initial.a.map, boxes: '0'.repeat(64) } });
    await incompatible.next('joined');
    await a.waitForFunction(() => __LAN.snapshot().mapState.includes('不一致'));
    await b.waitForFunction(() => __LAN.snapshot().mapState.includes('不一致'));
    evidence.mapMismatchWarning = await a.locator('#lan-status').textContent();
    incompatible.destroy();
    await a.waitForFunction(() => __LAN.snapshot().remoteCount === 1 && !__LAN.snapshot().mapWarning);
    evidence.checks.push('合成错误摘要经真实协议触发两端醒目的地图不一致提示，离开后恢复');
    // Before input, record the real exported interfaces and game input bindings.
    evidence.runtime = await a.evaluate(() => ({ state: __G.game.state, player: __G.player.pos.toArray(),
      camera: __G.camera.position.toArray(), audioStub: !!__G.audio.stub, errors: window.__errors,
      weaponState: __G.weapon.state, inputKeys: Object.keys(__G.input), audioNames: __G.audio.names }));
    // Keep the second browser in title/pause naturally when unfocused; it still renders LAN poses.
    await a.bringToFront();
    await a.keyboard.press('F2');
    await a.locator('#view').click({ position: { x: 180, y: 240 } });
    await a.keyboard.down('KeyD');
    await a.waitForTimeout(900);
    await a.keyboard.up('KeyD');
    await b.waitForTimeout(300);
    evidence.movement = { a: await a.evaluate(() => ({ pos: __G.player.pos.toArray(), state: __G.game.state })), b: await snapshot(b) };
    assert.ok(evidence.movement.b.stats.posesReceived > 3);
    assert.ok(Math.hypot(...evidence.movement.a.pos.map((n,i) => n-evidence.runtime.player[i])) > .2, '真实键盘输入应移动本机玩家');
    const remote = evidence.movement.b.remotes[0];
    assert.ok(Math.hypot(...remote.position.map((n,i) => n-evidence.movement.a.pos[i])) < 2, '远端插值应跟随移动');
    evidence.checks.push('真实键盘移动由20Hz消息传输并在另一端插值呈现');
    // Instrument only presentation calls/events on the receiver; never replay game events.
    await b.evaluate(() => {
      window.__lanProbe = { events: {}, muzzle: 0, tracer: 0, audio: [], before: { ...__G.combat.stats } };
      for (const name of ['weapon:fire','player:hit','enemy:alert']) __G.events.on(name, () => { __lanProbe.events[name] = (__lanProbe.events[name] || 0) + 1; });
      for (const name of ['muzzleFlash','tracer']) {
        const original = __G.fx[name]; __G.fx[name] = function (...args) { __lanProbe[name === 'muzzleFlash' ? 'muzzle' : 'tracer']++; return original.apply(this,args); };
      }
      const original = __G.audio.play;
      __G.audio.play = function (name, options) { __lanProbe.audio.push({ name, pos: options && options.pos && options.pos.toArray() }); return original.apply(this,arguments); };
    });
    await a.mouse.down(); await a.waitForTimeout(180); await a.mouse.up();
    await b.waitForFunction(() => __LAN.snapshot().stats.shotsReceived > 0, null, { timeout: 15000 });
    evidence.shooting = { a: await snapshot(a), b: await snapshot(b), probe: await b.evaluate(() => ({ ...__lanProbe, after: { ...__G.combat.stats } })) };
    assert.ok(evidence.shooting.probe.muzzle > 0 && evidence.shooting.probe.tracer > 0);
    assert.ok(evidence.shooting.probe.audio.some(sound => sound.name === 'hound_fire' && sound.pos.length === 3));
    assert.equal(evidence.shooting.probe.events['weapon:fire'] || 0, 0);
    assert.equal(evidence.shooting.probe.events['player:hit'] || 0, 0);
    assert.equal(evidence.shooting.probe.events['enemy:alert'] || 0, 0);
    assert.deepEqual(evidence.shooting.probe.after, evidence.shooting.probe.before);
    evidence.checks.push('真实武器开火跨端触发枪口/弹迹/带位置的world枪声，接收端未产生weapon:fire或统计变化');
    // Camera inspection for visual QA only: hold a fixed shot through the existing public shot camera API.
    for (const [page, other] of [[a, await b.evaluate(() => __G.player.pos.toArray())], [b, evidence.movement.a.pos]]) {
      await page.evaluate(pos => {
        const camera = [pos[0]-3, pos[1]+2.1, pos[2]+4];
        window.__setShot({ cam: [...camera, pos[0],pos[1]+1,pos[2]].join(',') });
        document.getElementById('lan-panel').hidden = false;
      }, other);
      await page.waitForFunction(() => __LAN.snapshot().remotes.some(r => r.visible && r.labelVisible));
      if (page === a) await page.screenshot({ path: path.join(output,'lobby-a.png') });
      await page.evaluate(() => { document.getElementById('lan-panel').hidden = true; });
      await page.waitForTimeout(250);
    }
    await a.screenshot({ path: path.join(output,'client-a.png') }); await b.screenshot({ path: path.join(output,'client-b.png') });
    evidence.visual = { a: await snapshot(a), b: await snapshot(b) };
    evidence.checks.push('两端世界层身体与Canvas名字牌可见；昵称按文本绘制；已保存截图');
    // Real seed disagreement: initial host remains, attempted join gets a corrected URL.
    const wrongContext = await browser.newContext(); contexts.push(wrongContext); const wrong = await wrongContext.newPage();
    await wrong.goto(`http://127.0.0.1:${port}/?q=low&noaudio=1&seed=99&lanAuto=1&lanRoom=BROWSER`);
    await wrong.waitForSelector('#lan-correct-url', { timeout: 120000 });
    evidence.seedCorrection = await wrong.locator('#lan-correct-url').getAttribute('href');
    assert.equal(new URL(evidence.seedCorrection).searchParams.get('seed'),'4207');
    evidence.checks.push('第三个真实页面的错误seed被拒绝并显示房主参数链接');
    await wrongContext.close();
    // Leave the current host and verify remote resources and roster/host promotion.
    const bId = (await snapshot(b)).playerId;
    await a.close();
    await b.waitForFunction(id => __LAN.snapshot().remoteCount === 0 && __LAN.snapshot().hostId === id, bId);
    evidence.afterLeave = await snapshot(b);
    assert.ok(evidence.afterLeave.stats.disposed > 0);
    assert.equal(await b.evaluate(() => __G.scene.children.filter(o => o.userData.lanRemote).length),0);
    evidence.checks.push('房主断开后另一端清除模型并dispose资源，房主顺延');
    evidence.passed = true;
  } catch (error) {
    evidence.failure = error.stack;
    throw error;
  } finally {
    fs.writeFileSync(path.join(output,'browser-results.json'),JSON.stringify(evidence,null,2));
    await browser.close(); await app.stop();
  }
  console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks, map: evidence.initial.a.map,
    probe: evidence.shooting.probe, errors: evidence.errors, failedResponses: evidence.failedResponses },null,2));
}
main().catch(error => { console.error(error.stack); process.exitCode=1; });
