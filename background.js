/* background.js — служебный скрипт расширения (MV3 service worker).
 *
 * Что делает:
 *  1) хранит настройки чтения (chrome.storage.sync, см. lib/settings.js);
 *  2) по book_id + chapter_id достаёт из публичного Hugging Face Dataset
 *     index.json книги, точную запись главы, manifest.json и проверяет mp3;
 *  3) отдаёт на вкладку разобранный манифест целиком;
 *  4) ведёт технический журнал (chrome.storage.local), который виден только
 *     в попапе: «Настройки → Для разработчика».
 *
 * Адрес облака лежит в сборке (lib/cloud-config.js, генерируется из
 * main-app/stark/cloud-config.json), поэтому в браузере его никто не вписывает.
 */
'use strict';

importScripts('lib/settings.js', 'lib/cloud-config.js', 'lib/cloud.js');

const Settings = self.RanobeSettings;
const CONF = self.RanobeCloudConfig || {};
const Cloud = self.RanobeCloud;

const BASE = Cloud.trimBase(CONF.baseUrl || '');
const CLOUD_CONF = { baseUrl: BASE, names: CONF.storage || {} };
const PROTOCOL = String(CONF.protocol || Cloud.PROTOCOL);

// Что видит человек. Технические подробности (адреса, коды ответов, причины
// отказа) идут только в журнал — см. addLog() и «Для разработчика» в попапе.
const MSG = {
  notPublished: 'Озвучка этой главы не опубликована.',
  noTitle: 'Этого тайтла нет в озвучке.',            // у книги нет ни одной озвученной главы
  network: 'Не удалось загрузить озвучку. Проверьте подключение к интернету и попробуйте ещё раз.',
  unavailable: 'Озвучка этой главы временно недоступна.',
  noChapter: 'Откройте страницу главы, чтобы включить озвучку.',
  blocked: 'Браузер не разрешил загрузить озвучку.'
};

// Домен HF и его CDN нужны только для чтения публичного Dataset.
const KNOWN_HOSTS = (() => {
  const out = [];
  if (BASE) out.push(BASE.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0]);
  for (const h of CONF.audioHosts || []) if (h && !out.includes(h)) out.push(String(h));
  return out;
})();

// ------------------------------------------------------------------ журнал
// Кольцевой буфер в chrome.storage.local. Пишут фон, страница и попап
// (сообщение «log»); читает только «Для разработчика» в попапе.
const LOG_KEY = Settings.KEYS.debugLog;
const LOG_MAX = 300;
const LOG_DATA_MAX = 600;
let logQueue = Promise.resolve();

function addLog(level, source, message, data) {
  const entry = { t: new Date().toISOString(), level: level || 'info', source: source || 'bg',
                  message: String(message || '') };
  if (data !== undefined) {
    try {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      entry.data = text.length > LOG_DATA_MAX ? text.slice(0, LOG_DATA_MAX) + '…' : text;
    } catch (e) { /* данные не сериализуются — пропускаем */ }
  }
  logQueue = logQueue.then(async () => {
    const st = await chrome.storage.local.get(LOG_KEY);
    const list = Array.isArray(st[LOG_KEY]) ? st[LOG_KEY] : [];
    list.push(entry);
    if (list.length > LOG_MAX) list.splice(0, list.length - LOG_MAX);
    await chrome.storage.local.set({ [LOG_KEY]: list });
  }).catch(() => {});
  return logQueue;
}

// ---------------------------------------------------------------- настройки

async function getSettings() {
  return Settings.withDefaults(await chrome.storage.sync.get(Settings.DEFAULTS));
}

async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}

// ------------------------------------------------------------------- сеть

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, {
      cache: opts.reload ? 'reload' : (opts.fresh ? 'no-cache' : 'default'),
      redirect: 'follow'
    });
    const finalUrl = res.url || url;
    if (!res.ok) return { ok: false, status: res.status, url: finalUrl };
    const text = await res.text();
    try { return { ok: true, status: res.status, url: finalUrl, data: JSON.parse(text) }; }
    catch (e) { return { ok: false, status: res.status, url: finalUrl, error: 'файл не похож на JSON' }; }
  } catch (e) {
    return { ok: false, status: 0, url, error: String((e && e.message) || e) };
  }
}

