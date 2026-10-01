'use strict';
const assert = require('node:assert/strict');
const Cloud = require('../lib/cloud.js');
const Conf = require('../lib/cloud-config.js');


const Meta = require('../lib/chapter-meta.js');
const parsed = Meta.fromUrl('https://ranobehub.org/ranobe/168-reincarnation-of-the-unemployed/chapter/32056');
assert.deepEqual(parsed, {
  chapter_id: '32056',
  book_id: '168',
  book_slug: 'reincarnation-of-the-unemployed'
});
assert.equal(Meta.bookFolder(parsed), '168');

const meta = { book_id: '168', chapter_id: '115721', book_slug: 'changed-slug', volume: '18' };
assert.equal(Cloud.PROTOCOL, 'ranobe-hub-tts-v3');
assert.equal(Cloud.VERSION, 3);
assert.equal(Conf.protocol, Cloud.PROTOCOL);
assert.equal(Conf.version, Cloud.VERSION);

assert.equal(Cloud.bookIndexRelative(meta), 'books/168/index.json');
assert.deepEqual(Cloud.expectedPaths(meta), {
  audio: 'books/168/chapters/115721/audio.mp3',
  manifest: 'books/168/chapters/115721/manifest.json',
});
assert.deepEqual(Cloud.expectedIndexPaths(meta), {
  audio: 'chapters/115721/audio.mp3',
  manifest: 'chapters/115721/manifest.json',
});
assert.equal(
  Cloud.bookIndexUrl(Conf, meta),
  'https://huggingface.co/datasets/akir21518/ranobe-audio/resolve/main/books/168/index.json'
);

const indexUrl = Cloud.bookIndexUrl(Conf, meta);
const index = {
  version: 3,
  protocol: 'ranobe-hub-tts-v3',
  book: { book_id: '168', title: 'Book' },
  chapters: {
    '115721': {
      book_id: '168', chapter_id: '115721',
      audio: 'chapters/115721/audio.mp3',
      manifest: 'chapters/115721/manifest.json'
    }
  }
};
const found = Cloud.fromBookIndex(index, meta, Conf.baseUrl);
assert.equal(found.error, undefined);
assert.equal(
  found.audioUrl,
  'https://huggingface.co/datasets/akir21518/ranobe-audio/resolve/main/books/168/chapters/115721/audio.mp3'
);
assert.equal(
  found.manifestUrl,
  'https://huggingface.co/datasets/akir21518/ranobe-audio/resolve/main/books/168/chapters/115721/manifest.json'
);

// Slug/title/volume changes must not move the storage location.
const renamed = { ...meta, book_slug: 'another-slug', volume: '19' };
assert.equal(Cloud.bookIndexRelative(renamed), Cloud.bookIndexRelative(meta));
assert.deepEqual(Cloud.expectedPaths(renamed), Cloud.expectedPaths(meta));

console.log('extension cloud protocol tests: OK');

assert.equal(Meta.nextChapterUrl('https://ranobehub.org/ranobe/168-slug/chapter/115721'),
             'https://ranobehub.org/ranobe/168-slug/chapter/115722');
assert.equal(Meta.nextChapterUrl('https://ranobehub.org/ranobe/168/chapter/9?x=1'),
             'https://ranobehub.org/ranobe/168/chapter/10');
assert.equal(Meta.nextChapterUrl('https://ranobehub.org/ranobe/168'), '');

// --- index.json: подсчёт глав
assert.equal(Cloud.chapterCount(index), 1);
assert.equal(Cloud.chapterCount({ chapters: {} }), 0);
assert.equal(Cloud.chapterCount({ chapters: [] }), 0);
assert.equal(Cloud.chapterCount(null), 0);

// --- manifest.json: проверка идентичности
const goodManifest = { protocol: 'ranobe-hub-tts-v3', book_id: '168', chapter_id: '115721',
                       audio: 'audio.mp3', segments: [] };
assert.deepEqual(Cloud.validateManifest(goodManifest, meta), { ok: true });
assert.equal(Cloud.validateManifest({ ...goodManifest, audio: undefined }, meta).ok, true);
assert.equal(Cloud.validateManifest({ ...goodManifest, protocol: 'v2' }, meta).ok, false);
assert.equal(Cloud.validateManifest({ ...goodManifest, chapter_id: '1' }, meta).ok, false);
assert.equal(Cloud.validateManifest({ ...goodManifest, book_id: '' }, meta).ok, false);
assert.equal(Cloud.validateManifest({ ...goodManifest, audio: 'other.mp3' }, meta).ok, false);
assert.equal(Cloud.validateManifest({ ...goodManifest, segments: null }, meta).ok, false);
assert.equal(Cloud.validateManifest(null, meta).ok, false);

// --- сгенерированный cloud-config.js не должен расходиться с cloud.js
assert.deepEqual(Conf.storage, Cloud.NAMES);

console.log('extension cloud manifest tests: OK');
