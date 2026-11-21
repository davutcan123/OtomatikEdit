'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
const start = template.indexOf('    function events(id,handle)');
const end = template.indexOf('\n    }', start) + '\n    }'.length;
assert.ok(start >= 0 && end > start);
const events = template.slice(start, end);

function jobEvent(id, data) {
  return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

app.whenReady().then(async () => {
  const reconnectIds = [], restartIds = [];
  const server = http.createServer((request, response) => {
    switch (request.url) {
      case '/':
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><title>SSE fixture</title><script>${events}</script>`);
        break;
      case '/stream-events/reconnect':
        reconnectIds.push(request.headers['last-event-id'] ?? null);
        if (reconnectIds.length === 2) {
          response.destroy();
          break;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (reconnectIds.length === 1) {
          response.end('retry: 40\n\n' +
            jobEvent(1, { type: 'progress', percent: 12 }) +
            jobEvent(2, { type: 'log', message: 'Rendering' }));
        } else {
          // A duplicate from a replay still must not run the handler twice.
          response.end(jobEvent(2, { type: 'log', message: 'Rendering' }) +
            jobEvent(3, { type: 'result', download_url: '/download/reconnect/mp4' }));
        }
        break;
      case '/stream-events/restarted':
        restartIds.push(request.headers['last-event-id'] ?? null);
        if (restartIds.length === 1) {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end('retry: 40\n\n' + jobEvent(1, { type: 'progress', percent: 20 }));
        } else {
          response.writeHead(404).end();
        }
        break;
      case '/stream-events/failed':
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(jobEvent(1, { type: 'error', message: 'Fixture error' }));
        break;
      default:
        response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false });
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const handled = [];
      const output = await events('reconnect', message => handled.push(message.type));
      const terminal = await events('failed', message => handled.push(message.type))
        .then(() => null, error => error.message);
      const expired = await events('expired', () => {})
        .then(() => null, error => error.message);
      const restarted = await events('restarted', () => {})
        .then(() => null, error => error.message);
      return { handled, output, terminal, expired, restarted };
    })()`);
    assert.deepEqual(reconnectIds, [null, '2', '2']);
    assert.deepEqual(restartIds, [null, '1']);
    assert.deepEqual(result.handled, ['progress', 'log', 'result', 'error']);
    assert.equal(result.output.download_url, '/download/reconnect/mp4');
    assert.equal(result.terminal, 'Fixture error');
    assert.match(result.expired, /süresi dolmuş/);
    assert.match(result.restarted, /süresi dolmuş/);
    console.log('Native EventSource resumed from the last received ID, retained the result and reported terminal errors.');
  } finally {
    window.destroy();
    server.closeAllConnections();
    server.close();
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