// index.json книги. При сбое (кроме 404) — второй заход в обход HTTP-кэша.
async function fetchBookIndex(bookId) {
  const url = Cloud.bookIndexUrl(CLOUD_CONF, { book_id: bookId });
  let idx = await fetchJson(url, { fresh: true });
  if (!idx.ok && idx.status !== 404) {
    const again = await fetchJson(url, { reload: true });
    if (again.ok) idx = again;
  }
  idx.url = url;
  return idx;
}

// Проверка mp3 без скачивания: Range на 2 байта, заодно узнаём размер и
// поддержку перемотки.
async function probeAudio(url) {
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1' }, cache: 'no-cache' });
    const range = res.headers.get('content-range') || '';
    const total = range ? Number(range.split('/')[1] || 0) : Number(res.headers.get('content-length') || 0);
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) { /* ок */ }
    return { ok: res.ok || res.status === 206, status: res.status, size: total || 0,
             ranges: res.status === 206 || /bytes/i.test(range) };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

// Сетевой сбой (нет связи / 5xx) отличаем от «доступа нет / файл битый».
function isNetworkFailure(res) {
  return res.status === 0 || res.status >= 500;
}

function failureText(res) {
  return res.error || ('код ' + res.status);
}

function humanSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' МБ' : Math.max(1, Math.round(bytes / 1024)) + ' КБ';
}

async function originAllowed(url) {
  try {
    const u = new URL(url);
    if (await chrome.permissions.contains({ origins: [u.origin + '/*'] })) return true;
    return KNOWN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) { return false; }
}

// ----------------------------------------------------------- поиск озвучки
//
// Строгий поиск v3: URL → book_id → books/<book_id>/index.json
// → запись chapter_id → chapters/<chapter_id>/manifest.json + audio.mp3.
//
// Каждый ответ содержит:
//   status  — машинный код (ok / not-found / wrong-chapter / bad-manifest /
//             need-permission / no-chapter / no-settings);
//   reason  — причина для интерфейса ('' / no-title / not-published /
//             network / unavailable / blocked / no-chapter);
//   message — короткая фраза для человека (её показывает панель);
//   detail  — техническая подробность (идёт только в журнал).

const chapterCache = new Map();

