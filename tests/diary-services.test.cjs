'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { QUOTE_ENDPOINT, MAX_QUOTE_LENGTH, DEFAULT_QUOTES, createQuoteService, createSoundPlayer } = require('../diary-services.js');

const response = text => ({ ok: true, json: async () => ({ text }) });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('经典脚本暴露浏览器服务且不依赖模块加载器', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../diary-services.js'), 'utf8'), context);
  assert.equal(typeof context.DiaryServices.createQuoteService, 'function');
  assert.equal(typeof context.DiaryServices.createSoundPlayer, 'function');
});

test('按实测顶层 text 结构读取，只发送无正文的匿名 GET', async () => {
  const calls = [];
  const service = createQuoteService({ fetchImpl: async (...args) => { calls.push(args); return response('慢慢来，也很好。'); } });
  assert.equal(await service.next(), '慢慢来，也很好。');
  assert.equal(QUOTE_ENDPOINT, 'https://uapis.cn/api/v1/saying');
  assert.equal(calls[0][0], QUOTE_ENDPOINT);
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].body, undefined);
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test('过滤标签、脚本和控制字符，Unicode 按码点计算长度', async () => {
  const values = ['<script>坏内容</script><b>今天\u0000也值得。</b>', '🌼'.repeat(32)];
  const service = createQuoteService({ fetchImpl: async () => response(values.shift()) });
  assert.equal(await service.next(), '今天也值得。');
  assert.equal(Array.from(await service.next()).length, 32);
  assert.equal(MAX_QUOTE_LENGTH, 32);
});

test('超长文本保留完整首句，不能硬截断', async () => {
  const service = createQuoteService({ fetchImpl: async () => response('今天也值得。' + '温柔'.repeat(40)) });
  assert.equal(await service.next(), '今天也值得。');
});

test('超长且没有可用首句最多重试一次，然后使用短句兜底', async () => {
  let calls = 0;
  const service = createQuoteService({ random: () => 0, fetchImpl: async () => { calls += 1; return response('温柔'.repeat(40)); } });
  const quote = await service.next();
  assert.equal(calls, 2);
  assert.ok(DEFAULT_QUOTES.includes(quote));
  assert.ok(Array.from(quote).length <= 26);
});

test('每次换句请求接口，连续重复用重试或本地句替换', async () => {
  let calls = 0;
  const service = createQuoteService({ random: () => 0, fetchImpl: async () => { calls += 1; return response('慢慢来，也很好。'); } });
  const first = await service.next();
  const second = await service.next();
  assert.notEqual(first, second);
  assert.equal(calls, 3);
});

test('拒绝明显攻击、贬低与暴力语气，最多重试后使用治愈兜底', async () => {
  for (const text of ['不炫耀，因为不自卑。', '愚蠢的人不值得被爱。', '你是个废物。', '仇恨终将杀死一切。', '人生只有绝望。', '蠢货，去死。', '贱人就是矫情。']) {
    let calls = 0;
    const service = createQuoteService({ random: () => 0, fetchImpl: async () => { calls += 1; return response(text); } });
    assert.ok(DEFAULT_QUOTES.includes(await service.next()));
    assert.equal(calls, 2);
  }
});

test('语气筛选不阻止普通好句和带情绪词的安慰句', async () => {
  const values = ['你是个废物。', '难过也没关系。', '春风会把好消息带来。'];
  const service = createQuoteService({ fetchImpl: async () => response(values.shift()) });
  assert.equal(await service.next(), '难过也没关系。');
  assert.equal(await service.next(), '春风会把好消息带来。');
});

test('离线、HTTP 错误、错误 JSON 和错误结构均可靠兜底且不连续重复', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
    async () => ({ ok: true, json: async () => ({ content: '错误结构' }) })
  ]) {
    const service = createQuoteService({ fetchImpl, random: () => 0 });
    const first = await service.next();
    const second = await service.next();
    assert.ok(DEFAULT_QUOTES.includes(first));
    assert.ok(DEFAULT_QUOTES.includes(second));
    assert.notEqual(first, second);
  }
});

test('忽略 abort 的慢请求和慢 JSON 都在总时限内兜底，晚返回不能污染去重状态', async () => {
  for (const slowJson of [false, true]) {
    const delayed = deferred();
    let signal;
    let calls = 0;
    const service = createQuoteService({ timeoutMs: 15, random: () => 0, fetchImpl: async (_url, options) => {
      signal = options.signal;
      if (++calls > 1) return response('迟到的句子。');
      return slowJson ? { ok: true, json: () => delayed.promise } : delayed.promise;
    } });
    const fallback = await service.next();
    assert.ok(DEFAULT_QUOTES.includes(fallback));
    assert.equal(signal.aborted, true);
    delayed.resolve(slowJson ? { text: '迟到的句子。' } : response('迟到的句子。'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await service.next(), '迟到的句子。');
  }
});

test('并发换句取消旧请求，旧返回不会改变最新去重状态', async () => {
  const firstRequest = deferred();
  let calls = 0;
  let oldSignal;
  const service = createQuoteService({ random: () => 0, fetchImpl: (_url, options) => {
    calls += 1;
    if (calls === 1) { oldSignal = options.signal; return firstRequest.promise; }
    return Promise.resolve(response(calls === 2 ? '最新的一句。' : '旧请求的句子。'));
  } });
  const older = service.next();
  const newer = service.next();
  assert.equal(await newer, '最新的一句。');
  assert.ok(DEFAULT_QUOTES.includes(await older));
  assert.equal(oldSignal.aborted, true);
  firstRequest.resolve(response('旧请求的句子。'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await service.next(), '旧请求的句子。');
});

test('音效使用真实本地路径，轻音量，同类复用并从头播放', async () => {
  const created = [];
  class FakeAudio {
    constructor(src) { this.src = src; this.currentTime = 9; this.pauseCalls = 0; this.playCalls = 0; created.push(this); }
    pause() { this.pauseCalls += 1; }
    play() { this.playCalls += 1; return Promise.resolve(); }
  }
  const player = createSoundPlayer({ AudioCtor: FakeAudio });
  assert.equal(await player.play('flip'), true);
  created[0].currentTime = 8;
  await player.play('flip');
  await player.play('close');
  assert.deepEqual(created.map(audio => audio.src), ['./asset/flip.mp3', './asset/close.mp3']);
  assert.equal(created[0].currentTime, 0);
  assert.equal(created[0].playCalls, 2);
  assert.equal(created[0].pauseCalls, 2);
  assert.equal(created[0].volume, 0.25);
});

test('音效缺失、播放拒绝及构造异常被捕获，不产生未处理拒绝', async () => {
  for (const AudioCtor of [
    class { constructor() { throw new Error('no audio'); } },
    class { pause() {} play() { return Promise.reject(new Error('autoplay blocked')); } },
    class { pause() {} play() { throw new Error('missing file'); } }
  ]) {
    const player = createSoundPlayer({ AudioCtor });
    assert.equal(await player.play('flip'), false);
  }
  assert.equal(await createSoundPlayer().play('flip'), false);
  assert.equal(await createSoundPlayer().play('invalid'), false);
});
