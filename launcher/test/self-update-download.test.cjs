const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSelfUpdateDownloader } = require('../self-update-download.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencodex-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installer = Buffer.from('MZ fixture executable bytes');
  const manifest = { schemaVersion: 1, appId: 'dev.opencodex.launcher', version: '2.2.0', platform: 'win32', arch: 'x64',
    installer: { name: 'OpenCodex Setup 2.2.0.exe', size: installer.length, sha256: sha(installer) }, commit: 'a'.repeat(40) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const asset = (name, bytes) => ({ name, size: bytes.length, sha256: sha(bytes), url: `https://github.com/Wolf-L/OpenCodex/releases/download/v2.2.0/${encodeURIComponent(name)}` });
  const candidate = { tagName: 'v2.2.0', version: '2.2.0', installer: asset(manifest.installer.name, installer), manifest: asset('opencodex-update-win32-x64.json', manifestBytes) };
  const calls = [], states = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(url.endsWith('.json') ? manifestBytes : installer); };
  const updater = createSelfUpdateDownloader({ root: path.join(root, 'downloads'), currentVersion: '2.1.0', fetchImpl,
    onState: state => states.push(state), ...options });
  return { root, installer, manifest, manifestBytes, candidate, calls, states, updater };
}

test('streams verified package, exposes only public progress and verifies ready again', async t => {
  const f = await fixture(t); const result = await f.updater.download(f.candidate);
  assert.equal(result.status, 'ready'); assert.equal(result.progress.percent, 100);
  assert.equal(JSON.stringify(result).includes(f.root), false); assert.equal(JSON.stringify(result).includes('https:'), false);
  assert.deepEqual(await fs.readFile(f.updater.prepared().installerPath), f.installer);
  assert.equal((await f.updater.verifyPrepared()).targetVersion, '2.2.0');
  assert.equal(f.calls.every(c => c.init.redirect === 'manual' && !c.init.headers.authorization), true);
  const exposed = f.updater.prepared(); exposed.sha256 = '0'.repeat(64);
  assert.equal(f.updater.prepared().sha256, sha(f.installer));
});

test('GitHub dot-named asset downloads with the original exact build manifest and hash', async t => {
  const f = await fixture(t);
  f.candidate.installer.name = 'OpenCodex.Setup.2.2.0.exe';
  f.candidate.installer.url = 'https://github.com/Wolf-L/OpenCodex/releases/download/v2.2.0/OpenCodex.Setup.2.2.0.exe';
  assert.equal((await f.updater.download(f.candidate)).status, 'ready');
  assert.equal(f.calls[1].url, f.candidate.installer.url);
  assert.deepEqual(await fs.readFile(f.updater.prepared().installerPath), f.installer);
  assert.equal((await f.updater.verifyPrepared()).sha256, sha(f.installer));
});

test('dot-name compatibility does not relax name, URL, version, size or digest validation', async t => {
  const f = await fixture(t);
  const candidate = structuredClone(f.candidate);
  candidate.installer.name = 'OpenCodex.Setup.2.2.0.exe';
  candidate.installer.url = 'https://github.com/Wolf-L/OpenCodex/releases/download/v2.2.0/OpenCodex.Setup.2.2.0.exe';
  for (const name of ['OpenCodex.Setup.2.3.0.exe', 'OpenCodex_Setup_2.2.0.exe', '../OpenCodex.Setup.2.2.0.exe', 'opencodex.setup.2.2.0.exe']) {
    await assert.rejects(f.updater.download({ ...candidate, installer: { ...candidate.installer, name } }));
  }
  await assert.rejects(f.updater.download({ ...candidate, installer: { ...candidate.installer, url: f.candidate.installer.url } }));
  assert.equal(f.calls.length, 0);
  for (const patch of [{ name: '../OpenCodex Setup 2.2.0.exe' }, { name: 'OpenCodex Setup 2.3.0.exe' }, { name: 'OpenCodex_Setup_2.2.0.exe' }, { size: f.installer.length + 1 }, { sha256: '0'.repeat(64) }]) {
    const manifest = structuredClone(f.manifest);
    Object.assign(manifest.installer, patch);
    const bytes = Buffer.from(JSON.stringify(manifest));
    const invalid = { ...candidate, manifest: { ...candidate.manifest, size: bytes.length, sha256: sha(bytes) } };
    const updater = createSelfUpdateDownloader({ root: path.join(f.root, crypto.randomUUID()), currentVersion: '2.1.0', fetchImpl: async () => new Response(bytes) });
    await assert.rejects(updater.download(invalid));
    assert.equal(updater.prepared(), null);
  }
});