async function resolveChapter(meta, opts = {}) {
  const key = [meta && meta.book_id, meta && meta.chapter_id, BASE].join('|');
  if (!opts.refresh && chapterCache.has(key)) return chapterCache.get(key);

  const result = {
    status: 'not-found',
    reason: '',
    message: '',
    meta,
    source: 'book-index',
    cloud: { base: BASE, index: meta ? Cloud.bookIndexUrl(CLOUD_CONF, meta) : '' }
  };
  const who = { book_id: meta && meta.book_id, chapter_id: meta && meta.chapter_id };

  function finish(status, reason, message, detail) {
    Object.assign(result, { status, reason, message, detail: detail || message });
    addLog(status === 'ok' ? 'info' : 'warn', 'resolve', status + ' (' + reason + '): ' + result.detail, who);
    // Сбой сети не запоминаем: повторная проверка должна реально сходить в облако.
    if (reason !== 'network') chapterCache.set(key, result);
    return result;
  }
  // Ответ сервера не ok: сеть или «недоступно».
  function fail(res, detail) {
    return isNetworkFailure(res)
      ? finish('not-found', 'network', MSG.network, detail)
      : finish('not-found', 'unavailable', MSG.unavailable, detail);
  }

  if (!meta || !meta.chapter_id || !meta.book_id) {
    return finish('no-chapter', 'no-chapter', MSG.noChapter,
      'Не удалось определить book_id и chapter_id из URL RanobeHub.');
  }
  if (!BASE) {
    return finish('no-settings', 'unavailable', MSG.unavailable,
      'В сборке не задан публичный Hugging Face Dataset.');
  }

  // 1. index.json книги
  const idx = await fetchBookIndex(meta.book_id);
  if (!idx.ok) {
    if (idx.status === 404) {
      return finish('not-found', 'no-title', MSG.noTitle,
        'У этого тайтла нет index.json (404): в облаке нет папки книги ' + meta.book_id + ' — ' + idx.url);
    }
    return fail(idx, 'Не удалось прочитать index.json книги (' + failureText(idx) + '): ' + idx.url);
  }
  const listed = idx.data && idx.data.chapters;
  if (listed && typeof listed === 'object' && !Array.isArray(listed) && Cloud.chapterCount(idx.data) === 0) {
    // Индекс есть, но пуст — по сути, та же ситуация, что и без папки.
    return finish('not-found', 'no-title', MSG.noTitle,
      'index.json книги ' + meta.book_id + ' найден, но в нём нет ни одной главы.');
  }

  // 2. запись главы
  const found = Cloud.fromBookIndex(idx.data, meta, BASE);
  if (!found) {
    return finish('not-found', 'not-published', MSG.notPublished,
      'В index.json этой книги нет chapter_id ' + meta.chapter_id + '.');
  }
  if (found.error) {
    return finish('wrong-chapter', 'unavailable', MSG.unavailable,
      'Озвучка отклонена на этапе index.json книги: ' + found.error);
  }
  Object.assign(result, {
    audioUrl: found.audioUrl,
    manifestUrl: found.manifestUrl,
    entry: found.entry,
    bookTitle: found.bookTitle || ''
  });

  // 3. доступ к домену и сам mp3
  if (!(await originAllowed(found.audioUrl))) {
    let origin = '';
    try { origin = new URL(found.audioUrl).origin; } catch (e) { /* ок */ }
    result.origin = origin;
    return finish('need-permission', 'blocked', MSG.blocked,
      'Нужно разрешение на доступ к ' + (origin || 'домену облака') + '.');
  }
  const head = await probeAudio(found.audioUrl);
  if (!head.ok) {
    return fail(head, head.status === 404
      ? 'audio.mp3 из index.json не найден в облаке (404): ' + found.audioUrl
      : 'audio.mp3 не открывается (' + failureText(head) + '): ' + found.audioUrl);
  }
  result.audio = { size: head.size, sizeText: humanSize(head.size), ranges: head.ranges, ok: true };

  // 4. manifest.json
  const manifest = await fetchJson(found.manifestUrl, { fresh: true });
  if (!manifest.ok) {
    return fail(manifest, 'manifest.json не найден или не прочитался (' + failureText(manifest) + '): ' +
      found.manifestUrl);
  }
  if (!manifest.data || !Array.isArray(manifest.data.segments)) {
    return finish('bad-manifest', 'unavailable', MSG.unavailable, 'manifest.json найден, но в нём нет segments.');
  }
  result.manifest = manifest.data;
  const identity = Cloud.validateManifest(manifest.data, meta);
  if (!identity.ok) {
    return finish('wrong-chapter', 'unavailable', MSG.unavailable, 'Озвучка отклонена: ' + identity.reason);
  }

  return finish('ok', '', '', 'Озвучка найдена: mp3 ' + (result.audio.sizeText || '?') +
    (result.audio.ranges ? ', перемотка поддерживается' : ', перемотка НЕ поддерживается') +
    ', реплик: ' + manifest.data.segments.length);
}

// ------------------------------------------- подсказка, когда глава не открыта
//
// Значок у края страницы (и попап) говорят по делу:
//   главная / каталог / профиль → «Готов к работе. Откройте любой тайтл»;
//   страница тайтла             → быстрая проверка index.json книги:
//                                 «Озвучка найдена, откройте главу» или «Озвучки нет».
// Результат по тайтлу помним недолго: озвучку могут дописать, а сеть — моргнуть.

const TITLE_TTL = 2 * 60 * 1000;
const titleCache = new Map();

const TIP = {
  ready:   { tone: 'ok',   title: 'Готов к работе',
             text: 'Откройте любой тайтл — я проверю, есть ли для него озвучка.' },
  other:   { tone: 'ok',   title: 'Готов к работе',
             text: 'Откройте любой тайтл, чтобы узнать, есть ли для него озвучка.' },
  found:   { tone: 'ok',   title: 'Озвучка найдена',
             text: 'Откройте главу — здесь появится плеер.' },
  none:    { tone: 'none', title: 'Озвучки нет',
             text: 'На этот тайтл озвучки не найдено.' },
  network: { tone: 'warn', title: 'Не удалось проверить',
             text: 'Проверьте подключение к интернету — попробую ещё раз при следующем визите.' },
  broken:  { tone: 'warn', title: 'Проверка недоступна',
             text: 'Озвучка сейчас временно недоступна. Попробуйте позже.' }
};

function tip(kind, extra) {
  return Object.assign({ kind }, TIP[kind], extra || {});
}

function pluralChapters(n) {
  const m10 = n % 10, m100 = n % 100;
  const w = (m10 === 1 && m100 !== 11) ? 'глава'
    : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) ? 'главы' : 'глав';
  return n + ' ' + w;
}

