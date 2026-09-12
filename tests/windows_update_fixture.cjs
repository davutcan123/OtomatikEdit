'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config');
const fixturePath = path.resolve(__dirname, '../scripts/windows_update_smoke.cjs');
const { previousVersion, configForBuild, proofFileForEnvironment, validateProof } = require(fixturePath);

test('repeated fixture builds cannot share arrays mutated by electron-builder', () => {
  const original = { files: ['*.cjs', 'fixture-config.json', 'package.json'], win: { target: [{ target: 'nsis', arch: ['x64'] }] } };
  const expected = structuredClone(original);
  const first = configForBuild(original, '1.1.1', 'old');
  const second = configForBuild(original, '1.1.2', 'new');
  doMergeConfigs([first]);
  assert.doesNotThrow(() => doMergeConfigs([second]));
  assert.deepEqual(original, expected);
  assert.notEqual(first.win.target, second.win.target);
  assert.equal(first.extraMetadata.version, '1.1.1');
  assert.equal(second.extraMetadata.version, '1.1.2');
});

test('fixture failures remain nonzero even when builder cleanup changes exitCode', () => {
  const code = `process.on('exit', () => { process.exitCode = 0; });
    require(${JSON.stringify(fixturePath)}).reportFailure(new Error('Expected fixture failure'));`;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected fixture failure/);
});

test('independent fixture proof requires downloaded installer, relaunch and retained data', () => {
  const good = { ok: true, previousVersion: '1.1.1', version: '1.1.2', autoRelaunched: true,
    recoveryPreserved: true, mediaPreserved: true, requests: ['latest.yml', 'UpdateFixture-1.1.2-win-x64.exe'] };
  assert.doesNotThrow(() => validateProof(good, '1.1.2'));
  for (const field of ['ok', 'autoRelaunched', 'recoveryPreserved', 'mediaPreserved']) {
    assert.throws(() => validateProof({ ...good, [field]: false }, '1.1.2'));
  }
  assert.throws(() => validateProof({ ...good, requests: ['latest.yml'] }, '1.1.2'));
  assert.throws(() => validateProof({ ...good, version: '1.1.1' }, '1.1.2'));
  assert.equal(previousVersion('2.0.0'), '1.0.0');
});

test('fixture proof path is isolated to this numeric CI run and attempt', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_TEMP: os.tmpdir(), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  assert.equal(proofFileForEnvironment(env), path.join(os.tmpdir(), 'windows-update-123-2.json'));
  assert.throws(() => proofFileForEnvironment({ ...env, GITHUB_RUN_ID: '../123' }));
  assert.throws(() => proofFileForEnvironment({ ...env, GITHUB_ACTIONS: '' }));
});

test('fresh proof-validation process fails closed when no proof exists', () => {
  const result = spawnSync(process.execPath, [fixturePath, '--verify-proof'], { encoding: 'utf8', env: {
    ...process.env, GITHUB_ACTIONS: 'true', RUNNER_TEMP: os.tmpdir(),
    GITHUB_RUN_ID: String(Date.now()), GITHUB_RUN_ATTEMPT: String(process.pid),
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});
