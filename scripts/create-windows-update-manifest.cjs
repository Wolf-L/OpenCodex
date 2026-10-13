"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const metadata = require("../package.json");

const MANIFEST_NAME = "opencodex-update-win32-x64.json";
const MAX_INSTALLER_BYTES = 1024 ** 3;
const MAX_MANIFEST_BYTES = 65536;

function inputs(options) {
  const version = options.version ?? metadata.version;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || !version.split(".").every(part => Number.isSafeInteger(Number(part)))) throw new Error("Invalid stable package version");
  if (typeof options.commit !== "string" || !/^[a-f0-9]{40}$/i.test(options.commit)) throw new Error("Invalid full Git commit");
  if (typeof options.directory !== "string" || !options.directory) throw new Error("Invalid release directory");
  return { directory: path.resolve(options.directory), version, commit: options.commit.toLowerCase() };
}

async function regularFile(file, maximum) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${path.basename(file)}`);
  if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maximum) throw new Error(`Invalid file size: ${path.basename(file)}`);
  return stat;
}

async function expectedManifest(options) {
  const { directory, version, commit } = inputs(options);
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Expected release directory without symlink");
  // 安装包名称仅由受限版本构造，调用者不能把任意路径写入发布清单。
  const name = `OpenCodex Setup ${version}.exe`;
  const installer = path.join(directory, name);
  const before = await regularFile(installer, MAX_INSTALLER_BYTES);
  const handle = await fs.open(installer, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Installer changed while opening");
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    // MZ 只用于排除明显错误的构建产物，不代表 Authenticode 签名验证。
    if (header.toString("ascii") !== "MZ") throw new Error("Installer is missing its MZ header");
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      bytes += chunk.length;
      if (bytes > MAX_INSTALLER_BYTES || bytes > before.size) throw new Error("Installer size changed while hashing");
      hash.update(chunk);
    }
    const after = await regularFile(installer, MAX_INSTALLER_BYTES);
    const final = await handle.stat();
    if (bytes !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || final.size !== before.size || final.mtimeMs !== before.mtimeMs || final.ctimeMs !== before.ctimeMs) throw new Error("Installer changed while hashing");
    return { schemaVersion: 1, appId: "dev.opencodex.launcher", version, platform: "win32", arch: "x64",
      installer: { name, size: bytes, sha256: hash.digest("hex") }, commit };
  } finally { await handle.close(); }
}

async function createWindowsUpdateManifest(options) {
  const manifest = await expectedManifest(options);
  const { directory } = inputs(options);
  const output = path.join(directory, MANIFEST_NAME);
  try { await regularFile(output, MAX_MANIFEST_BYTES); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(directory, `.${MANIFEST_NAME}.${crypto.randomUUID()}.tmp`);
  try {
    // 先完整落盘再发布文件名，重跑 CI 时也不会留下半写入的清单。
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, output);
    return manifest;
  } finally { await fs.rm(temporary, { force: true }); }
}

async function checkWindowsUpdateManifest(options) {
  const manifest = await expectedManifest(options);
  const file = path.join(inputs(options).directory, MANIFEST_NAME);
  await regularFile(file, MAX_MANIFEST_BYTES);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let actual;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) throw new Error("Invalid manifest file size");
    // 固定缓冲上限避免读取期间文件增长造成无界内存使用。
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) throw new Error("Invalid manifest file size");
    actual = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
  if (!isDeepStrictEqual(actual, manifest)) throw new Error("Update manifest does not match installer, version or commit");
  return manifest;
}

async function main(args) {
  const options = { directory: "release" };
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") { check = true; continue; }
    if (!["--directory", "--commit"].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
    const key = args[i].slice(2), value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
  }
  const manifest = await (check ? checkWindowsUpdateManifest(options) : createWindowsUpdateManifest(options));
  process.stdout.write(`${check ? "Verified" : "Created"} ${MANIFEST_NAME}: ${manifest.installer.size} bytes\n`);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { MANIFEST_NAME, createWindowsUpdateManifest, checkWindowsUpdateManifest };
