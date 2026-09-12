'use strict';
// Real N -> N+1 NSIS installation, download and automatic relaunch, restricted
// to disposable GitHub Windows runners. No production updater feed is changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function previousVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, 'Update fixture requires a stable version');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  assert.ok(major > 0, 'No stable predecessor of 0.0.0');
  return `${major - 1}.0.0`;
}

function configForBuild(config, version, output) {
  // electron-builder normalizes nested files arrays in place. Each version
  // must receive its own complete copy, not a shared array via object spread.
  return { ...structuredClone(config), extraMetadata: { version }, directories: { output } };
}

function proofFileForEnvironment(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.ok(env.RUNNER_TEMP && path.isAbsolute(env.RUNNER_TEMP));
  assert.match(env.GITHUB_RUN_ID || '', /^\d+$/);
  assert.match(env.GITHUB_RUN_ATTEMPT || '', /^\d+$/);
  return path.join(env.RUNNER_TEMP, `windows-update-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.json`);
}

function validateProof(proof, version) {
  assert.equal(proof.ok, true, proof.message);
  assert.equal(proof.previousVersion, previousVersion(version));
  assert.equal(proof.version, version);
  assert.equal(proof.autoRelaunched, true);
  assert.equal(proof.recoveryPreserved, true);
  assert.equal(proof.mediaPreserved, true);
  assert.ok(Array.isArray(proof.requests));
  assert.ok(proof.requests.includes('latest.yml'));
  assert.ok(proof.requests.includes(`UpdateFixture-${version}-win-x64.exe`));
  return proof;
}

async function verifyProof() {
  // This entry runs in a fresh process that never imports electron-builder.
  // CI cannot pass on a swallowed exit code without the successful proof.
  const file = proofFileForEnvironment();
  const proof = validateProof(JSON.parse(await fsp.readFile(file, 'utf8')), require('../package.json').version);
  assert.equal(path.dirname(proof.fixtureRoot).toLowerCase(), path.resolve(process.env.RUNNER_TEMP).toLowerCase());
  assert.ok(path.basename(proof.fixtureRoot).startsWith('otomatik-update-'));
  assert.equal(path.dirname(proof.installPath).toLowerCase(), path.join(proof.fixtureRoot, 'installed').toLowerCase());
  console.log(`Verified independent installed-update proof: ${JSON.stringify(proof)}`);
}

function reportFailure(error) {
  console.error(error);
  process.exitCode = 1;
  // Builder cleanup hooks can replace a previously assigned exitCode.
  // Its own CLI pins failure in an exit listener for this same reason.
  process.on('exit', () => { process.exitCode = 1; });
}

async function execute(file, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', windowsHide: true, ...options });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Command timed out: ${path.basename(file)}`)); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)); });
  });
}

