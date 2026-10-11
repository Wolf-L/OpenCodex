const fs = require("node:fs");
const path = require("node:path");

const MAX_SETTINGS_BYTES = 8 * 1024;

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function readOfficialStartupCacheSettings(runtimeDir) {
  const settingsPath = path.join(runtimeDir, "official-startup-cache.json");
  const directory = path.join(runtimeDir, "cache", "official-startup-responses");
  const result = (reason, enabled = false) => ({ enabled, reason, settingsPath, directory });
  let descriptor;
  try {
    // 只读本功能独立的显式 opt-in 文件；缺失时不创建目录，也不探查账号配置或环境变量。
    const initial = fs.lstatSync(settingsPath);
    if (initial.isSymbolicLink()) return result("symlink");
    if (!initial.isFile()) return result("non-regular");
    if (initial.size > MAX_SETTINGS_BYTES) return result("oversize");

    // O_NOFOLLOW 在支持的平台阻止跟随链接；前后身份核验同时覆盖 Windows 与替换竞争。
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0);
    descriptor = fs.openSync(settingsPath, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) return result("non-regular");
    if (!sameFile(initial, opened)) return result("changed");

    // 固定上限缓冲区额外保留一字节，避免 stat 后文件变大导致无界读取。
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_SETTINGS_BYTES) return result("oversize");
    const afterRead = fs.fstatSync(descriptor);
    const current = fs.lstatSync(settingsPath);
    if (current.isSymbolicLink()) return result("symlink");
    if (!sameFile(opened, afterRead) || !sameFile(opened, current)) return result("changed");

    let value;
    try {
      value = JSON.parse(buffer.toString("utf8", 0, length));
    } catch {
      return result("invalid");
    }
    // 未知字段也拒绝，防止路径覆盖或未来 schema 在旧版本中被意外启用。
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 2 || value.schemaVersion !== 1 ||
        typeof value.enabled !== "boolean") {
      return result("invalid");
    }
    return result(value.enabled ? "enabled" : "disabled", value.enabled);
  } catch (error) {
    // 诊断只返回固定原因码，绝不传播含有本机路径或其他敏感信息的异常文本。
    if (error && error.code === "ENOENT") return result("missing");
    if (error && error.code === "ELOOP") return result("symlink");
    return result("unreadable");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* 关闭失败不能把只读检查变成启动异常。 */ }
    }
  }
}

module.exports = { readOfficialStartupCacheSettings };
