"use strict";

// 所有平台和入口共用局域网默认值；只决定监听范围，不关闭或改写访问认证。
const DEFAULT_GATEWAY_HOST = "0.0.0.0";

function normalizeLauncherHostMode(value, defaultHost = DEFAULT_GATEWAY_HOST) {
  // 保留明确选择的本机/局域网模式；缺失配置才采用默认值，兼容旧设置文件。
  if (value === "local" || value === "lan") return value;
  return defaultHost === DEFAULT_GATEWAY_HOST ? "lan" : "local";
}

module.exports = { DEFAULT_GATEWAY_HOST, normalizeLauncherHostMode };
