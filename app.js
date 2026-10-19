/* 拾页交互层：存取与日期计算集中在 diary-core.js，方便将来替换为 Tauri fs。 */
(() => {
  'use strict';

  const core = window.DiaryCore;
  const $ = (id) => document.getElementById(id);
  const book = $('book');
  const spread = $('spread');
  const editor = $('diary-content');
  const calendar = $('calendar');
  const cover = $('cover');
  const closeButton = $('close-book');
  const todayButton = $('today-bookmark');
  const retryButton = $('retry-save');
  const status = $('save-status');
  const message = $('app-message');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const weatherTypes = ['sunny', 'cloudy', 'rainy', 'snowy'];
  const weatherNames = { sunny: '晴', cloudy: '阴', rainy: '雨', snowy: '雪' };
  const iconPaths = {
    sunny: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    cloudy: '<path d="M6 18a4 4 0 0 1-1-7.9A6 6 0 0 1 16.5 8 5 5 0 1 1 18 18Z"/>',
    rainy: '<path d="M6 15a4 4 0 0 1-1-7.9A6 6 0 0 1 16.5 5 5 5 0 0 1 18 15M7 18l-1 3m6-3-1 3m6-3-1 3"/>',
    snowy: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m10 14-1-4 4-1M4 14l4 1-1 4M17 5l-1 4 4 1"/>',
  };
  const quotes = [
    '把寻常的日子，过成值得珍藏的故事。',
    '风有风的去处，你有你的归途。',
    '慢慢走，沿途有花，也有光。',
    '留一页给今天，留一点温柔给自己。',
    '那些细碎的欢喜，值得郑重记下。',
    '窗前一盏灯，心上一段好时光。',
    '日子无声，落笔有痕。',
    '人间烟火，最是寻常，也最可珍藏。',
  ];
  let state = 'closed';
  let selectedDate = core.localDateKey();
  let calendarMonth = selectedDate;
  let weather = 'sunny';
  let dirty = false;
  let composing = false;
  let loadFailed = false;
  let saveTimer = null;
  let quoteIndex = -1;

  function announce(text) {
    message.textContent = text;
  }

  function setSaveStatus(kind, text) {
    status.dataset.status = kind;
    status.textContent = text;
    retryButton.hidden = kind !== 'error' || loadFailed;
  }

  function setState(next) {
    state = next;
    book.dataset.state = next;
    const isOpen = next === 'open';
    const isClosed = next === 'closed';
    book.setAttribute('aria-busy', String(!isOpen && !isClosed));
    spread.inert = !isOpen;
    spread.setAttribute('aria-hidden', String(!isOpen));
    cover.disabled = !isClosed;
    cover.tabIndex = isClosed ? 0 : -1;
    cover.setAttribute('aria-hidden', String(!isClosed));
    closeButton.hidden = !isOpen;
    todayButton.hidden = !isOpen;
  }

  // 状态计时与 CSS 的 800ms / 1200ms 一致；减少动态效果时仍依序完成状态切换。
  function pause(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, reducedMotion.matches ? 30 : milliseconds));
  }

  function updateCoverDate() {
    const today = core.localDateKey();
    $('cover-date').dateTime = today;
    $('cover-date').textContent = today.replaceAll('-', ' · ');
  }

  function renderWeather() {
    const button = $('weather');
    button.querySelector('.weather-symbol').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${iconPaths[weather]}</svg>`;
    button.querySelector('.weather-label').textContent = weatherNames[weather];
    button.setAttribute('aria-label', `天气：${weatherNames[weather]}，点击切换`);
    button.disabled = loadFailed;
  }

  function renderCalendar() {
    const monthDate = core.parseDate(calendarMonth);
    $('calendar-title').textContent = `${monthDate.getFullYear()}年 ${String(monthDate.getMonth() + 1).padStart(2, '0')}月`;
    const today = core.localDateKey();
    const fragment = document.createDocumentFragment();
    let unreadable = false;
    for (const item of core.monthGrid(calendarMonth)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'day';
      button.dataset.date = item.date;
      button.classList.toggle('outside', !item.inMonth);
      button.classList.toggle('today', item.date === today);
      button.classList.toggle('selected', item.date === selectedDate);
      let hasEntry = false;
      try {
        hasEntry = core.hasDiary(item.date);
      } catch {
        // 单条损坏不应阻断整个月历，也不能把损坏数据当空白覆盖。
        unreadable = true;
      }
      button.classList.toggle('has-entry', hasEntry);
      button.setAttribute('aria-label', `${core.formatHeading(item.date)}${hasEntry ? '，有日记' : ''}`);
      button.setAttribute('aria-pressed', String(item.date === selectedDate));
      if (item.date === today) button.setAttribute('aria-current', 'date');
      const number = document.createElement('span');
      number.className = 'day-number';
      number.textContent = item.day;
      const dot = document.createElement('span');
      dot.className = 'entry-dot';
      dot.setAttribute('aria-hidden', 'true');
      button.append(number, dot);
      button.disabled = item.date < '0100-01-01' || item.date > '9998-12-31';
      fragment.append(button);
    }
    calendar.replaceChildren(fragment);
    $('previous-month').disabled = calendarMonth.slice(0, 7) <= '0100-01';
    $('next-month').disabled = calendarMonth.slice(0, 7) >= '9998-12';
    $('previous-day').disabled = selectedDate <= '0100-01-01';
    $('next-day').disabled = selectedDate >= '9998-12-31';
    calendar.dataset.storageWarning = String(unreadable);
  }

  function chooseQuote() {
    // 每次翻开换一句，避免连续两次随机到同一句寄语。
    const offset = 1 + Math.floor(Math.random() * (quotes.length - 1));
    quoteIndex = (quoteIndex + offset) % quotes.length;
    $('daily-quote').textContent = quotes[quoteIndex];
  }

  function loadPage(date) {
    selectedDate = date;
    calendarMonth = date;
    dirty = false;
    loadFailed = false;
    editor.disabled = false;
    editor.scrollTop = 0;
    $('entry-date').textContent = core.formatHeading(date);
    editor.setAttribute('aria-label', `${core.formatHeading(date)}的日记`);
    try {
      const data = core.loadDiary(date);
      editor.value = data.content;
      weather = data.weather;
      setSaveStatus('saved', data.updatedAt ? '墨迹已存' : '落笔即存');
    } catch (error) {
      loadFailed = true;
      editor.value = '';
      editor.disabled = true;
      weather = 'sunny';
      setSaveStatus('error', '读取失败');
      announce(`这一天的日记无法读取，原数据已保留。可翻阅其他日期；修复存储后重新打开。${error.message}`);
    }
    renderWeather();
    renderCalendar();
  }

  function cancelPendingSave() {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }

  function updateSavedDayMarker() {
    const day = calendar.querySelector(`button[data-date="${selectedDate}"]`);
    if (!day) return;
    const hasEntry = editor.value.trim().length > 0;
    day.classList.toggle('has-entry', hasEntry);
    day.setAttribute('aria-label', `${core.formatHeading(selectedDate)}${hasEntry ? '，有日记' : ''}`);
  }

  function flushSave(force = false) {
    cancelPendingSave();
    if (loadFailed) return !dirty;
    if (!dirty && !force) return true;
    if (composing) {
      announce('请先完成当前输入法选字，再翻页或合上日记。');
      return false;
    }
    try {
      const recovering = status.dataset.status === 'error';
      core.saveDiary(selectedDate, { content: editor.value, weather });
      dirty = false;
      setSaveStatus('saved', '墨迹已存');
      // blur 先于鼠标 click；此处重建月历会移除待点击按钮，导致翻页点击丢失。
      updateSavedDayMarker();
      if (recovering) announce('保存已恢复，文字已妥善收好。');
      return true;
    } catch (error) {
      dirty = true;
      setSaveStatus('error', '未保存');
      announce(`保存失败，文字仍保留在当前页。请释放浏览器存储空间或恢复存储权限后，点击“重试保存”。${error.message}`);
      return false;
    }
  }

  function scheduleSave() {
    dirty = true;
    setSaveStatus('pending', '正在落墨…');
    cancelPendingSave();
    if (!composing) saveTimer = window.setTimeout(() => flushSave(), 300);
  }

  function navigate(date) {
    if (state !== 'open' || composing || !flushSave()) return;
    if (date < '0100-01-01' || date > '9998-12-31') return;
    loadPage(date);
    if (!loadFailed) announce(date === core.localDateKey() ? '已回到今天。' : `已翻至${core.formatHeading(date)}。`);
  }

  async function openBook() {
    if (state !== 'closed') return;
    updateCoverDate();
    loadPage(core.localDateKey());
    chooseQuote();
    setState('opening');
    announce('正在翻开日记……');
    await pause(800);
    setState('flipping');
    await pause(1200);
    setState('open');
    if (!loadFailed) announce(calendar.dataset.storageWarning === 'true' ? '已翻到今天。部分历史日记无法读取，原数据已保留。' : '已翻到今天。写下此刻，落笔即存。');
    editor.focus({ preventScroll: true });
  }

  async function closeBook() {
    if (state !== 'open' || !flushSave(true)) return;
    setState('closing');
    announce('正在合上日记……');
    await pause(800);
    setState('closed');
    updateCoverDate();
    announce(loadFailed ? '已合上；无法读取的原数据已保留。点击封面可再次翻开。' : '已合上并保存，点击封面可再次翻开。');
    cover.focus({ preventScroll: true });
    // Tauri v2 与 v1 的全局 API 位置不同；浏览器预览不触发 window.close。
    const tauri = window.__TAURI__;
    if (!tauri && !window.__TAURI_INTERNALS__) return;
    try {
      if (tauri?.window?.getCurrentWindow) {
        await tauri.window.getCurrentWindow().close();
      } else if (tauri?.window?.appWindow?.close) {
        await tauri.window.appWindow.close();
      } else if (tauri?.window?.getCurrent) {
        await tauri.window.getCurrent().close();
      } else {
        throw new Error('请启用 Tauri withGlobalTauri，并授予窗口关闭权限。');
      }
    } catch (error) {
      announce(`日记已合上${loadFailed ? '' : '并保存'}，窗口关闭失败。${error.message} 点击封面可再次翻开。`);
    }
  }

  cover.addEventListener('click', openBook);
  closeButton.addEventListener('click', closeBook);
  todayButton.addEventListener('click', () => navigate(core.localDateKey()));
  $('previous-day').addEventListener('click', () => navigate(core.shiftDay(selectedDate, -1)));
  $('next-day').addEventListener('click', () => navigate(core.shiftDay(selectedDate, 1)));
  calendar.addEventListener('click', (event) => {
    const day = event.target.closest('button[data-date]');
    if (day && !day.disabled) navigate(day.dataset.date);
  });
  for (const [id, delta] of [['previous-month', -1], ['next-month', 1]]) {
    $(id).addEventListener('click', () => {
      if (state !== 'open' || composing) return;
      calendarMonth = core.shiftMonth(calendarMonth, delta);
      renderCalendar();
      announce(`正在查看${$('calendar-title').textContent}，右页日期不变。`);
    });
  }
  $('weather').addEventListener('click', () => {
    if (state !== 'open' || loadFailed || composing) return;
    weather = weatherTypes[(weatherTypes.indexOf(weather) + 1) % weatherTypes.length];
    renderWeather();
    dirty = true;
    flushSave();
  });
  editor.addEventListener('input', scheduleSave);
  editor.addEventListener('compositionstart', () => {
    composing = true;
    cancelPendingSave();
  });
  editor.addEventListener('compositionend', () => {
    composing = false;
    scheduleSave();
  });
  editor.addEventListener('blur', () => {
    if (!composing) flushSave();
  });
  retryButton.addEventListener('click', () => {
    if (state === 'open' && flushSave()) announce('已重新保存，文字已妥善收好。');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !composing) flushSave();
    if (document.visibilityState === 'visible') updateCoverDate();
  });
  window.addEventListener('pagehide', () => {
    if (!composing) flushSave();
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty && !flushSave()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (state === 'open') flushSave(true);
    }
  });

  updateCoverDate();
  setState('closed');
})();
