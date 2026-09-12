// Run: node_modules/.bin/electron tests/workspace_layout.electron.cjs
// Exercise the real HTML/CSS in an isolated window without loading user data.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'otomatik-layout-'));
app.setPath('userData', path.join(artifacts, 'profile'));
const template = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
assert.match(template, /href="\/static\/workspace\.css"/, 'Workspace stylesheet must be linked');
const fixture = template.replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi, '');
let window, server;

async function inspect() {
  return window.webContents.executeJavaScript(`(() => {
    const bounds = id => {
      const node = document.getElementById(id), rect = node.getBoundingClientRect();
      return { left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom,
        width:rect.width, height:rect.height, clientHeight:node.clientHeight, scrollHeight:node.scrollHeight };
    };
    return { width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth,
      scrollHeight:document.documentElement.scrollHeight, preview:bounds('preview-panel'),
      shell:bounds('preview-shell'), timeline:bounds('timeline'), timelinePanel:bounds('timeline-panel'),
      library:bounds('project-library'), inspector:bounds('clip-inspector'),
      inspectorBody:bounds('clip-inspector-content'), tools:bounds('asset-editor-content'),
      toolbar: (() => { const bar = document.querySelector('.preview-toolbar');
        return { height:bar.clientHeight, meta:bar.querySelector('.preview-meta').clientHeight,
          rows:[...bar.querySelector('.preview-meta').children].map(el => ({height:el.clientHeight,width:el.clientWidth})) }; })() };
  })()`);
}

app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(fixture); return; }
    if (request.url.startsWith('/static/')) {
      const file=path.resolve(root,'.'+request.url.split('?')[0]);if(!file.startsWith(path.join(root,'static')+path.sep)||!fs.existsSync(file)){response.writeHead(404).end();return}
      response.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript'); response.end(fs.readFileSync(file)); return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show:false, width:1366, height:768, useContentSize:true,
    webPreferences:{ contextIsolation:true, sandbox:true, nodeIntegration:false } });
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('clip-inspector').classList.remove('hidden');
    document.getElementById('timeline-content').style.height = '420px';
    const presets = document.getElementById('text-presets');
    for (let i=0;i<50;i++) presets.append(presets.firstElementChild.cloneNode(true));
  })()`);
  for (const [width, height] of [[1366,768], [1920,1080], [1366,740], [1100,700], [1440,900]]) {
    window.setContentSize(width, height);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const view = await inspect();
    assert.equal(view.width, width);
    assert.ok(view.scrollHeight <= height + 1, `Page scrolls at ${width}: ${JSON.stringify(view)}`);
    assert.ok(view.scrollWidth <= width + 1, `Page overflows horizontally at ${width}`);
    assert.ok(view.shell.height >= 220, `Preview too short: ${view.shell.height}`);
    assert.ok(view.shell.bottom <= view.preview.bottom, `Preview extends into the timeline: ${JSON.stringify(view)}`);
    assert.ok(view.timeline.height >= 200, `Timeline too short: ${view.timeline.height}`);
    assert.ok(view.timeline.bottom <= height, 'Timeline is below the viewport');
    assert.ok(view.preview.bottom <= view.timelinePanel.top, 'Preview overlaps the timeline');
    assert.ok(view.library.right < view.timelinePanel.left, 'Media library must remain beside the timeline');
    assert.ok(view.inspector.left > view.preview.right, 'Inspector must remain beside the preview');
    assert.ok(view.tools.scrollHeight > view.tools.clientHeight, 'Long tools panel must scroll internally');
    fs.writeFileSync(path.join(artifacts, `workspace-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(view));
  }
  window.setContentSize(900, 650);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const small = await inspect();
  assert.ok(small.scrollHeight > small.height, 'Small windows must preserve natural document scrolling');
  console.log(`Workspace layout checks passed. Screenshots: ${artifacts}`);
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  window?.destroy(); server?.close(); app.exit(process.exitCode || 0);
});
