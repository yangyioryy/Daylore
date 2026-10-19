/* 外部短句只接收公开文字；日记正文始终不进入网络请求。 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiaryServices = api;
})(globalThis, function (root) {
  'use strict';

  const QUOTE_ENDPOINT = 'https://uapis.cn/api/v1/saying';
  const MAX_QUOTE_LENGTH = 32;
  // 公共语料并非治愈专库；轻量排除明显贬低、攻击和暴力用语。
  const DISCOURAGING_QUOTE = /自卑|炫耀|愚蠢|蠢货|废物|杀|仇恨|绝望|去死|贱/u;
  const DEFAULT_QUOTES = Object.freeze([
    '慢一点，也在向前。',
    '今天的你，已经很努力了。',
    '把心放轻，让日子慢慢发光。',
    '小小的快乐，也值得被记住。',
    '愿你今晚，睡在温柔的梦里。',
    '给自己一点时间，花会慢慢开。',
    '平凡的一天，也有自己的光。',
    '此刻，先好好照顾自己。'
  ]);

  function cleanQuote(value) {
    if (typeof value !== 'string') return '';
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const text = value
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity) => {
        if (entity[0] !== '#') return entities[entity.toLowerCase()];
        const hexadecimal = entity[1].toLowerCase() === 'x';
        const point = parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point) : '';
      })
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (DISCOURAGING_QUOTE.test(text.replace(/\s/g, ''))) return '';
    if (Array.from(text).length <= MAX_QUOTE_LENGTH) return text;
    // 只取有句末标点的完整首句，避免直接切字破坏句意。
    const firstSentence = text.match(/^.*?[。！？!?\.](?:[”’"'」』])?/u);
    return firstSentence && Array.from(firstSentence[0]).length <= MAX_QUOTE_LENGTH
      ? firstSentence[0] : '';
  }

  function createQuoteService({ fetchImpl = typeof root.fetch === 'function' ? root.fetch.bind(root) : null, timeoutMs = 1600, random = Math.random } = {}) {
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 15000) : 1600;
    let lastQuote = '';
    let latestRequest = 0;
    let activeRequest = null;

    function localQuote() {
      const candidates = DEFAULT_QUOTES.filter(quote => quote !== lastQuote);
      const value = Number(random());
      const index = Number.isFinite(value) ? Math.max(0, Math.min(candidates.length - 1, Math.floor(value * candidates.length))) : 0;
      return candidates[index];
    }

    async function next() {
      const requestId = ++latestRequest;
      if (activeRequest) activeRequest.cancel();
      if (typeof fetchImpl !== 'function' || typeof root.AbortController !== 'function') {
        lastQuote = localQuote();
        return lastQuote;
      }

      const controller = new root.AbortController();
      let settleCancellation;
      const cancellation = new Promise(resolve => { settleCancellation = resolve; });
      const request = {
        cancel() {
          controller.abort();
          settleCancellation('');
        }
      };
      activeRequest = request;
      // 竞速覆盖 fetch 与 response.json；即使模拟实现忽略 abort，也能准时结束。
      const timer = root.setTimeout(() => request.cancel(), timeout);
      const obtainQuote = async () => {
        for (let attempt = 0; attempt < 2 && !controller.signal.aborted; attempt += 1) {
          const response = await fetchImpl(QUOTE_ENDPOINT, {
            method: 'GET',
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal
          });
          if (!response.ok || controller.signal.aborted) return '';
          const payload = await response.json();
          if (controller.signal.aborted) return '';
          const quote = cleanQuote(payload && payload.text);
          if (quote && quote !== lastQuote) return quote;
        }
        return '';
      };

      let quote = '';
      try {
        quote = await Promise.race([obtainQuote(), cancellation]);
      } catch (_error) {
        // 网络不可用、跨域拒绝、无效 JSON 都使用本地短句。
      } finally {
        root.clearTimeout(timer);
        controller.abort();
        if (activeRequest === request) activeRequest = null;
      }
      if (!quote || quote === lastQuote) quote = localQuote();
      // 被后续换句替代的调用仍可完成，但不能改写最新的去重状态。
      if (requestId === latestRequest) lastQuote = quote;
      return quote;
    }

    return Object.freeze({ next });
  }

  function createSoundPlayer({ AudioCtor = root.Audio } = {}) {
    const sources = { flip: './asset/flip.mp3', close: './asset/close.mp3' };
    const audioByKind = new Map();

    function play(kind) {
      if (!Object.hasOwn(sources, kind) || typeof AudioCtor !== 'function') return Promise.resolve(false);
      try {
        let audio = audioByKind.get(kind);
        if (!audio) {
          audio = new AudioCtor(sources[kind]);
          audio.preload = 'auto';
          audio.volume = 0.25;
          audioByKind.set(kind, audio);
        }
        // 同一种音效复用实例并从头播放，快速连点不会叠加音量。
        audio.pause();
        audio.currentTime = 0;
        return Promise.resolve(audio.play()).then(() => true, () => false);
      } catch (_error) {
        return Promise.resolve(false);
      }
    }

    return Object.freeze({ play });
  }

  return Object.freeze({ QUOTE_ENDPOINT, MAX_QUOTE_LENGTH, DEFAULT_QUOTES, createQuoteService, createSoundPlayer });
});
