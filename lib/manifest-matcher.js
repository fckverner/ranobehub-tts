/* manifest-matcher.js — ядро расширения браузера.
 *
 * Задача: играет mp3, в руках манифест (что и когда звучит) и страница главы
 * на сайте. Нужно понять, какой абзац звучит прямо сейчас, чтобы подсветить
 * его, подтянуть к «уровню глаз» и листать страницу по ходу озвучки.
 *
 * Текст озвучки и текст страницы совпадают НЕ полностью: тире вырезаны,
 * длинная реплика разбита по точкам на несколько строк, реплику могли
 * прочитать «как слышится» (обращаюсь вместо обращаясь), где-то опечатка на
 * сайте, где-то исправленная в озвучке. Поэтому сравниваются не строки, а
 * наборы значимых слов, и решается не «где эта строка», а «какая раскладка
 * ВСЕХ реплик по ВСЕМ абзацам наиболее правдоподобна» — задача выравнивания,
 * которую решает динамическое программирование (см. align ниже).
 *
 * Всё, что здесь есть, обязано совпадать с питоновской программой
 * (normalize_for_match и правило слов) — иначе ключи из манифеста не найдутся.
 * Совпадение проверяется тестом tests/test_parity.py в main-app (Python-часть);
 * поведение JS-стороны — tests/matcher.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ManifestMatcher = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ слова

  var MIN_WORD_LEN = 4;    // слова короче — шум («как», «это», «его»)
  var MAX_WORDS = 40;      // больше не нужно: и хватает, и манифест не пухнет

  // Латинские буквы, неотличимые на вид от русских: в русских словах на сайтах
  // то и дело попадается латинская «c», «o», «e». Приводим к русским, чтобы
  // «Рyдеус» и «Рудеус» считались одним словом.
  var LOOKALIKE = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
                    k: 'к', m: 'м', t: 'т', h: 'н', b: 'ь', u: 'и', n: 'п' };

  // Нормализация — знак в знак как normalize_for_match в программе:
  // строчные буквы, ё→е, э→е, латинские двойники → русские, всё прочее в пробелы.
  function norm(text) {
    var out = [], s = String(text == null ? '' : text).toLowerCase();
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === 'ё' || ch === 'э') ch = 'е';
      if (LOOKALIKE[ch]) ch = LOOKALIKE[ch];
      out.push(/[\p{L}\p{N}]/u.test(ch) ? ch : ' ');
    }
    return out.join('').replace(/\s+/g, ' ').trim();
  }

  // Слова-зацепки: длиной от 4 букв, по порядку, без повторов.
  // Если таких почти нет (короткая реплика «— Да.») — берём слова от 2 букв:
  // «да» встречается на странице в считаных абзацах и решает дело.
  function wordsOf(text) {
    var all = norm(text).split(' ').filter(Boolean), out = [], seen = {}, i, w;
    for (i = 0; i < all.length; i++) {
      w = all[i];
      if (w.length < MIN_WORD_LEN || seen[w]) continue;
      seen[w] = 1; out.push(w);
      if (out.length >= MAX_WORDS) break;
    }
    if (out.length < 2) {
      out = []; seen = {};
      for (i = 0; i < all.length; i++) {
        w = all[i];
        if (w.length < 2 || seen[w]) continue;
        seen[w] = 1; out.push(w);
        if (out.length >= MAX_WORDS) break;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ страница

  // Что считать абзацем текста. На ranobehub это <p> внутри
  // div#reader-content-<ID главы>.reader-content (там же заголовки <h2> «Часть N»).
  var BLOCK_SELECTOR = 'p, h2, h3, h4, li, blockquote';
  // Что не считать текстом главы: реклама, служебные панели, скрипты.
  var SKIP_SELECTOR = 'script, style, noscript, aside, .reader-ad-slot, [hidden],' +
    ' nav, header, footer, .reader-top, .reader-controls, .reader-ad-fallback';

  // doc можно передать явно (тесты, вставленный HTML); по умолчанию — текущая страница
  function contentRoot(chapterId, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    if (chapterId) {
      var el = doc.getElementById('reader-content-' + chapterId);
      if (el) return el;
    }
    return doc.querySelector('.reader-content')
        || doc.querySelector('#main-content')
        || doc.querySelector('main')
        || doc.body;
  }

  // Абзацы главы в том порядке, в котором они идут на странице.
  function collectBlocks(rootEl) {
    var all = rootEl.querySelectorAll(BLOCK_SELECTOR), out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest(SKIP_SELECTOR)) continue;
      if (!el.textContent.trim()) continue;
      out.push(el);
    }
    return out;
  }

  // «Ключ» абзаца — начало его нормализованного текста. Раскладка хранит номера
  // абзацев, а сайт может вставить или убрать блок (примечание, подпись, рекламу),
  // и номера съедут на единицу. По ключу абзац находится и после такого сдвига,
  // а если не находится — магнит не двигает страницу вообще, вместо того чтобы
  // тащить её к случайному соседу.
  var KEY_LEN = 80;
  var MAX_SHIFT = 80;
  function blockKey(el) {
    return norm(el && el.textContent).slice(0, KEY_LEN);
  }

  // ------------------------------------------------------ веса и похожесть

  // Строит индекс страницы: для каждого абзаца — его слова и «редкость» каждого
  // слова. Редкое слово (имя, топоним) весит в разы больше частого — именно
  // поэтому «Сильфиэтта» тянет подсветку к себе, а «было» никуда не тянет.
  function buildIndex(blocks) {
    var n = blocks.length, i, j, sets = [], words = [], df = {};
    for (i = 0; i < n; i++) {
      var w = wordsOf(blocks[i].textContent);
      words.push(w);
      var s = {};
      for (j = 0; j < w.length; j++) s[w[j]] = 1;
      sets.push(s);
      for (var k in s) df[k] = (df[k] || 0) + 1;
    }
    var idf = {};
    for (var t in df) idf[t] = Math.sqrt(n / df[t]);
    // pre — кэш весов реплик. Живёт в индексе, а не глобально: веса зависят от
    // idf конкретной страницы, и общий кэш отдавал бы для новой главы веса старой.
    return { n: n, blocks: blocks, words: words, sets: sets, idf: idf, pre: {} };
  }

  // Доля «веса» слов реплики, которая нашлась в абзацах start..start+span-1.
  // Абзац внутри склейки, не давший ни одного слова, штрафуется: иначе склейка
  // бесплатно прихватывает лишние абзацы и утаскивает за собой разметку.
  var BLANK_PEN = 0.35;

  function segmentWeights(index, segWords) {
    var cache = index.pre || (index.pre = {});
    var key = segWords.join(' ');
    if (cache[key]) return cache[key];
    var map = {}, total = 0;
    for (var i = 0; i < segWords.length; i++) {
      var w = segWords[i];
      map[w] = (index.idf[w] || 1);
      total += map[w];
    }
    return (cache[key] = { map: map, total: total });
  }

  function coverage(index, segWords, start, span) {
    if (!segWords.length || !index.n) return 0;
    var p = segmentWeights(index, segWords);
    if (!p.total) return 0;
    var got = 0, blanks = 0, lo = Math.max(0, start), hi = Math.min(index.n, start + span);
    for (var j = lo; j < hi; j++) {
      var hit = false, set = index.sets[j];
      for (var w in p.map) {
        if (set[w]) { hit = true; break; }
      }
      if (!hit) blanks++;
    }
    var union = {};
    for (j = lo; j < hi; j++) {
      for (var k in index.sets[j]) union[k] = 1;
    }
    for (var w2 in p.map) if (union[w2]) got += p.map[w2];
    return got / p.total - BLANK_PEN * blanks;
  }

  // «Подпись» разметки: сколько абзацев и сколько в них всего знаков. Дешевле
  // полного сравнения текстов, а для нашей задачи достаточно: если сайт
  // пересоздал те же абзацы (на ranobehub он делает это на каждой прокрутке),
  // подпись не изменится и раскладку можно не пересчитывать — хватит взять
  // новые узлы. Если текст другой — подпись почти наверняка изменится.
  function textSignature(blocks) {
    var n = 0, len = 0;
    for (var i = 0; i < blocks.length; i++) {
      var t = blocks[i];
      if (!t) continue;
      n++;
      len += (t.textContent || '').length;
    }
    return n + ':' + len;
  }

  // ------------------------------------------------------ выравнивание (DP)

  var SPAN_MAX = 3;    // одна реплика — не больше трёх абзацев подряд
  var SKIP_PEN = 0.18; // штраф за абзац, которого нет в озвучке
  var INS_PEN = 0.05;  // штраф за «ещё одна реплика в этом же абзаце»
  var SPAN_PEN = 0.08; // штраф за склейку каждого следующего абзаца
  var EMPTY_PEN = 0.15;// реплика без слов держится прежнего абзаца

  // Лучшая раскладка ВСЕХ реплик по абзацам (монотонно, с пропусками и склейками).
  // Возвращает [{start, span, score}] — по одному на реплику.
  function align(index, segmentsWords) {
    var N = segmentsWords.length, M = index.n, NEG = -1e9;
    if (!N) return [];
    if (!M) return segmentsWords.map(function () { return { start: 0, span: 0, score: 0 }; });
    var prev = new Array(M + 1), cur, bk = [], back = [], i, j, s;
    prev[0] = 0;
    for (j = 1; j <= M; j++) prev[j] = prev[j - 1] - SKIP_PEN;
    for (i = 1; i <= N; i++) {
      var seg = segmentsWords[i - 1], has = seg.length > 0;
      cur = new Array(M + 1); cur[0] = NEG;
      var row = new Array(M + 1);
      for (j = 1; j <= M; j++) {
        var best = NEG, how = null, v;
        if (prev[j] > NEG) {                       // вторая половина той же реплики
          v = prev[j] + (has ? coverage(index, seg, j - 1, 1) : 0) - INS_PEN;
          if (v > best) { best = v; how = [j, 1, 'same']; }
        }
        if (prev[j - 1] > NEG) {                   // 1 реплика = 1 абзац
          v = prev[j - 1] + (has ? coverage(index, seg, j - 1, 1) : -EMPTY_PEN);
          if (v > best) { best = v; how = [j - 1, 1, 'one']; }
        }
        for (s = 2; s <= SPAN_MAX; s++) {          // 1 реплика = 2–3 абзаца
          if (j - s >= 0 && prev[j - s] > NEG) {
            v = prev[j - s] + coverage(index, seg, j - s, s) - SPAN_PEN * (s - 1);
            if (v > best) { best = v; how = [j - s, s, 'span']; }
          }
        }
        if (cur[j - 1] > NEG) {                    // абзац без озвучки
          v = cur[j - 1] - SKIP_PEN;
          if (v > best) { best = v; how = [j - 1, 0, 'skip']; }
        }
        cur[j] = best; row[j] = how;
      }
      back.push(row);
      prev = cur;
    }
    // хвост страницы (сноски, ссылки «следующая глава») покрывать не обязаны
    j = 0;
    for (i = 0; i <= M; i++) if (prev[i] > prev[j]) j = i;
    var out = new Array(N);
    i = N;
    while (i > 0) {
      var h = back[i - 1][j];
      if (h[2] === 'one' || h[2] === 'span') {
        out[i - 1] = { start: h[0], span: h[1], score: coverage(index, segmentsWords[i - 1], h[0], h[1]) };
        j = h[0];
        i--;
      } else if (h[2] === 'same') {
        out[i - 1] = { start: Math.max(0, j - 1), span: 1, score: null };
        i--;
      } else {
        j = h[0];
      }
    }
    for (i = 0; i < N; i++) {
      if (out[i] && out[i].score == null) {
        out[i].score = coverage(index, segmentsWords[i], out[i].start, 1);
      } else if (!out[i]) {
        out[i] = { start: 0, span: 1, score: 0 };
      }
    }
    return out;
  }

  // Качество привязки: если средняя похожесть низкая — манифест не от этой страницы.
  function alignmentQuality(mapping, segmentsWords) {
    var sum = 0, cnt = 0;
    for (var i = 0; i < mapping.length; i++) {
      if (!segmentsWords[i] || !segmentsWords[i].length) continue;
      sum += mapping[i].score || 0; cnt++;
    }
    return cnt ? sum / cnt : 0;
  }

  // ------------------------------------------------------ воспроизведение

  // Какой сегмент манифеста звучит в момент t (мс). Сегменты отсортированы.
  //
  // Допуск 5 мс не случаен: полоса перемотки даёт время с точностью 1/1000 от
  // длительности файла (у главы на 20 минут это 1.2 с шага), и «точное» попадание
  // на start_ms реплики запросто оказывается на 0.4 мс раньше — тогда подсветка
  // осталась бы на предыдущем абзаце, пока звук уже читает новый.
  var SEGMENT_EPS_MS = 5;

  function segmentAt(manifest, t) {
    var segs = manifest.segments, lo = 0, hi = segs.length - 1, res = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].start_ms - SEGMENT_EPS_MS <= t) { res = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return res;
  }

  // Начало реплики в секундах: start_ms (v3) или устаревшее start (сек).
  function segmentStartSec(seg) {
    if (!seg) return 0;
    return seg.start_ms != null ? seg.start_ms / 1000 : Number(seg.start || 0);
  }

  // Прокрутка так, чтобы абзац оказался на «уровне глаз» — выше центра экрана.
  // eyeLevel: доля высоты окна, на которой должна оказаться верхняя кромка абзаца.
  function scrollToEye(el, eyeLevel) {
    // Абзац мог быть пересоздан сайтом между кадром подсветки и прокруткой.
    // У оторванного узла прямоугольник нулевой, и «прокрутить к нему» означало
    // бы уехать на треть экрана вверх — именно так магнит и ломался.
    if (!el || el.isConnected === false) return false;
    if (el.getClientRects && el.getClientRects().length === 0) return false;
    var frac = typeof eyeLevel === 'number' ? eyeLevel : 0.34;
    var scroller = nearestScroller(el);
    var box = el.getBoundingClientRect();
    if (scroller === document.scrollingElement || scroller === document.documentElement ||
        scroller === document.body) {
      var top = window.pageYOffset + box.top - window.innerHeight * frac;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else {
      var sbox = scroller.getBoundingClientRect();
      scroller.scrollTo({ top: scroller.scrollTop + (box.top - sbox.top) - scroller.clientHeight * frac,
                          behavior: 'smooth' });
    }
    return true;
  }

  function nearestScroller(el) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var st = getComputedStyle(node);
      if (/(auto|scroll|overlay)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) {
        return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Какие абзацы занимает реплика: [{start, span, score}] → список индексов.
  function blocksOf(mapping, i, blockCount) {
    var m = mapping[i];
    if (!m) return [];
    var out = [];
    for (var k = m.start; k < m.start + (m.span || 1); k++) {
      if (k >= 0 && k < blockCount) out.push(k);
    }
    return out;
  }

  // Обратное отображение «абзац → реплика»: нужно кнопке «Найти по тексту»,
  // когда человек кликает по абзацу страницы. Возвращает номер реплики и
  // признак точного попадания (false — абзац только внутри склейки).
  function blockToSegment(mapping, blockIndex) {
    var exact = null, inside = null;
    for (var i = 0; i < mapping.length; i++) {
      var m = mapping[i];
      if (!m) continue;
      var end = m.start + (m.span || 1) - 1;
      if (blockIndex >= m.start && blockIndex <= end) {
        if (m.start === blockIndex) return { i: i, exact: true };
        if (inside === null) inside = i;
      }
      // реплика «после» абзаца: пригодится, если абзац не покрыт озвучкой
      if (exact === null && inside === null && m.start > blockIndex) {
        return { i: i, exact: false, gap: m.start - blockIndex };
      }
    }
    if (inside !== null) return { i: inside, exact: false, gap: 0 };
    return null;
  }

  // Слежение за звуком: на смене сегмента подсвечивает его абзацы и подтягивает их.
  // opts: {manifest, audio, mapping, index, cssClass, eyeLevel, magnet, getBlocks, getKeys}
  function follow(opts) {
    var cls = opts.cssClass || 'tts-now';
    var magnet = opts.magnet !== false;      // «магнит» можно выключить на ходу
    var painted = [];
    var last = -2;
    var shift = 0;                            // на сколько абзацев страница сдвинулась относительно раскладки
    var wantScrollUntil = 0;                  // абзац не нашёлся при смене реплики — пробуем ещё недолго
    var dead = false, rafId = 0;              // после stop() экземпляр мёртв: его цикл кадров больше не живёт

    // Абзацы берём в момент отрисовки, а не один раз на старте: страница
    // пересоздаёт разметку (см. textSignature), и любые сохранённые ссылки на
    // узлы к следующей секунде оказываются выброшенными из документа.
    function blocks() {
      if (opts.getBlocks) {
        var b = opts.getBlocks();
        if (b && b.length) return b;
      }
      return (opts.index && opts.index.blocks) || [];
    }

    // Живой узел абзаца №k из раскладки. Сначала там, где он ожидается (с учётом
    // уже замеченного сдвига), потом — ближайший с тем же текстом. null — если
    // такого абзаца сейчас на странице нет (например, сайт ещё дорисовывает главу).
    function elementFor(k) {
      var list = blocks();
      if (!list.length || k < 0) return null;
      var keys = opts.getKeys ? opts.getKeys() : null;
      if (!keys) return list[k] || null;                 // без ключей — по номеру, как раньше
      var want = keys[k];
      if (want == null) return null;
      function ok(i) { return i >= 0 && i < list.length && blockKey(list[i]) === want; }
      var i0 = k + shift;
      if (ok(i0)) return list[i0];
      for (var d = 1; d <= MAX_SHIFT; d++) {
        if (ok(i0 + d)) { shift = i0 + d - k; return list[i0 + d]; }
        if (ok(i0 - d)) { shift = i0 - d - k; return list[i0 - d]; }
      }
      return null;
    }

    function clear() {
      for (var i = 0; i < painted.length; i++) {
        if (painted[i] && painted[i].isConnected !== false) painted[i].classList.remove(cls);
      }
      painted = [];
    }

    // Абзац уже там, где надо, — страницу не трогаем: лишняя «плавная прокрутка»
    // на пару пикселей выглядит как дёрганье.
    function atEye(el, frac) {
      var h = window.innerHeight, top = el.getBoundingClientRect().top;
      return top >= 0 && top <= h && Math.abs(top - h * frac) <= h * 0.03;
    }

    // Плавная прокрутка доезжает не всегда туда, где её ждали: на живой
    // странице разметка «подъезжает» (реклама, картинки, пересоздание дерева),
    // и абзац оказывается не на уровне глаз, а ниже — замер на настоящей главе
    // дал 51 % вместо 34 %. Поэтому после прокрутки положение проверяется и,
    // если абзац всё ещё виден, но стоит не на месте, — поправляется.
    // Если человек сам ушёл в другое место (абзаца не видно), поправлять нельзя:
    // это выглядело бы как «страница дерётся со мной».
    var settleTimer = null, settleTries = 0;
    function settle() {
      settleTimer = null;
      if (dead || !magnet) return;
      var si = last;
      if (si < 0 || !opts.mapping[si]) return;
      var el = elementFor(opts.mapping[si].start);       // по тексту, а не по номеру
      if (!el || el.isConnected === false) return;
      var h = window.innerHeight;
      var frac = typeof opts.eyeLevel === 'number' ? opts.eyeLevel : 0.34;
      var top = el.getBoundingClientRect().top;
      if (top < 0 || top > h) return;                       // абзаца не видно — не трогаем
      if (Math.abs(top - h * frac) <= h * 0.06) return;     // уже на месте
      if (settleTries >= 2) return;
      settleTries++;
      scrollToEye(el, frac);
      settleTimer = setTimeout(settle, 700);
    }
    function scheduleSettle() {
      clearTimeout(settleTimer);
      settleTries = 0;
      settleTimer = setTimeout(settle, 500);
    }
    function paint(si, withScroll) {
      if (dead) return;
      clear();
      if (si < 0 || !opts.mapping[si]) return;
      var m = opts.mapping[si];
      for (var k = m.start; k < m.start + (m.span || 1); k++) {
        var el = elementFor(k);
        if (!el) continue;
        el.classList.add(cls);
        painted.push(el);
      }
      if (!magnet) return;
      // Прокручиваем только к первому абзацу реплики и только если он найден
      // ПО ТЕКСТУ. Не нашёлся — не двигаем страницу, а пробуем при следующей
      // перерисовке (недолго): лучше секунду не следить, чем унести не туда.
      var head = elementFor(m.start);
      if (withScroll) wantScrollUntil = Date.now() + 1500;
      if (head && wantScrollUntil && Date.now() < wantScrollUntil) {
        wantScrollUntil = 0;
        if (!atEye(head, opts.eyeLevel)) scrollToEye(head, opts.eyeLevel);
        scheduleSettle();
      }
    }
    function step() {
      if (dead) return;
      var t = opts.audio.currentTime * 1000;
      var si = segmentAt(opts.manifest, t);
      if (si !== last) { last = si; paint(si, true); }
      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);
    return {
      // stop() убивает экземпляр насовсем. Раньше цикл кадров жил вечно: после смены
      // главы «осиротевший» экземпляр со старым манифестом и старой раскладкой
      // продолжал подсвечивать чужие абзацы и прокручивать страницу к ним.
      stop: function () { dead = true; cancelAnimationFrame(rafId); last = -2; shift = 0; wantScrollUntil = 0; clear(); clearTimeout(settleTimer); settleTimer = null; },
      reset: function () { last = -2; },      // после перемотки — перерисовать
      // Раскладку пересчитали на месте: реплика та же, номера абзацев новые.
      // Перерисовываем, но страницу не трогаем — человек мог читать где угодно.
      rebind: function () { shift = 0; paint(last, false); },
      // Перерисовать текущую реплику заново, ничего не прокручивая: нужно,
      // когда сайт пересоздал разметку и подсветка потерялась.
      repaint: function () { paint(last, false); },
      current: function () { return last; },
      setMagnet: function (on) { magnet = !!on; }
    };
  }

  // Готовим всё по манифесту: находим контейнер главы, собираем абзацы,
  // считаем слова реплик (из поля match) и выравниваем.
  function prepare(manifest, rootEl, doc) {
    var root = rootEl || contentRoot(manifest && manifest.chapter_id, doc);
    var blocks = collectBlocks(root);
    var index = buildIndex(blocks);
    var segWords = (manifest.segments || []).map(function (s) {
      return wordsOf(s.match || s.text || '');
    });
    var mapping = align(index, segWords);
    var keys = [];
    for (var ki = 0; ki < blocks.length; ki++) keys.push(blockKey(blocks[ki]));
    return { root: root, index: index, segmentsWords: segWords, mapping: mapping,
             keys: keys,
             signature: textSignature(blocks),
             quality: alignmentQuality(mapping, segWords) };
  }

  return {
    norm: norm, wordsOf: wordsOf,
    contentRoot: contentRoot, collectBlocks: collectBlocks, buildIndex: buildIndex,
    coverage: coverage, align: align, alignmentQuality: alignmentQuality,
    segmentAt: segmentAt, segmentStartSec: segmentStartSec, follow: follow, prepare: prepare, scrollToEye: scrollToEye,
    blocksOf: blocksOf, blockToSegment: blockToSegment, textSignature: textSignature,
    blockKey: blockKey,
    BLOCK_SELECTOR: BLOCK_SELECTOR, SKIP_SELECTOR: SKIP_SELECTOR
  };
});
