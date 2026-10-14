"use strict";

function windowsInstallerNames(version) {
  // 只接受同一版本的两种精确文件名；GitHub 上传后将构建产物中的空格改为点号。
  // 禁止通用去空格/标点归一化，避免将未知文件或路径当成可信安装包。
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) return [];
  return [`OpenCodex Setup ${version}.exe`, `OpenCodex.Setup.${version}.exe`];
}

module.exports = { windowsInstallerNames };
