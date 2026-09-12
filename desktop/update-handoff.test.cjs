'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateHandoff } = require('./update-handoff.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}) {
  const calls = [], events = [];
  const handoff = new UpdateHandoff({ busy: () => '', prepareBackend: async () => { calls.push('gate'); return { update_ready: true }; }, cancelBackend: async () => calls.push('ungate'), send: (...args) => events.push(args), flushRecovery: async () => calls.push('recovery'), stopBackend: async () => calls.push('stop'), launchInstaller: async () => calls.push('install'), recoverBackend: async () => calls.push('restart-old'), ...overrides });
  return { handoff, calls, events };
}
test('handshake saves before backend stop and installer, ignores foreign/stale ack', async () => {
  const h = harness();
  const ready = h.handoff.prepare(); await settle();
  h.handoff.acknowledge(999); await settle();
  assert.deepEqual(h.calls, ['gate']);
  h.handoff.acknowledge(h.handoff.attempt);
  assert.deepEqual(await ready, { ready: true });
  await h.handoff.install();
  assert.deepEqual(h.calls, ['gate', 'recovery', 'stop', 'install']);
});
test('native save and backend jobs prevent preparation and never stop work', async () => {
  for (const overrides of [{ busy: () => 'Saving' }, { prepareBackend: async () => ({ update_ready: false }) }]) {
    const h = harness(overrides);
    assert.equal((await h.handoff.prepare()).ready, false);
    assert.equal(h.calls.includes('stop'), false);
    assert.equal(h.handoff.active, false);
  }
});
test('native save race during acknowledgement cancels gate and resumes editing', async () => {
  const h = harness();
  const preparing = h.handoff.prepare(); await settle();
  const attempt = h.handoff.attempt;
  h.handoff.interrupt();
  assert.equal((await preparing).ready, false);
  h.handoff.acknowledge(attempt);
  assert.deepEqual(h.calls, ['gate', 'ungate']);
  assert.deepEqual(h.events.at(-1), ['desktop:update-cancelled', attempt]);
});
test('native save race during durable recovery also cancels installation', async () => {
  let release, busy = '';
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ busy: () => busy, flushRecovery: () => pending });
  const preparing = h.handoff.prepare(); await settle();
  h.handoff.acknowledge(h.handoff.attempt); await settle();
  busy = 'Saving'; release();
  assert.equal((await preparing).ready, false);
  assert.equal(h.calls.includes('stop'), false);
});
test('renderer busy retries safely; recovery failure is an error, both release gate', async () => {
  for (const busy of [true, false]) {
    const h = harness();
    const preparing = h.handoff.prepare(); await settle();
    h.handoff.acknowledge(h.handoff.attempt, 'Not ready', busy);
    if (busy) assert.equal((await preparing).ready, false);
    else await assert.rejects(preparing, /Not ready/);
    assert.equal(h.handoff.active, false);
    assert.equal(h.calls.includes('ungate'), true);
    assert.equal(h.calls.includes('stop'), false);
  }
});
test('failed installer restarts old backend without abandoning project', async () => {
  const h = harness({ launchInstaller: async () => { throw new Error('Installer refused'); } });
  const preparing = h.handoff.prepare(); await settle(); h.handoff.acknowledge(h.handoff.attempt); await preparing;
  await assert.rejects(h.handoff.install(), /Installer refused/);
  assert.deepEqual(h.calls, ['gate', 'recovery', 'stop', 'restart-old', 'ungate']);
  assert.equal(h.handoff.active, false);
});
test('unknown backend state fails closed; cancellation still unfreezes editor', async () => {
  const h = harness({ prepareBackend: async () => { throw new Error('Network down'); } });
  await assert.rejects(h.handoff.prepare(), /Network down/);
  assert.equal(h.calls.includes('stop'), false);
  assert.equal(h.handoff.active, false);
});
test('partly completed shutdown is recovered even when the stop promise rejects', async () => {
  const h = harness({ stopBackend: async () => { throw new Error('taskkill response lost'); } });
  const preparing = h.handoff.prepare(); await settle(); h.handoff.acknowledge(h.handoff.attempt); await preparing;
  await assert.rejects(h.handoff.install(), /taskkill response lost/);
  assert.equal(h.calls.includes('restart-old'), true);
  assert.equal(h.calls.includes('install'), false);
  assert.equal(h.handoff.active, false);
});
test('unknown cancellation state propagates an explicit error and cannot install', async () => {
  const error = new Error('Gate still unknown'); error.userMessage = 'Restart required';
  const h = harness({ prepareBackend: async () => ({ update_ready: false }), cancelBackend: async () => { throw error; } });
  await assert.rejects(h.handoff.prepare(), { userMessage: 'Restart required' });
  assert.equal(h.calls.includes('install'), false);
  assert.equal(h.handoff.active, false);
});
test('even a completed native save invalidates a recovery already in progress', async () => {
  let release, busy = '';
  const recovery = new Promise(resolve => { release = resolve; });
  const h = harness({ busy: () => busy, flushRecovery: () => recovery });
  const preparing = h.handoff.prepare(); await settle();
  h.handoff.acknowledge(h.handoff.attempt); await settle();
  busy = 'Saving'; h.handoff.interrupt(); busy = ''; // Finished before fsync did.
  release();
  assert.equal((await preparing).ready, false);
  assert.equal(h.calls.includes('stop'), false);
  assert.equal(h.calls.includes('ungate'), true);
});
test('native save during backend gate acquisition cancels before freezing renderer', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ prepareBackend: () => gate });
  const preparing = h.handoff.prepare(); await settle();
  h.handoff.interrupt();
  release({ update_ready: true });
  assert.equal((await preparing).ready, false);
  assert.equal(h.events.some(([name]) => name === 'desktop:prepare-update'), false);
  assert.equal(h.calls.includes('ungate'), true);
  assert.equal(h.calls.includes('stop'), false);
});
