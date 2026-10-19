/* 日期与持久化不依赖 DOM；替换存储实现时保留 saveDiary / loadDiary 接口即可。 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiaryCore = api;
})(globalThis, function (root) {
  'use strict';
  const MAX_CONTENT_LENGTH = 1000000;
  const WEATHER = new Set(['sunny', 'cloudy', 'rainy', 'snowy']);
  const MOODS = Object.freeze([
    { id: 'happy', label: '开心', symbol: '☺' },
    { id: 'calm', label: '平静', symbol: '☕' },
    { id: 'tired', label: '疲惫', symbol: '☾' },
    { id: 'confused', label: '迷茫', symbol: '?' },
    { id: 'hopeful', label: '期待', symbol: '✧' },
    { id: 'sad', label: '低落', symbol: '☂' },
  ].map(mood => Object.freeze(mood)));
  const MOOD_IDS = new Set(MOODS.map(mood => mood.id));

  function localDateKey(date = new Date()) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RangeError('日期无效。');
    const year = date.getFullYear();
    if (year < 0 || year > 9999) throw new RangeError('日期年份必须在 0000–9999 之间。');
    return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function parseDate(key) {
    if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new RangeError('日期格式应为 YYYY-MM-DD。');
    const [year, month, day] = key.split('-').map(Number);
    // setFullYear 避免 new Date(0–99, ...) 自动把年份解释成 1900–1999；正午避开午夜夏令时切换。
    const date = new Date(0);
    date.setHours(12, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) throw new RangeError('日期不存在。');
    return date;
  }

  function checkDelta(delta) {
    if (!Number.isSafeInteger(delta)) throw new RangeError('日期偏移必须为安全整数。');
  }

  function shiftDay(key, delta) {
    checkDelta(delta);
    const date = parseDate(key);
    // 按日历日加减，不按 86400000 毫秒加减，避免夏令时造成错日。
    date.setDate(date.getDate() + delta);
    return localDateKey(date);
  }

  function shiftMonth(key, delta) {
    checkDelta(delta);
    const date = parseDate(key);
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + delta);
    const end = new Date(date);
    end.setMonth(end.getMonth() + 1, 0);
    date.setDate(Math.min(day, end.getDate()));
    return localDateKey(date);
  }

  function monthGrid(key) {
    const date = parseDate(key);
    const month = date.getMonth();
    date.setDate(1);
    date.setDate(1 - (date.getDay() + 6) % 7);
    return Array.from({ length: 42 }, () => {
      const cell = { date: localDateKey(date), day: date.getDate(), inMonth: date.getMonth() === month };
      date.setDate(date.getDate() + 1);
      return cell;
    });
  }

  function formatHeading(key) {
    const date = parseDate(key);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 星期${'日一二三四五六'[date.getDay()]}`;
  }

  function ownValue(object, name) {
    const property = Object.getOwnPropertyDescriptor(object, name);
    // 不执行调用者传入对象的 getter，数据记录只接受普通值。
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
  }

  function normalizeData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('日记数据必须为对象。');
    const content = ownValue(data, 'content');
    if (typeof content !== 'string') throw new TypeError('日记正文必须为字符串。');
    if (content.length > MAX_CONTENT_LENGTH) throw new RangeError(`日记正文长度不能超过 ${MAX_CONTENT_LENGTH} 字符。`);
    const weather = ownValue(data, 'weather');
    const mood = ownValue(data, 'mood');
    // 旧记录与未知心情统一视为未盖章，不改变原始存储内容。
    return { content, weather: WEATHER.has(weather) ? weather : 'sunny', mood: MOOD_IDS.has(mood) ? mood : null };
  }

  function createDiaryStore(storage) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new TypeError('存储对象须提供 getItem 和 setItem。');
    return {
      saveDiary(date, data) {
        parseDate(date);
        const record = { ...normalizeData(data), updatedAt: new Date().toISOString() };
        // 写入失败直接抛出，让交互层保留待保存内容，不能把失败伪装成成功。
        storage.setItem(date, JSON.stringify(record));
        return record;
      },
      loadDiary(date) {
        parseDate(date);
        const raw = storage.getItem(date);
        if (raw === null) return { content: '', weather: 'sunny', mood: null, updatedAt: null };
        try {
          const data = JSON.parse(raw);
          const record = normalizeData(data);
          const updatedAt = ownValue(data, 'updatedAt');
          if (typeof updatedAt !== 'string' || new Date(updatedAt).toISOString() !== updatedAt) throw new Error('更新时间无效。');
          return { ...record, updatedAt };
        } catch (error) {
          throw new Error(`日期 ${date} 的日记数据损坏，原始内容已保留。`, { cause: error });
        }
      },
      hasDiary(date) {
        return this.loadDiary(date).content.trim().length > 0;
      },
    };
  }

  // 惰性读取 localStorage，禁用存储的环境也能先正常载入页面，再由 UI 提示具体错误。
  function saveDiary(date, data) { return createDiaryStore(root.localStorage).saveDiary(date, data); }
  function loadDiary(date) { return createDiaryStore(root.localStorage).loadDiary(date); }
  function hasDiary(date) { return loadDiary(date).content.trim().length > 0; }

  return Object.freeze({ MAX_CONTENT_LENGTH, MOODS, localDateKey, parseDate, shiftDay, shiftMonth, monthGrid, formatHeading, createDiaryStore, saveDiary, loadDiary, hasDiary });
});