test('rejects release identity and version confusion before making requests', async t => {
  const f = await fixture(t);
  for (const mutate of [c => c.version = '2.1.0', c => c.tagName = 'v2.3.0', c => c.installer.name = '../evil.exe',
    c => c.installer.url = c.installer.url.replace('Wolf-L', 'evil'), c => c.manifest = null, c => c.installer.size = 2 ** 30 + 1]) {
    const candidate = structuredClone(f.candidate); mutate(candidate);
    await assert.rejects(f.updater.download(candidate));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.updater.prepared(), null);
});

test('rejects manifest platform, identity, size and hash mismatches', async t => {
  const f = await fixture(t);
  for (const mutate of [m => m.platform = 'linux', m => m.appId = 'evil', m => m.version = '2.3.0', m => m.installer.size++,
    m => m.installer.sha256 = '0'.repeat(64), m => m.extra = true]) {
    const manifest = structuredClone(f.manifest); mutate(manifest); const bytes = Buffer.from(JSON.stringify(manifest));
    const candidate = structuredClone(f.candidate); candidate.manifest.size = bytes.length; candidate.manifest.sha256 = sha(bytes);
    const updater = createSelfUpdateDownloader({ root: path.join(f.root, crypto.randomUUID()), currentVersion: '2.1.0', fetchImpl: async () => new Response(bytes) });
    await assert.rejects(updater.download(candidate)); assert.equal(updater.prepared(), null);
  }
});

test('rejects truncated, excessive, changed and non-PE installer bytes', async t => {
  const f = await fixture(t);
  for (const bytes of [f.installer.subarray(0, 4), Buffer.concat([f.installer, Buffer.from('x')]), Buffer.from('MZ' + 'x'.repeat(f.installer.length - 2)), Buffer.from('ZZ' + 'x'.repeat(f.installer.length - 2))]) {
    const root = path.join(f.root, crypto.randomUUID());
    const updater = createSelfUpdateDownloader({ root, currentVersion: '2.1.0', fetchImpl: async url => new Response(url.endsWith('.json') ? f.manifestBytes : bytes) });
    await assert.rejects(updater.download(f.candidate)); assert.equal(updater.prepared(), null);
    const files = await fs.readdir(root, { recursive: true }); assert.equal(files.some(name => name.endsWith('.part') || name.endsWith('.exe')), false);
  }
});

test('cancel aborts pending request, retry starts a clean request, and concurrent call shares one operation', async t => {
  const f = await fixture(t); let block = true, calls = 0;
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const updater = createSelfUpdateDownloader({ root: path.join(f.root, 'retry'), currentVersion: '2.1.0', fetchImpl: async url => {
    calls++; requestStarted(); if (block) return new Promise(() => {}); return new Response(url.endsWith('.json') ? f.manifestBytes : f.installer);
  } });
  const first = updater.download(f.candidate), concurrent = updater.download(f.candidate);
  // 等待真实请求进入夹具再取消，避免磁盘调度较慢时固定睡眠先于请求结束。
  await started; updater.cancel();
  assert.equal((await first).status, 'cancelled'); await concurrent; assert.equal(calls, 1);
  block = false; await updater.download(f.candidate); assert.equal(updater.state().status, 'ready'); assert.equal(calls, 3);
});

