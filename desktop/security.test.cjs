const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalURL, validateRecovery, MAX_RECOVERY_BYTES } = require('./security.cjs');
test('only the exact private backend origin is trusted', () => {
  const origin = 'http://127.0.0.1:4242';
  assert.equal(isLocalURL(origin + '/projects', origin), true);
  for (const url of ['http://127.0.0.1:4243', 'http://localhost:4242', 'https://evil.example', 'file:///tmp/test', 'http://127.0.0.1:4242.evil.example', 'invalid']) {
    assert.equal(isLocalURL(url, origin), false, url);
  }
  assert.equal(isLocalURL(origin, ''), false);
});
test('recovery payload must be bounded JSON object', () => {
  assert.equal(validateRecovery('{"name":"Türkçe proje"}'), '{"name":"Türkçe proje"}');
  for (const bad of [null, {}, 'broken', 'null', '[]', '3', 'x'.repeat(MAX_RECOVERY_BYTES + 1)]) {
    assert.throws(() => validateRecovery(bad));
  }
});
