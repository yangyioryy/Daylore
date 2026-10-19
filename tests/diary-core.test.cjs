'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../diary-core.js');

function memoryStorage() {
  const records = new Map();
  return {
    records,
    getItem(key) { return records.has(key) ? records.get(key) : null; },
    setItem(key, value) { records.set(key, value); }
  };
}

test('本地日期不使用 UTC 日期，且保留 0–99 年', () => {
  const date = new Date(0);
  date.setFullYear(7, 0, 2);
  date.setHours(23, 59, 59, 0);
  assert.equal(core.localDateKey(date), '0007-01-02');
  assert.equal(core.parseDate('0099-02-28').getFullYear(), 99);
  assert.equal(core.parseDate('0000-02-29').getFullYear(), 0);
  assert.throws(() => core.localDateKey(new Date(NaN)), RangeError);
});

test('严格拒绝非真实日期、非字符串和格式错误', () => {
  for (const key of ['2025-02-29', '1900-02-29', '2026-04-31', '2026-1-01', '2026-01-01x', '10000-01-01', '2026-00-10', '', null, {}, new String('2026-01-01')]) {
    assert.throws(() => core.parseDate(key), /日期/);
  }
  assert.equal(core.localDateKey(core.parseDate('2000-02-29')), '2000-02-29');
});

test('逐日翻阅跨月、跨年、闰年与夏令时边界', () => {
  assert.equal(core.shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(core.shiftDay('2024-02-28', 1), '2024-02-29');
  assert.equal(core.shiftDay('2024-03-01', -1), '2024-02-29');
  assert.equal(core.shiftDay('0099-12-31', 1), '0100-01-01');
  assert.equal(core.shiftDay('2026-03-08', 1), '2026-03-09');
  assert.equal(core.shiftDay('2026-11-01', 1), '2026-11-02');
  assert.throws(() => core.shiftDay('0000-01-01', -1), RangeError);
  assert.throws(() => core.shiftDay('9999-12-31', 1), RangeError);
  for (const delta of [0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => core.shiftDay('2026-01-01', delta), /偏移/);
  }
});

test('月份导航截短月末，处理闰年与年份 0–99', () => {
  assert.equal(core.shiftMonth('2026-01-31', 1), '2026-02-28');
  assert.equal(core.shiftMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(core.shiftMonth('2026-01-31', -1), '2025-12-31');
  assert.equal(core.shiftMonth('0099-12-31', 1), '0100-01-31');
  assert.equal(core.shiftMonth('0000-02-29', 12), '0001-02-28');
  assert.throws(() => core.shiftMonth('9999-12-01', 1), RangeError);
  assert.throws(() => core.shiftMonth('0000-01-01', -1), RangeError);
  assert.throws(() => core.shiftMonth('2026-01-01', 0.2), /偏移/);
});

test('日历固定 42 格，星期一开头，正确标注相邻月份', () => {
  const grid = core.monthGrid('2026-10-19');
  assert.equal(grid.length, 42);
  assert.deepEqual(grid[0], { date: '2026-09-28', day: 28, inMonth: false });
  assert.deepEqual(grid[3], { date: '2026-10-01', day: 1, inMonth: true });
  assert.equal(grid.filter(cell => cell.inMonth).length, 31);
  assert.equal(core.parseDate(grid[0].date).getDay(), 1);
  assert.equal(core.monthGrid('2021-02-03')[0].date, '2021-02-01');
  assert.throws(() => core.monthGrid('0000-01-01'), RangeError);
  assert.throws(() => core.monthGrid('9999-12-01'), RangeError);
});

test('中文日期抬头包含准确星期', () => {
  assert.equal(core.formatHeading('2026-10-19'), '2026年10月19日 星期一');
  assert.equal(core.formatHeading('2026-10-18'), '2026年10月18日 星期日');
});

test('按日期独立保存正文、天气、时间，空日期默认值独立', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  const blank = { content: '', weather: 'sunny', mood: null, updatedAt: null };
  assert.deepEqual(store.loadDiary('2026-10-19'), blank);
  const first = store.saveDiary('2026-10-19', { content: '拾起今日。\n第二行', weather: 'rainy', updatedAt: '不信任输入时间' });
  store.saveDiary('2026-10-20', { content: '明天', weather: 'snowy' });
  assert.equal(first.content, '拾起今日。\n第二行');
  assert.equal(first.weather, 'rainy');
  assert.equal(new Date(first.updatedAt).toISOString(), first.updatedAt);
  assert.deepEqual(store.loadDiary('2026-10-19'), first);
  assert.equal(store.loadDiary('2026-10-20').weather, 'snowy');
  assert.equal(storage.records.has('2026-10-19'), true);
  assert.equal(store.hasDiary('2026-10-19'), true);
  store.saveDiary('2026-10-21', { content: ' \n\t ', weather: 'cloudy' });
  assert.equal(store.hasDiary('2026-10-21'), false);
  assert.equal(store.hasDiary('2026-10-22'), false);
  const empty = store.loadDiary('2026-10-22');
  empty.content = '修改返回值';
  assert.deepEqual(store.loadDiary('2026-10-22'), blank);
});

test('未知天气安全回落，恶意属性不参与记录', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  for (const weather of ['__proto__', 'constructor', {}, null, 'typhoon']) {
    assert.equal(store.saveDiary('2026-10-19', { content: '<script>不可执行</script>', weather }).weather, 'sunny');
  }
  const hostile = JSON.parse('{"content":"正文","weather":"rainy","__proto__":{"polluted":true}}');
  store.saveDiary('2026-10-19', hostile);
  assert.deepEqual(Object.keys(store.loadDiary('2026-10-19')).sort(), ['content', 'mood', 'updatedAt', 'weather']);
  assert.equal({}.polluted, undefined);
  let getterCalled = false;
  assert.throws(() => store.saveDiary('2026-10-19', { get content() { getterCalled = true; return ''; } }), /正文/);
  assert.equal(getterCalled, false);
  assert.throws(() => store.saveDiary('2026-10-19', []), /对象/);
  assert.throws(() => store.saveDiary('2026-10-19', { content: 1 }), /正文/);
});

