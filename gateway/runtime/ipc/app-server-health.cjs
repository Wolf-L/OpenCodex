"use strict";

function createAppServerHealth() {
  const active = new Set();
  function track(child) {
    if (!child || typeof child.once !== "function") return child;
    const entry = { child, responded: false };
    active.add(entry);
    let pending = "", dropping = false;
    const onData = chunk => {
      // 只观察已有 stdout 协议，不发送额外请求；有界缓冲避免诊断放大输出内存。
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!dropping && line.length <= 1024 * 1024) {
          try {
            const value = JSON.parse(line);
            if (value && (typeof value.id === "string" || typeof value.id === "number") && Object.hasOwn(value, "result") && !value.error) entry.responded = true;
          } catch {}
        }
        dropping = false;
      }
      if (pending.length > 1024 * 1024) { pending = ""; dropping = true; }
    };
    const remove = () => { active.delete(entry); child.stdout?.off("data", onData); child.off("error", remove); child.off("exit", remove); };
    child.stdout?.on("data", onData); child.once("error", remove); child.once("exit", remove);
    return child;
  }
  function status() {
    const alive = [...active].filter(({ child }) => child.pid && child.exitCode == null && child.signalCode == null && !child.killed);
    return { activeCount: alive.length, ready: alive.some(entry => entry.responded) };
  }
  return { track, status };
}

module.exports = { createAppServerHealth };
