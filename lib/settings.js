/* settings.js — единый источник настроек и ключей хранилища.
 *
 * Раньше DEFAULTS, EYE_LEVELS, RATES и ключи chrome.storage были скопированы
 * в background.js, popup.js и content.js и уже начали расходиться (в попапе
 * не было playbackRate/volume). Теперь все три контекста берут их отсюда.
 *
 * UMD: в service worker — importScripts, в попапе — <script>, в content —
 * через manifest.json, в Node-тестах — require().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RanobeSettings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // chrome.storage.sync — пользовательские настройки чтения.
  var DEFAULTS = Object.freeze({
    eyeLevel: 34,          // % высоты окна, где держать звучащий абзац
    magnet: true,          // автопрокрутка вслед за озвучкой
    autoLoad: true,        // искать озвучку сразу при открытии главы
    autoNext: true,        // по окончании главы открыть следующую
    playbackRate: 1,
    volume: 1,
    pickAfterJump: true,   // выходить из «Найти по тексту» после прыжка
    hideIfNone: false      // прятать панель, если озвучки точно нет
  });

  var EYE_LEVELS = Object.freeze([15, 34, 50]);          // вверху / выше центра / по центру
  var RATES = Object.freeze([0.75, 1, 1.25, 1.5, 2]);

  // chrome.storage.local / sessionStorage — состояние интерфейса.
  var KEYS = Object.freeze({
    panelPos: 'panelPos',              // {left, top} панели или нет ключа = штатное место
    panelCollapsed: 'panelCollapsed',
    dockY: 'dockY',                    // высота значка у правого края, доля окна
    debugLog: 'debugLog',              // кольцевой журнал (только фон пишет)
    resumeUntil: 'rhTtsResumeUntil'    // sessionStorage: продолжить звук после перехода
  });

  // Ближайшее допустимое значение: старые сохранённые 1.15× или 22 %
  // подтягиваются к нынешним вариантам, чтобы <select> не оказался пустым.
  function nearest(list, value, fallback) {
    var v = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(v)) return fallback;
    return list.reduce(function (best, x) {
      return Math.abs(x - v) < Math.abs(best - v) ? x : best;
    }, list[0]);
  }

  function withDefaults(stored) {
    var out = {}, k;
    for (k in DEFAULTS) out[k] = DEFAULTS[k];
    if (stored && typeof stored === 'object') {
      for (k in stored) if (stored[k] !== undefined) out[k] = stored[k];
    }
    return out;
  }

  return {
    DEFAULTS: DEFAULTS,
    EYE_LEVELS: EYE_LEVELS,
    RATES: RATES,
    KEYS: KEYS,
    nearest: nearest,
    withDefaults: withDefaults,
    eyeLevel: function (v) { return nearest(EYE_LEVELS, v, DEFAULTS.eyeLevel); },
    rate: function (v) { return nearest(RATES, v, DEFAULTS.playbackRate); }
  };
});
