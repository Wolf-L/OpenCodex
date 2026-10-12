#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { deploymentEnvironment } = require("./linux-common.cjs");
const { readOfficialStartupCacheSettings } = require("../gateway/runtime/electron/official-startup-cache-settings.cjs");

function configureStartupCache(runtimeDir, enabled, { ifMissing = false } = {}) {
  const before = readOfficialStartupCacheSettings(runtimeDir);
  // 安装升级仅补缺失配置，保留用户明确关闭或需要人工处理的无效文件。
  if (ifMissing && before.reason !== "missing") return { ...before, changed: false };
  if (!["missing", "enabled", "disabled"].includes(before.reason)) throw new Error(`缓存配置不可修改：${before.reason}`);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ schemaVersion: 1, enabled })}\n`;
  if (before.reason === "missing") {
    try { fs.writeFileSync(before.settingsPath, body, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (ifMissing && error.code === "EEXIST") return { ...readOfficialStartupCacheSettings(runtimeDir), changed: false };
      throw error;
    }
  } else {
    // 只有明确 enable/disable 才替换已有设置，不读写响应缓存、访问密码或账号文件。
    const temporary = path.join(runtimeDir, `.startup-cache-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    try {
      if (fs.lstatSync(before.settingsPath).isSymbolicLink()) throw new Error("拒绝替换符号链接");
      fs.renameSync(temporary, before.settingsPath);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return { ...readOfficialStartupCacheSettings(runtimeDir), changed: true };
}

function main(args = process.argv.slice(2)) {
  const [action = "status", ...flags] = args;
  if (!["status", "enable", "disable"].includes(action) || flags.some(flag => flag !== "--if-missing") || (action !== "enable" && flags.length)) {
    throw new Error("用法：opencodex cache {status|enable [--if-missing]|disable}");
  }
  const runtimeDir = deploymentEnvironment().CODEX_WEB_RUNTIME_DIR;
  const state = action === "status" ? readOfficialStartupCacheSettings(runtimeDir)
    : configureStartupCache(runtimeDir, action === "enable", { ifMissing: flags.includes("--if-missing") });
  console.log(JSON.stringify({ enabled: state.enabled, reason: state.reason, changed: state.changed ?? false, settingsPath: state.settingsPath }, null, 2));
  if (action !== "status") console.log("重启后生效。启用后先正常联网打开主界面和个人资料，再检查 /api/health 的 supported、coverage 与缓存写入/命中数。个人快照不会随安装包提供。");
}
if (require.main === module) { try { main(); } catch (error) { console.error(`[linux:cache] ${error.message}`); process.exitCode = 1; } }
module.exports = { configureStartupCache };
