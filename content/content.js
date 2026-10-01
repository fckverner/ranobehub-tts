/* content.js — всё, что происходит на странице главы ranobehub.org.
 *
 *   • разбирает название главы и её ID;
 *   • просит фон найти mp3 и манифест в облаке (фон не боится CORS);
 *   • считает раскладку «реплики ↔ абзацы» (manifest-matcher.js);
 *   • показывает плеер в теневом DOM (стили сайта ему не мешают);
 *   • подсвечивает звучащий абзац и прокручивает страницу вслед за озвучкой;
 *   • панель можно перетащить в любое место страницы — положение запоминается;
 *   • кнопка «Найти по тексту»: клик по любому абзацу — озвучка с него.
 *
 * Разметка панели, CSS страницы и надписи-заглушки — в content/templates.js.
 * Общие настройки и ключи хранилища — в lib/settings.js.
 *
 * Всё, что видит человек, — простыми словами. Технические подробности уходят
 * в журнал (log()), который открывается в попапе: «Настройки → Для разработчика».
 */
'use strict';

(function () {
  if (window.__rhTts) { window.__rhTts.refresh(); return; }

  const M = window.ManifestMatcher;
  const Meta = window.RanobeChapterMeta;
  const Settings = window.RanobeSettings;
  const { HL_CLASS, PAGE_CSS, PANEL_HTML, NOTES } = window.RhTtsTemplates;

  const KEYS = Settings.KEYS;
  const DEFAULT_MARGIN = 16;
  const DOCK_DEFAULT_Y = 0.72;
  const RESUME_MS = 60000;           // сколько живёт намерение «продолжить звук в следующей главе»

  const state = {
    idle: false,
    dockY: DOCK_DEFAULT_Y,
    prefCollapsed: false,
    emptyMode: false,
    emptyOpen: false,
    emptyBook: '',
    resumeUntil: 0,
    panelPos: null,
    meta: null,
    settings: null,
    resolve: null,
    manifest: null,
    prepared: null,
    follow: null,
    audio: null,
    pickMode: false,
    status: 'запуск…',
    loadedChapter: null,
    loadSeq: 0,
    collapsed: false,
    followOpts: null,       // объект опций M.follow(); меняется на лету (eyeLevel, magnet)
    layoutLogged: '',       // подпись последней записанной в журнал раскладки
    rangeLogged: '',
    ui: {}
  };

  // ------------------------------------------------------------- помощники

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function ask(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload), (res) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res || {});
        });
      } catch (e) {
        resolve({ error: String(e && e.message || e) });
      }
    });
  }

  // Технический журнал: уходит в фон и читается только из попапа.
  function log(level, message, data) {
    try {
      chrome.runtime.sendMessage({ type: 'log', level, source: 'page', message, data }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* расширение перезагружено — журнал не критичен */ }
  }

  function injectPageCss() {
    if (document.getElementById('rh-tts-style')) return;
    const style = document.createElement('style');
    style.id = 'rh-tts-style';
    style.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------- разметка


  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'rh-tts-host';
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; width: max-content; ' +
      'right: ' + DEFAULT_MARGIN + 'px; bottom: ' + DEFAULT_MARGIN + 'px;';
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content/panel.css');
    shadow.appendChild(link);
    const wrap = document.createElement('div');
    wrap.innerHTML = PANEL_HTML;
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.crossOrigin = null;
    shadow.appendChild(audio);
    state.audio = audio;

    const q = (id) => shadow.getElementById(id);
    state.ui = {
      host, shadow, wrap,
      chapter: q('chapter'), status: q('status'), hint: q('hint'),
      note: q('note'), noteIcon: q('noteIcon'), noteTitle: q('noteTitle'), noteText: q('noteText'),
      noteActions: q('noteActions'), noteRecheck: q('noteRecheck'),
      play: q('play'), seek: q('seek'), buffered: q('buffered'), cur: q('cur'), total: q('total'),
      pick: q('pick'), reload: q('reload'), settings: q('settings'),
      recheck: q('recheck'), settings2: q('settings2'), panel: wrap.querySelector('.panel'),
      dock: q('dock'), dockBtn: q('dockBtn'), dockTipTitle: q('dockTipTitle'), dockTipText: q('dockTipText'),
      magnet: q('magnet'), eye: q('eye'),
      rate: q('rate'), vol: q('vol'), collapse: q('collapse'), head: q('head')
    };
    try { q('dockImg').src = chrome.runtime.getURL('icons/icon48.png'); } catch (e) { /* без значка обойдёмся */ }
    wirePanel();
    wireDrag();
    wireDock();
    loadPanelPrefs();
    return host;
  }

  // ------------------------------------------------------- положение панели

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // pos = {left, top} в пикселях окна или null (штатное место: правый нижний угол).
  // Сохранённое значение не портится: если окно стало меньше, панель лишь
  // показывается в пределах экрана, а в памяти остаётся то, что выбрал человек.
  function placeHost() {
    const host = state.ui.host;
    if (!host) return;
    if (state.idle) {
      // Значок-«язычок»: прижат к правому краю, по вертикали двигается.
      const h = host.offsetHeight || 40;
      const top = clamp(Math.round(state.dockY * window.innerHeight - h / 2), 8, Math.max(8, window.innerHeight - h - 8));
      host.style.left = 'auto'; host.style.bottom = 'auto';
      host.style.right = '0px'; host.style.top = top + 'px';
      return;
    }
    const pos = state.panelPos;
    if (!pos) {
      host.style.left = 'auto'; host.style.top = 'auto';
      host.style.right = DEFAULT_MARGIN + 'px'; host.style.bottom = DEFAULT_MARGIN + 'px';
      return;
    }
    const w = host.offsetWidth || 336, h = host.offsetHeight || 120;
    const maxX = Math.max(0, window.innerWidth - w), maxY = Math.max(0, window.innerHeight - h);
    host.style.right = 'auto'; host.style.bottom = 'auto';
    host.style.left = Math.round(clamp(pos.left, 0, maxX)) + 'px';
    host.style.top = Math.round(clamp(pos.top, 0, maxY)) + 'px';
  }

  function savePanelPos(pos) {
    state.panelPos = pos;
    try {
      if (pos) chrome.storage.local.set({ [KEYS.panelPos]: pos });
      else chrome.storage.local.remove(KEYS.panelPos);
    } catch (e) { /* расширение перезагружено */ }
  }

  // Свёрнутость складывается из двух вещей: выбор человека (prefCollapsed, он
  // запоминается) и временное правило для тайтлов без озвучки (emptyMode: панель
  // свёрнута, пока человек сам её не раскроет). Временное правило выбор не портит.
  // Закраска пройденной части ползунка (в CSS читается как --p).
  function paintRange(el) {
    if (!el) return;
    const max = Number(el.max) || 100;
    el.style.setProperty('--p', Math.max(0, Math.min(100, (Number(el.value) / max) * 100)) + '%');
  }

  function applyCollapse() {
    const ui = state.ui;
    if (!ui.wrap) return;
    const collapsed = state.emptyMode ? !state.emptyOpen : !!state.prefCollapsed;
    ui.wrap.querySelector('.body').style.display = collapsed ? 'none' : '';
    ui.collapse.classList.toggle('is-collapsed', collapsed);
    state.collapsed = collapsed;
    placeHost();                                   // высота изменилась — не даём панели уехать за экран
  }

  function setCollapsed(collapsed, persist) {
    state.prefCollapsed = !!collapsed;
    applyCollapse();
    if (persist) {
      try { chrome.storage.local.set({ [KEYS.panelCollapsed]: !!collapsed }); } catch (e) {}
    }
  }

  // Тайтл без единой озвученной главы: панель сворачивается, а в шапке — понятная
  // подпись. По кнопке ▸ можно развернуть и прочитать пояснение.
  function applyEmptyState() {
    const r = state.resolve;
    const on = !!(r && r.status !== 'ok' && r.reason === 'no-title');
    const bookId = String(state.meta && state.meta.book_id || '');
    if (on) {
      // Открытое вручную окно не захлопываем при листании глав той же книги.
      if (!state.emptyMode || state.emptyBook !== bookId) state.emptyOpen = false;
      state.emptyBook = bookId;
      state.ui.chapter.textContent = 'Этого тайтла нет в озвучке';
      state.ui.chapter.title = 'Ни одна глава этой книги ещё не озвучена';
    } else {
      state.ui.chapter.title = '';
    }
    state.emptyMode = on;
    state.ui.panel.classList.toggle('empty-mode', on);
    applyCollapse();
  }

  // ---------------------------------------- значок, пока глава не открыта

  function isChapterPage() {
    return !!Meta.fromUrl(location.href).chapter_id || !!document.querySelector('[id^="reader-content-"]');
  }

  // Текст подсказки у значка зависит от страницы: главная, тайтл (есть ли озвучка
  // в облаке) и т. д. Спрашиваем фон; ответ по адресу запоминаем на время визита.
  let dockTipHref = '';
  let dockTipSeq = 0;
  function paintDockTip(t) {
    const ui = state.ui;
    if (!ui.dock || !t) return;
    ui.dockTipTitle.textContent = t.title || '';
    ui.dockTipText.textContent = t.text || '';
    ui.dock.dataset.tone = t.tone || 'ok';
    const label = 'Озвучка RanobeHub — ' + String(t.title || '').toLowerCase();
    ui.dockBtn.title = label;
    ui.dockBtn.setAttribute('aria-label', label);
  }
  function refreshDockTip(force) {
    const ui = state.ui;
    if (!ui.dock || !state.idle) return;
    if (!force && dockTipHref === location.href) return;
    dockTipHref = location.href;
    const seq = ++dockTipSeq;
    const href = location.href;
    ask('pageContext', { url: href, refresh: !!force }).then((res) => {
      if (!res || res.error) return;                              // расширение перезагружено — оставим прежний текст
      if (seq !== dockTipSeq || href !== location.href) return;   // страница уже сменилась
      paintDockTip(res);
    });
  }

  function setIdle(on) {
    const ui = state.ui;
    if (!ui.dock) return;
    state.idle = !!on;
    if (on) refreshDockTip(false);
    ui.panel.hidden = !!on;
    ui.dock.hidden = !on;
    ui.dock.classList.remove('open');
    if (state.ui.host) state.ui.host.style.display = '';
    placeHost();
    if (!on) applyCollapse();
  }

  // Главы нет — значок; глава есть — обычная панель. Пока звук идёт, панель не
  // прячем: человек мог уйти со страницы главы, оставив озвучку играть.
  function syncIdle() {
    if (!state.ui.dock) return;
    const chapter = isChapterPage();
    if (chapter && state.idle) setIdle(false);
    else if (!chapter && !state.idle && (!state.audio || state.audio.paused)) setIdle(true);
    else if (!chapter && state.idle) refreshDockTip(false);      // SPA: перешли с главной на тайтл
  }

  function wireDock() {
    const ui = state.ui, btn = ui.dockBtn;
    let drag = null;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { y0: e.clientY, moved: false };
      try { btn.setPointerCapture(e.pointerId); } catch (err) {}
    });
    btn.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientY - drag.y0) < 5) return;   // это ещё клик
      drag.moved = true;
      ui.dock.classList.add('dragging');
      state.dockY = clamp(e.clientY / window.innerHeight, 0.03, 0.97);
      placeHost();
    });
    const finish = () => {
      if (!drag) return;
      ui.dock.classList.remove('dragging');
      if (drag.moved) {
        try { chrome.storage.local.set({ [KEYS.dockY]: Math.round(state.dockY * 1000) / 1000 }); } catch (e) {}
      } else {
        ui.dock.classList.toggle('open');      // клик: показать/убрать подсказку
        if (ui.dock.dataset.tone === 'warn') refreshDockTip(true);
      }
      drag = null;
    };
    btn.addEventListener('pointerup', finish);
    btn.addEventListener('pointercancel', () => { drag = null; ui.dock.classList.remove('dragging'); });
    // С клавиатуры (Enter/Пробел) значок тоже открывает подсказку.
    btn.addEventListener('click', (e) => { if (e.detail === 0) ui.dock.classList.toggle('open'); });
    // Клик мимо значка убирает подсказку, открытую кликом.
    document.addEventListener('pointerdown', (e) => {
      if (e.composedPath && e.composedPath().indexOf(ui.host) >= 0) return;
      ui.dock.classList.remove('open');
    }, true);
  }

  function wireDrag() {
    const ui = state.ui, head = ui.head;
    let drag = null;

    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest && e.target.closest('button'))) return;
      const r = ui.host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      ui.panel.classList.add('dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = ui.host.offsetWidth, h = ui.host.offsetHeight;
      const left = clamp(e.clientX - drag.dx, 0, Math.max(0, window.innerWidth - w));
      const top = clamp(e.clientY - drag.dy, 0, Math.max(0, window.innerHeight - h));
      drag.moved = true;
      state.panelPos = { left, top };
      placeHost();
    });
    const finish = () => {
      if (!drag) return;
      ui.panel.classList.remove('dragging');
      if (drag.moved && state.panelPos) {
        savePanelPos({ left: Math.round(state.panelPos.left), top: Math.round(state.panelPos.top) });
        log('info', 'Панель перемещена', state.panelPos);
      }
      drag = null;
    };
    head.addEventListener('pointerup', finish);
    head.addEventListener('pointercancel', finish);
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      savePanelPos(null);
      placeHost();
      setHint('Панель возвращена на место.');
    });

    window.addEventListener('resize', placeHost);
  }

  function loadPanelPrefs() {
    try {
      chrome.storage.local.get([KEYS.panelPos, KEYS.panelCollapsed, KEYS.dockY], (st) => {
        if (chrome.runtime.lastError || !st) return;
        if (isFinite(st[KEYS.dockY])) state.dockY = clamp(Number(st[KEYS.dockY]), 0.03, 0.97);
        const p = st[KEYS.panelPos];
        state.panelPos = p && isFinite(p.left) && isFinite(p.top) ? { left: p.left, top: p.top } : null;
        placeHost();
        state.prefCollapsed = !!st[KEYS.panelCollapsed];
        applyCollapse();
      });
      // Попап (кнопка «Вернуть панель на место») и другие вкладки меняют то же хранилище.
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[KEYS.panelPos]) {
          const p = changes[KEYS.panelPos].newValue;
          state.panelPos = p && isFinite(p.left) && isFinite(p.top) ? { left: p.left, top: p.top } : null;
          placeHost();
        }
        if (changes[KEYS.dockY] && isFinite(changes[KEYS.dockY].newValue)) {
          state.dockY = clamp(Number(changes[KEYS.dockY].newValue), 0.03, 0.97);
          placeHost();
        }
        if (changes[KEYS.panelCollapsed] && !!changes[KEYS.panelCollapsed].newValue !== !!state.prefCollapsed) {
          state.prefCollapsed = !!changes[KEYS.panelCollapsed].newValue;
          applyCollapse();
        }
      });
    } catch (e) { /* без хранилища панель просто стоит на штатном месте */ }
  }

  function setStatus(text, kind) {
    state.status = text;
    if (!state.ui.status) return;
    state.ui.status.textContent = text;
    state.ui.status.dataset.kind = kind || '';
    state.ui.wrap.querySelector('.dot').dataset.kind = kind || '';
  }

  function setHint(text) {
    if (state.ui.hint) {
      state.ui.hint.textContent = text || '';
      state.ui.hint.style.display = text ? '' : 'none';
    }
  }

  // ------------------------------------------------------------- плеер

  function wirePanel() {
    const ui = state.ui, audio = state.audio;

    ui.play.addEventListener('click', () => {
      if (!state.manifest) { setHint('Озвучка ещё не загрузилась.'); return; }
      if (audio.paused) audio.play().catch(onPlayError);
      else audio.pause();
    });

    ui.seek.addEventListener('input', () => {
      paintRange(ui.seek);
      if (!isFinite(audio.duration) || !audio.duration) return;
      audio.currentTime = (Number(ui.seek.value) / 1000) * audio.duration;
      state.follow && state.follow.reset();
    });
    ui.seek.addEventListener('change', () => {
      state.follow && state.follow.reset();
    });

    ui.pick.addEventListener('click', () => togglePickMode());
    ui.reload.addEventListener('click', () => { load(true); });
    ui.settings.addEventListener('click', async () => {
      const res = await ask('openSettings');
      if (!res.opened) setHint('Настройки расширения — значок «Озвучка RanobeHub» на панели браузера (справа от адресной строки).');
    });
    ui.collapse.addEventListener('click', () => {
      if (state.emptyMode) { state.emptyOpen = !state.emptyOpen; applyCollapse(); return; }
      setCollapsed(!state.prefCollapsed, true);
    });
    ui.recheck.addEventListener('click', () => { load(true); });
    ui.noteRecheck.addEventListener('click', () => recheckPage());
    ui.settings2.addEventListener('click', () => ui.settings.click());

    ui.magnet.addEventListener('change', () => {
      ui.eye.disabled = !ui.magnet.checked;
      saveSettings({ magnet: ui.magnet.checked });
      state.follow && state.follow.setMagnet(ui.magnet.checked);
    });
    ui.eye.addEventListener('change', () => {
      const level = Number(ui.eye.value);
      if (state.followOpts) state.followOpts.eyeLevel = level / 100;   // читается в момент прокрутки
      saveSettings({ eyeLevel: level });
    });
    ui.rate.addEventListener('change', () => {
      audio.playbackRate = audio.defaultPlaybackRate = Number(ui.rate.value);
      saveSettings({ playbackRate: Number(ui.rate.value) });
    });
    ui.vol.addEventListener('input', () => {
      audio.volume = Number(ui.vol.value) / 100;
      paintRange(ui.vol);
      saveSettings({ volume: audio.volume });
    });

    audio.addEventListener('play', () => { ui.play.classList.add('playing'); });
    audio.addEventListener('pause', () => { ui.play.classList.remove('playing'); });
    audio.addEventListener('waiting', () => setStatus('Загружаю…', 'work'));
    audio.addEventListener('playing', () => { refreshStatus(); });
    audio.addEventListener('progress', paintBuffered);
    audio.addEventListener('loadedmetadata', () => { ui.total.textContent = fmtTime(audio.duration); refreshStatus(); });
    audio.addEventListener('error', () => {
      setStatus('Не удалось воспроизвести озвучку. Нажмите ↻, чтобы попробовать снова.', 'error');
      log('error', 'Ошибка воспроизведения mp3: ' + describeAudioError(),
          { code: audio.error && audio.error.code, src: audio.currentSrc });
    });
    audio.addEventListener('ended', () => {
      ui.play.classList.remove('playing');
      if (state.settings && state.settings.autoNext) goToNextChapter();
    });

    // Полоса времени: обновляем каждый кадр, но не мешаем, пока человек тянет ползунок.
    let seeking = false;
    ui.seek.addEventListener('pointerdown', () => { seeking = true; });
    ui.seek.addEventListener('pointerup', () => { seeking = false; });
    const tick = () => {
      if (isFinite(audio.duration) && audio.duration) {
        if (!seeking) { ui.seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000)); paintRange(ui.seek); }
        ui.cur.textContent = fmtTime(audio.currentTime);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.pickMode) { togglePickMode(false); return; }
      const inside = e.composedPath && e.composedPath().indexOf(ui.host) >= 0;
      if (inside && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); ui.play.click(); }
    }, true);

    // клик по абзацу в режиме «Найти по тексту»
    document.addEventListener('click', (e) => {
      if (!state.pickMode) return;
      const block = e.target && e.target.closest
        ? e.target.closest(M.BLOCK_SELECTOR) : null;
      if (!block) return;
      if (block.closest('#rh-tts-host')) return;
      e.preventDefault();
      e.stopPropagation();
      jumpToBlock(block);
    }, true);

    window.addEventListener('beforeunload', () => { if (state.follow) state.follow.stop(); });
  }

  function describeAudioError() {
    const err = state.audio && state.audio.error;
    if (!err) return 'неизвестная ошибка';
    const map = {
      1: 'загрузка прервана',
      2: 'сеть недоступна или сервер оборвал соединение',
      3: 'файл повреждён',
      4: 'формат не поддерживается или ссылка закрыта (нет доступа)'
    };
    return map[err.code] || ('код ' + err.code);
  }

  function onPlayError(e) {
    const msg = String(e && e.message || e);
    const needsClick = /gesture|user/i.test(msg);
    setStatus(needsClick ? 'Браузер ждёт клика — нажмите ▶' : 'Не удалось запустить воспроизведение. Нажмите ▶ ещё раз.', 'error');
    log(needsClick ? 'info' : 'error', 'Запуск воспроизведения не удался: ' + msg);
  }

  function paintBuffered() {
    const audio = state.audio, ui = state.ui;
    if (!audio || !audio.duration || !ui.buffered) return;
    let end = 0;
    try {
      for (let i = 0; i < audio.buffered.length; i++) {
        if (audio.buffered.start(i) <= audio.currentTime + 0.5) end = audio.buffered.end(i);
      }
      if (!end && audio.buffered.length) end = audio.buffered.end(audio.buffered.length - 1);
    } catch (e) { /* буфер ещё не готов */ }
    ui.buffered.style.width = Math.min(100, (end / audio.duration) * 100) + '%';
  }

  function refreshStatus() {
    const r = state.resolve;
    if (!r) return;
    if (r.status !== 'ok') { setStatus(r.message || 'Озвучка недоступна.', r.reason === 'not-published' ? 'warn' : 'error'); return; }
    const q = state.prepared ? state.prepared.quality : 0;
    const dur = state.audio && isFinite(state.audio.duration) && state.audio.duration
      ? ' · ' + fmtTime(state.audio.duration) : '';
    // Человеку хватает трёх состояний; цифры «похожести» и число реплик — в журнал.
    if (q >= 0.6) setStatus('Озвучка готова' + dur, 'ok');
    else if (q >= 0.4) setStatus('Озвучка готова, но подсветка текста может быть неточной' + dur, 'warn');
    else setStatus('Озвучка может не совпадать с текстом на странице', 'error');
    // Статус обновляется часто (буферизация, старт, метаданные) — в журнал пишем один раз.
    const sig = r.manifest.chapter_id + ':' + q.toFixed(2);
    if (state.layoutLogged !== sig) {
      state.layoutLogged = sig;
      log('info', 'Раскладка: реплик ' + r.manifest.segment_count + ', абзацев ' +
          (state.prepared ? state.prepared.index.n : '?') + ', похожесть ' + q.toFixed(2) +
          (r.audio && r.audio.sizeText ? ', mp3 ' + r.audio.sizeText : ''));
    }
    if (q < 0.4) {
      setHint('Возможно, страница ещё не догрузилась или озвучка сделана для другой версии текста. '
              + 'Попробуйте обновить страницу.');
    } else if (r.audio && r.audio.ok && !r.audio.ranges) {
      // Звук играет, но сервер не подтвердил поддержку Range: перемотка и прыжки
      // по абзацам будут прыгать в начало. Человеку нужно это увидеть словами.
      setHint('Перемотка и «Найти по тексту» могут работать неточно.');
      if (state.rangeLogged !== sig) { state.rangeLogged = sig; log('warn', 'Сервер не поддерживает Range: перемотка и прыжки по абзацам будут неточными.'); }
    }
  }

  // ------------------------------------------------------------- загрузка

  async function load(force) {
    // Всегда перечитываем ID прямо из текущего URL. Это важно для SPA: RanobeHub
    // меняет location.href без полной перезагрузки страницы.
    const liveMeta = Meta.parse(document, location);
    if (liveMeta.chapter_id && (!state.meta || state.meta.chapter_id !== liveMeta.chapter_id)) {
      state.meta = liveMeta;
    } else if (!state.meta) {
      state.meta = liveMeta;
    }

    const requestSeq = ++state.loadSeq;
    const requestedChapter = String(state.meta && state.meta.chapter_id || '');
    const ui = state.ui;

    if (!state.loadedChapter || state.loadedChapter !== requestedChapter) {
      state.loadedChapter = requestedChapter;
      detachFollow();
      state.resolve = null;
    }

    ui.chapter.textContent = [state.meta.book_title, state.meta.volume ? ('Том ' + state.meta.volume) : '',
                              state.meta.chapter_title].filter(Boolean).join(' · ')
      .replace(/\s*·\s*$/, '') || 'Глава';

    if (!requestedChapter) {
      setStatus('Откройте страницу главы, чтобы включить озвучку.', 'error');
      setLoading(false);
      return;
    }

    // Сначала смотрим, что вообще лежит на странице. «Текста нет» — не всегда
    // поломка: бывают страницы из одних иллюстраций. Ошибку без причины не показываем.
    const page = inspectPage();
    if (page.kind === 'missing' || page.kind === 'empty') {
      dropAudio();
      state.resolve = null;
      showNote(NOTES[page.kind === 'empty' ? 'noText' : 'pageMissing']);
      log('warn', 'Текст главы не найден: ' + page.kind + ', абзацев ' + page.blocks + ', картинок ' + page.images);
      return;
    }

    setLoading(true);
    setStatus('Ищу озвучку…', 'work');
    setHint('');
    const res = await ask('resolve', { meta: state.meta, refresh: !!force });

    // Ответ мог прийти уже после следующего листания. В таком случае его нельзя
    // прикреплять к новой главе.
    if (requestSeq !== state.loadSeq || !state.meta || state.meta.chapter_id !== requestedChapter ||
        location.href !== state.meta.url) {
      return;
    }

    if (res.error) {
      setStatus('Что-то пошло не так. Нажмите ↻, чтобы попробовать снова.', 'error');
      setLoading(false);
      log('error', 'Сбой связи с фоновой частью расширения: ' + res.error);
      return;
    }
    state.resolve = res;
    applyPanelVisibility();
    applyEmptyState();

    if (res.status !== 'ok') {
      // Никаких остатков от предыдущей главы: ни manifest, ни src, ни магнит.
      dropAudio();
      state.resumeUntil = 0;
      try { sessionStorage.removeItem(KEYS.resumeUntil); } catch (e) { /* ок */ }
      refreshStatus();
      if (res.reason === 'no-title') {
        // У книги нет озвучки вовсе: панель сворачивается сама (applyEmptyState).
        clearNote();
        setLoading(false);
      } else if (page.kind === 'illustrations') {
        showNote(NOTES.illustrations);        // страница из картинок: озвучки и не должно быть
      } else {
        showNote(noteForResolve(res));        // плеер прячем, остаётся понятная надпись
      }
      return;
    }
    clearNote();
    setLoading(false);
    state.manifest = res.manifest;

    // раскладка «реплики ↔ абзацы» по текущей странице
    preparedBuild();

    if (state.audio.src !== res.audioUrl) {
      state.audio.src = res.audioUrl;
      state.audio.load();
    }
    refreshStatus();
    log('info', 'Озвучка загружена: ' + res.audioUrl);
    resumeIfNeeded();
  }

  // Продолжаем звук в новой главе, если она открылась сама после конца прошлой
  // (или пока человек слушал). Флаг живёт недолго, чтобы старое намерение не
  // включило звук через минуту после ручного перехода.
  function resumeIfNeeded() {
    const want = state.resumeUntil && Date.now() < state.resumeUntil;
    state.resumeUntil = 0;
    try { sessionStorage.removeItem(KEYS.resumeUntil); } catch (e) { /* нет доступа — не страшно */ }
    if (!want || !(state.settings && state.settings.autoNext)) return;
    if (!state.audio || !state.audio.src) return;
    state.audio.play().catch(onPlayError);
  }

  // «Скрывать панель на главах без озвучки»: прячем только когда озвучки точно
  // нет, а не когда что-то сломалось — иначе человек не поймёт, почему тишина.
  function applyPanelVisibility() {
    const r = state.resolve;
    const hide = !!(state.settings && state.settings.hideIfNone && r &&
                    (r.reason === 'not-published' || r.reason === 'no-title'));
    if (state.ui.host) state.ui.host.style.display = hide ? 'none' : '';
  }


  // ------------------------------------------------ что на странице главы

  // У главы не всегда есть текст: бывают начальные и конечные иллюстрации,
  // страницы из одних картинок. Поэтому «текст не найден» ещё не значит «что-то
  // сломалось» — сперва смотрим, что на странице на самом деле.
  const MIN_TEXT_CHARS = 120;   // короче — текста, по сути, нет (подпись к картинке)
  const SETTLE_TRIES = 6;       // ~1,5 с: даём тексту дорисоваться, прежде чем решить «только картинки»

  function inspectPage() {
    const id = Meta.parse(document, location).chapter_id || (state.meta && state.meta.chapter_id);
    const root = M.contentRoot(id);
    // contentRoot в крайнем случае отдаёт <body> — это не контейнер главы, картинки
    // шапки и рекламы за иллюстрации принимать нельзя.
    const real = !!root && (String(root.id || '').indexOf('reader-content-') === 0 ||
                            !!(root.classList && root.classList.contains('reader-content')));
    if (!real) return { kind: 'missing', blocks: 0, chars: 0, images: 0 };
    const blocks = M.collectBlocks(root);
    let chars = 0;
    for (let i = 0; i < blocks.length; i++) chars += (blocks[i].textContent || '').trim().length;
    let images = 0;
    root.querySelectorAll('img, canvas').forEach((el) => { if (!el.closest(M.SKIP_SELECTOR)) images++; });
    let kind;
    if (chars >= MIN_TEXT_CHARS) kind = 'text';
    else if (images > 0) kind = 'illustrations';
    else if (chars > 0) kind = 'text';           // очень короткая глава
    else kind = 'empty';                          // контейнер есть, в нём ни текста, ни картинок
    return { kind, blocks: blocks.length, chars, images };
  }

  // Ждём, пока страница главы отрисуется, и передаём результат осмотра.
  // done вызывается всегда — и когда дождались, и когда время вышло; что делать
  // дальше (плеер, надпись об иллюстрациях, «не нашёл»), решает load().
  function waitForContent(done, tries) {
    tries = tries || 0;
    const page = inspectPage();
    const enoughText = page.kind === 'text' && page.chars >= MIN_TEXT_CHARS;
    const settled = (page.kind === 'illustrations' || page.kind === 'text') && tries >= SETTLE_TRIES;
    if (enoughText || settled || tries > 40) { done(page); return; }
    setTimeout(() => waitForContent(done, tries + 1), 250);
  }

  // ------------------------------------------------ надпись вместо плеера


  function noteForResolve(res) {
    if (res && res.reason === 'not-published') return NOTES.notPublished;
    const msg = (res && res.message) || 'Попробуйте ещё раз чуть позже.';
    return { icon: '⚠️', title: 'Озвучка недоступна', text: msg, status: msg, tone: 'error', recheck: true };
  }

  // Плеер прячется, остаётся только шапка и короткая надпись.
  function showNote(n) {
    const ui = state.ui;
    if (!ui.note || !n) return;
    if (state.emptyMode) {                      // «тайтла нет в озвучке» сменилось конкретной главой
      state.emptyMode = false;
      ui.panel.classList.remove('empty-mode');
      applyCollapse();
    }
    ui.noteIcon.textContent = n.icon;
    ui.noteTitle.textContent = n.title;
    ui.noteText.textContent = n.text;
    ui.noteActions.hidden = !n.recheck;
    ui.panel.classList.add('note-mode');
    setStatus(n.status || n.title, n.tone || '');
    setHint('');
    setLoading(false);
    placeHost();                                // высота панели изменилась
  }

  function clearNote() {
    const ui = state.ui;
    if (!ui.panel || !ui.panel.classList.contains('note-mode')) return;
    ui.panel.classList.remove('note-mode');
    placeHost();
  }

  // Пока идёт поиск озвучки, прежняя картинка панели не прыгает, а лишь тускнеет.
  function setLoading(on) {
    if (state.ui.panel) state.ui.panel.classList.toggle('loading', !!on);
  }

  function resetPlayerUi() {
    const ui = state.ui;
    if (!ui.seek) return;
    ui.seek.value = '0';
    paintRange(ui.seek);
    ui.cur.textContent = '00:00';
    ui.total.textContent = '00:00';
    if (ui.buffered) ui.buffered.style.width = '0%';
    ui.play.classList.remove('playing');
  }

  // Полностью отцепляем звук: без остатков от прошлой главы.
  function detachFollow() {
    state.follow && state.follow.stop();
    state.follow = null;
    state.followOpts = null;
    state.manifest = null;
    state.prepared = null;
  }

  function dropAudio() {
    detachFollow();
    if (state.audio && state.audio.getAttribute('src')) {
      state.audio.pause();
      state.audio.removeAttribute('src');
      state.audio.load();
    }
    resetPlayerUi();
  }

  function recheckPage() {
    setLoading(true);
    setStatus('Проверяю…', 'work');
    waitForContent(() => load(true));
  }

  // guard=true — пересчёт «по ходу дела»: если раскладка получилась заметно хуже
  // прежней (страница сейчас дорисована наполовину), старую не выбрасываем.
  function preparedBuild(guard) {
    const root = M.contentRoot(state.manifest.chapter_id);
    const next = M.prepare(state.manifest, root);
    if (guard && state.prepared && next.quality < state.prepared.quality - 0.15) return false;
    state.prepared = next;
    if (!state.follow) {
      state.followOpts = {
        manifest: state.manifest,
        audio: state.audio,
        index: state.prepared.index,
        mapping: state.prepared.mapping,
        // Узлы абзацев берутся в момент отрисовки: ranobehub пересоздаёт всю
        // главу при каждой прокрутке, и сохранённые ссылки тут же протухают.
        getBlocks: () => (state.prepared ? state.prepared.index.blocks : []),
        // Ключи абзацев: по ним магнит находит нужный абзац, даже если сайт
        // вставил или убрал блок и номера съехали.
        getKeys: () => (state.prepared ? state.prepared.keys : null),
        cssClass: HL_CLASS,
        eyeLevel: Settings.eyeLevel(state.settings && state.settings.eyeLevel) / 100,
        magnet: state.settings ? !!state.settings.magnet : true
      };
      state.follow = M.follow(state.followOpts);
    } else {
      state.followOpts.manifest = state.manifest;
      state.followOpts.index = state.prepared.index;
      state.followOpts.mapping = state.prepared.mapping;
      // Раньше здесь стояло follow.stop(): оно заставляло магнит заново «подъехать»
      // к абзацу при каждом пересчёте — и страницу дёргало посреди чтения.
      state.follow.rebind();
    }
    return true;
  }

  // ------------------------------------------------- сохранение подсветки

  // Сайт (проверено на живой главе) на каждой прокрутке пересоздаёт абзацы:
  // текст тот же, узлы новые. Поэтому после любой правки разметки:
  //   • живые узлы берём всегда — иначе подсвечивать пришлось бы мёртвые;
  //   • абзац для реплики магнит ищет по тексту, поэтому лишний или пропавший
  //     блок раскладку больше не «сдвигает»;
  //   • подпись изменилась → раскладку пересчитываем (см. scheduleRebuild).
  // Живые абзацы текущей главы (пустой массив — если контейнера пока нет).
  function liveBlocks() {
    if (!state.manifest) return [];
    const root = M.contentRoot(state.manifest.chapter_id);
    return root ? M.collectBlocks(root) : [];
  }

  function refreshBlocks() {
    if (!state.prepared || !state.manifest) return false;
    const fresh = liveBlocks();
    if (!fresh.length) return false;
    state.prepared.index.blocks = fresh;
    if (M.textSignature(fresh) !== state.prepared.signature) {
      preparedBuild(false);        // нужна ли раскладка «сейчас» — решает вызывающий (клик по абзацу)
      refreshStatus();
    }
    if (state.follow) state.follow.repaint();
    return true;
  }

  // Ответ на пересоздание разметки — сразу, в обработчике MutationObserver
  // (до того, как браузер нарисует кадр), чтобы подсветка не мигала.
  // Тяжёлое (пересчёт раскладки) откладывается и не сбрасывается новыми
  // изменениями: раньше таймер переставлялся при каждой правке разметки, и пока
  // шла прокрутка магнита (а сайт на ней перерисовывает абзацы), пересчёт не
  // наступал вовсе — раскладка стояла со сдвигом на один абзац.
  let rebuildTimer = null, rebuildFails = 0, rebuildSig = '';
  function syncBlocksNow() {
    if (!state.prepared || !state.manifest) return;
    const fresh = liveBlocks();
    if (!fresh.length) return;
    state.prepared.index.blocks = fresh;              // узлы — всегда живые
    if (state.follow) state.follow.repaint();
    const sig = M.textSignature(fresh);
    if (sig === state.prepared.signature) { rebuildFails = 0; return; }
    if (sig !== rebuildSig) { rebuildSig = sig; rebuildFails = 0; }
    if (rebuildTimer || rebuildFails >= 3) return;    // уже ждём / трижды не вышло — до новой правки не трогаем
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      if (!state.prepared || !state.manifest) return;
      const now = liveBlocks();
      if (!now.length || M.textSignature(now) === state.prepared.signature) return;   // уже улеглось
      if (preparedBuild(true)) { rebuildFails = 0; refreshStatus(); }
      else rebuildFails++;                             // страница дорисована не до конца — старая раскладка лучше
    }, 300);
  }

  // ------------------------------------------------------------- «Найти по тексту»

  function togglePickMode(force) {
    const on = force === undefined ? !state.pickMode : !!force;
    if (on && !state.manifest) {
      setHint('Для этой главы пока нет озвучки — искать по тексту нечего.');
      return;
    }
    state.pickMode = on;
    document.body.classList.toggle('rh-tts-picking', on);
    state.ui.pick.classList.toggle('active', on);
    setHint(on
      ? 'Кликните по абзацу — озвучка пойдёт с него. Esc — выйти.'
      : '');
  }

  // Перемотка на начало реплики i (+ eps, см. SEGMENT_EPS_MS в matcher). Возвращает audio.
  function seekToSegment(i, eps) {
    const seg = state.manifest.segments[i];
    state.audio.currentTime = M.segmentStartSec(seg) + (eps || 0);
    state.follow && state.follow.reset();
    return state.audio;
  }

  function jumpToBlock(block) {
    if (!state.prepared || !state.manifest) return;
    // Клик мог прийти уже после того, как сайт пересоздал абзацы: сначала
    // обновляем разметку, потом ищем абзац — по узлу, а если узел успел
    // смениться, по тексту. Раньше здесь стоял поиск по старому массиву, и
    // любой клик после прокрутки заканчивался «абзац не из текста главы».
    refreshBlocks();
    const list = state.prepared.index.blocks;
    let idx = list.indexOf(block);
    if (idx < 0) {
      const want = M.norm(block.textContent);
      idx = list.findIndex((b) => M.norm(b.textContent) === want);
    }
    if (idx < 0) { setHint('Этот фрагмент не входит в текст главы.'); return; }
    const hit = M.blockToSegment(state.prepared.mapping, idx);
    if (!hit) {
      setHint('Эта часть текста не озвучена.');
      return;
    }
    seekToSegment(hit.i, 0.001).play().catch(onPlayError);
    // Галочка «Выходить из «Найти по тексту» после прыжка»: включена — выходим
    // (по умолчанию так), выключена — остаёмся в режиме, чтобы прыгать подряд.
    // Выходим ДО подсказки: выход из режима стирает подсказку, и раньше человек
    // из-за этого не видел ни строчки о том, куда же он прыгнул.
    const exitAfterJump = !state.settings || state.settings.pickAfterJump !== false;
    if (exitAfterJump) togglePickMode(false);
    setHint(hit.exact ? '' : 'Для этого абзаца озвучки нет — начинаю с ближайшего места.');
    log('info', 'Прыжок по тексту: абзац ' + idx + ' → реплика ' + (hit.i + 1) +
        (hit.exact ? '' : ' (ближайшая, через ' + (hit.gap || 0) + ' абз.)'));
  }

  function nextChapterLink() {
    const cur = location.href;
    const link = document.querySelector('a[rel="next"]')
      || document.querySelector('[data-chapter-transition-target="next"]')
      || document.querySelector('a[aria-label*="Следующ" i]')
      || Array.from(document.querySelectorAll('a[href*="/chapter/"]'))
        .find((a) => /следующ/i.test(a.textContent || ''));
    return link && link.href && link.href !== cur ? link : null;
  }

  // Нажатие «→» так, как его видит сайт: он слушает клавиатуру сам.
  function pressArrowRight() {
    const init = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
                   bubbles: true, cancelable: true, composed: true, view: window };
    const target = document.body || document.documentElement;
    for (const type of ['keydown', 'keyup']) {
      try { target.dispatchEvent(new KeyboardEvent(type, init)); } catch (e) { /* ок */ }
    }
  }

  // Переход к следующей главе. Три способа по очереди, каждый проверяется по
  // смене адреса: 1) ссылка на странице, 2) «→» как у сайта, 3) номер в адресе +1.
  function goToNextChapter() {
    const from = location.href;
    const fromId = state.meta && state.meta.chapter_id;
    state.resumeUntil = Date.now() + RESUME_MS;
    setStatus('Глава дочитана — открываю следующую…', 'work');
    log('info', 'Автопереход: глава ' + fromId + ' закончилась');

    const moved = () => location.href !== from;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      const link = nextChapterLink();
      if (link) {
        log('info', 'Автопереход: нажимаю ссылку «следующая»');
        link.click();
        await wait(1500);
        if (moved()) return;
      }
      log('info', 'Автопереход: нажимаю «→»');
      pressArrowRight();
      await wait(1800);
      if (moved()) return;

      const url = Meta.nextChapterUrl(from);
      if (!url) {
        state.resumeUntil = 0;
        setStatus('Не удалось найти следующую главу. Перейдите вручную.', 'warn');
        log('warn', 'Автопереход: адрес следующей главы не построить из ' + from);
        return;
      }
      log('info', 'Автопереход: открываю ' + url);
      // Страница перезагрузится — намерение продолжить звук переживает это в sessionStorage.
      try { sessionStorage.setItem(KEYS.resumeUntil, String(Date.now() + RESUME_MS)); } catch (e) { /* ок */ }
      location.assign(url);
    })();
  }

  // ------------------------------------------------------------- слежение за SPA

  function watchSpa() {
    let lastHref = location.href;
    setInterval(() => {
      syncIdle();
      if (location.href === lastHref) return;
      lastHref = location.href;
      const meta = Meta.parse(document, location);
      if (!meta.chapter_id || meta.chapter_id === state.loadedChapter) return;

      // Ключевой фикс SPA-перехода: сохраняем НОВУЮ meta, а старую озвучку
      // немедленно отцепляем. Раньше local const meta вычислялся, но state.meta
      // оставалась от предыдущей главы, поэтому load() повторно использовал её.
      state.loadSeq++;
      state.meta = meta;
      // Если человек сам листнул во время звука — тоже продолжаем. После
      // конца главы флаг уже поставлен в goToNextChapter (у ended paused === true).
      if (state.audio && !state.audio.paused) state.resumeUntil = Date.now() + RESUME_MS;
      togglePickMode(false);
      dropAudio();
      state.resolve = null;
      state.loadedChapter = null;
      setLoading(true);
      setStatus('Новая глава — ищу озвучку…', 'work');
      if (state.ui.host) state.ui.host.style.display = '';
      setHint('');

      waitForContent(() => {
        const current = Meta.parse(document, location);
        if (!current.chapter_id || current.chapter_id !== state.meta.chapter_id || current.url !== location.href) {
          return;
        }
        state.meta = current;
        load(false);
      });
    }, 700);

    // Сайт пересоздаёт разметку главы при каждой прокрутке (и при смене ширины
    // окна). Про число абзацев это не видно — их ровно столько же, — поэтому
    // сравниваем подпись разметки и обновляем или узлы, или всю раскладку.
    // Наблюдаем только вставку/удаление узлов: свои классы подсветки мы не
    // слушаем, иначе получился бы цикл «подсветил → пересчитал → подсветил».
    const mo = new MutationObserver(() => { syncBlocksNow(); });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });

    // Плеер и стиль подсветки могли быть снесены перерисовкой — возвращаем.
    setInterval(() => {
      if (state.ui.host && !state.ui.host.isConnected) document.documentElement.appendChild(state.ui.host);
      if (!document.getElementById('rh-tts-style')) injectPageCss();
    }, 1500);
  }

  // ------------------------------------------------------------- сообщения из попапа

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'getStatus') {
      sendResponse({
        meta: state.meta,
        isChapter: isChapterPage(),
        url: location.href,
        status: state.status,
        found: state.resolve ? state.resolve.status : 'loading',
        source: state.resolve ? state.resolve.source : null,
        cloud: state.resolve ? state.resolve.cloud : null,
        detail: state.resolve ? state.resolve.detail : null,
        message: state.resolve ? state.resolve.message : null,
        reason: state.resolve ? state.resolve.reason : null,
        quality: state.prepared ? state.prepared.quality : null,
        blocks: state.prepared ? state.prepared.index.n : null,
        segments: state.manifest ? state.manifest.segment_count : null,
        audio: state.resolve && state.resolve.audio ? state.resolve.audio : null,
        playing: !!(state.audio && !state.audio.paused)
      });
      return;
    }
    if (msg.type === 'settingsChanged') {
      // Настройки применяются на лету: заново искать озвучку ради переключателя не нужно.
      getSettings().then(() => { applySettingsToPanel(); applyPanelVisibility(); });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'refreshTip') {
      refreshDockTip(true);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'reload') {
      getSettings().then(() => {
        applySettingsToPanel();
        load(true);
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'debugMap') {
      // Только для проверок и разбора жалоб: что именно расширение видит на
      // странице. Страница до этого дотянуться не может — сообщение приходит
      // из попапа или из фоновой части расширения.
      sendResponse({
        chapter: state.meta && state.meta.chapter_id,
        quality: state.prepared ? state.prepared.quality : null,
        signature: state.prepared ? state.prepared.signature : null,
        blocks: state.prepared ? state.prepared.index.blocks.map((b) => ({
          text: M.norm(b.textContent).slice(0, 60), live: !!b.isConnected
        })) : [],
        mapping: state.prepared ? state.prepared.mapping.map((m) => ({
          start: m.start, span: m.span || 1,
          score: m.score == null ? null : Math.round(m.score * 100) / 100 })) : [],
        segments: state.manifest ? state.manifest.segments.map((s) => (s.match || s.text || '').slice(0, 60)) : [],
        segmentCount: state.manifest ? state.manifest.segment_count : null,
        playing: !!(state.audio && !state.audio.paused),
        now: state.audio ? Math.round(state.audio.currentTime * 1000) / 1000 : null,
        current: state.follow ? state.follow.current() : null
      });
      return;
    }
    if (msg.type === 'jump') {
      const seg = state.manifest && state.manifest.segments[msg.i];
      if (seg) seekToSegment(msg.i, 0).play().catch(() => {});
      sendResponse({ ok: !!seg });
      return;
    }
  });

  // ------------------------------------------------------------- запуск

  async function getSettings() {
    state.settings = await ask('getSettings');
    return state.settings;
  }

  function saveSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    return ask('saveSettings', { patch });
  }

  function applySettingsToPanel() {
    const s = state.settings || {};
    // Старые сохранённые значения (1.15×, 1.3×, «уровень 22 %» и т. п.) подтягиваем
    // к ближайшему из нынешних вариантов, чтобы список никогда не оказывался пустым.
    const rate = Settings.rate(s.playbackRate);
    const eye = Settings.eyeLevel(s.eyeLevel);
    state.ui.magnet.checked = !!s.magnet;
    state.ui.eye.value = String(eye);
    state.ui.eye.disabled = !s.magnet;
    state.ui.rate.value = String(rate);
    state.ui.vol.value = String(Math.round((s.volume != null ? s.volume : 1) * 100));
    paintRange(state.ui.vol);
    // defaultPlaybackRate — чтобы скорость не сбрасывалась в 1× при audio.load() на новой главе
    state.audio.playbackRate = state.audio.defaultPlaybackRate = rate;
    state.audio.volume = s.volume != null ? Number(s.volume) : 1;
    if (state.followOpts) {
      state.followOpts.eyeLevel = eye / 100;
      state.followOpts.magnet = !!s.magnet;
    }
    state.follow && state.follow.setMagnet(!!s.magnet);
  }

  async function start() {
    injectPageCss();
    buildPanel();
    state.meta = Meta.parse(document, location);
    await getSettings();
    applySettingsToPanel();
    try {
      const until = Number(sessionStorage.getItem(KEYS.resumeUntil) || 0);
      if (until && Date.now() < until) state.resumeUntil = until;
      sessionStorage.removeItem(KEYS.resumeUntil);
    } catch (e) { /* ок */ }
    watchSpa();
    // Открыта не глава (главная, страница книги, каталог): вместо панели —
    // маленький значок у края, и никаких «не нашёл текст главы».
    if (!isChapterPage()) { setIdle(true); return; }
    waitForContent((page) => {
      if (state.settings && state.settings.autoLoad) { load(false); return; }
      const note = page.kind === 'illustrations' ? NOTES.illustrations
                 : page.kind === 'empty' ? NOTES.noText
                 : page.kind === 'missing' ? NOTES.pageMissing : null;
      if (note) showNote(note);
      else setStatus('Автозагрузка выключена. Нажмите ↻, чтобы найти озвучку.', 'warn');
    });
  }

  window.__rhTts = {
    refresh() { getSettings().then(() => { applySettingsToPanel(); load(true); }); },
    state,
    get meta() { return state.meta; }
  };

  start();
})();
