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
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (file !== root && !file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf' };
      const content = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  // 所有资源均在 finally 中关闭；删除前校验真实路径，严格限制到此次创建的临时目录。
  async function dispose() {
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
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    let navigationId = 0;
    async function navigate(clear = true) {
      const url = `${origin}/?test=${++navigationId}`;
      await cdp.call('Page.navigate', { url });
      await cdp.until(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && typeof DiaryCore === 'object'`);
      if (clear) {
        await cdp.eval('localStorage.clear()');
        await navigate(false);
      }
    }
    async function open() { await cdp.click('#cover'); await cdp.until("document.querySelector('#book').dataset.state === 'open'"); }
    async function screenshot(name) {
      if (!process.argv.includes('--screenshots')) return;
      const result = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(path.join(root, 'doc', name), Buffer.from(result.data, 'base64'));
    }
    return { cdp, navigate, open, screenshot, dispose };
  } catch (error) { await dispose(); throw error; }
}

test('拾页真实浏览器交互验收', { timeout: 60000 }, async (t) => {
  const harness = await makeHarness();
  const { cdp, navigate, open, screenshot } = harness;
  const state = () => cdp.eval("document.querySelector('#book').dataset.state");
  const date = () => cdp.eval("document.querySelector('#calendar .selected').dataset.date");
  const record = (key) => cdp.eval(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}))`);
  try {
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
      await sleep(650);
      assert.equal(await state(), 'opening');
      await cdp.until("document.querySelector('#book').dataset.state === 'flipping'");
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
      await sleep(650);
      assert.equal(await state(), 'closing');
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
      assert.equal(await date(), tomorrow, '编辑器失焦保存后，原日期按钮仍能响应真实鼠标点击');
      assert.equal((await record(today)).content, '快速切页不会串写');
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '');
      await cdp.input('明天的独立日记');
      await cdp.click('#previous-day');
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
      await cdp.click('#next-day'); await cdp.click('#today-bookmark');
      assert.equal(await date(), today);
      await navigate(false); await open();
      assert.equal(await cdp.eval("document.querySelector('#diary-content').value"), '快速切页不会串写');
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
        await sleep(80);
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
          return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, left: book.left, right: book.right, editorWidth: editor.clientWidth, lineHeight: editorStyle.lineHeight, ruleHeight: getComputedStyle(document.documentElement).getPropertyValue('--rule-height').trim(), glyphBottom: baseline + metrics.actualBoundingBoxDescent, gradientStops, weatherClickable: clickable('#weather'), ribbonClickable: clickable('#close-book'), draggable: Boolean(document.elementFromPoint(book.right + 6, book.top + 150)?.closest('[data-tauri-drag-region]')) };
        })()`);
        assert.ok(layout.scroll <= width + 1, `${width}px 视口产生横向滚动：${JSON.stringify(layout)}`);
        assert.ok(layout.left >= 0 && layout.right <= width + 1, `${width}px 书本越过视口`);
        assert.ok(layout.editorWidth > 40, `${width}px 编辑器宽度不足`);
        assert.equal(layout.lineHeight, layout.ruleHeight, '横线间距与文字行高一致');
        assert.ok(layout.gradientStops.length >= 6, '可从计算后CSS读取横线位置');
        assert.ok(Math.abs(layout.gradientStops.at(-2) - layout.glyphBottom) < 2, `${width}px 横线与实际字体底部须对齐：${JSON.stringify(layout)}`);
        assert.equal(layout.weatherClickable, true, `${width}px 天气按钮被其他元素遮挡`);
        assert.equal(layout.ribbonClickable, true, `${width}px 合书丝带被遮挡`);
        assert.equal(layout.draggable, true, `${width}px 外框须实际命中窗口拖动区域`);
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
  } finally { await harness.dispose(); }
});