test('校验正文长度且在失败时保留已有记录', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  store.saveDiary('2026-10-19', { content: '原文', weather: 'sunny' });
  assert.throws(() => store.saveDiary('2026-10-19', { content: '字'.repeat(core.MAX_CONTENT_LENGTH + 1) }), /长度/);
  assert.equal(store.loadDiary('2026-10-19').content, '原文');
  assert.equal(store.saveDiary('2026-10-20', { content: '字'.repeat(core.MAX_CONTENT_LENGTH) }).content.length, core.MAX_CONTENT_LENGTH);
  assert.throws(() => store.saveDiary('2026-02-30', { content: '' }), /日期/);
});

test('损坏存储明确报错，不覆盖原始内容', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  for (const invalid of ['{', 'null', '[]', '"字符串"', '{}', '{"content":3}', '{"content":"a","updatedAt":"坏日期"}', '{"content":"a","updatedAt":"2026-02-30T00:00:00.000Z"}']) {
    storage.records.set('2026-10-19', invalid);
    assert.throws(() => store.loadDiary('2026-10-19'), /损坏/);
    assert.equal(storage.records.get('2026-10-19'), invalid);
    assert.throws(() => store.hasDiary('2026-10-19'), /损坏/);
  }
  storage.records.set('2026-10-19', JSON.stringify({ content: '旧天气', weather: 'alien', updatedAt: '2026-10-19T00:00:00.000Z' }));
  assert.equal(store.loadDiary('2026-10-19').weather, 'sunny');
});

test('存储权限和容量错误可被调用者捕获', () => {
  const store = core.createDiaryStore({
    getItem() { throw new Error('读取权限被拒绝'); },
    setItem() { throw new Error('存储容量不足'); }
  });
  assert.throws(() => store.loadDiary('2026-10-19'), /读取权限被拒绝/);
  assert.throws(() => store.saveDiary('2026-10-19', { content: '原文' }), /存储容量不足/);
  assert.throws(() => core.createDiaryStore({}), /存储/);
});

