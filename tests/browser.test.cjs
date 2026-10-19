'use strict';

// 零依赖真实浏览器验收：使用 Node 内置 WebSocket 连接 Chrome DevTools Protocol。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mediaDownloads() {
  const directory = path.join(os.homedir(), 'Downloads', 'Music');
  let names;
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = await Promise.all(names.filter(name => /flip|close/i.test(name)).map(async name => {
    const info = await fs.stat(path.join(directory, name));
    return {name, size:info.size, modified:info.mtimeMs};
  }));
  return files.sort((a,b) => a.name.localeCompare(b.name));
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.errors = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    });
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 6000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async until(expression, timeout = 5000) {
    const deadline = Date.now() + timeout;
    do {
      if (await this.eval(expression)) return;
      await sleep(20);
    } while (Date.now() < deadline);
    throw new Error(`页面等待超时：${expression}`);
  }
  async click(selector, realMouse = false) {
    if (!realMouse) return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const position = await this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
  }
  async input(text) {
    return this.eval(`(() => { const editor = document.querySelector('#diary-content'); editor.focus(); editor.value = ${JSON.stringify(text)}; editor.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  }
  async motion(reduce) {
    await this.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
  }
  close() {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('浏览器连接已关闭')); }
    this.pending.clear();
    this.socket.close();
  }
}

async function makeHarness() {
  const candidates = [process.env.DAYLORE_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  let executable;
  for (const item of candidates) { try { await fs.access(item); executable = item; break; } catch {} }
  if (!executable) throw new Error('找不到 Chrome/Edge，请设置 DAYLORE_BROWSER 为浏览器可执行文件路径。');
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const profile = await fs.mkdtemp(path.join(temporaryRoot, 'daylore-browser-'));
  let browser;
  let cdp;
  let downloadMonitor;
  let violation = '';
  const mediaRequests = [];
  const downloadsBefore = await mediaDownloads();
  const stopForViolation = (reason) => {
    violation = reason;
    cdp?.close();
    if (browser && browser.exitCode === null) browser.kill();
  };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (/\.(?:mp3|m4a|wav|ogg)$/i.test(pathname)) {
        mediaRequests.push(pathname);
        response.writeHead(403).end();
        stopForViolation('浏览器禁止请求真实媒体：' + pathname);
        return;
      }
      const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };
      const content = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': content.byteLength, 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  // 所有资源均在 finally 中关闭；删除前校验真实路径，严格限制到此次创建的临时目录。
  async function dispose() {
    clearInterval(downloadMonitor);
    cdp?.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), sleep(1500)]);
    }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    const resolved = await fs.realpath(profile);
    if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('daylore-browser-')) throw new Error('拒绝清理未经验证的临时路径');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    downloadMonitor = setInterval(async () => {
      try {
        if (JSON.stringify(await mediaDownloads()) !== JSON.stringify(downloadsBefore)) stopForViolation('Downloads\\Music 中音频文件发生变化，已停止本次测试');
      } catch (error) { stopForViolation('无法监测下载目录：' + error.message); }
    }, 500);
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let launchError;
    browser.on('error', (error) => { launchError = error; });
    browser.stderr.resume();
    let port;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (launchError) throw launchError;
      try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
      await sleep(50);
    }
    if (!port) throw new Error('浏览器未在 6 秒内启动 DevTools');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find((item) => item.type === 'page');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    cdp = new CDP(socket);
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.audioCalls = [];
      window.rejectAudio = false;
      // 完整替代构造器，避免真实 Audio 的 preload 触发下载器或媒体请求。
      window.Audio = class FakeAudio {
        constructor(source) {
          this.src = new URL(source, location.href).href;
          this.currentSrc = this.src;
          this.currentTime = 0;
          this.preload = 'none';
          this.volume = 1;
          this.paused = true;
        }
        pause() { this.paused = true; }
        play() {
          this.paused = Boolean(window.rejectAudio);
          window.audioCalls.push({src:this.src, currentTime:this.currentTime, volume:this.volume, preload:this.preload, result:window.rejectAudio ? 'rejected' : 'resolved'});
          return window.rejectAudio ? Promise.reject(new DOMException('验收模拟播放受限', 'NotAllowedError')) : Promise.resolve();
        }
      };
      window.quoteMock = false;
      window.quoteRequests = [];
      const actualFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = String(input?.url || input);
        if (!window.quoteMock || !url.startsWith('https://uapis.cn/api/v1/saying')) return actualFetch(input, options);
        window.quoteRequests.push(url);
        if (window.quoteFailure) return Promise.reject(new TypeError('验收模拟离线'));
        return Promise.resolve(new Response(JSON.stringify({text: window.quoteResponse}), {status:200, headers:{'Content-Type':'application/json'}}));
      };
    ` });
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    let navigationId = 0;
    async function navigate(clear = true) {
      const url = `${origin}/?test=${++navigationId}`;
      await cdp.call('Page.navigate', { url });
      await cdp.until(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && typeof DiaryCore === 'object'`);
      assert.equal(await cdp.eval('window.Audio.name'), 'FakeAudio', '页面必须使用无网络音频替身');
      if (clear) {
        await cdp.eval('localStorage.clear()');
        await navigate(false);
      }
    }
    async function open() { assert.equal(await cdp.eval('window.Audio.name'), 'FakeAudio'); await cdp.click('#cover'); await cdp.until("document.querySelector('#book').dataset.state === 'open'"); }
    async function screenshot(name) {
      if (!process.argv.includes('--screenshots')) return;
      const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(path.join(root, 'doc', name), Buffer.from(result.data, 'base64'));
    }
    return { cdp, navigate, open, screenshot, dispose, mediaRequests, downloadsBefore, violation:() => violation };
  } catch (error) { await dispose(); throw error; }
}

test('拾页真实浏览器交互验收', { timeout: 60000 }, async (t) => {
  const harness = await makeHarness();
  const { cdp, navigate, open, screenshot } = harness;
  const state = () => cdp.eval("document.querySelector('#book').dataset.state");
  const date = () => cdp.eval("document.querySelector('#calendar .selected').dataset.date");
  const record = (key) => cdp.eval(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
  const settled = () => cdp.until("document.querySelector('#book').dataset.state === 'open'");
  try {
    await t.test('二轮缺陷复现：翻页状态、在线寄语与心情入口', async () => {
      await cdp.motion(true);
      await navigate(); await open();
      const features = await cdp.eval(`({
        quoteRefresh: Boolean(document.querySelector('#refresh-quote')),
        moodStamp: Boolean(document.querySelector('#mood-stamp')),
        moodPicker: Boolean(document.querySelector('#mood-picker')),
        onlineServices: typeof window.DiaryServices === 'object'
      })`);
      await cdp.click('#next-day');
      features.dateTurn = await state() === 'turning';
      t.diagnostic('二轮缺陷复现：' + JSON.stringify(features));
      assert.deepEqual(features, { quoteRefresh: true, moodStamp: true, moodPicker: true, onlineServices: true, dateTurn: true });
    });

    await t.test('透明合本、默认动画时序、再次翻开', async () => {
      await cdp.motion(false);
      await navigate();
      assert.equal(await state(), 'closed');
      assert.equal(await cdp.eval("getComputedStyle(document.body).backgroundColor"), 'rgba(0, 0, 0, 0)');
      assert.equal(await cdp.eval("(() => { const r = document.querySelector('#book').getBoundingClientRect(); return Boolean(document.elementFromPoint(r.right + 6, r.top + 150)?.closest('[data-tauri-drag-region]')); })()"), true, '合本外框须实际命中窗口拖动区域');
      await screenshot('验收-合上.png');
      const start = Date.now();
      await cdp.click('#cover');
      assert.equal(await state(), 'opening');
      await sleep(100);
      const leftVisible = () => cdp.eval("(() => { const node = document.querySelector('#calendar'); const parent = document.querySelector('.page-left'); const s = getComputedStyle(node); const p = getComputedStyle(parent); return s.visibility !== 'hidden' && p.visibility !== 'hidden' && Number(s.opacity) > 0 && Number(p.opacity) > 0 && parent.getBoundingClientRect().width > 5; })()");
      assert.equal(await leftVisible(), false, '封面前半程不能提前露出左页日历');
      await screenshot('二轮-开盖前半程.png');
      await sleep(Math.max(0, 650 - (Date.now() - start)));
      assert.equal(await state(), 'opening');
      assert.equal(await leftVisible(), false, '封面完全打开前日历内容保持隐藏');
      await cdp.until("document.querySelector('#book').dataset.state === 'flipping'");
      assert.equal(await leftVisible(), true, '封面完全打开后才显示日历内容');
      await sleep(900);
      assert.equal(await state(), 'flipping');
      await cdp.until("document.querySelector('#book').dataset.state === 'open'");
      assert.ok(Date.now() - start >= 1950, '开盖和三页动画不能提前结束');
      assert.equal(await cdp.eval("document.querySelectorAll('.flip-leaf').length"), 3);
      await cdp.eval('document.fonts.ready');
      if (process.argv.includes('--screenshots')) {
        await cdp.input('窗前的风，翻过了今天这一页。\n把细碎的欢喜，认真记在这里。\n愿明天仍有值得期待的小事。');
        await sleep(350);
        const metrics = await cdp.eval(`(() => {
          const style = getComputedStyle(document.querySelector('#diary-content'));
          const context = document.createElement('canvas').getContext('2d');
          context.font = style.fontSize + ' ' + style.fontFamily;
          const m = context.measureText('窗前的风，翻过了今天这一页。');
          const lineHeight = parseFloat(style.lineHeight);
          const baseline = (lineHeight - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2 + m.fontBoundingBoxAscent;
          return { font: context.font, lineHeight, fontAscent: m.fontBoundingBoxAscent, fontDescent: m.fontBoundingBoxDescent, actualAscent: m.actualBoundingBoxAscent, actualDescent: m.actualBoundingBoxDescent, estimatedBaseline: baseline, estimatedGlyphBottom: baseline + m.actualBoundingBoxDescent, backgroundPosition: style.backgroundPosition };
        })()`);
        t.diagnostic('书写字体与横线数据：' + JSON.stringify(metrics));
      }
      await screenshot('验收-展开.png');
      await cdp.click('#close-book');
      assert.equal(await state(), 'closing');
      await sleep(100);
      assert.equal(await leftVisible(), true, '合盖前半程左页仍随封面可见');
      await sleep(550);
      assert.equal(await state(), 'closing');
      assert.equal(await leftVisible(), false, '合盖后半程左页应收起');
      await screenshot('二轮-合盖后半程.png');
      await cdp.until("document.querySelector('#book').dataset.state === 'closed'");
      assert.match(await cdp.eval("document.querySelector('#app-message').textContent"), /已合上并保存/);
      await cdp.motion(true);
      await open();
    });

    await t.test('防抖、真实鼠标切日期、持久化、天气与月历导航', async () => {
      await navigate(); await open();
      const today = await date();
      await cdp.input('今天的墨迹');
      await sleep(100);
      assert.equal(await record(today), null, '300ms 前不写入');
      await sleep(260);
      assert.equal((await record(today)).content, '今天的墨迹');
      assert.equal(await cdp.eval(`document.querySelector('[data-date="${today}"]').classList.contains('has-entry')`), true);
      const tomorrow = await cdp.eval(`DiaryCore.shiftDay(${JSON.stringify(today)}, 1)`);
      await cdp.input('快速切页不会串写');
      // 真鼠标按下会使 textarea 失焦，必须防止保存时重建日历导致 click 丢失。
      await cdp.click(`[data-date="${tomorrow}"]`, true);
      assert.equal(await state(), 'turning');
      await settled();
      assert.equal(await date(), tomorrow, '编辑器失焦保存后，原日期按钮仍能响应真实鼠标点击');
      assert.equal((await record(today)).content, '快速切页不会串写');
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '');
      await cdp.input('明天的独立日记');
      await cdp.click('#previous-day');
      await settled();
      assert.equal(await date(), today);
      assert.equal((await record(tomorrow)).content, '明天的独立日记');
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '快速切页不会串写');
      const seen = [];
      for (let i = 0; i < 4; i++) { seen.push(await cdp.eval("document.querySelector('.weather-label').textContent")); await cdp.click('#weather'); }
      assert.deepEqual(seen, ['晴', '阴', '雨', '雪']);
      assert.equal((await record(today)).weather, 'sunny');
      const month = await cdp.eval("document.querySelector('#calendar-title').textContent");
      const heading = await cdp.eval("document.querySelector('#entry-date').textContent");
      await cdp.click('#previous-month');
      assert.notEqual(await cdp.eval("document.querySelector('#calendar-title').textContent"), month);
      assert.equal(await cdp.eval("document.querySelector('#entry-date').textContent"), heading);
      await cdp.click('#next-month');
      assert.equal(await cdp.eval("document.querySelector('#calendar-title').textContent"), month);
      await cdp.click('#next-day'); await settled();
      await cdp.click('#today-bookmark'); await settled();
      assert.equal(await date(), today);
      await navigate(false); await open();
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '快速切页不会串写');
    });

    await t.test('日历、上下天、回今天均翻页，中点换数据且忽略连点', async () => {
      await cdp.motion(true);
      await navigate(); await open();
      await cdp.motion(false);
      const today = await date();
      const tomorrow = await cdp.eval(`DiaryCore.shiftDay(${JSON.stringify(today)}, 1)`);
      await cdp.input('翻页前的草稿');
      const started = Date.now();
      await cdp.click(`[data-date="${tomorrow}"]`, true);
      assert.equal(await state(), 'turning');
      assert.equal(await cdp.eval("document.querySelector('#book').dataset.direction"), 'forward');
      assert.equal(await date(), today, '日期不能在动画开始时提前替换');
      const snapshot = await cdp.eval(`(() => { const page = document.querySelector('.date-turn .turn-front .page'); return {width:page.offsetWidth, expected:document.querySelector('#book').clientWidth / 2, height:page.offsetHeight, visibility:getComputedStyle(page).visibility, content:page.querySelector('textarea').value}; })()`);
      assert.ok(Math.abs(snapshot.width - snapshot.expected) <= 1 && snapshot.height > 100, JSON.stringify(snapshot));
      assert.equal(snapshot.visibility, 'visible', '日期快照不能被合盖折叠样式隐藏');
      assert.equal(snapshot.content, '翻页前的草稿');
      assert.equal((await record(today)).content, '翻页前的草稿');
      await cdp.click('#next-day');
      await sleep(150);
      assert.equal(await date(), today);
      await cdp.until(`document.querySelector('#calendar .selected').dataset.date === ${JSON.stringify(tomorrow)}`);
      assert.equal(await state(), 'turning', '中点后仍有翻页后半程');
      await screenshot('二轮-切换日期.png');
      await settled();
      assert.ok(Date.now() - started >= 530, '普通翻页须完成560ms前后两阶段');
      assert.equal(await date(), tomorrow, '翻页过程中连点不会跨过两天');
      for (const [selector, direction, expected] of [
        ['#previous-day', 'backward', today],
        ['#next-day', 'forward', tomorrow],
        ['#today-bookmark', 'backward', today],
      ]) {
        await cdp.click(selector);
        assert.equal(await state(), 'turning', selector);
        assert.equal(await cdp.eval("document.querySelector('#book').dataset.direction"), direction);
        await settled();
        assert.equal(await date(), expected);
      }
      await cdp.motion(true);
      const reducedStarted = Date.now();
      await cdp.click('#next-day');
      assert.equal(await state(), 'turning');
      await settled();
      assert.ok(Date.now() - reducedStarted < 500, '减少动态效果使用60ms翻页');
    });

    await t.test('真实API响应接入、刷新短句、长句及断网回退', async () => {
      await navigate();
      await cdp.eval(`(() => {
        window.quoteMock = true;
        window.quoteRequests = [];
        window.quoteResponse = '把今天写成一封温柔的信。';
      })()`);
      await open();
      await cdp.until("document.querySelector('#daily-quote').textContent === '把今天写成一封温柔的信。'");
      assert.ok(await cdp.eval('quoteRequests.length >= 1'));
      await cdp.eval("window.quoteResponse = '愿你的每一次落笔，都有回响。'");
      await cdp.click('#refresh-quote');
      await cdp.until("document.querySelector('#daily-quote').textContent === '愿你的每一次落笔，都有回响。'");
      await cdp.eval("window.quoteResponse = '光'.repeat(80)");
      await cdp.click('#refresh-quote');
      await cdp.until("!document.querySelector('#refresh-quote').disabled");
      assert.ok(await cdp.eval("Array.from(document.querySelector('#daily-quote').textContent).length <= 32"));
      await cdp.eval('window.quoteFailure = true');
      await cdp.click('#refresh-quote');
      await cdp.until("!document.querySelector('#refresh-quote').disabled");
      const length = await cdp.eval("Array.from(document.querySelector('#daily-quote').textContent).length");
      assert.ok(length > 0 && length <= 32);
      await cdp.input('断网时日记仍能保存');
      await cdp.click('#weather');
      assert.equal((await record(await date())).content, '断网时日记仍能保存');
    });

    await t.test('六种火漆心情立即持久化、跨日隔离、月历同步及移除', async () => {
      await navigate(); await open();
      const today = await date();
      assert.equal(await cdp.eval("document.querySelector('#mood-picker').hidden"), true);
      const moods = ['happy', 'calm', 'tired', 'confused', 'hopeful', 'sad'];
      for (const mood of moods) {
        await cdp.click('#mood-stamp');
        assert.equal(await cdp.eval("document.querySelector('#mood-picker').hidden"), false);
        await cdp.click(`#mood-picker [data-mood="${mood}"]`);
        assert.equal((await record(today)).mood, mood);
        assert.equal(await cdp.eval("document.querySelector('#mood-stamp').dataset.mood"), mood);
        assert.equal(await cdp.eval(`document.querySelector('.day[data-date="${today}"]').dataset.mood`), mood);
        assert.equal(await cdp.eval(`document.querySelector('.day[data-date="${today}"] .mood-mark').getAttribute('aria-hidden')`), 'true');
        assert.equal(await cdp.eval("document.querySelector('#mood-picker').hidden"), true);
        if (mood === 'happy') await screenshot('二轮-心情印章.png');
      }
      await cdp.click('#next-day'); await settled();
      assert.equal(await cdp.eval("document.querySelector('#mood-stamp').dataset.mood || ''"), '');
      await cdp.input('另一天的心情日记');
      await cdp.click('#mood-stamp'); await cdp.click('#mood-picker [data-mood="hopeful"]');
      await cdp.click('#previous-day'); await settled();
      assert.equal(await cdp.eval("document.querySelector('#mood-stamp').dataset.mood"), 'sad');
      await navigate(false); await open();
      assert.equal(await cdp.eval("document.querySelector('#mood-stamp').dataset.mood"), 'sad');
      await cdp.click('#mood-stamp'); await cdp.click('#mood-picker [data-mood=""]');
      assert.equal((await record(today)).mood, null);
      assert.equal(await cdp.eval(`document.querySelector('.day[data-date="${today}"]').dataset.mood || ''`), '');
    });

    await t.test('本地MP3文件头、翻页合书音效调用与拒绝容错', async () => {
      // 文件检查只使用 Node 本地读取；浏览器通过完整 FakeAudio 验证调用契约。
      for (const name of ['flip.mp3', 'close.mp3']) {
        const bytes = await fs.readFile(path.join(root, 'asset', name));
        assert.ok(bytes.byteLength > 1000, name + ' 不应为空');
        assert.ok(bytes.subarray(0,3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0), name + ' 应为 MP3 文件');
      }
      await navigate();
      await open();
      assert.ok(await cdp.eval("audioCalls.some(call => /asset\\/flip\\.mp3(?:$|\\?)/.test(call.src) && call.result === 'resolved')"));
      const before = await cdp.eval('audioCalls.length');
      await cdp.click('#next-day'); await settled();
      assert.ok(await cdp.eval(`audioCalls.slice(${before}).some(call => /flip\\.mp3/.test(call.src))`));
      await cdp.click('#close-book');
      await cdp.until("document.querySelector('#book').dataset.state === 'closed'");
      assert.ok(await cdp.eval("audioCalls.some(call => /asset\\/close\\.mp3/.test(call.src) && call.result === 'resolved')"));
      await cdp.eval('window.rejectAudio = true');
      await open();
      await cdp.click('#next-day'); await settled();
      await cdp.click('#close-book');
      await cdp.until("document.querySelector('#book').dataset.state === 'closed'");
      assert.ok(await cdp.eval("audioCalls.some(call => /flip\\.mp3/.test(call.src) && call.result === 'rejected')"));
      assert.ok(await cdp.eval("audioCalls.some(call => /close\\.mp3/.test(call.src) && call.result === 'rejected')"));
      assert.ok(await cdp.eval('audioCalls.every(call => call.currentTime === 0 && call.volume === 0.25)'));
    });

    await t.test('中文输入法延迟保存、损坏数据保持原样', async () => {
      await navigate(); await open();
      const today = await date();
      await cdp.eval("document.querySelector('#diary-content').dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}))");
      await cdp.input('中文组合输入');
      await sleep(360);
      assert.equal(await record(today), null);
      await cdp.click('#next-day');
      assert.equal(await date(), today);
      await cdp.eval("document.querySelector('#diary-content').dispatchEvent(new CompositionEvent('compositionend', {bubbles:true, data:'中文组合输入'}))");
      await sleep(360);
      assert.equal((await record(today)).content, '中文组合输入');
      await cdp.eval(`localStorage.setItem(${JSON.stringify(today)}, '{损坏')`);
      await navigate(false); await open();
      assert.equal(await cdp.eval("document.querySelector('#diary-content').disabled"), true);
      assert.equal(await cdp.eval("document.querySelector('#save-status').dataset.status"), 'error');
      await cdp.click('#close-book');
      await cdp.until("document.querySelector('#book').dataset.state === 'closed'");
      assert.equal(await cdp.eval(`localStorage.getItem(${JSON.stringify(today)})`), '{损坏');
    });

    await t.test('容量不足阻止切日与合书，重试后恢复保存和提示', async () => {
      await navigate(); await open();
      const today = await date();
      await cdp.eval("window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (/^\\d{4}-/.test(key)) throw new DOMException('验收模拟容量不足', 'QuotaExceededError'); return originalSetItem.call(this, key, value); }");
      await cdp.input('保存失败时保留我');
      await cdp.click('#next-day');
      assert.equal(await date(), today);
      await cdp.click('#close-book');
      assert.equal(await state(), 'open');
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '保存失败时保留我');
      assert.equal(await cdp.eval("document.querySelector('#save-status').dataset.status"), 'error');
      assert.match(await cdp.eval("document.querySelector('#app-message').textContent"), /保存失败/);
      assert.equal(await record(today), null);
      await cdp.eval('Storage.prototype.setItem = window.originalSetItem');
      await cdp.click('#retry-save');
      assert.equal((await record(today)).content, '保存失败时保留我');
      assert.equal(await cdp.eval("document.querySelector('#save-status').dataset.status"), 'saved');
      assert.match(await cdp.eval("document.querySelector('#app-message').textContent"), /已重新保存/);
      await cdp.click('#next-day');
      await settled();
      assert.notEqual(await date(), today);
    });

    await t.test('Tauri v1/v2 在保存与合书动画完成后关闭窗口', async () => {
      for (const version of [1, 2]) {
        await navigate(); await open();
        await cdp.motion(version === 2);
        const today = await date();
        await cdp.eval(`(() => { window.closeCalls = []; const close = () => { closeCalls.push({ state: document.querySelector('#book').dataset.state, record: JSON.parse(localStorage.getItem(${JSON.stringify(today)})), elapsed: performance.now() - window.closeStarted }); return Promise.resolve(); }; window.__TAURI__ = { window: ${version === 1 ? '{ appWindow: {close} }' : '{ getCurrentWindow: () => ({close}) }'} }; })()`);
        await cdp.input(`原生 v${version} 退出前保存`);
        await cdp.eval("window.closeStarted = performance.now(); document.querySelector('#close-book').click()");
        assert.equal(await cdp.eval('closeCalls.length'), 0);
        assert.equal((await record(today)).content, `原生 v${version} 退出前保存`);
        await cdp.until('closeCalls.length === 1');
        const result = await cdp.eval('closeCalls[0]');
        assert.equal(result.state, 'closed');
        assert.equal(result.record.content, `原生 v${version} 退出前保存`);
        assert.ok(result.elapsed >= (version === 1 ? 750 : 20));
      }
    });

    await t.test('320/768/1280 视口无横向溢出，天气与书签可直接点击', async () => {
      await cdp.motion(true);
      await navigate(); await open();
      await cdp.eval('document.fonts.ready');
      for (const width of [320, 768, 1280]) {
        await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        // 视口变更会触发书本原有transform过渡，先确认其已真正停稳。
        await cdp.until("document.querySelector('#book').getAnimations().every(animation => animation.playState !== 'running')");
        const layout = await cdp.eval(`(() => {
          const book = document.querySelector('#book').getBoundingClientRect();
          const editor = document.querySelector('#diary-content');
          const editorStyle = getComputedStyle(editor);
          const context = document.createElement('canvas').getContext('2d');
          context.font = editorStyle.fontSize + ' ' + editorStyle.fontFamily;
          const metrics = context.measureText('窗前的风，翻过了今天这一页。');
          const baseline = (parseFloat(editorStyle.lineHeight) - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;
          const gradientStops = Array.from(editorStyle.backgroundImage.matchAll(/(-?\\d+(?:\\.\\d+)?)px/g), (match) => Number(match[1]));
          const clickable = (selector) => { const node = document.querySelector(selector); const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); };
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
          const overlaps = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          const weather = rect('#weather'), ribbon = rect('#close-book'), stamp = rect('#mood-stamp'), editorRect = rect('#diary-content'), next = rect('#next-day');
          return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, left: book.left, right: book.right, editorWidth: editor.clientWidth, lineHeight: editorStyle.lineHeight, ruleHeight: getComputedStyle(document.documentElement).getPropertyValue('--rule-height').trim(), glyphBottom: baseline + metrics.actualBoundingBoxDescent, gradientStops, weatherClickable: clickable('#weather'), ribbonClickable: clickable('#close-book'), stampClickable: clickable('#mood-stamp'), weatherRibbonOverlap: overlaps(weather,ribbon), stampEditorOverlap: overlaps(stamp,editorRect), stampNextOverlap: overlaps(stamp,next), rects:{weather,ribbon,stamp,editor:editorRect,next}, draggable: Boolean(document.elementFromPoint(book.right + 6, book.top + 150)?.closest('[data-tauri-drag-region]')) };
        })()`);
        assert.ok(layout.scroll <= width + 1, `${width}px 视口产生横向滚动：${JSON.stringify(layout)}`);
        assert.ok(layout.left >= 0 && layout.right <= width + 1, `${width}px 书本越过视口`);
        assert.ok(layout.editorWidth > 40, `${width}px 编辑器宽度不足`);
        assert.equal(layout.lineHeight, layout.ruleHeight, '横线间距与文字行高一致');
        assert.ok(layout.gradientStops.length >= 6, '可从计算后CSS读取横线位置');
        assert.ok(Math.abs(layout.gradientStops.at(-2) - layout.glyphBottom) < 2, `${width}px 横线与实际字体底部须对齐：${JSON.stringify(layout)}`);
        assert.equal(layout.weatherClickable, true, `${width}px 天气按钮被其他元素遮挡`);
        assert.equal(layout.ribbonClickable, true, `${width}px 合书丝带被遮挡`);
        assert.equal(layout.weatherRibbonOverlap, false, `${width}px 天气与合书图标矩形重叠：${JSON.stringify(layout.rects)}`);
        assert.equal(layout.stampEditorOverlap, false, `${width}px 印章挡住书写区域：${JSON.stringify(layout.rects)}`);
        assert.equal(layout.stampNextOverlap, false, `${width}px 印章挡住下一页：${JSON.stringify(layout.rects)}`);
        assert.equal(layout.stampClickable, true, `${width}px 心情印章被遮挡`);
        assert.equal(layout.draggable, true, `${width}px 外框须实际命中窗口拖动区域`);
        await screenshot(`二轮-${width}px.png`);
      }
      await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    });

    await t.test('图片和字体请求全部失败时仍可打开、书写与保存', async () => {
      await cdp.call('Network.enable');
      await cdp.call('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.call('Network.setBlockedURLs', { urls: ['*/asset/*'] });
      try {
        await navigate(); await open();
        const assets = await cdp.eval("Promise.all(['cover.png', 'paper.png', 'font.ttf'].map(name => fetch('./asset/' + name).then(response => response.ok, () => false)))");
        assert.deepEqual(assets, [false, false, false], '确认三种素材请求实际被阻止');
        const fallback = await cdp.eval("({cover: getComputedStyle(document.querySelector('.cover-front')).backgroundImage, paper: getComputedStyle(document.querySelector('.page')).backgroundImage, font: getComputedStyle(document.body).fontFamily})");
        assert.match(fallback.cover, /gradient/);
        assert.match(fallback.paper, /radial-gradient/);
        assert.match(fallback.font, /Kaiti/);
        const today = await date();
        await cdp.input('没有素材，也能安心记下今天。');
        await sleep(350);
        assert.equal((await record(today)).content, '没有素材，也能安心记下今天。');
      } finally {
        await cdp.call('Network.setBlockedURLs', { urls: [] });
        await cdp.call('Network.setCacheDisabled', { cacheDisabled: false });
      }
    });

    await t.test('直接双击使用的 file 协议可打开、保存并刷新恢复', async (subtest) => {
      const url = pathToFileURL(path.join(root, 'index.html')).href;
      await cdp.call('Page.navigate', { url });
      await cdp.until(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && typeof DiaryCore === 'object'`);
      const storage = await cdp.eval("(() => { try { localStorage.setItem('__file_smoke__', '1'); localStorage.removeItem('__file_smoke__'); localStorage.clear(); return {ok:true}; } catch (error) { return {ok:false, error:error.name}; } })()");
      await open();
      if (!storage.ok) {
        assert.equal(await cdp.eval("document.querySelector('#save-status').dataset.status"), 'error');
        assert.match(await cdp.eval("document.querySelector('#app-message').textContent"), /无法读取|读取失败/);
        subtest.diagnostic('当前浏览器禁止 file 本地存储，已确认错误明确显示：' + storage.error);
        return;
      }
      const today = await date();
      await cdp.input('直接双击打开，也记得今天。');
      await cdp.click('#weather');
      assert.equal((await record(today)).content, '直接双击打开，也记得今天。');
      assert.equal((await record(today)).weather, 'cloudy');
      await cdp.eval('window.__beforeFileReload = true');
      await cdp.call('Page.reload', { ignoreCache: true });
      await cdp.until("!window.__beforeFileReload && document.readyState === 'complete' && typeof DiaryCore === 'object' && document.querySelector('#book')?.dataset.state === 'closed'");
      await open();
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '直接双击打开，也记得今天。');
      assert.equal(await cdp.eval("document.querySelector('.weather-label').textContent"), '阴');
      await cdp.click('#close-book');
      await cdp.until("document.querySelector('#book').dataset.state === 'closed'");
    });
    assert.deepEqual(cdp.errors, [], '页面不应有未捕获异常');
    assert.deepEqual(harness.mediaRequests, [], '浏览器媒体请求必须为零');
    assert.equal(harness.violation(), '', '验收期间不得产生媒体请求或下载变化');
    const downloadsAfter = await mediaDownloads();
    assert.deepEqual(downloadsAfter, harness.downloadsBefore, 'Downloads\\Music 音频文件应保持原样');
    const summarize = files => ({count:files.length, latestModified:files.length ? new Date(Math.max(...files.map(file => file.modified))).toISOString() : null});
    t.diagnostic('媒体请求：0；下载目录前后对比：' + JSON.stringify({before:summarize(harness.downloadsBefore),after:summarize(downloadsAfter)}));
  } finally { await harness.dispose(); }
});
