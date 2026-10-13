"use strict";
const path = require("node:path");
const ROOT = "C:\\OpenCodexAcceptance";
function assertIsolated({ username, root, args, marker, platform, githubActions, runnerEnvironment }) {
  // 多项独立限制同时满足后才准许运行；宿主构建步骤不会调用此入口。
  const sandbox = args.includes("--run-isolated") && username === "WDAGUtilityAccount";
  const hosted = args.includes("--run-github-hosted") && githubActions === "true" && runnerEnvironment === "github-hosted";
  if (platform !== "win32" || path.win32.resolve(root).toLowerCase() !== ROOT.toLowerCase() || (!sandbox && !hosted) || marker?.purpose !== "opencodex-native-update-acceptance" || marker?.isolated !== true)
    throw new Error("Native acceptance requires explicit Windows Sandbox or GitHub-hosted Windows isolation");
  return ROOT;
}
function assertChild(target, root = ROOT) {
  const normalized = path.win32.resolve(target);
  if (!normalized.toLowerCase().startsWith(path.win32.resolve(root).toLowerCase() + "\\")) throw new Error("Acceptance target is outside the guest workspace");
  return normalized;
}
function assertScenario(result, expected) {
  if (result.status !== expected.status || result.version !== expected.version || !result.originalExited || !result.runningVersionMatches || !result.sentinelsUnchanged || !result.registryMatches || !result.lockReleased || (expected.restored && (!result.applicationMatches || !result.failedInstallPreserved)))
    throw new Error(`Acceptance result failed: ${JSON.stringify(result)}`);
  return result;
}
module.exports = { ROOT, assertIsolated, assertChild, assertScenario };
