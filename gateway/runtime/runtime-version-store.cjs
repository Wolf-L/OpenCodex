"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { writeJsonAtomicSync } = require("../../shared/atomic-file.cjs");
const { digestFile, withPhysicalAsarAccess } = require("./runtime-source-binding.cjs");

const FORMAT = 1;
const validId = (id) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function resolvedPath(file) {
  // 新版本目录可能尚不存在；先解析最近的真实父目录，识别父级 junction 指回来源的情况。
  let existing = path.resolve(file);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function inventory(root) {
  return withPhysicalAsarAccess(() => {
    const entries = [];
    // 同步遍历复用单个缓冲区，避免数万小文件各分配 1MB 引发大量 GC。
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    function visit(relative) {
      const file = path.join(root, relative);
      const stat = fs.lstatSync(file);
      const name = relative.split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (!inside(fs.realpathSync(root), target)) throw new Error("运行时快照不接受越界或失效符号链接");
        // 将内部绝对链接规范化成相对链接，避免快照继续依赖原安装目录。
        entries.push([name, "link", path.relative(path.dirname(file), target).split(path.sep).join("/")]);
      } else if (stat.isDirectory()) {
        entries.push([name, "dir"]);
        for (const child of fs.readdirSync(file).sort()) visit(path.join(relative, child));
      } else if (stat.isFile()) {
        entries.push([name, "file", stat.size, digestFile(file, buffer), process.platform === "win32" ? 0 : stat.mode & 0o777]);
      } else throw new Error("运行时快照只接受普通文件、目录和内部符号链接");
    }
    visit("");
    return entries;
  });
}

