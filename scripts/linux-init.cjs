#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { deploymentEnvironment } = require("./linux-common.cjs");

function createConfig(configPath, password) {
  if (typeof password !== "string" || password.trim().length < 12 || /[\r\n\0]/.test(password)) {
    throw new Error("访问密码至少 12 个非首尾空白字符，不可包含换行或 NUL");
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  // wx 拒绝覆盖现有文件/符号链接；直接写与 gateway 兼容的 hash，不将明文落盘。
  const fd = fs.openSync(configPath, "wx", 0o600);
  try {
    const hash = crypto.createHash("sha256").update(password, "utf8").digest("hex");
    fs.writeFileSync(fd, `# OpenCodex Linux deployment access control\nauth:\n  password: "sha256-v1:${hash}"\n`);
  } finally { fs.closeSync(fd); }
}

function readSecret(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.reject(new Error("需要交互式终端输入密码；自动化可使用 --password-stdin（不要把密码放在命令参数中）"));
  output.write(prompt);
  return new Promise((resolve, reject) => {
    const previousRaw = input.isRaw;
    let value = "";
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.setRawMode(previousRaw);
      input.pause();
      output.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onEnd = () => finish(new Error("密码输入已结束"));
    const onData = (data) => {
      for (const char of data) {
        if (char === "\u0003" || char === "\u0004") return finish(new Error("已取消"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (char >= " " && char !== "\u001b") value += char;
        if (value.length > 4096) return finish(new Error("密码过长"));
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
  });
}

async function main(args = process.argv.slice(2)) {
  if (process.platform !== "linux") throw new Error("linux:init 只用于 Linux 部署");
  if (args.some((arg) => arg !== "--password-stdin")) throw new Error("用法：pnpm run linux:init [--password-stdin]");
  const configPath = deploymentEnvironment().CODEX_WEB_CONFIG_PATH;
  // 在询问秘密前检查，避免用户输入后才发现配置已存在。
  try { fs.lstatSync(configPath); throw new Error(`拒绝覆盖已有配置：${configPath}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let password;
  if (args.includes("--password-stdin")) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      value += chunk.toString("utf8");
      if (value.length > 4096) throw new Error("密码输入过长");
    }
    password = value.replace(/\r?\n$/, "");
  } else {
    password = await readSecret("设置 Web 访问密码（至少 12 字符，输入不回显）：");
    const confirm = await readSecret("再次输入密码：");
    if (password !== confirm) throw new Error("两次密码不一致");
  }
  createConfig(configPath, password);
  console.log(`已创建私有访问配置：${configPath}\n未修改 Codex 账号、API key 或登录状态。`);
}

if (require.main === module) main().catch((error) => { console.error(`[linux:init] ${error.message}`); process.exitCode = 1; });
module.exports = { createConfig, readSecret };
