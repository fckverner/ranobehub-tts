/* popup.js — окно расширения: состояние текущей главы и настройки.
 *
 * Всё, что видит человек, написано простыми словами. Технические сведения
 * (адреса, коды ответов, журнал) спрятаны в «Настройки → Для разработчика».
 */
'use strict';

const Settings = window.RanobeSettings;
const Cloud = window.RanobeCloud;
const $ = (id) => document.getElementById(id);
const TOGGLES = ['autoLoad', 'autoNext', 'magnet', 'pickAfterJump', 'hideIfNone'];

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res || {});
    });
  });
}

function writeLog(level, message, data) {
  return send({ type: 'log', level, source: 'popup', message, data });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function tellTab(msg) {
  const tab = await activeTab();
  if (!tab || !tab.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { return null; }
}

function setStatus(el, text, kind, autoClearMs) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
  if (autoClearMs) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, autoClearMs);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// CSS-класс для причины отказа: «тайтла нет» — обычное состояние, не поломка.
function toneFor(reason, fallback) {
  if (reason === 'no-title') return fallback;
  return reason === 'not-published' ? 'warn' : 'error';
}

// ------------------------------------------------------------------ вкладки

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('tab-main').classList.toggle('hidden', name !== 'main');
  $('tab-settings').classList.toggle('hidden', name !== 'settings');
}

// ---------------------------------------------------------------- настройки

function paintEye(level, enabled) {
  document.querySelectorAll('#eyeSeg button').forEach((b) => {
    const on = Number(b.dataset.v) === level;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.disabled = !enabled;
  });
}

async function loadSettings() {
  const st = await send({ type: 'getSettings' });
  const s = Settings.withDefaults(st && !st.error ? st : {});
  for (const id of TOGGLES) $(id).checked = !!s[id];
  paintEye(Settings.eyeLevel(s.eyeLevel), !!s.magnet);
}

async function saveSettings(patch) {
  await send({ type: 'saveSettings', patch });
  await tellTab({ type: 'settingsChanged' });
  setStatus($('optStatus'), 'Сохранено', 'ok', 1200);
}

// ------------------------------------------------------------ текущая глава

async function showChapter() {
  const box = $('chapterInfo');
  const tab = await activeTab();
  if (!tab || !tab.id) { box.textContent = 'Нет активной вкладки.'; return null; }
  const res = await tellTab({ type: 'getStatus' });
  const onSite = /^https?:\/\/([^/]+\.)?ranobehub\.org(\/|$)/i.test(tab.url || (res && res.url) || '');
  if (!res) {
    // Скрипта на странице нет: не ranobehub, либо вкладка открыта до установки расширения.
    box.innerHTML = onSite
      ? 'Страница ещё загружается или была открыта до установки расширения. <b>Обновите её (F5)</b>.'
      : 'Откройте <b>ranobehub.org</b> — там расширение подключится к озвучке.';
    return null;
  }
  if (!res.isChapter) {
    // Не глава: главная, каталог или страница тайтла — подсказка та же, что у значка на странице.
    const t = await send({ type: 'pageContext', url: res.url || tab.url });
    if (t && t.title) {
      const cls = t.tone === 'ok' ? 'ok' : (t.tone === 'warn' ? 'warn' : 'muted');
      box.innerHTML = '<b>' + escapeHtml(t.title) + '</b><br><span class="' + cls + '">' + escapeHtml(t.text) + '</span>';
    } else {
      box.innerHTML = 'Откройте любой тайтл на <b>ranobehub.org</b>.';
    }
    return null;
  }
  if (!res.meta) return null;
  const meta = res.meta;
  const lines = [];
  lines.push('<b>' + escapeHtml(meta.chapter_title || 'Глава') + '</b>');
  const sub = [meta.book_title, meta.volume ? 'Том ' + meta.volume : ''].filter(Boolean).join(' · ');
  if (sub) lines.push('<span class="muted">' + escapeHtml(sub) + '</span>');

  let text, cls;
  if (res.found === 'ok') { text = 'Озвучка готова'; cls = 'ok'; }
  else if (res.found === 'loading') { text = res.status || 'Проверяю озвучку…'; cls = ''; }
  else {
    text = res.message || 'Озвучка недоступна.';
    cls = toneFor(res.reason, 'muted');
  }
  lines.push('<span class="' + cls + '">' + escapeHtml(text) + '</span>');
  box.innerHTML = lines.join('<br>');
  return res;
}

