/* chapter-meta.js — что расширение вычитывает со страницы главы ranobehub.
 *
 * Возвращает:
 *   chapter_id      115721        — ID главы (из адреса или data-атрибута)
 *   book_id         "168"         — ID книги (из ссылки на книгу)
 *   book_slug       "reincarnation-of-the-unemployed" — слаг книги из адреса
 *   book_folder     "168"                  — стабильный ID-путь книги в v3
 *   book_title      "Реинкарнация безработного…"
 *   volume          "18"          — том (из «Том 18 · Глава 12(187)…»)
 *   chapter_title   "Глава 12(187). Правда от Орстеда и десять дней в столице."
 *   chapter_local   "12"          — номер главы внутри тома
 *   chapter_number  "187"         — общий номер главы (в скобках), если есть
 *   url             адрес страницы
 *
 * Разбор нарочно «многослойный»: сайт может перерисовать разметку, поэтому
 * значения ищутся в нескольких местах, а не в одном селекторе.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RanobeChapterMeta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function text(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function fromUrl(url) {
    var out = { chapter_id: '', book_id: '', book_slug: '' };
    var cm = /\/chapter\/(\d+)/i.exec(url || '');
    if (cm) out.chapter_id = cm[1];
    // «/ranobe/168-reincarnation-of-the-unemployed/chapter/115721»: ID книги и
    // slug стоят рядом. Для storage используется только ID книги; slug — metadata.
    var bm = /\/ranobe\/(\d+)(?:-([a-z0-9][a-z0-9-]*))?/i.exec(url || '');
    if (bm) {
      out.book_id = bm[1];
      out.book_slug = (bm[2] || '').replace(/-+$/, '');
    }
    return out;
  }

  // Каноническая папка книги в v3 — только стабильный book_id.
  function bookFolder(info) {
    return info ? String(info.book_id || '') : '';
  }

  // «Глава 12(187). Правда от Орстеда…» → local 12, number 187, title целиком
  function parseChapterNumbers(title) {
    var out = { chapter_local: '', chapter_number: '' };
    var m = /Глава\s*(\d+)\s*(?:\(\s*(\d+)\s*\))?/i.exec(title || '');
    if (m) {
      out.chapter_local = m[1];
      out.chapter_number = m[2] || '';
    }
    return out;
  }

  function parse(doc, loc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    loc = loc || (typeof location !== 'undefined' ? location : {});
    var url = (loc && loc.href) || '';
    var info = fromUrl(url);

    // --- ID главы: адрес → data-атрибут ссылки → id контейнера текста
    if (!info.chapter_id) {
      var byAttr = doc.querySelector('[data-chapter-transition-id]');
      if (byAttr) info.chapter_id = byAttr.getAttribute('data-chapter-transition-id') || '';
    }
    if (!info.chapter_id) {
      var content = doc.querySelector('[id^="reader-content-"]');
      if (content) info.chapter_id = String(content.id).replace('reader-content-', '');
    }

    // --- книга
    var bookLink = doc.querySelector('.reader-identity a[href*="/ranobe/"]')
      || doc.querySelector('a[href*="/ranobe/"]');
    info.book_title = text(bookLink);
    if (bookLink) {
      var href = bookLink.getAttribute('href') || '';
      var bm = /\/ranobe\/(\d+)(?:-([a-z0-9][a-z0-9-]*))?/i.exec(href);
      if (bm) {
        if (!info.book_id) info.book_id = bm[1];
        if (!info.book_slug && bm[2]) info.book_slug = bm[2].replace(/-+$/, '');
      }
    }
    info.book_folder = bookFolder(info);

    // --- том и название главы: «Том <!-- -->18<!-- --> · <!-- -->Глава 12(187). …»
    // В .reader-identity-meta лежит несколько <span>: «Том 18 · Глава 12(187)…» и
    // счётчик «Читают сейчас 8». Берём тот, в котором есть «Том» или «Глава».
    var metaLine = '';
    var metaEl = doc.querySelector('.reader-identity-meta');
    if (metaEl) {
      var variants = [];
      for (var c = 0; c < metaEl.children.length; c++) variants.push(text(metaEl.children[c]));
      variants.push(text(metaEl));
      metaLine = variants.find(function (v) { return /(Том\s*[0-9IVXLC]|Глава\s*\d)/i.test(v); }) || variants[0];
    }
    var vm = /Том\s*([0-9IVXLC]+)/i.exec(metaLine);
    if (vm) info.volume = vm[1];

    info.chapter_title = '';
    var dash = metaLine.lastIndexOf('·');
    if (dash >= 0) info.chapter_title = metaLine.slice(dash + 1).trim();
    if (!info.chapter_title) {
      var h1 = doc.querySelector('.title-transition')
        || doc.querySelector('h1')
        || doc.querySelector('h2');
      info.chapter_title = text(h1);
    }
    // Название без «шапки» — то, что показываем в подписи плеера
    info.chapter_name = info.chapter_title.replace(/^Глава\s*[\d()]+\s*[.·—-]?\s*/i, '').trim();

    Object.assign(info, parseChapterNumbers(metaLine || info.chapter_title));
    info.url = url;
    return info;
  }

  // Адрес следующей главы: к числу после «/chapter/» прибавляется единица.
  // Запасной путь на случай, когда сайт не даёт ни ссылки, ни реакции на →.
  function nextChapterUrl(url) {
    var m = /^(.*?\/chapter\/)(\d+)(.*)$/i.exec(url || '');
    if (!m) return '';
    return m[1] + (parseInt(m[2], 10) + 1) + m[3].replace(/^[?#].*$/, '');
  }

  return { parse: parse, fromUrl: fromUrl, bookFolder: bookFolder,
           parseChapterNumbers: parseChapterNumbers, nextChapterUrl: nextChapterUrl };
});
