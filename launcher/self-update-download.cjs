"use strict";
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const metadata = require('../package.json');
const { windowsInstallerNames } = require('../shared/windows-installer-name.cjs');
const repository = new URL(metadata.homepage).pathname.replace(/^\/|\/$/g, '');
const MAX_INSTALLER = 1024 ** 3, MAX_MANIFEST = 65536;
const HASH = /^[a-f0-9]{64}$/;
class UpdateError extends Error {}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function version(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value || '');
  const parts = match?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : null;
}
function isNewer(remote, local) {
  const a = version(remote), b = version(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function assetUrl(value, tagName, name) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash ||
    decodeURIComponent(url.pathname) !== `/${repository}/releases/download/${tagName}/${name}`) throw new UpdateError('更新下载地址不属于所选发布');
  return url.href;
}
function validateCandidate(input, currentVersion) {
  // 再次验证主进程传入的发布身份；下载模块不接收渲染器提供的任意地址或路径。
  if (!input || !isNewer(input.version, currentVersion) || ![input.version, `v${input.version}`].includes(input.tagName)) throw new UpdateError('更新版本无效或未高于当前版本');
  const installerName = input.installer?.name;
  if (!windowsInstallerNames(input.version).includes(installerName)) throw new UpdateError('更新安装包文件名无效');
  const asset = (value, name, max) => {
    if (!value || value.name !== name || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > max ||
      (value.sha256 !== undefined && !HASH.test(value.sha256))) throw new UpdateError('更新发布文件或摘要无效');
    return Object.freeze({ name, size: value.size, sha256: value.sha256, url: assetUrl(value.url, input.tagName, name) });
  };
  return Object.freeze({ version: input.version, tagName: input.tagName,
    installer: asset(input.installer, installerName, MAX_INSTALLER), manifest: asset(input.manifest, 'opencodex-update-win32-x64.json', MAX_MANIFEST) });
}
function validateManifest(bytes, candidate) {
  const m = JSON.parse(bytes.toString('utf8'));
  if (!exactKeys(m, ['schemaVersion', 'appId', 'version', 'platform', 'arch', 'installer', 'commit']) ||
    m.schemaVersion !== 1 || m.appId !== 'dev.opencodex.launcher' || m.version !== candidate.version || m.platform !== 'win32' || m.arch !== 'x64' ||
    !/^[a-f0-9]{40}$/.test(m.commit) || !exactKeys(m.installer, ['name', 'size', 'sha256']) ||
    // 清单保留本地构建名，附件可能为 GitHub 的点号名；同版本精确别名仍需大小和 SHA-256 一致。
    !windowsInstallerNames(candidate.version).includes(m.installer.name) || m.installer.size !== candidate.installer.size || !HASH.test(m.installer.sha256) ||
    (candidate.installer.sha256 && m.installer.sha256 !== candidate.installer.sha256)) throw new UpdateError('更新清单与版本、平台或安装包不一致');
  return m.installer.sha256;
}
async function safeDirectory(directory, create = false) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      info = await fs.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UpdateError('更新目录包含链接或非目录节点');
  }
  return absolute;
}
function redirectedUrl(location, previous) {
  const url = new URL(location, previous);
  if (url.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname) ||
    url.port || url.username || url.password || url.hash) throw new UpdateError('更新下载重定向地址不受信任');
  return url.href;
}
function abortReason(signal) { return signal.reason instanceof Error ? signal.reason : new UpdateError('更新下载已取消'); }
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function request(url, context) {
  for (let redirects = 0; ; redirects++) {
    if (context.signal.aborted) throw abortReason(context.signal);
    const response = await abortable(context.fetchImpl(url, { redirect: 'manual', signal: context.signal,
      headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity', 'user-agent': 'OpenCodex Updater' } }), context.signal);
    context.touch();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      if (redirects >= 3 || !response.headers.get('location')) throw new UpdateError('更新下载重定向次数过多或地址缺失');
      url = redirectedUrl(response.headers.get('location'), url); continue;
    }
    if (response.status !== 200 || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new UpdateError(`更新下载失败：HTTP ${response.status}`);
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      void response.body?.cancel().catch(() => {});
      throw new UpdateError('更新下载不接受压缩传输编码');
    }
    return response;
  }
}
async function consume(asset, context, onChunk) {
  const response = await request(asset.url, context);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.size)) {
    void response.body?.cancel().catch(() => {});
    throw new UpdateError('更新下载声明大小不匹配');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new UpdateError('更新下载内容不可读');
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), context.signal);
      if (done) break;
      context.touch(); received += value.byteLength;
      if (received > asset.size) throw new UpdateError('更新下载超过预期大小');
      await onChunk(Buffer.from(value), received);
    }
    if (received !== asset.size) throw new UpdateError('更新下载未完成或大小不匹配');
  } finally { void reader.cancel().catch(() => {}); }
}

