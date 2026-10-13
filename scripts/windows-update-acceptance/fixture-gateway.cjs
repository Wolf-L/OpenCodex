"use strict";
// 真实子进程仅验证监督、IPC 就绪与所有权，不声称覆盖产品 Gateway。
process.send({ ready: true });
setInterval(() => {}, 1000);
