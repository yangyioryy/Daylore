/* 拾页交互层：存取与日期计算集中在 diary-core.js，方便将来替换为 Tauri fs。 */
(() => {
  'use strict';

  const core = window.DiaryCore;
  const services = window.DiaryServices;
  const quoteService = services.createQuoteService();
  const sounds = services.createSoundPlayer();
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
  const stamp = $('mood-stamp');
  const moodPicker = $('mood-picker');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const weatherTypes = ['sunny', 'cloudy', 'rainy', 'snowy'];
  const weatherNames = { sunny: '晴', cloudy: '阴', rainy: '雨', snowy: '雪' };
  const iconPaths = {
    sunny: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    cloudy: '<path d="M6 18a4 4 0 0 1-1-7.9A6 6 0 0 1 16.5 8 5 5 0 1 1 18 18Z"/>',
    rainy: '<path d="M6 15a4 4 0 0 1-1-7.9A6 6 0 0 1 16.5 5 5 5 0 0 1 18 15M7 18l-1 3m6-3-1 3m6-3-1 3"/>',
    snowy: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m10 14-1-4 4-1M4 14l4 1-1 4M17 5l-1 4 4 1"/>',
  };
  const moodPaths = {
    happy: '<path d="M7 14q5 7 10 0M8 9h.01M16 9h.01"/>',
    calm: '<path d="M6 10h4m4 0h4M9 16q3 2 6 0"/>',
    tired: '<path d="M6 10l4 1m4 0 4-1M9 17h6M19 4l3 3-3 3"/>',
    confused: '<path d="M8 8q1-4 5-3 5 2 1 5l-2 2v2m0 4h.01"/>',
    hopeful: '<path d="m12 4 2.2 5 5.8.6-4.3 3.8 1.3 5.6-5-3-5 3 1.3-5.6L4 9.6 9.8 9Z"/>',
    sad: '<path d="M7 10h.01M16 10h.01M8 18q4-5 8 0M7 13l-2 3q-1 3 1 3 3 0 1-3Z"/>',
  };
  let state = 'closed';
  let selectedDate = core.localDateKey();
  let calendarMonth = selectedDate;
  let weather = 'sunny';
  let mood = null;
  let dirty = false;
  let composing = false;
  let loadFailed = false;
  let saveTimer = null;
  let quoteRequest = 0;

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
    closeButton.hidden = !(isOpen || next === 'turning');
    todayButton.hidden = !(isOpen || next === 'turning');
    closeButton.disabled = !isOpen;
    todayButton.disabled = !isOpen;
    if (!isOpen) hideMoodPicker();
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

  function hideMoodPicker() {
    moodPicker.hidden = true;
    stamp.setAttribute('aria-expanded', 'false');
  }

  function moodInfo(value) {
    return core.MOODS.find((item) => item.id === value);
  }

  function renderMood() {
    const info = moodInfo(mood);
    stamp.dataset.mood = mood || '';
    stamp.disabled = loadFailed;
    stamp.querySelector('.stamp-icon').innerHTML = info ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>${moodPaths[mood]}</svg>` : '印';
    stamp.querySelector('.stamp-label').textContent = info ? info.label : '留个心情';
    stamp.setAttribute('aria-label', info ? `心情：${info.label}，点击更换或移除印章` : '选择今日心情印章');
    for (const option of moodPicker.querySelectorAll('button[data-mood]')) option.setAttribute('aria-pressed', String(option.dataset.mood === (mood || '')));
  }

  function updateMoodMarker(day, value) {
    const info = moodInfo(value);
    day.dataset.mood = info ? info.id : '';
    let mark = day.querySelector('.mood-mark');
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'mood-mark';
      mark.setAttribute('aria-hidden', 'true');
      day.append(mark);
    }
    mark.textContent = info ? info.symbol : '';
    mark.hidden = !info;
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
      let dayMood = null;
      try {
        const record = core.loadDiary(item.date);
        hasEntry = record.content.trim().length > 0;
        dayMood = record.mood;
      } catch {
        // 单条损坏不应阻断整个月历，也不能把损坏数据当空白覆盖。
        unreadable = true;
      }
      button.classList.toggle('has-entry', hasEntry);
      button.setAttribute('aria-label', `${core.formatHeading(item.date)}${hasEntry ? '，有日记' : ''}${dayMood ? `，心情${moodInfo(dayMood).label}` : ''}`);
      button.setAttribute('aria-pressed', String(item.date === selectedDate));
      if (item.date === today) button.setAttribute('aria-current', 'date');
      const number = document.createElement('span');
      number.className = 'day-number';
      number.textContent = item.day;
      const dot = document.createElement('span');
      dot.className = 'entry-dot';
      dot.setAttribute('aria-hidden', 'true');
      button.append(number, dot);
      updateMoodMarker(button, dayMood);
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

  function fitQuote(text) {
    // 窄屏纸页更小，优先换成完整短句，不裁掉句子的后半截。
    const limit = window.innerWidth <= 480 ? 16 : services.MAX_QUOTE_LENGTH;
    if (Array.from(text).length <= limit) return text;
    const current = $('daily-quote').textContent;
    const candidates = services.DEFAULT_QUOTES.filter((item) => Array.from(item).length <= limit && item !== current);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  async function chooseQuote() {
    const request = ++quoteRequest;
    const button = $('refresh-quote');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const quote = await quoteService.next();
      // 过期请求不能把后来翻到的页面或手动换句覆盖掉。
      if (request === quoteRequest) $('daily-quote').textContent = fitQuote(quote);
    } finally {
      if (request === quoteRequest) {
        button.disabled = false;
        button.setAttribute('aria-busy', 'false');
      }
    }
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
      mood = data.mood;
      setSaveStatus('saved', data.updatedAt ? '墨迹已存' : '落笔即存');
    } catch (error) {
      loadFailed = true;
      editor.value = '';
      editor.disabled = true;
      weather = 'sunny';
      mood = null;
      setSaveStatus('error', '读取失败');
      announce(`这一天的日记无法读取，原数据已保留。可翻阅其他日期；修复存储后重新打开。${error.message}`);
    }
    renderWeather();
    renderMood();
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
    updateMoodMarker(day, mood);
    day.setAttribute('aria-label', `${core.formatHeading(selectedDate)}${hasEntry ? '，有日记' : ''}${mood ? `，心情${moodInfo(mood).label}` : ''}`);
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
      core.saveDiary(selectedDate, { content: editor.value, weather, mood });
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

  function makeTurningLeaf(direction) {
    const leaf = document.createElement('div');
    leaf.className = 'date-turn';
    leaf.setAttribute('aria-hidden', 'true');
    leaf.inert = true;
    const front = document.createElement('div');
    front.className = 'turn-face turn-front';
    const snapshot = document.querySelector(direction === 'forward' ? '.page-right' : '.page-left').cloneNode(true);
    snapshot.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    snapshot.querySelector('.mood-picker')?.remove();
    if (snapshot.querySelector('textarea')) snapshot.querySelector('textarea').value = editor.value;
    front.append(snapshot);
    const back = document.createElement('div');
    back.className = 'turn-face turn-back';
    leaf.append(front, back);
    book.append(leaf);
    return leaf;
  }

  async function navigate(date) {
    if (state !== 'open' || composing || !flushSave()) return;
    if (date < '0100-01-01' || date > '9998-12-31') return;
    if (date === selectedDate) {
      calendarMonth = date;
      renderCalendar();
      announce('已经在这一页了。');
      return;
    }
    const direction = date > selectedDate ? 'forward' : 'backward';
    book.dataset.direction = direction;
    book.dataset.turnPhase = 'first';
    hideMoodPicker();
    const leaf = makeTurningLeaf(direction);
    setState('turning');
    void sounds.play('flip');
    // 先保存旧页，中点再装入新页；整个翻页期间锁住控件，避免连点串日。
    await pause(280);
    loadPage(date);
    book.dataset.turnPhase = 'second';
    void chooseQuote();
    await pause(280);
    leaf.remove();
    delete book.dataset.direction;
    delete book.dataset.turnPhase;
    setState('open');
    if (!loadFailed) announce(date === core.localDateKey() ? '已回到今天。' : `已翻至${core.formatHeading(date)}。`);
  }

  async function openBook() {
    if (state !== 'closed') return;
    updateCoverDate();
    loadPage(core.localDateKey());
    void chooseQuote();
    setState('opening');
    void sounds.play('flip');
    announce('正在翻开日记……');
    await pause(800);
    setState('flipping');
    void sounds.play('flip');
    await pause(1200);
    setState('open');
    if (!loadFailed) announce(calendar.dataset.storageWarning === 'true' ? '已翻到今天。部分历史日记无法读取，原数据已保留。' : '已翻到今天。写下此刻，落笔即存。');
    editor.focus({ preventScroll: true });
  }

  async function closeBook() {
    if (state !== 'open' || !flushSave(true)) return;
    quoteRequest += 1;
    setState('closing');
    void sounds.play('close');
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
  $('refresh-quote').addEventListener('click', () => {
    if (state === 'open') void chooseQuote();
  });
  for (const item of [...core.MOODS, { id: '', label: '移除印章', symbol: '×' }]) {
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.mood = item.id;
    const symbol = document.createElement('span');
    symbol.textContent = item.symbol;
    symbol.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    option.append(symbol, label);
    moodPicker.append(option);
  }
  stamp.addEventListener('click', () => {
    if (state !== 'open' || loadFailed || composing) return;
    moodPicker.hidden = !moodPicker.hidden;
    stamp.setAttribute('aria-expanded', String(!moodPicker.hidden));
    if (!moodPicker.hidden) moodPicker.querySelector(`[data-mood="${mood || ''}"]`)?.focus();
  });
  moodPicker.addEventListener('click', (event) => {
    const option = event.target.closest('button[data-mood]');
    if (!option || state !== 'open' || loadFailed || composing) return;
    mood = option.dataset.mood || null;
    renderMood();
    dirty = true;
    const saved = flushSave();
    hideMoodPicker();
    stamp.focus({ preventScroll: true });
    if (mood && !reducedMotion.matches) stamp.animate([{ transform: 'rotate(-8deg) scale(1.22)', opacity: .5 }, { transform: 'rotate(-8deg) scale(1)', opacity: 1 }], { duration: 260, easing: 'ease-out' });
    if (saved) announce(mood ? `已盖下“${moodInfo(mood).label}”心情，月历也记住了。` : '心情印章已移除。');
  });
  document.addEventListener('click', (event) => {
    if (!moodPicker.hidden && !moodPicker.contains(event.target) && !stamp.contains(event.target)) hideMoodPicker();
  });
  window.addEventListener('resize', () => {
    $('daily-quote').textContent = fitQuote($('daily-quote').textContent);
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
    if (event.key === 'Escape' && !moodPicker.hidden) {
      hideMoodPicker();
      stamp.focus({ preventScroll: true });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (state === 'open') flushSave(true);
    }
  });

  updateCoverDate();
  setState('closed');
})();
