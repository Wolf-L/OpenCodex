const { parentPort } = require("worker_threads");
const { createCompatibilityService } = require("../compatibility/service.cjs");
const { createStaticAssetService } = require("./static-assets.cjs");

parentPort.on("message", (message) => {
  const id = message?.id;
  let compatibilityService = null;
  try {
    const i18nSnapshot = {
      locale: String(message?.locale || "en-US"),
      messages: { "web.remoteFile.downloadFile": String(message?.downloadMessage || "Download file") },
    };
    // 每份资源有独立的定位生命周期，避免 Worker 复用时旧失败污染新契约。
    // 不单独落盘，主线程仍负责聚合诊断和响应缓存。
    const patchReports = new Map();
    try { compatibilityService = createCompatibilityService(); } catch {}
    const patcher = createStaticAssetService({
      compatibilityService,
      publishStaticPoint: point => patchReports.set(point.id, point),
      getI18nSnapshot: () => i18nSnapshot,
      getOfficialBundle: () => null,
    });
    // 不回传初始化 ready 状态，以免覆盖其它资源已经产生的实际诊断。
    patchReports.clear();
    const bytes = message.data;
    const sourceData = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const data = patcher.patchOfficialAssetData(
      String(message.reqPath || ""),
      sourceData,
      { headers: { host: String(message.host || "") } }
    );
    const patched = data !== sourceData;
    const transferable =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : Buffer.from(data);
    // 摘要定位失败与成功都回传主线程，调试页不能把 Worker 的实际结果丢成“待检测”。
    parentPort.postMessage({ data: transferable, id, patched, patchReports: [...patchReports.values()] }, [transferable.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error), id });
  } finally {
    compatibilityService?.dispose();
  }
});