test('rejects untrusted redirects and accepts only bounded HTTPS asset redirects', async t => {
  const f = await fixture(t);
  for (const location of ['http://release-assets.githubusercontent.com/test', 'https://localhost/test', 'https://github.com/evil/test', 'https://release-assets.githubusercontent.com.evil.test/test']) {
    const updater = createSelfUpdateDownloader({ root: path.join(f.root, crypto.randomUUID()), currentVersion: '2.1.0', fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) });
    await assert.rejects(updater.download(f.candidate));
  }
  let requests = 0;
  const updater = createSelfUpdateDownloader({ root: path.join(f.root, 'redirect'), currentVersion: '2.1.0', fetchImpl: async url => {
    requests++;
    if (url.includes('github.com/')) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/file?manifest=${url.endsWith('.json')}` } });
    return new Response(url.endsWith('true') ? f.manifestBytes : f.installer);
  } });
  await updater.download(f.candidate); assert.equal(requests, 4);
});

test('total and stalled requests time out even when injected fetch ignores abort', async t => {
  const f = await fixture(t);
  for (const mode of ['request', 'body']) {
    const updater = createSelfUpdateDownloader({ root: path.join(f.root, mode), currentVersion: '2.1.0', timeoutMs: 100, stallTimeoutMs: 30,
      fetchImpl: async () => mode === 'request' ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} })) });
    await assert.rejects(updater.download(f.candidate), /超时/); assert.equal(updater.state().status, 'error');
  }
});

test('insufficient disk space and linked root fail before networking', async t => {
  const f = await fixture(t);
  const low = createSelfUpdateDownloader({ root: path.join(f.root, 'low'), currentVersion: '2.1.0', statfsImpl: async () => ({ bsize: 1, bavail: 1 }), fetchImpl: async () => { throw new Error('network should not run'); } });
  await assert.rejects(low.download(f.candidate), /空间/);
  const destination = path.join(f.root, 'destination'); await fs.mkdir(destination);
  const link = path.join(f.root, 'linked'); await fs.symlink(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = createSelfUpdateDownloader({ root: link, currentVersion: '2.1.0', fetchImpl: async () => { throw new Error('network should not run'); } });
  await assert.rejects(linked.download(f.candidate), /链接|目录/);
});

test('install-time tampering revokes prepared state', async t => {
  const f = await fixture(t); await f.updater.download(f.candidate);
  await fs.writeFile(f.updater.prepared().installerPath, Buffer.from('MZ tampered'));
  await assert.rejects(f.updater.verifyPrepared()); assert.equal(f.updater.prepared(), null); assert.equal(f.updater.state().status, 'error');
});

test('cancellation after writing removes only the owned partial and preserves unrelated data', async t => {
  const f = await fixture(t); const root = path.join(f.root, 'partial'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'keep.txt'), 'unrelated');
  let updater, wrote = false;
  updater = createSelfUpdateDownloader({ root, currentVersion: '2.1.0', onState: state => {
    if (state.progress.received > 0 && !wrote) { wrote = true; updater.cancel(); }
  }, fetchImpl: async url => {
    if (url.endsWith('.json')) return new Response(f.manifestBytes);
    await new Promise(resolve => setTimeout(resolve, 210));
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(f.installer.subarray(0, 5)); } }));
  } });
  assert.equal((await updater.download(f.candidate)).status, 'cancelled');
  assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal((await fs.readdir(root, { recursive: true })).some(name => name.endsWith('.part')), false);
});

test('rejects manifest digest corruption, compressed transfer, wrong content length and excessive redirects', async t => {
  const f = await fixture(t);
  const wrongDigest = structuredClone(f.candidate); wrongDigest.manifest.sha256 = '0'.repeat(64);
  await assert.rejects(f.updater.download(wrongDigest), /清单摘要/);
  for (const headers of [{ 'content-encoding': 'gzip' }, { 'content-length': '1' }]) {
    const updater = createSelfUpdateDownloader({ root: path.join(f.root, crypto.randomUUID()), currentVersion: '2.1.0', fetchImpl: async () => new Response(f.manifestBytes, { headers }) });
    await assert.rejects(updater.download(f.candidate));
  }
  let requests = 0;
  const redirects = createSelfUpdateDownloader({ root: path.join(f.root, 'loop'), currentVersion: '2.1.0', fetchImpl: async () => {
    requests++; return new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/loop' } });
  } });
  await assert.rejects(redirects.download(f.candidate), /重定向/); assert.equal(requests, 4);
});

test('total timeout bounds a continuously progressing response', async t => {
  const f = await fixture(t); let interval;
  t.after(() => clearInterval(interval));
  const updater = createSelfUpdateDownloader({ root: path.join(f.root, 'total-timeout'), currentVersion: '2.1.0', timeoutMs: 65, stallTimeoutMs: 50,
    fetchImpl: async () => new Response(new ReadableStream({ start(stream) { interval = setInterval(() => stream.enqueue(Buffer.from(' ')), 10); }, cancel() { clearInterval(interval); } })) });
  await assert.rejects(updater.download(f.candidate), /总时限/);
});

test('unexpected failures do not expose native file paths or URLs through state or rejection', async t => {
  const f = await fixture(t);
  const updater = createSelfUpdateDownloader({ root: path.join(f.root, 'error'), currentVersion: '2.1.0', fetchImpl: async () => {
    throw new Error(`network failed at https://secret.invalid/token and ${f.root}`);
  } });
  await assert.rejects(updater.download(f.candidate), error => !error.message.includes(f.root) && !error.message.includes('https:'));
  assert.equal(JSON.stringify(updater.state()).includes('secret.invalid'), false);
});

