"use strict";
const fs = require("node:fs");
const path = require("node:path");

const PRIVATE_DIRECTORIES = new Set([".codex", ".ssh", ".data", "official-user-data", "repair-backups", "reports"]);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "fixtures"]);
const PRIVATE_FILE = /^(?:\.env(?:\..*)?|auth\.json|server\.env|config\.(?:yaml|toml)|id_rsa|id_ed25519|history\.jsonl|cookies|login data)$|\.(?:pem|p12|pfx|sqlite3?|db|log)$/i;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function validatePackagedApp(appDirectory) {
  // 检查复制后的第一方应用目录，不能只验证源文件的 glob 配置。
  // 依赖包可能包含其自己的合法测试资源，交由打包器处理生产依赖，不扩大排除范围。
  if (!fs.statSync(appDirectory).isDirectory()) throw new Error("Packaged application directory is missing");
  const violations = [];
  let files = 0;
  function visit(directory, segments = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (segments.length === 0 && entry.name === "node_modules") continue;
      const parts = [...segments, entry.name];
      const relative = parts.join("/");
      const name = entry.name.toLowerCase();
      if (entry.isSymbolicLink() || PRIVATE_DIRECTORIES.has(name) || TEST_DIRECTORIES.has(name)
          || PRIVATE_FILE.test(name) || TEST_FILE.test(name)) {
        // 只输出相对文件名，不读取或记录被拒绝文件中的凭据内容。
        violations.push(relative);
        continue;
      }
      if (entry.isDirectory()) visit(path.join(directory, entry.name), parts);
      else if (entry.isFile()) files += 1;
    }
  }
  visit(appDirectory);
  if (violations.length) throw new Error(`Packaged application contains private or test files: ${violations.join(", ")}`);
  return { files };
}

async function afterPack(context) {
  // 使用打包器的平台目录解析，兼容 macOS .app 与 Windows/Linux resources 布局。
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const result = validatePackagedApp(path.join(resources, "app"));
  console.log(`Package privacy check passed (${result.files} first-party files)`);
}

module.exports = afterPack;
module.exports.validatePackagedApp = validatePackagedApp;
