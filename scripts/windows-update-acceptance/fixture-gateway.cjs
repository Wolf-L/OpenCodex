"use strict";
// 真实子进程仅验证监督、IPC 就绪与所有权，不声称覆盖产品 Gateway。
process.send({ ready: true });
process.on("message", message => {
  if (message?.type === "probe" && /^[a-f0-9]{32}$/.test(message.nonce)) process.send({ type: "probe-response", nonce: message.nonce });
});
setInterval(() => {}, 1000);
