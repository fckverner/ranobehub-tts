'use strict';
const assert = require('node:assert/strict');
const M = require('../lib/manifest-matcher.js');

// --- нормализация: ё/э → е, латинские двойники → кириллица, пунктуация → пробел
assert.equal(M.norm('Ёлка, Эхо!'), 'елка ехо');
assert.equal(M.norm('Рyдеус'), M.norm('Рудеус'));       // латинская y
assert.equal(M.norm('  — Да.  '), 'да');

// --- слова-зацепки: от 4 букв без повторов, с откатом на короткие
assert.deepEqual(M.wordsOf('Рудеус посмотрел на Рудеус и Сильфиэтту'), ['рудеус', 'посмотрел', 'сильфиетту']);
assert.deepEqual(M.wordsOf('— Да, да.'), ['да']);

// --- выравнивание на «страницу» из фальшивых абзацев (нужен только textContent)
const block = (t) => ({ textContent: t });
const page = [
  'Рудеус проснулся рано утром и посмотрел в окно.',
  'Примечание переводчика: сноска к предыдущему абзацу.',
  'Сильфиэтта уже ждала его во дворе с деревянным мечом.',
  'Они тренировались до самого обеда, пока Зенит не позвала их.'
].map(block);
const segments = [
  'Рудеус проснулся рано утром и посмотрел в окно',
  'Сильфиэтта уже ждала его во дворе с деревянным мечом',
  'Они тренировались до самого обеда пока Зенит не позвала их'
].map(M.wordsOf);

const index = M.buildIndex(page);
const mapping = M.align(index, segments);
assert.deepEqual(mapping.map((m) => m.start), [0, 2, 3]);   // абзац-сноска пропущен
assert.ok(M.alignmentQuality(mapping, segments) > 0.9);

// обратное отображение для «Найти по тексту»
assert.deepEqual(M.blockToSegment(mapping, 2), { i: 1, exact: true });
assert.equal(M.blockToSegment(mapping, 1).i, 1);             // сноска → ближайшая следующая реплика
assert.equal(M.blockToSegment(mapping, 1).exact, false);

// кэш весов живёт в индексе, а не глобально: другой индекс — другие веса
const other = M.buildIndex([block('Рудеус Рудеус'), block('Рудеус ушёл')]);
M.coverage(other, segments[0], 0, 1);
assert.notStrictEqual(other.pre, index.pre);
assert.ok(index.pre[segments[0].join(' ')]);

// --- какая реплика звучит в момент t (с допуском 5 мс)
const manifest = { segments: [{ start_ms: 0 }, { start_ms: 1000 }, { start_ms: 2500 }] };
assert.equal(M.segmentAt(manifest, -10), -1);
assert.equal(M.segmentAt(manifest, 996), 1);
assert.equal(M.segmentAt(manifest, 2499), 2);
assert.equal(M.segmentAt(manifest, 99999), 2);

assert.equal(M.segmentStartSec({ start_ms: 1500 }), 1.5);
assert.equal(M.segmentStartSec({ start: 2 }), 2);
assert.equal(M.segmentStartSec(null), 0);

assert.equal(M.textSignature(page), '4:' + page.reduce((n, b) => n + b.textContent.length, 0));

console.log('extension matcher tests: OK');