async function waitForFile(file, timeout = 180000, readContents = true) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return readContents ? await fsp.readFile(file, 'utf8') : await fsp.stat(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Update fixture did not produce ${path.basename(file)}`);
}

async function main() {
  if (process.platform !== 'win32') { console.log('Real NSIS update smoke runs on Windows CI only.'); return; }
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Do not install test applications outside a disposable CI runner');
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  const proofFile = proofFileForEnvironment();
  assert.equal(fs.existsSync(proofFile), false, 'A stale proof must never validate this test run');
  const repository = path.resolve(__dirname, '..');
  const metadata = require(path.join(repository, 'package.json'));
  const nextVersion = metadata.version;
  const oldVersion = previousVersion(nextVersion);
  const root = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP, 'otomatik-update-'));
  const sourceDir = path.join(root, 'source');
  const installDir = path.join(root, 'installed');
  const outputDir = path.join(root, 'new');
  const nonce = crypto.randomUUID();
  const requests = [];
  let oldProcess;
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
    requests.push(name);
    const allowed = ['latest.yml', `UpdateFixture-${nextVersion}-win-x64.exe`, `UpdateFixture-${nextVersion}-win-x64.exe.blockmap`];
    if (!allowed.includes(name)) { response.writeHead(404).end(); return; }
    const file = path.join(outputDir, name);
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream', 'Content-Length': stat.size });
      fs.createReadStream(file).on('error', () => response.destroy()).pipe(response);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fsp.mkdir(sourceDir);
    await fsp.mkdir(path.join(root, 'project-data', 'uploads'), { recursive: true });
    await fsp.mkdir(path.join(root, 'user-data'));
    await fsp.writeFile(path.join(root, '.update-fixture'), nonce);
    const media = Buffer.from('Original media retained across the real NSIS update.');
    await fsp.writeFile(path.join(root, 'project-data', 'uploads', 'fixture-media.bin'), media);
    await fsp.writeFile(path.join(root, 'project-data', 'recovery.json'), JSON.stringify({ id: nonce, name: 'Before update', timelines: [] }));
    const fixturePackage = { name: `otomatik-edit-update-fixture-${nonce}`, version: nextVersion,
      description: 'Disposable Windows updater integration fixture', author: metadata.author,
      main: 'main.cjs', private: true, dependencies: metadata.dependencies };
    await fsp.writeFile(path.join(sourceDir, 'package.json'), JSON.stringify(fixturePackage));
    const lock = JSON.parse(await fsp.readFile(path.join(repository, 'package-lock.json'), 'utf8'));
    lock.name = fixturePackage.name;
    lock.version = nextVersion;
    lock.packages[''] = { name: fixturePackage.name, version: nextVersion, dependencies: metadata.dependencies };
    await fsp.writeFile(path.join(sourceDir, 'package-lock.json'), JSON.stringify(lock));
    await fsp.copyFile(path.join(repository, 'scripts', 'fixtures', 'windows-update-main.cjs'), path.join(sourceDir, 'main.cjs'));
    await fsp.copyFile(path.join(repository, 'desktop', 'updater.cjs'), path.join(sourceDir, 'updater.cjs'));
    const feedURL = `http://127.0.0.1:${server.address().port}/`;
    await fsp.writeFile(path.join(sourceDir, 'fixture-config.json'), JSON.stringify({ root, nonce, previousVersion: oldVersion,
      nextVersion, feedURL, mediaHash: crypto.createHash('sha256').update(media).digest('hex') }));
    // npm is launched through Node so Windows .cmd quoting cannot affect paths.
    const npmCLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await execute(process.execPath, [npmCLI, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit'], { cwd: sourceDir });
    const { build, Platform, Arch } = require('electron-builder');
    const config = {
      appId: `com.davutcan.otomatikedit.updatefixture.${nonce}`, productName: 'Otomatik Edit Update Test',
      artifactName: 'UpdateFixture-${version}-${os}-${arch}.${ext}',
      // Use the same package-locked runtime as the production build. Let the
      // builder resolve/download it: modern Electron packages need not contain
      // node_modules/electron/dist, even after a successful production build.
      electronVersion: require('electron/package.json').version,
      files: ['*.cjs', 'fixture-config.json', 'package.json'], asar: true, npmRebuild: false,
      publish: { provider: 'generic', url: feedURL },
      win: { target: [{ target: 'nsis', arch: ['x64'] }], executableName: 'OtomatikEditUpdateTest', icon: path.join(repository, 'desktop', 'assets', 'icon.ico') },
      nsis: { oneClick: false, perMachine: false, runAfterFinish: false, createDesktopShortcut: false,
        createStartMenuShortcut: false, deleteAppDataOnUninstall: false },
    };
    for (const [version, folder] of [[oldVersion, 'old'], [nextVersion, 'new']]) {
      await build({ projectDir: sourceDir, publish: 'never', targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        config: configForBuild(config, version, path.join(root, folder)) });
    }
    const oldInstaller = path.join(root, 'old', `UpdateFixture-${oldVersion}-win-x64.exe`);
    await execute(oldInstaller, ['/S', '/currentuser', `/D=${installDir}`]);
    const installed = path.join(installDir, 'OtomatikEditUpdateTest.exe');
    await waitForFile(installed, 60000, false);
    oldProcess = spawn(installed, [], { stdio: 'ignore', windowsHide: true });
    oldProcess.once('error', error => console.error(error));
    const result = JSON.parse(await waitForFile(path.join(root, 'result.json'), 240000));
    const proof = validateProof({ ...result, fixtureRoot: root, requests }, nextVersion);
    // Exclusive creation prevents a different/stale invocation replacing proof.
    await fsp.writeFile(proofFile, JSON.stringify(proof), { flag: 'wx' });
    console.log(JSON.stringify(proof));
  } catch (error) {
    console.error(`Windows update fixture retained for diagnostics: ${root}`);
    console.error(await fsp.readFile(path.join(root, 'events.jsonl'), 'utf8').catch(() => 'No fixture events yet.'));
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try {
      const running = JSON.parse(await fsp.readFile(path.join(root, 'running.json'), 'utf8'));
      if (Number.isSafeInteger(running.pid) && running.pid > 0) {
        await execute('taskkill', ['/PID', String(running.pid), '/T', '/F'], { stdio: 'ignore' }).catch(() => {});
      }
    } catch { if (oldProcess?.pid) oldProcess.kill(); }
    const uninstaller = (await fsp.readdir(installDir).catch(() => []))
      .find(name => name.startsWith('Uninstall ') && name.endsWith('.exe'));
    if (uninstaller) await execute(path.join(installDir, uninstaller), ['/S', '/currentuser']).catch(error => console.warn(error.message));
  }
}

if (require.main === module) (process.argv.includes('--verify-proof') ? verifyProof() : main()).catch(reportFailure);
module.exports = { previousVersion, configForBuild, proofFileForEnvironment, validateProof, reportFailure };
