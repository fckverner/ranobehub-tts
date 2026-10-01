/* cloud.js — канонический протокол v3 для публичного Hugging Face Dataset RanobeHub TTS.
 *
 * Формат репозитория:
 *   books/<book_id>/index.json
 *   books/<book_id>/chapters/<chapter_id>/audio.mp3
 *   books/<book_id>/chapters/<chapter_id>/manifest.json
 *
 * Идентичность = book_id + chapter_id. slug/volume/title не участвуют в пути.
 * Этот модуль обязан повторять каноническую схему main-app.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RanobeCloud = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PROTOCOL = 'ranobe-hub-tts-v3';
  var VERSION = 3;
  var NAMES = {
    rootFolder: 'books',
    bookFolder: '{book_id}',
    chaptersFolder: 'chapters',
    chapterFolder: '{chapter_id}',
    audioFile: 'audio.mp3',
    manifestFile: 'manifest.json',
    bookIndexFile: 'index.json'
  };

  function trimBase(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function fields(meta) {
    meta = meta || {};
    return {
      chapter_id: String(meta.chapter_id || '').trim(),
      book_id: String(meta.book_id || '').trim()
    };
  }

  function validId(value) {
    return /^\d+$/.test(String(value || ''));
  }

  function expand(template, meta) {
    var map = fields(meta);
    return String(template || '').replace(/\{([a-z_]+)\}/gi, function (all, name) {
      var key = String(name).toLowerCase();
      var value = map[key];
      return value === undefined || value === '' ? all : value;
    });
  }

  function bookFolder(meta) {
    var f = fields(meta);
    return validId(f.book_id) ? expand(NAMES.bookFolder, meta) : '';
  }

  function chapterFolder(meta) {
    var f = fields(meta);
    return validId(f.chapter_id) ? expand(NAMES.chapterFolder, meta) : '';
  }

  function bookIndexRelative(meta) {
    var book = bookFolder(meta);
    return book ? NAMES.rootFolder + '/' + book + '/' + NAMES.bookIndexFile : '';
  }

  function chapterRelative(meta, fileName) {
    var book = bookFolder(meta), chapter = chapterFolder(meta);
    if (!book || !chapter) return '';
    return NAMES.rootFolder + '/' + book + '/' + NAMES.chaptersFolder + '/' +
      chapter + '/' + fileName;
  }

  function bookIndexUrl(conf, meta) {
    var base = trimBase((conf || {}).baseUrl);
    var rel = bookIndexRelative(meta);
    return base && rel ? base + '/' + rel : '';
  }

  function join(baseUrl, relative) {
    relative = String(relative || '');
    if (/^https?:\/\//i.test(relative)) return relative;
    return trimBase(baseUrl) + '/' + relative.replace(/^\/+/, '');
  }

  function basename(url) {
    try {
      var u = new URL(String(url));
      return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    } catch (e) {
      return String(url || '').split('/').pop() || '';
    }
  }

  function normalizeTitle(value) {
    return String(value || '').toLowerCase()
      .replace(/[ёэ]/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/^глава\s+\d+\s*(?:\(\s*\d+\s*\))?\s*/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function same(a, b) {
    return String(a || '').trim() === String(b || '').trim();
  }

  // Пути, записанные внутри books/<book_id>/index.json, относительны к папке книги.
  function expectedIndexPaths(meta) {
    var chapter = chapterFolder(meta);
    if (!bookFolder(meta) || !chapter) return { audio: '', manifest: '' };
    var prefix = NAMES.chaptersFolder + '/' + chapter + '/';
    return {
      audio: prefix + NAMES.audioFile,
      manifest: prefix + NAMES.manifestFile
    };
  }

  function expectedPaths(meta) {
    return {
      audio: chapterRelative(meta, NAMES.audioFile),
      manifest: chapterRelative(meta, NAMES.manifestFile)
    };
  }

  function fromBookIndex(index, meta, baseUrl) {
    if (!index || typeof index !== 'object') {
      return { error: 'index.json не является JSON-объектом.' };
    }
    if (Number(index.version || 0) !== VERSION || String(index.protocol || '') !== PROTOCOL) {
      return { error: 'index.json имеет неподдерживаемый протокол.' };
    }

    var f = fields(meta);
    if (!validId(f.book_id) || !validId(f.chapter_id)) {
      return { error: 'У текущей страницы нет корректных book_id/chapter_id.' };
    }

    var book = index.book || {};
    if (!same(book.book_id, f.book_id)) {
      return { error: 'index.json принадлежит другой книге.' };
    }

    var chapters = index.chapters;
    if (!chapters || typeof chapters !== 'object' || Array.isArray(chapters)) {
      return { error: 'В index.json нет корректного объекта chapters.' };
    }

    var entry = chapters[f.chapter_id];
    if (!entry || typeof entry !== 'object') return null;

    if (!same(entry.chapter_id, f.chapter_id) || !same(entry.book_id, f.book_id)) {
      return { error: 'Идентификаторы главы в index.json не совпадают с URL.' };
    }

    var expected = expectedIndexPaths(meta);
    if (entry.audio !== expected.audio || entry.manifest !== expected.manifest) {
      return { error: 'Пути audio/manifest в index.json не соответствуют протоколу v3.' };
    }

    // Не используем indexUrlUsed/response.url: Hugging Face может
    // перенаправить resolve/main/index.json на CDN/Xet, где URL уже не
    // является корнем каталога репозитория. Путь внутри Dataset строим
    // только из канонического baseUrl и ID-only схемы v3.
    var base = trimBase(baseUrl);
    var audioRelative = chapterRelative(meta, NAMES.audioFile);
    var manifestRelative = chapterRelative(meta, NAMES.manifestFile);
    return {
      audioUrl: base && audioRelative ? join(base, audioRelative) : '',
      manifestUrl: base && manifestRelative ? join(base, manifestRelative) : '',
      entry: entry,
      bookTitle: String(book.title || '')
    };
  }

  // Число глав в index.json (0 — если chapters нет или он не объект).
  function chapterCount(index) {
    var chapters = index && index.chapters;
    if (!chapters || typeof chapters !== 'object' || Array.isArray(chapters)) return 0;
    return Object.keys(chapters).length;
  }

  // Проверка manifest.json главы: протокол v3, совпадение book_id/chapter_id
  // со страницей и единственно допустимое имя аудиофайла.
  // Возвращает {ok: true} или {ok: false, reason}.
  function validateManifest(data, meta) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'Манифест не является объектом.' };
    if (String(data.protocol || '') !== PROTOCOL) {
      return { ok: false, reason: 'Манифест имеет неподдерживаемый протокол.' };
    }
    if (!Array.isArray(data.segments)) {
      return { ok: false, reason: 'В манифесте нет segments.' };
    }
    var f = fields(meta);
    var required = [['book_id', 'ID книги'], ['chapter_id', 'ID главы']];
    for (var i = 0; i < required.length; i++) {
      var field = required[i][0], label = required[i][1];
      var value = String(data[field] || '').trim();
      if (!value) return { ok: false, reason: 'В манифесте нет обязательного поля «' + field + '».' };
      if (value !== f[field]) return { ok: false, reason: label + ' манифеста не совпадает со страницей.' };
    }
    if (String(data.audio || NAMES.audioFile) !== NAMES.audioFile) {
      return { ok: false, reason: 'В манифесте разрешён только файл ' + NAMES.audioFile + '.' };
    }
    return { ok: true };
  }

  function describe(conf, meta) {
    var base = trimBase((conf || {}).baseUrl);
    if (!base) return {
      ok: false,
      text: 'Адрес Hugging Face Dataset не задан в сборке расширения.'
    };
    return {
      ok: true,
      base: base,
      bookIndex: meta ? bookIndexUrl(conf, meta) : '',
      text: 'Публичный Dataset. Токен для чтения не нужен.'
    };
  }

  return {
    PROTOCOL: PROTOCOL,
    VERSION: VERSION,
    NAMES: NAMES,
    trimBase: trimBase,
    fields: fields,
    expand: expand,
    bookFolder: bookFolder,
    chapterFolder: chapterFolder,
    bookIndexRelative: bookIndexRelative,
    chapterRelative: chapterRelative,
    bookIndexUrl: bookIndexUrl,
    expectedPaths: expectedPaths,
    expectedIndexPaths: expectedIndexPaths,
    fromBookIndex: fromBookIndex,
    chapterCount: chapterCount,
    validateManifest: validateManifest,
    basename: basename,
    normalizeTitle: normalizeTitle,
    join: join,
    describe: describe
  };
});