function copyInventory(source, target, entries) {
  return withPhysicalAsarAccess(() => {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    // 不使用硬链接，也不继承 WindowsApps 的特殊文件属性；源目录始终只读。
    for (const [relative, kind, , , mode] of entries) {
      const from = path.join(source, relative);
      const to = path.join(target, relative);
      if (kind === "dir") { fs.mkdirSync(to, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (kind === "link") continue;
      const input = fs.openSync(from, "r");
      let output;
      try {
        output = fs.openSync(to, "wx", mode || 0o600);
        let count;
        while ((count = fs.readSync(input, buffer, 0, buffer.length, null))) {
          let offset = 0;
          while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
        }
        fs.fsyncSync(output);
      } finally { fs.closeSync(input); if (output !== undefined) fs.closeSync(output); }
      if (process.platform !== "win32") fs.chmodSync(to, mode);
    }
    // 最后创建链接，Windows junction 目标也必须指向副本，而非原安装。
    for (const [relative, kind, link] of entries) if (kind === "link") {
      const to = path.join(target, relative);
      const destination = path.resolve(path.dirname(to), link);
      const directory = fs.statSync(path.join(source, relative)).isDirectory();
      fs.symlinkSync(process.platform === "win32" && directory ? destination : link, to,
        directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
    }
  });
}

class RuntimeVersionStore {
  constructor(bundleDir) {
    this.bundleDir = path.resolve(bundleDir);
    this.root = `${this.bundleDir}.versions`;
    this.pointerPath = `${this.bundleDir}.current.json`;
  }
  pointer() {
    if (!fs.existsSync(this.pointerPath)) return null;
    const pointer = JSON.parse(fs.readFileSync(this.pointerPath, "utf8"));
    if (pointer.schemaVersion !== FORMAT || !validId(pointer.current) || (pointer.previous !== null && !validId(pointer.previous))) throw new Error("运行时版本指针无效，未自动覆盖");
    return pointer;
  }
  directory(id) {
    if (!validId(id)) throw new Error("运行时版本编号无效");
    const dir = path.join(this.root, id);
    if (fs.existsSync(dir) && (!inside(fs.realpathSync(this.root), fs.realpathSync(dir)) || fs.lstatSync(dir).isSymbolicLink())) throw new Error("运行时版本目录不能是外部链接");
    return dir;
  }
  read(id, { verify = true, verifyRunner = true } = {}) {
    const dir = this.directory(id);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "version.json"), "utf8"));
    if (record.schemaVersion !== FORMAT || record.id !== id || record.platform !== process.platform || record.arch !== process.arch) throw new Error("运行时版本平台或架构不匹配");
    for (const component of ["source", "bundle", "runner"]) {
      if (verify && (component !== "runner" || verifyRunner) && hash(inventory(path.join(dir, component))) !== record.components[component]) throw new Error(`运行时 ${component} 内容校验失败`);
    }
    for (const value of Object.values(record.layout)) {
      if (typeof value === "string" && path.isAbsolute(value) && !inside(path.join(dir, "source"), value)) throw new Error("运行时清单包含快照以外的组件路径");
    }
    return { ...record, dir, bundleDir: path.join(dir, "bundle") };
  }
  async locked(operation) {
    if (fs.existsSync(this.root) && fs.lstatSync(this.root).isSymbolicLink()) throw new Error("快照存储目录不能是符号链接");
    fs.mkdirSync(this.root, { recursive: true });
    const lock = path.join(this.root, "prepare.lock");
    let fd;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new Error(`已有运行时准备任务，或上次意外退出留下锁；确认无准备进程后再清理：${lock}`); throw error; }
    try { fs.writeFileSync(fd, String(process.pid)); return await operation(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  sourcePlan(layout, sourceInfo) {
    const roots = [{ source: layout.platform === "darwin" ? layout.appRoot : layout.runtimeRoot, target: "runtime" }];
    const runtimeRoot = path.resolve(roots[0].source);
    // 不把显式 /usr/bin Electron 或用户主目录误当成应用安装树整目录复制。
    const broadRoots = [path.parse(runtimeRoot).root, os.homedir(), "/usr", "/usr/bin", "/bin", "/opt", "/Applications"].map(p => path.resolve(p));
    if (broadRoots.includes(runtimeRoot) || (!inside(sourceInfo.installRoot, runtimeRoot) && path.dirname(path.resolve(sourceInfo.installRoot)) !== runtimeRoot)) throw new Error("运行时来源必须是独立应用安装目录，不能快照系统或用户根目录");
    for (const [source, target] of [[layout.resourcesDir, "resources"], [sourceInfo.codexBinaryPath, `cli/${path.basename(sourceInfo.codexBinaryPath || "codex")}`]]) {
      if (source && !roots.some((root) => inside(root.source, source))) roots.push({ source, target });
    }
    for (const root of roots) {
      if (inside(resolvedPath(root.source), resolvedPath(this.root)) || inside(resolvedPath(this.root), resolvedPath(root.source))) throw new Error("快照存储不能与官方来源重叠");
      root.entries = inventory(root.source);
    }
    const identity = hash({ platform: process.platform, arch: process.arch,
      roots: roots.map(({ target, entries }) => ({ target, entries })),
      executable: digestFile(layout.executablePath) });
    return { roots, identity };
  }
  snapshot(layout, sourceInfo, plan) {
    const id = crypto.randomBytes(16).toString("hex");
    const dir = this.directory(id);
    fs.mkdirSync(dir, { recursive: true });
    const remap = (file) => {
      if (!file) return file;
      const root = plan.roots.find((item) => inside(item.source, file));
      if (!root) throw new Error("运行时组件不在已验证来源内");
      return path.join(dir, "source", root.target, path.relative(root.source, file));
    };
    try {
      for (const root of plan.roots) {
        const target = path.join(dir, "source", root.target);
        copyInventory(root.source, target, root.entries);
        if (hash(inventory(target)) !== hash(root.entries) || hash(inventory(root.source)) !== hash(root.entries)) throw new Error("官方来源在复制期间变化，保留当前版本并中止切换");
      }
      const snapshotLayout = { ...layout };
      for (const key of ["appRoot", "runtimeRoot", "frameworksDir", "resourcesDir", "asarPath", "executablePath", "codexBinaryPath"]) {
        if (layout[key]) snapshotLayout[key] = remap(layout[key]);
      }
      const mappedInfo = { ...sourceInfo, installRoot: remap(sourceInfo.installRoot), resourcesDir: remap(sourceInfo.resourcesDir),
        asarPath: remap(sourceInfo.asarPath), unpackedAsarDir: remap(sourceInfo.unpackedAsarDir), codexBinaryPath: remap(sourceInfo.codexBinaryPath) };
      return { id, dir, layout: snapshotLayout, sourceInfo: mappedInfo, origin: sourceInfo, originIdentity: plan.identity };
    } catch (error) {
      // 只删除本次随机创建且尚未发布的目录，不清理旧版本或用户数据。
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  seal(candidate, bundle, runtime) {
    const files = Object.fromEntries(["source", "bundle", "runner"].map(name => [name, inventory(path.join(candidate.dir, name))]));
    for (const [name, entries] of Object.entries(files)) writeJsonAtomicSync(path.join(candidate.dir, `${name}-files.json`), entries);
    const record = { schemaVersion: FORMAT, id: candidate.id, platform: process.platform, arch: process.arch,
      version: bundle.version, build: bundle.build, createdAt: new Date().toISOString(),
      origin: candidate.origin, originIdentity: candidate.originIdentity, layout: candidate.layout,
      components: Object.fromEntries(Object.entries(files).map(([name, entries]) => [name, hash(entries)])),
      sizes: Object.fromEntries(Object.entries(files).map(([name, entries]) => [name, entries.reduce((sum, entry) => sum + (entry[1] === "file" ? entry[2] : 0), 0)])),
      runnerExecutable: path.relative(candidate.dir, runtime.executablePath) };
    writeJsonAtomicSync(path.join(candidate.dir, "version.json"), record);
    return record;
  }
  activate(id, expected) {
    this.read(id);
    const current = this.pointer();
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("运行时版本指针已被另一任务修改，拒绝覆盖");
    if (current?.current === id) return;
    // 所有组件和清单已落盘并通过内容校验后，最后仅原子替换一个入口指针。
    writeJsonAtomicSync(this.pointerPath, { schemaVersion: FORMAT, current: id, previous: current?.current || null });
  }
  restore() {
    // 还原与准备共用跨进程互斥文件；不覆盖正在构建版本的入口。
    const lock = path.join(this.root, "prepare.lock");
    const fd = fs.openSync(lock, "wx", 0o600);
    try { this.restoreUnlocked(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  restoreUnlocked() {
    const pointer = this.pointer();
    if (!pointer?.previous) throw new Error("尚无完整运行时版本备份");
    this.read(pointer.previous);
    writeJsonAtomicSync(this.pointerPath, { schemaVersion: FORMAT, current: pointer.previous, previous: pointer.current });
  }
}

function resolveBundleDirectory(bundleDir) {
  const store = new RuntimeVersionStore(bundleDir);
  const pointer = store.pointer();
  return pointer ? path.join(store.directory(pointer.current), "bundle") : bundleDir;
}

module.exports = { RuntimeVersionStore, resolveBundleDirectory, inventory, copyInventory, hash };
