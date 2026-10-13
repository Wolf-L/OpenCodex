# Windows 原生更新隔离验收

此工具在 Windows 宿主构建真实 NSIS 包，在 **Windows Sandbox 独立操作系统** 内运行。夹具沿用产品安装身份，所以绝不能在宿主启动生成的安装包。构建入口不会执行它们。

也支持一次性 **GitHub 托管 Windows runner**（明确拒绝 self-hosted）。CI 调用 `pwsh -File scripts/windows-update-acceptance/launch-ci.ps1`：它先构建，再建立全新的固定工作区、运行四项验收并检查最终结果。只有 `GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`、Windows 平台和显式 `--run-github-hosted` 同时成立时，来宾脚本才执行。最大总预算 20 分钟，证据在 `C:\AcceptanceOutput`；CI 应始终上传此目录及 `C:\OpenCodexAcceptance\results`，超时不盲目强杀进程。

```powershell
node scripts/windows-update-acceptance/build.cjs <全新的输出目录>
node --test launcher/test/windows-update-acceptance.test.cjs
```

需要仓库已安装的 Electron 42.0.1、electron-builder 和已有 NSIS 编译缓存。默认缓存为工作区 `work/windows-nsis-smoke/builder-cache`，可用 `ELECTRON_BUILDER_CACHE` 指定。输出含 `inputs/manifest.json`、四个安装器、外置 Electron Node 宿主和来宾脚本；已有 manifest 时拒绝覆盖证据。

将 inputs 以只读文件夹映射进 Sandbox，再由来宾复制到 `C:\OpenCodexAcceptance\inputs`。创建 `C:\OpenCodexAcceptance\ISOLATED-SANDBOX.json`：

```json
{"purpose":"opencodex-native-update-acceptance","isolated":true}
```

在来宾中使用以下命令（只适用于用户名 `WDAGUtilityAccount`）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\OpenCodexAcceptance\inputs\node-host\OpenCodexAcceptanceHost.exe' 'C:\OpenCodexAcceptance\inputs\guest-runner.cjs' --run-isolated
```

可将专用空输出目录映射为 `C:\AcceptanceOutput`，脚本会导出小型结果、事务日志与事件文件。安装目录、备份和注册表现场留在 Sandbox 中。每个事务最多等候 15 分钟；失败时不要把 `recovery-needed` 当作通过。

覆盖：损坏摘要在停服前拒绝；1.0.0 到 1.0.1 的真实升级与 ACK；1.0.2 延迟退出后的文件和注册表恢复；真实 NSIS 退出 13 的失败回退。每次回退比较完整应用清单和两个安装登记键，检查原进程退出、旧版重新运行，以及合成配置、账号、聊天哨兵未变。

失败场景须精确匹配预期错误；启动失败另核对本事务候选版本的真实启动和退出 42 事件，安装器失败必须为原生退出 13，不能以任意异常冒充。每次升级/回退后通过随机 nonce 向轻量 Gateway 发出真实 IPC 探测，收到对应响应后再核对父子进程完整身份与当前存活。CI 实时打印阶段，上传记录不含用户凭据。

三个产品模块 `self-update-controller.cjs`、`self-update-install.cjs`、`self-update-helper.cjs` 原样打包，manifest 留存其 SHA-256。更新助手、进程检查、NSIS、文件恢复与注册表恢复均使用原生实现。仅网络下载器被夹具替换，真实安装 API 仍重新核验安装包摘要；Gateway 为真实轻量子进程，通过真实 IPC 就绪。结果不代表公开发布下载、实际官方 Gateway／CLI、真实用户账号、断电恢复或签名验证。立即退出到无法捕获身份的场景应单独验收，不能由延迟退出结果推断。

备份文件系统另有 Windows 真实 Electron 普通模式回归：`node --test launcher/test/self-update-asar.test.cjs`。它使用有效的 `default_app.asar`，调用产品清单和复制原语，确认归档保持物理文件、原始字节和摘要不变。主进程使用 Electron 内置 `original-fs`，目录外 Node 助手使用原生 `node:fs`；不能通过删去 ASAR 或改用 Node 模式夹具掩盖差异。