function createSelfUpdateDownloader(options) {
  const { root, currentVersion, onState = () => {}, fetchImpl = globalThis.fetch, statfsImpl = fs.statfs } = options;
  const bounded = (value, limit) => Number.isFinite(value) && value > 0 ? Math.min(value, limit) : limit;
  const timeoutMs = bounded(options.timeoutMs, 15 * 60 * 1000), stallTimeoutMs = bounded(options.stallTimeoutMs, 30000);
  let view = { status: 'idle', progress: { received: 0, total: 0, percent: 0 }, targetVersion: '', error: '' };
  let operation = null, controller = null, ready = null, verifying = false, cancelled = false, published = false, lastEvent = 0;
  const state = () => ({ ...view, progress: { ...view.progress } });
  function emit(force = true) {
    if (force || Date.now() - lastEvent >= 200) { lastEvent = Date.now(); onState(state()); }
  }
  function download(input) {
    if (operation) return operation;
    if (verifying) return Promise.reject(new UpdateError('正在校验安装包，请稍后重试'));
    controller = new AbortController(); cancelled = false; published = false; ready = null;
    // 在异步工作启动之前保存 promise，重复点击共享同一下载，不创建第二个文件。
    operation = Promise.resolve().then(async () => {
      let temporary = null, temporaryIdentity = null, handle = null, timer, stall;
      const signal = controller.signal;
      const touch = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(new UpdateError('更新下载停滞超时')), stallTimeoutMs); };
      try {
        const candidate = validateCandidate(input, currentVersion);
        view = { status: 'downloading', targetVersion: candidate.version, progress: { received: 0, total: candidate.installer.size, percent: 0 }, error: '' }; emit();
        timer = setTimeout(() => controller.abort(new UpdateError('更新下载总时限超时')), timeoutMs); touch();
        const directory = await safeDirectory(root, true);
        const space = await statfsImpl(directory);
        const availableBytes = Number(space.bavail) * Number(space.bsize);
        if (!Number.isFinite(availableBytes) || availableBytes < candidate.installer.size * 2 + 64 * 1024 ** 2) throw new UpdateError('更新下载磁盘空间不足');
        const operationDir = path.join(directory, crypto.randomUUID());
        await fs.mkdir(operationDir); await safeDirectory(operationDir);
        const context = { fetchImpl, signal, touch };
        const chunks = [];
        await consume(candidate.manifest, context, bytes => chunks.push(bytes));
        const manifestBytes = Buffer.concat(chunks);
        if (candidate.manifest.sha256 && hash(manifestBytes) !== candidate.manifest.sha256) throw new UpdateError('更新清单摘要不匹配');
        const expectedHash = validateManifest(manifestBytes, candidate);
        temporary = path.join(operationDir, 'installer.part');
        await safeDirectory(operationDir);
        handle = await fs.open(temporary, 'wx', 0o600);
        temporaryIdentity = await handle.stat();
        const digest = crypto.createHash('sha256'); let signature = Buffer.alloc(0);
        await consume(candidate.installer, context, async (bytes, received) => {
          if (signature.length < 2) signature = Buffer.concat([signature, bytes.subarray(0, 2 - signature.length)]);
          digest.update(bytes); await handle.writeFile(bytes);
          view.progress = { received, total: candidate.installer.size, percent: Math.floor(received / candidate.installer.size * 100) }; emit(false);
        });
        view.status = 'verifying'; emit();
        if (signature.toString('ascii') !== 'MZ' || digest.digest('hex') !== expectedHash) throw new UpdateError('更新安装包格式或 SHA-256 摘要不匹配');
        if (signal.aborted) throw abortReason(signal);
        await handle.sync();
        if (signal.aborted) throw abortReason(signal);
        await handle.close(); handle = null;
        await safeDirectory(operationDir);
        if (signal.aborted) throw abortReason(signal);
        const installerPath = path.join(operationDir, 'installer.exe');
        await fs.rename(temporary, installerPath); temporary = installerPath;
        // fsync/rename 期间仍接受取消；已改名但尚未发布的本次文件也由 finally 安全清理。
        if (signal.aborted) throw abortReason(signal);
        ready = Object.freeze({ installerPath, size: candidate.installer.size, sha256: expectedHash, targetVersion: candidate.version });
        temporary = null;
        published = true; view.status = 'ready'; emit(); return state();
      } catch (error) {
        ready = null; view.status = cancelled ? 'cancelled' : 'error'; view.error = cancelled ? '' : error instanceof UpdateError ? error.message : '更新下载失败，请重试'; emit();
        if (cancelled) return state(); throw new UpdateError(view.error);
      } finally {
        clearTimeout(timer); clearTimeout(stall);
        if (handle) await handle.close().catch(() => {});
        // 只删除本次独占创建的半成品，历史成功包及用户目录内容保持不动。
        if (temporary && temporaryIdentity) {
          try {
            await safeDirectory(path.dirname(temporary));
            const actual = await fs.lstat(temporary);
            if (actual.isFile() && !actual.isSymbolicLink() && actual.dev === temporaryIdentity.dev && actual.ino === temporaryIdentity.ino) await fs.unlink(temporary);
          } catch { /* 目录身份不再可信时保留文件，不能清理可能属于他人的路径。 */ }
        }
        controller = null; operation = null;
      }
    });
    return operation;
  }
  async function verifyPrepared() {
    if (!ready || operation || verifying) throw new UpdateError('没有可安装的已校验更新');
    const snapshot = ready; verifying = true; let handle;
    view.status = 'verifying'; emit();
    try {
      await safeDirectory(path.dirname(snapshot.installerPath));
      const before = await fs.lstat(snapshot.installerPath);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== snapshot.size || before.nlink !== 1) throw new UpdateError('已下载更新文件类型或大小变化');
      handle = await fs.open(snapshot.installerPath, 'r');
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== snapshot.size) throw new UpdateError('已下载更新文件身份变化');
      const digest = crypto.createHash('sha256'); let size = 0;
      for await (const bytes of handle.createReadStream({ autoClose: false })) {
        size += bytes.length; if (size > snapshot.size) throw new UpdateError('已下载更新文件大小变化'); digest.update(bytes);
      }
      if (size !== snapshot.size || digest.digest('hex') !== snapshot.sha256) throw new UpdateError('已下载更新文件摘要变化');
      await safeDirectory(path.dirname(snapshot.installerPath));
      const after = await fs.lstat(snapshot.installerPath);
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== snapshot.size || after.nlink !== 1 || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new UpdateError('已下载更新文件身份变化');
      view.status = 'ready'; emit(); return { ...snapshot };
    } catch (error) { ready = null; view.status = 'error'; view.error = error instanceof UpdateError ? error.message : '已下载更新无法校验，请重新下载'; emit(); throw new UpdateError(view.error); }
    finally { if (handle) await handle.close(); verifying = false; }
  }
  return { state, download, verifyPrepared, prepared: () => ready ? { ...ready } : null,
    cancel() { if (controller && operation && !published) { cancelled = true; controller.abort(new UpdateError('更新下载已取消')); } } };
}
module.exports = { createSelfUpdateDownloader };
