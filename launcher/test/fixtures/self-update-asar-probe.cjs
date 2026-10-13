"use strict";
const nodeMode = !!process.env.ELECTRON_RUN_AS_NODE;
const app = nodeMode ? null : require("electron").app;
const fs = nodeMode ? require("node:fs") : require("original-fs");
const path = require("node:path");
const root = process.env.OPENCODEX_ASAR_PROBE_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith("opencodex-asar-backup-")) throw new Error("ASAR probe requires an isolated temporary root");
// 无窗口夹具在 ready 之前重定向所有可写配置与缓存，绝不使用产品用户目录。
for (const key of app ? ["userData", "sessionData", "logs", "crashDumps", "temp"] : []) {
  const dir = path.join(root, "profile", key);
  fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir);
}
const finish = code => app ? app.exit(code) : process.exitCode = code;
(app ? app.whenReady() : Promise.resolve()).then(async () => {
  const helper = require("./self-update-helper.cjs");
  if (nodeMode) {
    const journal = helper.readJson(path.join(root, "backup-journal.json"));
    const actual = await helper.inventory(journal.backupDir);
    const expected = helper.readJson(journal.inventoryFile);
    const verification = { nodeMode: true, locale: Intl.Collator().resolvedOptions().locale, expectedNames: expected.map(entry => entry.name), actualNames: actual.map(entry => entry.name), identicalInventory: JSON.stringify(expected) === JSON.stringify(actual) };
    try { await helper.verifyBackup(journal); verification.verified = true; }
    catch (error) { verification.verified = false; verification.error = error.message; }
    fs.writeFileSync(path.join(root, "external-result.json"), JSON.stringify(verification));
    process.stdout.write(JSON.stringify(verification) + "\n");
    finish(verification.verified ? 0 : 1); return;
  }
  const install = require("./self-update-install.cjs");
  const source = path.join(root, "source"), destination = path.join(root, "backup");
  const before = await helper.inventory(source);
  // 调用 prepareWindowsUpdate 实际使用的复制原语，不用测试自己的备份替代品。
  await install.__test.copyApplicationTree(source, destination);
  const after = await helper.inventory(destination);
  const sourceAsar = path.join(source, "resources/default_app.asar");
  const copiedAsar = path.join(destination, "resources/default_app.asar");
  const archiveEntry = before.find(entry => entry.name === path.join("resources", "default_app.asar"));
  const sourceDigest = await helper.digest(sourceAsar);
  const inventoryFile = path.join(root, "inventory.json");
  helper.atomicJson(inventoryFile, before);
  const journal = { backupDir: destination, inventoryFile, inventorySize: fs.statSync(inventoryFile).size, inventorySha256: await helper.digest(inventoryFile), registry: [] };
  helper.atomicJson(path.join(root, "backup-journal.json"), journal);
  await helper.verifyBackup(journal);
  const result = { electronNormalMode: !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE,
    physicalFile: fs.lstatSync(copiedAsar).isFile(), archiveBytes: fs.statSync(copiedAsar).size,
    identicalDigest: sourceDigest === await helper.digest(copiedAsar),
    physicalInventoryEntry: archiveEntry?.size === fs.statSync(sourceAsar).size && archiveEntry?.sha256 === sourceDigest && !archiveEntry?.directory,
    identicalInventory: JSON.stringify(before) === JSON.stringify(after), backupVerified: true,
    locale: Intl.Collator().resolvedOptions().locale, inventoryNames: before.map(entry => entry.name) };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result));
  finish(Object.values(result).some(value => value === false) ? 1 : 0);
}).catch(error => {
  fs.writeFileSync(path.join(root, "error.txt"), error.stack);
  process.stderr.write(error.stack + "\n"); finish(1);
});
