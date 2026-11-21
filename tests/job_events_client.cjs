'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const start = template.indexOf('    function events(id,handle)');
const end = template.indexOf('\n    }', start) + '\n    }'.length;
assert.ok(start >= 0 && end > start);

test('heartbeats extend job deadline, but repeated disconnects without events cannot hang', async () => {
  const timers = new Map();
  const instances = [];
  let nextTimer = 0;

  class EventSource {
    static CLOSED = 2;
    constructor() {
      this.handlers = new Map();
      this.readyState = 0;
      this.closed = false;
      instances.push(this);
    }
    addEventListener(event, handler) { this.handlers.set(event, handler); }
    close() { this.closed = true; }
  }

  const context = vm.createContext({
    EventSource,
    setTimeout: (callback, timeout) => {
      assert.equal(timeout, 45_000);
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(template.slice(start, end), context);
  const result = context.events('job', () => assert.fail('Heartbeat reached the job handler'));
  const expired = assert.rejects(result, /İş durumuna ulaşılamadı/);
  const [stream] = instances;
  stream.onerror();
  stream.onerror();
  assert.equal(instances.length, 1);
  assert.equal(stream.closed, false);
  assert.deepEqual([...timers.keys()], [1]);

  stream.handlers.get('heartbeat')();
  assert.deepEqual([...timers.keys()], [2]);
  stream.onerror();
  timers.get(2)();
  await expired;
  assert.equal(stream.closed, true);
  assert.equal(timers.size, 0);
});
