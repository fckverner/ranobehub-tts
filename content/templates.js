/* templates.js — статическая разметка и тексты панели озвучки.
 *
 * Только данные, никакой логики: HTML панели (рисуется в теневом DOM),
 * CSS для страницы сайта (подсветка абзаца, курсор «Найти по тексту») и
 * надписи, которые панель показывает вместо плеера.
 * Подключается в manifest.json перед content/content.js.
 */
'use strict';

(function () {
  const HL_CLASS = 'rh-tts-now';

  const PAGE_CSS = `
    .${HL_CLASS} {
      background: linear-gradient(90deg, rgba(255,60,172,.20), rgba(122,92,255,.05));
      box-shadow: inset 3px 0 0 0 #ff3cac, 0 0 18px rgba(255,60,172,.16);
      border-radius: 6px;
      transition: background .2s ease;
    }
    body.rh-tts-picking [id^="reader-content-"] p,
    body.rh-tts-picking [id^="reader-content-"] h2,
    body.rh-tts-picking [id^="reader-content-"] h3,
    body.rh-tts-picking [id^="reader-content-"] li,
    body.rh-tts-picking [id^="reader-content-"] blockquote {
      cursor: crosshair !important;
    }
    body.rh-tts-picking [id^="reader-content-"] p:hover {
      background: rgba(255,60,172,.14);
      border-radius: 6px;
    }
  `;

  const PANEL_HTML = `
  <div class="panel" part="panel">
    <header class="head" id="head" title="Потяните, чтобы переместить панель. Двойной клик — вернуть на место.">
      <span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="dot" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <div class="titles">
        <div class="title">Озвучка RanobeHub</div>
        <div class="chapter" id="chapter">Определяю главу…</div>
      </div>
      <button class="icon" id="collapse" title="Свернуть или развернуть панель"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
    </header>

    <div class="body">
      <div class="empty" id="empty">
        <div class="empty-icon" aria-hidden="true">🎧</div>
        <div class="empty-title">Этого тайтла пока нет в озвучке</div>
        <div class="empty-text">Ни одна глава этой книги ещё не озвучена, поэтому плеер спрятан. Загляните позже — когда озвучка появится, здесь заработает плеер.</div>
        <div class="row empty-actions">
          <button class="wide" id="recheck" title="Проверить, не появилась ли озвучка"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg> Проверить снова</button>
          <button class="icon" id="settings2" title="Настройки расширения"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg></button>
        </div>
      </div>

      <div class="note" id="note">
        <div class="note-icon" id="noteIcon" aria-hidden="true">🖼️</div>
        <div class="note-title" id="noteTitle"></div>
        <div class="note-text" id="noteText"></div>
        <div class="row note-actions" id="noteActions" hidden>
          <button class="wide" id="noteRecheck" title="Проверить страницу и озвучку ещё раз"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg> Проверить снова</button>
        </div>
      </div>

      <div class="status" id="status">Запуск…</div>

      <div class="row player">
        <button class="play" id="play" title="Играть (пробел)"><svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.5-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/></svg><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg></button>
        <div class="timeline">
          <div class="track">
            <div class="buffered" id="buffered"></div>
            <input type="range" id="seek" min="0" max="1000" value="0" step="1" aria-label="Перемотка">
          </div>
          <div class="times"><span id="cur">00:00</span> / <span id="total">00:00</span></div>
        </div>
      </div>

      <div class="row tools">
        <button class="wide" id="pick" title="Кликните по абзацу — озвучка начнётся с него"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg> Найти по тексту</button>
        <button class="icon" id="reload" title="Обновить озвучку"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg></button>
        <button class="icon" id="settings" title="Настройки расширения"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg></button>
      </div>

      <div class="grid">
        <label class="cell" title="Страница сама прокручивается вслед за озвучкой">
          <small>Автопрокрутка</small>
          <span class="cv"><span class="swt"></span><input type="checkbox" id="magnet" class="switch"></span>
        </label>
        <label class="cell" title="Где на экране держать звучащий абзац">
          <small>Держать</small>
          <span class="cv"><select id="eye">
            <option value="15">вверху</option>
            <option value="34" selected>выше центра</option>
            <option value="50">по центру</option>
          </select></span>
        </label>
        <label class="cell" title="Скорость озвучки">
          <small>Скорость</small>
          <span class="cv"><select id="rate">
            <option value="0.75">0.75×</option>
            <option value="1" selected>1×</option>
            <option value="1.25">1.25×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
          </select></span>
        </label>
        <label class="cell vol" title="Громкость">
          <small>Громкость</small>
          <span class="cv"><svg class="vi" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg><input type="range" id="vol" min="0" max="100" value="100"></span>
        </label>
      </div>

      <div class="hint" id="hint"></div>
    </div>
  </div>

  <div class="dock" id="dock" hidden>
    <div class="dock-tip" role="status">
      <b id="dockTipTitle">Готов к работе</b>
      <span id="dockTipText">Откройте любой тайтл — я проверю, есть ли для него озвучка.</span>
    </div>
    <button class="dock-btn" id="dockBtn" type="button"
            title="Озвучка RanobeHub" aria-label="Озвучка RanobeHub">
      <img id="dockImg" alt="" draggable="false">
      <i class="dock-dot"></i>
    </button>
  </div>`;

  // Надписи вместо плеера: {icon, title, text, status, tone, recheck}.
  const NOTES = {
    illustrations: {
      icon: '🖼️', title: 'Здесь иллюстрации',
      text: 'На этой странице нет текста, поэтому озвучки нет. Плеер вернётся на главе с озвучкой.',
      status: 'Иллюстрации — озвучивать здесь нечего.', tone: '', recheck: false
    },
    noText: {
      icon: '📄', title: 'На странице нет текста',
      text: 'Озвучивать здесь нечего. Если текст должен быть, обновите страницу.',
      status: 'На странице нет текста для озвучки.', tone: '', recheck: true
    },
    pageMissing: {
      icon: '⏳', title: 'Глава ещё не показалась',
      text: 'Не удалось найти содержимое главы. Попробуйте обновить страницу.',
      status: 'Не удалось найти содержимое главы. Попробуйте обновить страницу.', tone: 'warn', recheck: true
    },
    notPublished: {
      icon: '🎧', title: 'Этой главы пока нет в озвучке',
      text: 'Плеер скрыт — он появится на озвученных главах.',
      status: 'Озвучка этой главы не опубликована.', tone: '', recheck: true
    }
  };


  window.RhTtsTemplates = Object.freeze({ HL_CLASS, PAGE_CSS, PANEL_HTML, NOTES });
})();
