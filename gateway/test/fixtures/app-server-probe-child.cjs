const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// 仅由测试的 spawn 包装器传入模式；生产入口没有替换 CLI 参数的选项。
const [mode, operation] = process.argv.slice(2);
if (operation === "--version") {
  if (mode === "version-timeout") setInterval(() => {}, 1000);
  else if (mode === "version-invalid") process.stdout.write("private diagnostic message\n");
  else process.stdout.write("codex-cli 1.2.3-test\n");
} else {
  const trace = path.join(process.env.CODEX_HOME, "trace.jsonl");
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  let initialized = false, welcomed = false;
  if (mode === "force-kill") process.on("SIGTERM", () => {});
  if (mode === "force-term" || mode === "force-kill") setInterval(() => {}, 1000);
  if (mode === "stderr-flood") {
    process.stderr.write("private stderr sentinel\n".repeat(100000));
    process.stdout.write(`${JSON.stringify({ method: "public-notification", params: { value: "x".repeat(200000) } })}\n`);
  }
  const lines = readline.createInterface({ input: process.stdin });
  if (mode === "bad-eof") lines.once("close", () => { process.exitCode = 9; });
  lines.on("line", line => {
    const frame = JSON.parse(line);
    fs.appendFileSync(trace, `${JSON.stringify(frame)}\n`);
    if (frame.method === "initialize") {
      // 用真实接收标记协调取消测试，避免按启动后固定毫秒猜测进程是否已就绪。
      if (mode === "cancel") { process.stderr.write("probe-fixture-initialize-received\n"); return; }
      if (mode === "timeout") return;
      if (mode === "exit") return process.exit(7);
      welcomed = true;
      return emit({ id: frame.id, result: { codexHome: mode === "wrong-home" ? path.join(process.env.CODEX_HOME, "wrong") : process.env.CODEX_HOME } });
    }
    if (frame.method === "initialized") { initialized = welcomed; return; }
    if (!initialized) return emit({ id: frame.id, error: { code: -1, message: "uninitialized" } });
    if (frame.method === "account/read") return emit({ id: frame.id, result: { account: mode === "account" ? { secret: "private account sentinel" } : null } });
    if (frame.method === "model/list") {
      if (mode === "response-error") return emit({ id: frame.id, error: { code: -2, message: "private response sentinel" } });
      return emit({ id: frame.id, result: { data: [{ id: "private model payload" }], nextCursor: "private cursor" } });
    }
    if (frame.method === "thread/list") return emit({ id: frame.id, result: { data: mode === "history" ? [{ id: "private history payload" }] : [], nextCursor: null } });
    process.exit(8);
  });
}
