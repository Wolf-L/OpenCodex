const crypto = require("node:crypto");

/** 只保留原 RPC 会话及未发出的下行帧；有任何序号缺口都失败，不重放已发送调用。 */
function createAppHostRecovery({
  send, closeSession,
  ttlMs = 90_000, maxOffline = 32, maxBytes = 1024 * 1024, maxFrames = 256,
  maxTotalBytes = 16 * 1024 * 1024,
  randomToken = () => crypto.randomBytes(24).toString("base64url"),
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const sessions = new Map(), offline = new Map();
  let totalBytes = 0, disposed = false;
  const session = ws => ws?.__opencodexAppHostRecovery || null;
  const reset = () => ({ version: 1, status: "reset" });
  function clearExpiry(s) {
    if (s.timer !== null) clearTimer(s.timer);
    s.timer = null; offline.delete(s.token);
  }
  function end(s, reason) {
    if (!s || s.closed) return;
    s.closed = true; sessions.delete(s.token); clearExpiry(s);
    totalBytes -= s.bytes; s.bytes = 0; s.queue.length = 0;
    // reset 是独立控制帧；失效的 RPC 不再发送带旧对象引用的数据。
    try { if (s.ws) send(s.ws, { type: "opencodex:app-host-reset", reason }); } catch {}
    try { closeSession(s, reason); } catch {} finally { s.ports.clear(); s.ws = null; }
  }
  function bind(s, ws) {
    clearExpiry(s); s.ws = ws; ws.__opencodexAppHostRecovery = s;
    for (const context of s.ports.values()) context.ws = ws;
  }
  function negotiate(ws, clientId, authKey, hello) {
    if (disposed || hello?.version !== 1) return null;
    const current = session(ws);
    if (current) {
      if (current.closed || current.ws !== ws) return reset();
      if (current.clientId !== clientId || current.authKey !== authKey ||
          (hello.token != null && hello.token !== current.token)) {
        end(current, "identity_changed"); return reset();
      }
      return { version: 1, status: "resumed", token: current.token };
    }
    if (typeof hello.token === "string") {
      const s = sessions.get(hello.token);
      // 知道 clientId 不足以恢复：随机标识与原认证上下文、页面身份必须同时一致。
      if (!s || s.closed || s.clientId !== clientId || s.authKey !== authKey) return reset();
      if (!Number.isSafeInteger(hello.sent) || !Number.isSafeInteger(hello.received) ||
          hello.sent !== s.incoming || hello.received !== s.outgoing) {
        end(s, "gap"); return reset();
      }
      bind(s, ws);
      return { version: 1, status: "resumed", token: s.token };
    }
    // 非空但错误类型的恢复标识不能意外退回创建新会话。
    if (hello.token != null) return reset();
    const s = { token: randomToken(), clientId, authKey, ws, ports: new Map(),
      incoming: 0, outgoing: 0, queue: [], bytes: 0, timer: null, closed: false };
    sessions.set(s.token, s); bind(s, ws);
    return { version: 1, status: "new", token: s.token };
  }
  function detach(ws) {
    const s = session(ws);
    if (!s || s.closed || s.ws !== ws) return !!s;
    s.ws = null; offline.set(s.token, s);
    s.timer = setTimer(() => end(s, "expired"), ttlMs); s.timer?.unref?.();
    while (offline.size > maxOffline) end(offline.values().next().value, "capacity");
    return true;
  }
  function transmit(s, payload) {
    if (s.outgoing >= Number.MAX_SAFE_INTEGER) { end(s, "sequence"); return false; }
    // 发送前推进位置；send 报错意味着交付不确定，不能把该帧放回离线队列重发。
    const sequence = ++s.outgoing;
    let accepted = false;
    try { accepted = send(s.ws, { type: "opencodex:app-host-frame", sequence, payload }); } catch {}
    if (!accepted) end(s, "send_failed");
    return accepted;
  }
  function sendFrame(ws, payload) {
    const s = session(ws);
    if (!s) return send(ws, payload);
    if (s.closed) return false;
    if (s.ws && s.ws.readyState !== s.ws.OPEN) detach(s.ws);
    if (s.ws) return transmit(s, payload);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes > maxBytes || s.queue.length >= maxFrames || s.bytes + bytes > maxBytes) {
      end(s, "capacity"); return false;
    }
    while (totalBytes + bytes > maxTotalBytes && offline.size) end(offline.values().next().value, "capacity");
    if (s.closed || totalBytes + bytes > maxTotalBytes) return false;
    s.queue.push({ payload, bytes }); s.bytes += bytes; totalBytes += bytes;
    return true;
  }
  function flush(ws) {
    const s = session(ws);
    if (!s || s.closed || s.ws !== ws) return;
    while (s.queue.length && !s.closed) {
      const item = s.queue.shift(); s.bytes -= item.bytes; totalBytes -= item.bytes;
      if (!transmit(s, item.payload)) return;
    }
  }
  function accept(ws, sequence) {
    const s = session(ws);
    if (!s || s.closed || s.ws !== ws) return false;
    if (!Number.isSafeInteger(sequence) || sequence !== s.incoming + 1) { end(s, "gap"); return false; }
    s.incoming = sequence; return true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const s of [...sessions.values()]) end(s, "shutdown");
  }
  return { negotiate, session, detach, send: sendFrame, flush, accept, dispose,
    fail(ws, reason = "protocol") {
      const s = session(ws);
      if (s?.ws === ws) end(s, reason);
    } };
}

module.exports = { createAppHostRecovery };