test('install-time replacement with a link revokes ready without following the linked file', async t => {
  const f = await fixture(t); await f.updater.download(f.candidate);
  const prepared = f.updater.prepared(); const destination = `${prepared.installerPath}.original`;
  await fs.rename(prepared.installerPath, destination);
  try { await fs.symlink(destination, prepared.installerPath, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows file symlink privilege unavailable; junction ancestor protection tested separately'); return; } throw error; }
  await assert.rejects(f.updater.verifyPrepared()); assert.equal(f.updater.prepared(), null);
  assert.deepEqual(await fs.readFile(destination), f.installer);
});

test('cancellation during final fsync or rename never publishes ready and removes only owned output', async t => {
  for (const stage of ['sync', 'rename']) await t.test(stage, async t => {
    const f = await fixture(t); let entered, proceed;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { proceed = resolve; });
    if (stage === 'sync') {
      const original = fs.open;
      t.mock.method(fs, 'open', async (...args) => {
        const handle = await original(...args);
        if (args[0].endsWith('installer.part')) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => { await originalSync(); entered(); await gate; };
        }
        return handle;
      });
    } else {
      const original = fs.rename;
      t.mock.method(fs, 'rename', async (...args) => {
        await original(...args);
        if (args[1].endsWith('installer.exe')) { entered(); await gate; }
      });
    }
    const downloading = f.updater.download(f.candidate);
    await reached; f.updater.cancel(); proceed();
    assert.equal((await downloading).status, 'cancelled');
    assert.equal(f.updater.prepared(), null);
    assert.equal(f.states.some(state => state.status === 'ready'), false);
    const files = await fs.readdir(path.join(f.root, 'downloads'), { recursive: true });
    assert.equal(files.some(name => name.endsWith('.part') || name.endsWith('.exe')), false);
  });
});

test('immediate cancellation before scheduled work prevents all network requests', async t => {
  const f = await fixture(t); const pending = f.updater.download(f.candidate); f.updater.cancel();
  assert.equal((await pending).status, 'cancelled'); assert.equal(f.calls.length, 0);
});
