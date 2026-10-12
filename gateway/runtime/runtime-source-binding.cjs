const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withPhysicalAsarAccess } = require("../runner/shared/fs-utils.cjs");

const RUNTIME_BINDING_ENV = "OPENCODEX_RUNTIME_SOURCE_BINDING";
const ROLLBACK_PIN_ENV = "OPENCODEX_OFFICIAL_ROLLBACK_PIN";

function digestFile(filePath) {
  return withPhysicalAsarAccess(() => {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
      return hash.digest("hex");
    } finally { fs.closeSync(fd); }
  });
}

function digestTree(directory) {
  return withPhysicalAsarAccess(() => {
    if (!fs.existsSync(directory)) return null;
    const entries = [];
    const visit = (relative) => {
      for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
        const entry = path.join(relative, name);
        const file = path.join(directory, entry);
        const stat = fs.lstatSync(file);
        // 不遍历目录符号链接，防止安装包里的链接越过当前资源树。
        if (stat.isSymbolicLink()) entries.push([entry, "link", fs.readlinkSync(file)]);
        else if (stat.isDirectory()) visit(entry);
        else if (stat.isFile()) entries.push([entry, digestFile(file)]);
      }
    };
    visit("");
    return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  });
}

function sourceIdentity(manifest) {
  return {
    asar: digestFile(manifest.sourceAsarPath),
    unpacked: digestTree(manifest.sourceUnpackedAsarPath || `${manifest.sourceAsarPath}.unpacked`),
    cli: manifest.sourceCodexBinaryPath ? digestFile(manifest.sourceCodexBinaryPath) : null,
  };
}

function sourceIdentityBlockReason(manifest, { verifyContents = true } = {}) {
  try {
    if (manifest.sourceIdentity) {
      // 已有内容摘要时不降级为 mtime 身份；子进程随后验证绑定摘要，状态轮询只检查存在性。
      if (verifyContents && JSON.stringify(sourceIdentity(manifest)) !== JSON.stringify(manifest.sourceIdentity)) return "官方安装源内容已变化，无法证明与缓存版本一致";
    } else {
      // 旧清单只能沿用已有文件身份；首次正常扫描会升级为内容摘要。
      const stat = withPhysicalAsarAccess(() => fs.statSync(manifest.sourceAsarPath));
      if (stat.size !== Number(manifest.sourceAsarSize) || Math.trunc(stat.mtimeMs) !== Number(manifest.sourceAsarMtimeMs)) return "官方 app.asar 文件身份已变化，无法安全复用旧缓存";
    }
    return "";
  } catch (error) { return `官方安装源校验失败：${error.message}`; }
}

function createRuntimeBinding(bundle, layout, executablePath, verified = {}) {
  return {
    schemaVersion: 1,
    bundleDir: path.resolve(bundle.bundleDir),
    manifestHash: verified.manifestHash || digestFile(path.join(bundle.bundleDir, "manifest.json")),
    source: verified.source || sourceIdentity(bundle.manifest),
    sourceExecutable: layout.executablePath,
    sourceExecutableHash: verified.sourceExecutableHash || digestFile(layout.executablePath),
    sourceAsarPath: bundle.manifest.sourceAsarPath,
    codexBinaryPath: bundle.manifest.sourceCodexBinaryPath || null,
    executablePath,
    executableHash: digestFile(executablePath),
  };
}

function assertRuntimeBinding(binding, bundleDir, manifest) {
  if (!binding || binding.schemaVersion !== 1 || path.resolve(bundleDir) !== binding.bundleDir) throw new Error("官方运行时启动绑定无效，请重新启动 Launcher");
  const unchanged = digestFile(path.join(bundleDir, "manifest.json")) === binding.manifestHash
    && JSON.stringify(sourceIdentity(manifest)) === JSON.stringify(binding.source)
    && digestFile(binding.sourceExecutable) === binding.sourceExecutableHash
    && digestFile(binding.executablePath) === binding.executableHash;
  if (!unchanged) throw new Error("官方运行时来源在准备后发生变化，已中止启动；请重新启动 Launcher");
}

function runtimeBindingEnvironment(binding) {
  // 官方 bootstrap 也可能直接读取 CLI 覆盖值；子进程继承的环境必须与已选来源一致。
  return {
    [RUNTIME_BINDING_ENV]: JSON.stringify(binding),
    CODEX_DESKTOP_APP_PATH: binding.sourceAsarPath,
    CODEX_DESKTOP_EXECUTABLE_PATH: binding.sourceExecutable,
    CODEX_APP_SERVER_BINARY_PATH: binding.codexBinaryPath || "",
    CODEX_CLI_PATH: binding.codexBinaryPath || "",
  };
}

module.exports = { RUNTIME_BINDING_ENV, ROLLBACK_PIN_ENV, digestFile, sourceIdentity, sourceIdentityBlockReason, createRuntimeBinding, assertRuntimeBinding, runtimeBindingEnvironment, withPhysicalAsarAccess };
