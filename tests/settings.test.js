'use strict';
const assert = require('node:assert/strict');
const S = require('../lib/settings.js');

assert.equal(S.eyeLevel(22), 15);
assert.equal(S.eyeLevel(40), 34);
assert.equal(S.eyeLevel('50'), 50);
assert.equal(S.eyeLevel(undefined), S.DEFAULTS.eyeLevel);
assert.equal(S.eyeLevel('abc'), S.DEFAULTS.eyeLevel);
assert.equal(S.rate(1.1), 1);
assert.equal(S.rate(1.3), 1.25);
assert.equal(S.rate(null), 1);

const merged = S.withDefaults({ magnet: false, extra: 1, volume: undefined });
assert.equal(merged.magnet, false);
assert.equal(merged.volume, 1);
assert.equal(merged.extra, 1);
assert.equal(merged.autoNext, true);
assert.ok(Object.isFrozen(S.DEFAULTS));

console.log('extension settings tests: OK');