async function checkTitle(bookId, refresh) {
  const key = String(bookId);
  const hit = titleCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < TITLE_TTL) return hit.result;

  const who = { book_id: key };
  let result;
  if (!BASE) {
    result = tip('broken');
  } else {
    const idx = await fetchBookIndex(key);
    if (idx.status === 404) {
      result = tip('none');
      addLog('info', 'title', 'Тайтл ' + key + ': папки книги в облаке нет (404).', who);
    } else if (!idx.ok) {
      result = isNetworkFailure(idx) ? tip('network') : tip('broken');
      addLog('warn', 'title', 'Не удалось прочитать index.json книги ' + key + ': ' + failureText(idx), who);
    } else {
      const n = Cloud.chapterCount(idx.data);
      if (n === 0) {
        result = tip('none');
        addLog('info', 'title', 'Тайтл ' + key + ': index.json есть, озвученных глав нет.', who);
      } else {
        result = tip('found', { text: 'Озвучено: ' + pluralChapters(n) + '. Откройте главу — здесь появится плеер.',
                                chapters: n });
        addLog('info', 'title', 'Тайтл ' + key + ': озвучено глав — ' + n + '.', who);
      }
    }
  }
  // Сетевой сбой не запоминаем: следующая проверка должна сходить в облако снова.
  if (result.kind !== 'network') titleCache.set(key, { at: Date.now(), result });
  return result;
}

// Что сказать по адресу страницы, где НЕ открыта глава.
async function describePage(url, refresh) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return tip('other'); }
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return tip('ready');                                  // главная
  const bm = /^\/ranobe\/(\d+)(?:-[^/]*)?(?:\/|$)/i.exec(path);
  if (bm) return checkTitle(bm[1], refresh);                       // страница тайтла
  return tip('other');                                             // каталог, поиск, профиль…
}

// ---------------------------------------------------------------- сообщения
//
// Протокол сообщений (chrome.runtime.sendMessage({type, ...})):
//   resolve      {meta, refresh}  → результат resolveChapter
//   pageContext  {url, refresh}   → подсказка для значка/попапа (tip)
//   getSettings / saveSettings {patch}
//   log {level, source, message, data} / getLog / clearLog
//   cloudInfo                     → сведения для «Для разработчика»
//   forgetCache                   → сбросить кэш глав
//   openSettings                  → попытка открыть попап

const handlers = {
  resolve: (msg) => resolveChapter(msg.meta, { refresh: msg.refresh }),
  pageContext: (msg) => describePage(msg.url, !!msg.refresh),
  getSettings: () => getSettings(),
  saveSettings: (msg) => saveSettings(msg.patch || {}),
  log: async (msg) => {
    await addLog(msg.level, msg.source || 'page', msg.message, msg.data);
    return { ok: true };
  },
  getLog: async () => {
    await logQueue;
    const st = await chrome.storage.local.get(LOG_KEY);
    return { entries: Array.isArray(st[LOG_KEY]) ? st[LOG_KEY] : [] };
  },
  clearLog: async () => {
    await logQueue;
    await chrome.storage.local.remove(LOG_KEY);
    return { ok: true };
  },
  cloudInfo: () => ({
    describe: Cloud.describe(CLOUD_CONF, null),
    builtin: BASE,
    hosts: KNOWN_HOSTS,
    names: CLOUD_CONF.names,
    public: true,
    configured: !!BASE,
    version: chrome.runtime.getManifest().version,
    protocol: PROTOCOL
  }),
  forgetCache: () => {
    chapterCache.clear();
    titleCache.clear();
    return { ok: true };
  },
  openSettings: async () => {
    // С Chrome 127 попап открывается только жестом пользователя;
    // если не вышло — панель подскажет, где искать настройки.
    try {
      if (chrome.action && chrome.action.openPopup) {
        await chrome.action.openPopup();
        return { opened: true };
      }
    } catch (e) { /* ок */ }
    return { opened: false };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && Object.prototype.hasOwnProperty.call(handlers, msg.type) && handlers[msg.type];
  if (!handler) {
    sendResponse({ error: 'неизвестный запрос: ' + (msg && msg.type) });
    return false;
  }
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;   // ответ асинхронный
});

chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.sync.get(null);
  const patch = {};
  for (const k of Object.keys(Settings.DEFAULTS)) if (st[k] === undefined) patch[k] = Settings.DEFAULTS[k];
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
});