test('浏览器脚本可直接加载，localStorage 权限检查延迟到实际操作', () => {
  const context = vm.createContext({});
  // 在被测 realm 内定义 getter；Node 24 的跨 realm 全局 getter 会吞掉外部异常。
  vm.runInContext("Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('禁止本地存储'); } });", context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../diary-core.js'), 'utf8'), context);
  assert.equal(typeof context.DiaryCore.localDateKey, 'function');
  assert.throws(() => context.DiaryCore.loadDiary('2026-10-19'), /禁止本地存储/);
});

test('六种心情提供冻结的中文元数据', () => {
  assert.deepEqual(core.MOODS.map(({ id, label }) => [id, label]), [
    ['happy', '开心'], ['calm', '平静'], ['tired', '疲惫'],
    ['confused', '迷茫'], ['hopeful', '期待'], ['sad', '低落']
  ]);
  assert.equal(Object.isFrozen(core.MOODS), true);
  for (const mood of core.MOODS) {
    assert.equal(Object.isFrozen(mood), true);
    assert.equal(typeof mood.symbol, 'string');
    assert.ok(mood.symbol.length > 0);
  }
});

test('旧记录兼容未盖章且读取不会改写原始存储', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  const legacy = { content: '旧日记', weather: 'rainy', updatedAt: '2026-10-19T00:00:00.000Z' };
  const raw = JSON.stringify(legacy);
  storage.records.set('2026-10-19', raw);
  assert.deepEqual(store.loadDiary('2026-10-19'), { ...legacy, mood: null });
  assert.equal(storage.records.get('2026-10-19'), raw);
  assert.equal(store.loadDiary('2026-10-20').mood, null);
});

test('六种心情按日期独立保存，重建存储接口后仍保留印章', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  const moods = ['happy', 'calm', 'tired', 'confused', 'hopeful', 'sad'];
  moods.forEach((mood, index) => {
    const date = `2026-10-${19 + index}`;
    const saved = store.saveDiary(date, { content: `日记 ${index}`, weather: 'cloudy', mood });
    assert.equal(saved.mood, mood);
    assert.equal(JSON.parse(storage.records.get(date)).mood, mood);
  });
  const reloaded = core.createDiaryStore(storage);
  moods.forEach((mood, index) => {
    const record = reloaded.loadDiary(`2026-10-${19 + index}`);
    assert.equal(record.mood, mood);
    assert.equal(record.content, `日记 ${index}`);
    assert.equal(record.weather, 'cloudy');
  });
});

test('未知或恶意心情安全归为未盖章，不执行 getter 或继承属性', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  for (const mood of ['__proto__', 'constructor', 'unknown', 'HAPPY', {}, [], null, 1, true]) {
    const saved = store.saveDiary('2026-10-19', { content: '正文', mood });
    assert.equal(saved.mood, null);
    assert.equal(store.loadDiary('2026-10-19').mood, null);
    storage.records.set('2026-10-20', JSON.stringify({ content: '旧数据', mood, updatedAt: saved.updatedAt }));
    assert.equal(store.loadDiary('2026-10-20').mood, null);
  }
  let getterCalled = false;
  const data = { content: '正文', get mood() { getterCalled = true; throw new Error('不应执行'); } };
  assert.equal(store.saveDiary('2026-10-19', data).mood, null);
  assert.equal(getterCalled, false);
  const inherited = Object.assign(Object.create({ mood: 'happy' }), { content: '正文' });
  assert.equal(store.saveDiary('2026-10-19', inherited).mood, null);
});

test('正文更新与重新盖章同时保存，移除印章使用 null', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  store.saveDiary('2026-10-19', { content: '初稿', weather: 'rainy', mood: 'tired' });
  const revised = store.saveDiary('2026-10-19', { content: '修改后的正文', weather: 'sunny', mood: 'hopeful' });
  assert.deepEqual(store.loadDiary('2026-10-19'), revised);
  assert.equal(revised.content, '修改后的正文');
  assert.equal(revised.mood, 'hopeful');
  assert.equal(revised.weather, 'sunny');
  store.saveDiary('2026-10-19', { ...revised, mood: null });
  assert.equal(core.createDiaryStore(storage).loadDiary('2026-10-19').mood, null);
});

test('只有心情印章的日期仍按正文是否非空判断日记', () => {
  const storage = memoryStorage();
  const store = core.createDiaryStore(storage);
  store.saveDiary('2026-10-19', { content: ' \n\t ', mood: 'calm' });
  assert.equal(store.loadDiary('2026-10-19').mood, 'calm');
  assert.equal(store.hasDiary('2026-10-19'), false);
});