async function checkNow() {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || '')) {
    setStatus($('checkStatus'), 'Откройте ranobehub.org.', 'warn');
    return;
  }
  setStatus($('checkStatus'), 'Проверяю озвучку…', '');
  const st = await tellTab({ type: 'getStatus' });
  const meta = st && st.meta;
  if (!meta || !meta.chapter_id || !st.isChapter) {
    // Не глава: перепроверяем тайтл (в обход кэша) и обновляем подсказку.
    if (st && st.url) await send({ type: 'pageContext', url: st.url, refresh: true });
    setStatus($('checkStatus'), '', '');
    await tellTab({ type: 'refreshTip' });
    await showChapter();
    return;
  }
  const res = await send({ type: 'resolve', meta, refresh: true });
  if (res.error) {
    setStatus($('checkStatus'), 'Что-то пошло не так. Попробуйте ещё раз.', 'error');
    writeLog('error', 'Проверка из попапа не удалась: ' + res.error);
    return;
  }
  if (res.status === 'ok') setStatus($('checkStatus'), 'Озвучка найдена и готова к воспроизведению.', 'ok');
  else setStatus($('checkStatus'), res.message || 'Озвучка недоступна.', toneFor(res.reason, ''));
  await tellTab({ type: 'reload' });      // панель на странице подхватывает новый результат
  setTimeout(showChapter, 500);
}

// ------------------------------------------------------- для разработчика

function fmtEntry(e) {
  const time = String(e.t || '').slice(11, 19);
  const lvl = String(e.level || 'info').toUpperCase().padEnd(5);
  return time + ' ' + lvl + ' ' + (e.source || '') + ': ' + (e.message || '') + (e.data ? '  ' + e.data : '');
}

async function buildDevInfo() {
  const info = await send({ type: 'cloudInfo' });
  const res = await tellTab({ type: 'getStatus' });
  const meta = (res && res.meta) || {};
  const conf = { baseUrl: info.builtin || '', names: info.names || {} };
  const rows = [
    ['Версия', info.version || ''],
    ['Протокол', info.protocol || ''],
    ['Хранилище', info.builtin || 'не задано'],
    ['book_id / chapter_id', (meta.book_id || '—') + ' / ' + (meta.chapter_id || '—')],
    ['Индекс книги', meta.book_id && info.builtin ? Cloud.bookIndexUrl(conf, meta) : '—'],
    ['Состояние', res && res.found ? res.found + (res.reason ? ' (' + res.reason + ')' : '') : '—'],
    ['Подробности', (res && res.detail) || '—'],
    ['Качество совпадения', res && res.quality != null ? Number(res.quality).toFixed(2) : '—'],
    ['Абзацев / реплик', (res && res.blocks != null ? res.blocks : '—') + ' / ' + (res && res.segments != null ? res.segments : '—')]
  ];
  return rows.map((r) => r[0] + ': ' + r[1]).join('\n');
}

async function renderDev() {
  $('devInfo').textContent = await buildDevInfo();
  const { entries } = await send({ type: 'getLog' });
  const list = Array.isArray(entries) ? entries : [];
  const view = $('logView');
  view.textContent = list.length ? list.map(fmtEntry).join('\n') : 'Журнал пуст.';
  view.scrollTop = view.scrollHeight;
}

// ------------------------------------------------------------------ запуск

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  await loadSettings();
  const manifest = chrome.runtime.getManifest();
  $('verText').textContent = 'Версия ' + manifest.version;
  showChapter();

  $('check').addEventListener('click', checkNow);

  for (const id of TOGGLES) {
    $(id).addEventListener('change', async () => {
      if (id === 'magnet') {
        const cur = document.querySelector('#eyeSeg button.on');
        paintEye(cur ? Number(cur.dataset.v) : Settings.DEFAULTS.eyeLevel, $('magnet').checked);
      }
      await saveSettings({ [id]: $(id).checked });
    });
  }
  document.querySelectorAll('#eyeSeg button').forEach((b) => {
    b.addEventListener('click', async () => {
      const level = Number(b.dataset.v);
      paintEye(level, $('magnet').checked);
      await saveSettings({ eyeLevel: level });
    });
  });

  $('resetPos').addEventListener('click', async () => {
    await chrome.storage.local.remove(Settings.KEYS.panelPos);     // панели на страницах следят за этим ключом
    setStatus($('optStatus'), 'Панель возвращена на место', 'ok', 1800);
  });

  $('devToggle').addEventListener('click', async (e) => {
    e.preventDefault();
    const box = $('devBox');
    const open = box.classList.contains('hidden');
    box.classList.toggle('hidden', !open);
    if (open) { await renderDev(); box.scrollIntoView({ block: 'nearest' }); }
  });
  $('logRefresh').addEventListener('click', renderDev);
  $('logClear').addEventListener('click', async () => {
    await send({ type: 'clearLog' });
    await renderDev();
    setStatus($('logStatus'), 'Журнал очищен', 'ok', 1500);
  });
  $('logCopy').addEventListener('click', async () => {
    const text = $('devInfo').textContent + '\n\n' + $('logView').textContent;
    try {
      await navigator.clipboard.writeText(text);
      setStatus($('logStatus'), 'Скопировано', 'ok', 1500);
    } catch (e) {
      setStatus($('logStatus'), 'Не удалось скопировать — выделите текст вручную.', 'warn');
    }
  });
});
