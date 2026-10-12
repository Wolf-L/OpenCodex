"use strict";

// 纯解析模块不读取配置、不改写密码，供 gateway 与部署诊断共同使用。
function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    // 只去掉引号外的 YAML 注释，避免密码里的 # 被错误截断。
    if (quote === '"') {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === '"') quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (char === "'") quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlStringScalar(rawValue) {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith('"')) {
    // 双引号字符串按 JSON 规则解析，复用转义处理，避免手写反斜杠状态机。
    if (!value.endsWith('"')) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    }
  }
  if (value.startsWith("'")) {
    // YAML 单引号内用两个单引号表示字面单引号。
    if (!value.endsWith("'")) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function leadingIndent(line) {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findAuthPasswordScalar(rawConfig) {
  /**
   * 这里只实现 auth.password 需要的 YAML 子集：
   * 顶层 auth: 块 + 一级 password 标量。
   * 这样能保持无额外依赖，同时避免“看似支持完整 YAML 实则不完整”的风险。
   */
  const lines = String(rawConfig || "").split(/\r?\n/);
  let inAuth = false;
  let authIndent = 0;
  let authChildIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const logicalLine = stripYamlComment(line);
    if (!logicalLine.trim()) continue;
    const indent = leadingIndent(line);
    if (inAuth && indent <= authIndent) {
      inAuth = false;
      authChildIndent = null;
    }
    if (!inAuth && indent === 0) {
      const authMatch = logicalLine.trim().match(/^auth\s*:\s*(.*)$/);
      if (authMatch) {
        // 这里仅支持项目约定的 auth: 块形式，避免解析 inline YAML object 引入半吊子解析器。
        if (authMatch[1].trim()) {
          throw new Error("[gateway] unsupported inline auth config in config.yaml; use block form auth.password");
        }
        inAuth = true;
        authIndent = indent;
        authChildIndent = null;
        continue;
      }
    }
    if (!inAuth || indent <= authIndent) continue;
    if (authChildIndent == null) authChildIndent = indent;
    if (indent !== authChildIndent) continue;
    const passwordMatch = line.match(/^(\s*)password\s*:\s*(.*)$/);
    if (!passwordMatch) continue;
    return {
      lineIndex: i,
      value: parseYamlStringScalar(passwordMatch[2]),
    };
  }
  return null;
}

function replaceAuthPasswordScalar(rawConfig, value) {
  const raw = String(rawConfig || "");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const fail = () => { throw new Error("无法安全更新 auth.password：请使用唯一的顶层 auth 块和普通 password 标量"); };
  let auth = -1;
  // 只修改项目支持的块式配置；多文档、别名、重复键不能靠猜测决定认证语义。
  for (let i = 0; i < lines.length; i++) {
    const logical = stripYamlComment(lines[i]);
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(logical) || /^['"]auth['"]\s*:/.test(logical) || /^<<\s*:/.test(logical)) fail();
    if (/^auth\s*:/.test(logical)) {
      if (auth !== -1 || !/^auth\s*:\s*$/.test(logical)) fail();
      auth = i;
    }
  }
  if (auth === -1) return `${raw}${raw && !raw.endsWith("\n") ? newline : ""}auth:${newline}  password: ${JSON.stringify(value)}${newline}`;
  let end = lines.length;
  let indent = null;
  let password = -1;
  for (let i = auth + 1; i < lines.length; i++) {
    const logical = stripYamlComment(lines[i]);
    if (!logical.trim()) continue;
    if (!/^\s/.test(logical)) { end = i; break; }
    if (/^\s*\t/.test(logical) || /^\s*(?:<<\s*:|['"]password['"]\s*:)/.test(logical)) fail();
    const spaces = leadingIndent(logical);
    if (indent === null) indent = spaces;
    if (spaces < indent) fail();
    if (spaces !== indent || !/^\s*password\s*:/.test(logical)) continue;
    if (password !== -1) fail();
    const scalar = logical.replace(/^\s*password\s*:\s*/, "").trim();
    if (/^[>|&*!{\[]/.test(scalar)) fail();
    parseYamlStringScalar(scalar);
    password = i;
  }
  if (password !== -1) {
    // 保留当前行缩进和注释，不重写任何其它配置字段。
    const line = lines[password];
    const comment = line.slice(stripYamlComment(line).length);
    lines[password] = `${line.match(/^\s*/)[0]}password: ${JSON.stringify(value)}${comment ? ` ${comment}` : ""}`;
  } else {
    // 插入到 auth 块的起始处，不吞掉尾部注释或文件原有换行风格。
    lines.splice(auth + 1, 0, `${" ".repeat(indent || 2)}password: ${JSON.stringify(value)}`);
  }
  return lines.join(newline);
}

module.exports = { findAuthPasswordScalar, replaceAuthPasswordScalar };
