"use strict";
const fs = require("fs");
const path = require("path");
const atomic = require("write-file-atomic");

function writeFileAtomicSync(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 现有文件继承权限；新配置默认仅当前用户可读写。同步读改写不跨越 await。
  const mode = fs.existsSync(filePath) ? undefined : 0o600;
  atomic.sync(filePath, data, { mode, ...options, fsync: true });
}

function writeJsonAtomicSync(filePath, value, options) {
  writeFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

module.exports = { writeFileAtomicSync, writeJsonAtomicSync };
