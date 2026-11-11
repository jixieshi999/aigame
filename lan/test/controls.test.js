'use strict';
// Real input regression: a sequential host refresh must not freeze the local controller.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createLanServer } = require('../server');
const { RawClient } = require('./raw-client');
const { chromium, executablePath } = require('./browser-runtime');

async function main() {
  const output = path.join(__dirname, 'artifacts-controls');
  fs.mkdirSync(output, { recursive: true });
  const app = createLanServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  let browser, peer, timer;
  const report = { at: new Date().toISOString(), checks: [], errors: [] };
  const read = page => page.evaluate(() => ({ lan: __LAN.snapshot(), game: __G.game.state, alive: __G.player.alive,
    enabled: __G.player.enabled, pos: __G.player.pos.toArray(), yaw: __G.player.yaw, pitch: __G.player.pitch,
    frame: __frames, focused: document.activeElement?.id, locked: !!document.pointerLockElement,
    mode: __G.input.mode, panel: !document.getElementById('lan-panel').hidden, prompt: document.getElementById('lan-status').textContent }));
  async function controls(page) {
    await page.bringToFront();
    if (await page.locator('#lan-panel').isVisible()) await page.keyboard.press('F2');
    if (await page.evaluate(() => __G.game.state === 'paused')) await page.locator('[data-act="resume"]').click();
    else await page.locator('#view').click({ position: { x: 160, y: 250 } });
    await page.waitForTimeout(200);
    const before = await read(page);
    await page.mouse.move(260, 280, { steps: 10 });
    await page.waitForTimeout(250);
    const looked = await read(page);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(800);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(100);
    const after = await read(page);
    return { before, looked, after, distance: Math.hypot(...after.pos.map((n, i) => n - before.pos[i])),
      look: Math.abs(looked.yaw - before.yaw) + Math.abs(looked.pitch - before.pitch) };
  }
  try {
    browser = await chromium.launch({ headless: true, executablePath,
      args: ['--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on('pageerror', error => report.errors.push(error.message));
    console.log('载入真实游戏：使用普通开始流程，不固定相机或修改输入状态');
    await page.goto(`http://127.0.0.1:${port}/?q=low&lanAuto=1&lanRoom=CONTROLS&lanName=房主`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__LAN && (__LAN.snapshot().fatal || __LAN.snapshot().combat?.state === 'active'), null, { timeout: 120000 });
    assert.equal((await read(page)).lan.fatal, false);
    await page.evaluate(() => __G.enemies.clear());
    const original = (await read(page)).lan;
    peer = new RawClient(port); await peer.next('hello');
    peer.send({ type: 'join', room: 'CONTROLS', nickname: '另一个浏览器', mode: 'coop', seed: original.seed, eseed: original.eseed, map: original.map });
    const joined = await peer.next('joined');
    let seq = 0;
    timer = setInterval(() => peer.send({ type: 'pose', roundId: joined.roundId, seq: ++seq, pos: [-26,0,6], yaw: 0, pitch: 0,
      crouching: false, sprinting: false, ads: 0, alive: true, reloading: false }), 100);
    await page.waitForFunction(() => __LAN.snapshot().remoteCount === 1);
    report.active = await controls(page);
    assert.ok(report.active.distance > .5, '活动战斗必须响应真实WASD');
    assert.ok(report.active.look > .01, '活动战斗必须响应真实鼠标');
    report.checks.push('活动战斗真实鼠标和WASD可操作，名字牌存在');
    console.log('PASS: 活动战斗真实鼠标和WASD可操作');

    console.log('刷新房主，保留另一位在线成员后重新加入原房间');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__LAN && __LAN.snapshot().connected && __LAN.snapshot().combat?.state === 'ended', null, { timeout: 120000 });
    report.afterRefresh = await controls(page);
    console.log(JSON.stringify({ afterRefresh: { state: report.afterRefresh.after.game, combat: report.afterRefresh.after.lan.combat.state,
      distance: report.afterRefresh.distance, look: report.afterRefresh.look, frames: report.afterRefresh.after.frame - report.afterRefresh.before.frame,
      prompt: report.afterRefresh.after.prompt } }, null, 2));
    assert.ok(report.afterRefresh.distance > .5, '刷新后本轮结束也必须保留本机WASD控制');
    assert.ok(report.afterRefresh.look > .01, '刷新后本轮结束也必须保留本机鼠标控制');
    assert.equal(report.afterRefresh.after.lan.combat.sourceActive, 0, '已结束轮次不能产生未同步的静止敌人');
    assert.match(report.afterRefresh.after.prompt, /结束|重开/);
    report.checks.push('房主刷新后旧轮结束，仍可真实移动/转向，且显示重开提示');

    clearInterval(timer); timer = null; peer.destroy();
    await page.waitForFunction(() => __LAN.snapshot().hostId === __LAN.snapshot().playerId);
    if (await page.evaluate(() => !!document.pointerLockElement)) await page.keyboard.press('F2');
    else if (!await page.locator('#lan-panel').isVisible()) await page.keyboard.press('F2');
    await page.locator('#lan-reset').click();
    await page.waitForFunction(() => __LAN.snapshot().combat.state === 'active');
    await page.evaluate(() => __G.enemies.clear());
    report.restarted = await controls(page);
    assert.ok(report.restarted.distance > .5 && report.restarted.look > .01);
    report.checks.push('房主明确重开后，战斗与真实键鼠继续正常');
    await page.keyboard.press('F2');
    await page.waitForTimeout(400);
    assert.equal((await read(page)).game, 'paused');
    await page.keyboard.press('F2');
    await page.locator('[data-act="resume"]').click();
    report.resumed = await controls(page);
    assert.ok(report.resumed.distance > .5 && report.resumed.look > .01);
    report.checks.push('F2打开大厅暂停，收起并继续后真实键鼠恢复');
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) { report.failure = error.stack; throw error; }
  finally {
    clearInterval(timer); if (peer) peer.destroy();
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close(); await app.stop();
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks }, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
