/* Server-injected multiplayer bridge; combat.js supplies phase C authority and puppets. */
(function () {
  'use strict';
  const VERSION = 3;

  // SHA-256 fallback is needed on plain HTTP LAN origins without Web Crypto subtle.
  function sha256(value) {
    const input = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const data = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
    data.set(input); data[input.length] = 128;
    const view = new DataView(data.buffer);
    view.setUint32(data.length - 8, Math.floor(input.length / 0x20000000));
    view.setUint32(data.length - 4, (input.length * 8) >>> 0);
    const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const w = new Uint32Array(64);
    const rotate = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let j = 0; j < 16; j++) w[j] = view.getUint32(offset + j * 4);
      for (let j = 16; j < 64; j++) {
        const a = w[j - 15], b = w[j - 2];
        w[j] = (w[j - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[j - 7] +
          (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0;
      }
      let [a,b,c,d,e,f,g,z] = h;
      for (let j = 0; j < 64; j++) {
        const t = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[j] + w[j]) >>> 0;
        const u = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        z=g; g=f; f=e; e=(d+t)>>>0; d=c; c=b; b=a; a=(t+u)>>>0;
      }
      [a,b,c,d,e,f,g,z].forEach((n, j) => { h[j] = (h[j] + n) >>> 0; });
    }
    return h.map(n => n.toString(16).padStart(8, '0')).join('');
  }
  function rounded(value) {
    if (!Number.isFinite(value)) throw new Error('地图包含无效坐标');
    return Math.round(value * 1000) || 0;
  }
  function summarizeMap(physics) {
    const boxes = physics.boxes.map(box => JSON.stringify([
      rounded(box.min.x), rounded(box.min.y), rounded(box.min.z),
      rounded(box.max.x), rounded(box.max.y), rounded(box.max.z),
      +!!box.noNav, +!!box.bulletOnly, +!!box.playerOnly, String(box.surface || ''), String(box.tag || '')
    ])).sort();
    const grid = typeof physics.nav._grid === 'function' ? physics.nav._grid() : physics.nav._grid;
    if (!grid || grid.blocked.length !== grid.w * grid.h) throw new Error('导航网格不可用');
    return { schema: 'static-v1', boxes: sha256(JSON.stringify(['static-v1', boxes])),
      nav: sha256(JSON.stringify(['static-v1', grid.w, grid.h, rounded(grid.minX), rounded(grid.minZ),
        rounded(grid.cell), Array.from(grid.blocked, Number)])),
      boxCount: boxes.length, navWidth: grid.w, navHeight: grid.h };
  }
  function effectiveSeed(value, fallback) {
    const n = Number(value || fallback);
    if (!Number.isFinite(n)) throw new Error('seed/eseed 必须是有限数值');
    return n | 0;
  }
  const angleLerp = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
  /** Bounded interpolation/extrapolation, independent of the single-player clock. */
  function interpolate(samples, target) {
    if (!samples.length) return null;
    let left = samples[0], right = left;
    for (const sample of samples) {
      if (sample.at <= target) left = sample;
      if (sample.at >= target) { right = sample; break; }
      right = sample;
    }
    if (target > right.at && samples.length > 1) {
      const previous = samples[samples.length - 2], span = right.at - previous.at;
      const factor = span > 0 ? Math.min(target - right.at, 100) / span : 0;
      return { ...right, pos: right.pos.map((n, j) => n + Math.max(-1, Math.min(1, (n - previous.pos[j]) * factor))) };
    }
    const factor = right.at > left.at ? Math.max(0, Math.min(1, (target - left.at) / (right.at - left.at))) : 0;
    return { ...left, pos: left.pos.map((n, j) => n + (right.pos[j] - n) * factor),
      yaw: angleLerp(left.yaw, right.yaw, factor), pitch: left.pitch + (right.pitch - left.pitch) * factor,
      ads: left.ads + (right.ads - left.ads) * factor };
  }
  if (typeof window === 'undefined') {
    module.exports = { sha256, summarizeMap, effectiveSeed, interpolate };
    return;
  }
  if (window.__LAN) return;
  const servedBuild = document.currentScript && document.currentScript.dataset.build;
  const query = new URLSearchParams(location.search);
  const remotes = new Map();
  let G, map, seed, eseed, socket, selfId, roundId, hostId, members = [], poseSeq = 0, shotSeq = 0, combat, battleEnded = false;
  let closingPage = false;
  let clockOffset = null, labelAt = 0, fxWindow = 0, fxCount = 0, fatal = false, ready = false;
  let mapState = '等待游戏就绪', mapWarning = '', lastFxError = '';
  const stats = { posesSent: 0, posesReceived: 0, shotsSent: 0, shotsReceived: 0, fxPlayed: 0, disposed: 0 };
  const timers = [];
  const vectorValues = v => [Number(v.x), Number(v.y), Number(v.z)];
  const colors = [0x48b7fa, 0xff865d];

  function element(tag, text, parent, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }
  const style = element('style', undefined, document.head);
  style.textContent = `
    #lan-panel,#lan-toggle,#lan-status{font:14px/1.5 "Microsoft YaHei",sans-serif;box-sizing:border-box;color:#ecf4ff}
    #lan-panel{position:fixed;top:48px;right:16px;width:336px;max-width:94vw;max-height:82vh;overflow:auto;padding:18px;background:rgba(9,20,32,.96);border:1px solid #425f7d;border-radius:12px;z-index:2147483000;box-shadow:0 12px 44px #0008}
    #lan-panel[hidden],#lan-toggle[hidden]{display:none!important}
    #lan-panel h2{font-size:18px;margin:0 0 8px}#lan-panel p{margin:8px 0}#lan-panel label{display:block;margin:8px 0}
    #lan-panel input,#lan-panel select{display:block;width:100%;padding:7px;background:#142b40;color:#fff;border:1px solid #4b6580;border-radius:5px}
    #lan-panel button,#lan-toggle{padding:7px 12px;background:#214d70;color:#fff;border:1px solid #5a86a6;border-radius:6px;cursor:pointer}
    #lan-panel button:disabled{opacity:.5;cursor:wait}#lan-panel ul{padding-left:20px}#lan-panel a{color:#8ed6ff;word-break:break-all}
    #lan-panel .lan-note{font-size:12px;color:#adbfce}#lan-status{position:fixed;top:8px;left:50%;transform:translateX(-50%);max-width:72vw;z-index:2147483001;background:#081523d9;border-radius:5px;padding:4px 12px;pointer-events:none}
    #lan-status[data-warning="true"]{background:#672c19ed;color:#fff3cc}#lan-toggle{position:fixed;top:8px;right:16px;z-index:2147483000}
    #lan-rotate{display:none;position:fixed;inset:0;z-index:2147482999;align-items:center;justify-content:center;background:#06111cf2;color:#edf5ff;text-align:center;padding:28px;font:600 18px/1.6 "Microsoft YaHei",sans-serif}
    #lan-touch-interact{display:none;position:fixed;right:24px;bottom:128px;z-index:2147482998;padding:13px 17px;border:2px solid #8ed6ff;border-radius:50%;background:#102d44e8;color:#fff;font:600 15px/1 "Microsoft YaHei",sans-serif;touch-action:none;user-select:none}
    @media (max-width:700px) and (orientation:portrait){#lan-rotate{display:flex}}
    @media (pointer:coarse){#lan-touch-interact{display:block}}
  `;
  const panel = element('section', undefined, document.body); panel.id = 'lan-panel'; panel.setAttribute('aria-label', '局域网联机大厅');
  element('h2', '几猫 · 局域网联机', panel);
  element('p', '合作：共享中继、波次、复活与撤离', panel, 'lan-note');
  function field(text, id, value, max) {
    const label = element('label', text, panel), input = element('input', undefined, label);
    input.id = id; input.value = value; input.maxLength = max; return input;
  }
  const nameInput = field('昵称', 'lan-name', query.get('lanName') || `玩家${Date.now() % 10000}`, 20);
  const roomInput = field('房间号（字母、数字、下划线或短横线）', 'lan-room', query.get('lanRoom') || 'CAT', 32);
  const modeLabel = element('label', '房间模式', panel), modeInput = element('select', undefined, modeLabel); modeInput.id = 'lan-mode';
  for (const [value, text] of [['coop', '合作（同阵营）'], ['pvp', '双队对抗（可互相射击）']]) {
    const option = element('option', text, modeInput); option.value = value;
  }
  modeInput.value = query.get('lanMode') === 'pvp' ? 'pvp' : 'coop';
  const connectButton = element('button', '连接房间', panel); connectButton.id = 'lan-connect'; connectButton.disabled = true;
  const leaveButton = element('button', '离开房间', panel); leaveButton.id = 'lan-leave'; leaveButton.disabled = true; leaveButton.style.marginLeft = '8px';
  const resetButton = element('button', '房主重开战斗', panel); resetButton.id = 'lan-reset'; resetButton.disabled = true; resetButton.style.marginTop = '8px';
  const combatText = element('p','尚未连接战斗',panel); combatText.id='lan-combat';
  const statusText = element('p', '等待游戏初始化…', panel); statusText.id = 'lan-connection';
  const mapText = element('p', mapState, panel); mapText.id = 'lan-map';
  const correction = element('p', undefined, panel); correction.hidden = true;
  const list = element('ul', undefined, panel); list.id = 'lan-players';
  element('p', 'F2 打开/收起大厅。锁鼠时 F2 先释放鼠标。关闭大厅后点击原游戏继续。', panel, 'lan-note');
  element('p', '按住 E 或触屏交互键切断中继；倒下10秒后点击或按 Enter 复活。三处全断后全体存活队员撤离；暂停时世界继续。双队对抗按房主权威判定玩家命中。', panel, 'lan-note');
  const toggle = element('button', '联机大厅 F2', document.body); toggle.id = 'lan-toggle';
  const badge = element('div', '联机：等待游戏就绪', document.body); badge.id = 'lan-status';
  const rotateNotice = element('div', '请将手机横向握持以获得完整视野；若浏览器未自动旋转，请打开系统自动旋转。', document.body); rotateNotice.id='lan-rotate';
  const touchInteract = element('button', '交互', document.body); touchInteract.id='lan-touch-interact'; touchInteract.setAttribute('aria-label','按住交互');
  let touchInteractHeld=false;
  function setTouchInteract(held,event){touchInteractHeld=held;window.__lanInteractHeld=held;if(event){event.preventDefault();event.stopPropagation();}}
  for(const type of ['pointerdown','touchstart'])touchInteract.addEventListener(type,e=>{if(type==='pointerdown'&&e.pointerId!=null)touchInteract.setPointerCapture?.(e.pointerId);setTouchInteract(true,e)},{passive:false});
  for(const type of ['pointerup','pointercancel','pointerleave','touchend','touchcancel'])touchInteract.addEventListener(type,e=>setTouchInteract(false,e),{passive:false});
  window.__lanInteractHeld=false;
  function tryLandscape(){
    if(!('ontouchstart' in window)&&!navigator.maxTouchPoints)return;
    try{document.documentElement.requestFullscreen?.().then(()=>{if(screen.orientation?.lock){const pending=screen.orientation.lock('landscape');pending?.catch?.(()=>{});}}).catch(()=>{});}catch{}
    try{if(screen.orientation?.lock){const pending=screen.orientation.lock('landscape');pending?.catch?.(()=>{});}}catch{}
  }
  window.addEventListener('orientationchange',()=>{rotateNotice.hidden=innerWidth>=innerHeight;});
  window.addEventListener('pointerdown',tryLandscape,{once:true,passive:true});
  function status(text) { statusText.textContent = text; updateBadge(); }
  function updateBadge() {
    badge.textContent = mapWarning || (battleEnded ? '本轮已结束 · 房主按 F2 重开战斗' : `${statusText.textContent} · ${mapState}`);
    badge.dataset.warning = String(!!mapWarning || fatal || battleEnded);
    mapText.textContent = mapState;
  }
  function locked() {
    if (document.pointerLockElement) { panel.hidden = true; toggle.hidden = true; }
    else toggle.hidden = false;
  }
  function showPanel() {
    if (document.pointerLockElement) { document.exitPointerLock(); panel.hidden = false; }
    else panel.hidden = !panel.hidden;
  }
  toggle.addEventListener('click', showPanel);
  document.addEventListener('pointerlockchange', locked);
  function hotkey(event) {
    if (event.code === 'F2') { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) showPanel(); }
  }
  window.addEventListener('keydown', hotkey, true);
  // Only consume input aimed at this independent panel, leaving gameplay input intact.
  for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup', 'click', 'wheel', 'pointerdown', 'pointerup']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }

  function makeRemote(info) {
    const T = G.THREE, root = new T.Group(), body = new T.Group(); root.add(body);
    root.userData.lanRemote = info.playerId; root.layers.set(0);
    const geometry = new T.BoxGeometry(1, 1, 1);
    const suit = new T.MeshStandardMaterial({ color: colors[info.team], roughness: .8 });
    const dark = new T.MeshStandardMaterial({ color: 0x15222c, roughness: .8 });
    const skin = new T.MeshStandardMaterial({ color: 0xe7c6a1, roughness: .9 });
    function box(parent, size, position, material) {
      const mesh = new T.Mesh(geometry, material); mesh.scale.set(...size); mesh.position.set(...position);
      mesh.layers.set(0); mesh.castShadow = false; mesh.receiveShadow = false; parent.add(mesh); return mesh;
    }
    box(body, [.48,.62,.28], [0,1.08,0], suit);
    box(body, [.21,.77,.23], [-.135,.385,0], dark); box(body, [.21,.77,.23], [.135,.385,0], dark);
    const aim = new T.Group(); aim.position.y = 1.38; body.add(aim);
    box(aim, [.3,.33,.3], [0,.22,0], skin);
    box(aim, [.15,.16,.52], [-.32,-.18,-.14], suit); box(aim, [.15,.16,.52], [.32,-.18,-.14], suit);
    const gun = box(aim, [.13,.16,.72], [.23,-.17,-.49], dark);
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    const font = '600 28px "Microsoft YaHei",sans-serif', padding = 12, maxTextWidth = 376;
    context.font = font;
    const characters = Array.from(info.nickname);
    let nickname = info.nickname;
    while (context.measureText(nickname).width > maxTextWidth && characters.length) {
      characters.pop(); nickname = characters.join('') + '…';
    }
    // Render at twice the display resolution; the background hugs the measured name.
    canvas.width = Math.ceil(context.measureText(nickname).width) + padding * 2; canvas.height = 42;
    context.font = font; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillStyle = 'rgba(5,14,24,.48)'; context.beginPath(); context.roundRect(0,0,canvas.width,canvas.height,8); context.fill();
    context.fillStyle = info.team === 0 ? '#a1e0ff' : '#ffc0a7'; context.fillText(nickname, canvas.width / 2, canvas.height / 2 + 1);
    const texture = new T.CanvasTexture(canvas);
    if (T.SRGBColorSpace) texture.colorSpace = T.SRGBColorSpace;
    const labelMaterial = new T.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false, sizeAttenuation: false });
    const label = new T.Sprite(labelMaterial); label.layers.set(0); label.center.set(.5, 0);
    label.position.y = 1.95; label.scale.set(0,0,1);
    root.add(label); root.visible = false; G.scene.add(root);
    return { info, root, body, aim, gun, label, labelAspect: canvas.width / canvas.height, samples: [], seq: -1, shotSeq: -1, lastReceived: 0, updatedAt: -Infinity,
      distance: Infinity, projected: new T.Vector3(), disposed: false };
  }
  function removeRemote(id) {
    const remote = remotes.get(id); if (!remote) return;
    remote.root.removeFromParent();
    const geometries = new Set(), materials = new Set(), textures = new Set();
    remote.root.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (material) { materials.add(material); if (material.map) textures.add(material.map); }
      }
    });
    for (const item of [...geometries, ...materials, ...textures]) item.dispose();
    remote.disposed = true; stats.disposed++; remotes.delete(id);
  }
  function clearRemote() { for (const id of [...remotes.keys()]) removeRemote(id); }
  function updateRoster(players) {
    members = players; list.replaceChildren();
    for (const info of players) {
      element('li', `${info.nickname}${info.playerId === selfId ? '（你）' : ''}${info.playerId === hostId ? ' ★房主' : ''} · 阵营${info.team + 1}`, list);
      if (info.playerId === selfId) continue;
      if (!remotes.has(info.playerId)) remotes.set(info.playerId, makeRemote(info));
      if (info.pose) receivePose(info.pose);
    }
    for (const id of [...remotes.keys()]) if (!players.some(p => p.playerId === id)) removeRemote(id);
  }
  function receivePose(message) {
    if (combat) combat.pose(message);
    const remote = remotes.get(message.playerId);
    if (!remote || message.seq <= remote.seq) return;
    remote.seq = message.seq; remote.lastReceived = performance.now();
    const offset = remote.lastReceived - message.at;
    clockOffset = clockOffset === null ? offset : Math.min(clockOffset + .02, offset);
    remote.samples.push(message);
    if (remote.samples.length > 32) remote.samples.shift();
    stats.posesReceived++;
  }
  function remoteShot(message) {
    const remote = remotes.get(message.playerId);
    if (!remote || message.seq <= remote.shotSeq) return;
    remote.shotSeq = message.seq; stats.shotsReceived++;
    const now = performance.now();
    if (now - fxWindow >= 1000) { fxWindow = now; fxCount = 0; }
    const T = G.THREE, origin = new T.Vector3(...message.origin), dir = new T.Vector3(...message.dir), muzzle = new T.Vector3(...message.muzzle);
    if (G.camera.position.distanceToSquared(muzzle) > 80 * 80 || fxCount >= 40) return;
    fxCount++;
    try {
      // These two FX functions emit no game events. Never call playerShot or events.emit here.
      const hit = G.physics.raycast(origin, dir, 300);
      const end = origin.clone().addScaledVector(dir, hit ? hit.dist : 300);
      G.fx.muzzleFlash(muzzle, dir, { scale: .7 });
      G.fx.tracer(muzzle, end, { intensity: 10, width: .018, trail: false });
      // rifle_shot is permanently routed to the original near bus, even with pos.
      // hound_fire is a world-bus gun report and therefore actually uses a panner.
      G.audio.play('hound_fire', { pos: muzzle.clone(), gain: .55, ref: 12, roll: 1.2 });
      stats.fxPlayed++;
    } catch (error) { lastFxError = String(error.message || error); console.warn('[LAN] 远端特效失败', error); }
  }
  function send(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 65536) return false;
    socket.send(JSON.stringify({ ...data, v: VERSION })); return true;
  }
  function resetConnection() {
    touchInteractHeld=false;window.__lanInteractHeld=false;touchInteract.hidden=true;
    if (combat) combat.detach(!closingPage);
    clearRemote(); members = []; selfId = null; roundId = null; hostId = null; clockOffset = null; battleEnded = false;
    list.replaceChildren(); connectButton.disabled = !ready || fatal; leaveButton.disabled = true; resetButton.disabled = true;
    combatText.textContent='尚未连接战斗';
    for (const input of [nameInput, roomInput, modeInput]) input.disabled = false;
  }
  function disconnect() {
    if (socket) { const old = socket; socket = null; old.close(1000, '离开房间'); }
    resetConnection(); mapState = '尚未连接'; mapWarning = ''; status('已离开房间');
  }
  function showCorrection(message) {
    const url = new URL(location.href); url.searchParams.set('seed', message.seed); url.searchParams.set('eseed', message.eseed);
    url.searchParams.set('lanRoom', message.room); url.searchParams.set('lanName', nameInput.value);
    url.searchParams.set('lanMode', message.mode); url.searchParams.set('lanAuto', '1');
    if(query.get('lanMap')==='warehouse')url.searchParams.set('lanMap','warehouse');
    correction.replaceChildren(); correction.hidden = false;
    element('span', '房主地图链接：', correction);
    const link = element('a', url.href, correction); link.href = url.href; link.id = 'lan-correct-url';
  }
  function connect() {
    if (!ready || fatal) return;
    tryLandscape();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(roomInput.value.trim())) { status('房间号格式无效'); return; }
    disconnect(); correction.hidden = true; mapWarning = ''; mapState = '正在核对地图';
    const current = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`); socket = current;
    connectButton.disabled = true; leaveButton.disabled = false;
    for (const input of [nameInput, roomInput, modeInput]) input.disabled = true;
    status('正在连接服务器…');
    current.addEventListener('message', event => {
      if (socket !== current) return;
      let message;
      try { message = JSON.parse(event.data); } catch { status('服务器消息格式错误'); current.close(); return; }
      if (message.v !== VERSION) { status('服务器协议版本不兼容'); current.close(); return; }
      if (message.type === 'hello') {
        if (message.build !== servedBuild) { mapWarning = '构建版本已变化，请刷新页面'; status('构建版本不兼容'); current.close(); return; }
        send({ type: 'join', room: roomInput.value.trim(), nickname: nameInput.value, mode: modeInput.value, seed, eseed, map });
      } else if (message.type === 'joined') {
        selfId = message.playerId; roundId = message.roundId; hostId = message.hostId; poseSeq = 0; shotSeq = 0; battleEnded = message.combatStatus === 'ended';
        roomInput.value = message.room; updateRoster(message.players);
        combat.initialize(message); resetButton.disabled=selfId!==hostId;
        status(`已连接：房间 ${message.room}`);
      } else if (message.type === 'combatReset') {
        roundId=message.roundId;hostId=message.hostId;poseSeq=shotSeq=0;battleEnded=false;
        clearRemote();updateRoster(message.players);combat.initialize({...message,playerId:selfId});resetButton.disabled=selfId!==hostId;
      } else if (message.type === 'error') {
        if (message.code === 'seedMismatch') showCorrection(message);
        if (message.code === 'modeMismatch') modeInput.value = message.mode;
        mapWarning = message.reason; status(message.reason); panel.hidden = false;
      } else if (message.roundId === roundId) {
        if (message.type === 'roster') { hostId = message.hostId; updateRoster(message.players); combat.roster(message.players); resetButton.disabled=selfId!==hostId; }
        if (message.type === 'leave') removeRemote(message.playerId);
        if (message.type === 'pose') receivePose(message);
        if (message.type === 'shot') remoteShot(message);
        if (['shotIntent','reloadIntent','hazardIntent','interactIntent','respawnIntent'].includes(message.type)) combat.intent(message);
        if (message.type === 'world') combat.world(message);
        if (message.type === 'combatEvent') combat.event(message);
        if (message.type === 'authorityStatus') {hostId=message.hostId;battleEnded=message.status==='ended';combat.status(message);resetButton.disabled=selfId!==hostId;updateBadge();}
        if (message.type === 'mapMismatch' || message.type === 'mapStatus') {
          mapState = message.ok ? '地图一致 ✓' : '地图不一致 ⚠'; mapWarning = message.ok ? '' : message.reason; updateBadge();
          combat.setMap(message.ok);
        }
      }
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      socket = null; resetConnection(); mapState = '连接已关闭'; status(mapWarning || '连接已断开，请重新连接');
    });
    current.addEventListener('error', () => { if (socket === current) status('连接失败，请确认服务器及网络'); });
  }
  connectButton.addEventListener('click', connect); leaveButton.addEventListener('click', disconnect);
  resetButton.addEventListener('click',()=>send({type:'roundReset',roundId}));

  function animate(now) {
    if (!ready || fatal) return;
    const target = now - (clockOffset || 0) - 100;
    if (combat) combat.render(now);
    for (const remote of remotes.values()) {
      const pose = interpolate(remote.samples, target);
      if (!pose) continue;
      remote.projected.set(...pose.pos);
      remote.distance = G.camera.position.distanceTo(remote.projected);
      const visible = pose.alive && remote.distance <= 120 && now - remote.lastReceived < 3000;
      remote.root.visible = visible;
      if (!visible || now - remote.updatedAt < (remote.distance > 35 ? 100 : 32)) continue;
      remote.updatedAt = now;
      remote.root.position.set(...pose.pos); remote.root.rotation.y = pose.yaw;
      remote.body.scale.y = pose.crouching ? .64 : 1;
      remote.aim.rotation.x = pose.pitch;
      remote.gun.rotation.z = pose.reloading ? -.55 : 0;
      remote.gun.position.z = -.49 + pose.ads * .08;
      remote.label.position.y = pose.crouching ? 1.35 : 1.95;
      while (remote.samples.length > 2 && remote.samples[1].at < target - 200) remote.samples.shift();
    }
    if (now - labelAt >= 200) {
      labelAt = now; let count = 0;
      for (const remote of [...remotes.values()].sort((a,b) => a.distance - b.distance)) {
        remote.projected.copy(remote.root.position); remote.projected.y += remote.label.position.y; remote.projected.project(G.camera);
        remote.label.visible = remote.root.visible && remote.distance < 50 && count < 8 &&
          remote.projected.z >= -1 && remote.projected.z <= 1 && Math.abs(remote.projected.x) < 1.2 && Math.abs(remote.projected.y) < 1.2;
        if (remote.label.visible) {
          count++;
          // A 21px plate (14px text) stays compact even when another player is very close.
          const height = 42 * Math.tan(G.camera.fov * Math.PI / 360) /
            (Math.max(1, G.renderer.domElement.clientHeight) * (G.camera.zoom || 1));
          remote.label.scale.set(height * remote.labelAspect, height, 1); remote.label.material.opacity = Math.min(1, (50 - remote.distance) / 15);
        }
      }
    }
    requestAnimationFrame(animate);
  }
  function start() {
    G = window.__G;
    if(query.get('lanMap')==='warehouse') window.LanWarehouse?.install(G);
    combat = window.LanCombat.create({G,send,onStatus:text=>{combatText.textContent=text;}});
    map = summarizeMap(G.physics);
    seed = effectiveSeed(G.params.seed, 4207); eseed = effectiveSeed(G.params.eseed, 9001);
    ready = true; connectButton.disabled = false; mapState = '地图摘要就绪'; status('尚未连接');
    G.events.on('weapon:fire', event => {
      if (!selfId || !event || !event.origin || !event.dir) return;
      // The original event carries reused THREE vectors: copy numbers synchronously.
      const seq=++shotSeq;
      if (send({ type: 'shot', roundId, seq, origin: vectorValues(event.origin), dir: vectorValues(event.dir),
        muzzle: vectorValues(event.muzzle || event.origin) })) {stats.shotsSent++;combat.noteShot(seq);}
    });
    timers.push(setInterval(() => {
      if (!selfId) return;
      const player = G.player;
      if (send({ type: 'pose', roundId, seq: ++poseSeq, pos: vectorValues(player.pos), yaw: Number(player.yaw), pitch: Number(player.pitch),
        crouching: !!player.crouching, sprinting: !!player.sprinting, ads: Math.max(0, Math.min(1, Number(player.ads) || 0)),
        alive: !!player.alive, reloading: G.weapon.state === 'reload' || G.weapon.state === 'reloading' })) stats.posesSent++;
    }, 50));
    requestAnimationFrame(animate); locked();
    if (query.get('lanAuto') === '1') connect();
  }
  function fail(reason) {
    fatal = true; connectButton.disabled = true; mapWarning = reason; mapState = '无法接入'; status(reason);
  }
  const waitingSince = performance.now();
  const waiting = setInterval(() => {
    if (window.__fatal) { clearInterval(waiting); fail('游戏启动失败，联机未接入'); return; }
    const game = window.__G;
    if (game && game.showcase) { clearInterval(waiting); fail('展示模式不接入联机，请移除 URL 的 show 参数'); return; }
    if (window.__ready && game && ['THREE','scene','camera','player','physics','fx','audio','events','weapon'].every(key => game[key])) {
      clearInterval(waiting);
      if (game.player.stub || game.physics.stub || game.fx.stub) { fail('游戏模块退回空实现，无法接入联机'); return; }
      try { start(); } catch (error) { fail(`联机初始化失败：${error.message}`); }
    } else if (performance.now() - waitingSince > 120000) { clearInterval(waiting); fail('游戏初始化超时，请刷新后重试'); }
  }, 100);
  timers.push(waiting);
  window.addEventListener('pagehide', () => { closingPage=true;for (const timer of timers) clearInterval(timer); disconnect();if(combat)combat.destroy(); }, { once: true });
  // Read-only diagnostics for inspection and reproducible browser verification.
  window.__LAN = Object.freeze({ snapshot: () => ({ ready, fatal, connected: !!selfId, playerId: selfId, roundId, hostId,
    build: servedBuild, seed, eseed, map: map && { ...map }, mapState, mapWarning, members: members.map(p => ({ playerId: p.playerId, nickname: p.nickname, team: p.team })),
    remoteCount: remotes.size, remotes: [...remotes.values()].map(r => ({ playerId: r.info.playerId, nickname: r.info.nickname,
      position: r.root.position.toArray(), visible: r.root.visible, labelVisible: r.label.visible, bufferSize: r.samples.length })),
    stats: { ...stats }, combat:combat&&combat.snapshot(), lastFxError }) });
})();
