# Codex 26.1007 OWL / Windows 兼容性检查

检查日期：2026-10-11。

## 结论

**本机 Windows/OWL 启动链路已修复，网关、CLI 初始化及浏览器主界面已实测通过；完整功能仍未验证，不能标记为“完整兼容”。**

优化器将不匹配项记录为降级，而不是必然阻断网关启动。Git/worktree 的优化补丁不匹配，不等于相应业务功能已被证明失效。

初轮仅做源码审查、离线测试和只读预检。后续在用户授权安装、复用现有配置并修复启动后，加入下述补丁并运行了独立的 OWL 工作副本；没有修改官方安装，也没有发送模型测试消息。

## 后续启动修复与验收

| 阻塞 | 修复与证据 |
| --- | --- |
| Windows SideBySide 14001，runner 无法启动 | 对工作副本根目录的外部 `.manifest` 做普通读写重新落盘，首次复制和缓存命中都执行。原样字节重写后 `CreateActCtxW` 成功，实际 runner 进入 gateway 入口。机制尚未完全确定，不归因于签名或安全软件。 |
| `agents` 配置解析报 `expected struct AgentRoleToml` | 旧的非版本化 CLI `0.130.0-alpha.5` 抢在版本目录前被选中。调整候选顺序，优先现有版本目录，再回退旧路径；显式环境覆盖仍优先。隔离的同一模型/agents 配置在旧 CLI 失败、新 CLI `0.162.0-alpha.17.2` 成功，实际 app-server 握手也成功。没有删除或改写用户的 agents 字段。 |
| 登录后白屏，JS/CSS 返回 404 | Windows native realpath 对文件返回 MSIX 包缓存物理别名，根目录却返回逻辑路径，导致边界检查拒绝合法资源。Windows 改用 JS realpath，仍解析符号链接/目录联接并检查根目录边界；没有用字符串前缀或“失败即放行”绕过检查。 |

实机验收：仅本机监听，访问密码认证通过，浏览器显示聊天首页、输入框及模型选择器。未发送模型消息；账号远程功能、所有原生能力及完整业务流程不在本轮验收范围内。缓存重启复用了已处理的官方 bundle，CLI 仍为上述新版。

新增 9 项针对性回归覆盖 manifest 首次/缓存复制、CLI 候选顺序/回退、路径遍历/目录联接及 MSIX 别名，全部通过。重新执行下方原 7 个文件，以及 `portable-runtime-manifest.test.cjs`、`root-containment.test.cjs`、`static-assets.test.cjs`：**157 项，155 通过、2 失败、0 跳过**，并非全套测试全绿。

两项失败均在基线可复现：下方记录的 Windows Git fixture，以及 `static-assets.test.cjs` 的 `runtime compatibility page follows the public authentication locale`（旧的中文文案断言）。后者使用基线 `config.cjs` 在隔离进程复验仍失败；本轮没有改动或跳过这些断言。

本机安装使用原 2.1.0 发行包加可回滚的三文件补丁，不是新的上游正式发行版。修复只覆盖上述启动阻塞，后文列出的静态缺口仍需分别验证。

## 检查基线

| 项目 | 值 |
| --- | --- |
| OpenCodex | 2.1.0 |
| 上游提交 | `f6fd79ccffe2b631db99556e862b008cba04f5ab` |
| Codex 内部版本 | `26.1007.21434` |
| Windows Store 包版本 | `26.1007.2314.0`，x64 |
| 实际运行时 | OWL，入口 `ChatGPT.exe` |
| 官方 JS 入口 | `.vite/build/early-bootstrap.js` |
| 构建环境 | Node 24.14.0、pnpm 10.12.3、Windows |
| app.asar SHA256 | `c5fdef328cfa2ad9095786f9c3a7aaa447e68834d31299d6ef2592da02029038` |

检查结束时，官方 `app.asar` 的 SHA256 与检查前一致。报告不附带官方专有资源、用户目录、配置、日志或凭据。

## 初轮已执行的检查

- `pnpm install --frozen-lockfile --ignore-scripts`：通过；未执行 Electron 安装脚本。
- `pnpm run build:gateway`：通过，包括 TypeScript、浏览器 bundle、修改边界和版本检查。
- 离线测试：结果见下方测试记录。
- 实际版本的 `OfficialRuntimeOptimizer` 预检：通过依赖注入拦截全部写操作；只读取已提取的官方资源，不执行官方 JS。

### 离线测试记录

审查并执行了以下 7 个文件，**98 项，97 通过、1 失败、0 跳过**，不是全部测试套件：

```text
gateway/test/loopback-host.test.cjs
gateway/test/app-host-message-codec.test.cjs
gateway/test/http-utils.test.cjs
gateway/test/gateway-lifecycle.test.cjs
gateway/test/official-desktop-compat.test.cjs
gateway/test/official-runtime.test.cjs
gateway/test/official-electron-module-hook.test.cjs
```

使用普通 Node 子进程，清空继承环境后显式设置临时 home/config/runtime/profile/temp；没有启动 Electron。特别设置 `ELECTRON_OVERRIDE_DIST_PATH` 到未使用的隔离路径：此依赖版本在缺少二进制时，单纯 `require("electron")` 也可能运行安装下载逻辑，只有 `--ignore-scripts` 并不足够。测试只需要其导入，不使用真实可执行文件。

失败项：`official-desktop-compat.test.cjs:618` 的 `runtime optimizer bounds hidden gateway sidebar Git discovery without changing explicit timeouts`，断言位于第 731 行。预期缺失仓库的 code 128，实际得到 `{preflightDeadline: 1000, timeout: 1000}`。

定位指向测试 fixture 的平台路径假设：输入 `/cloud-missing` 使用 POSIX 风格，而生成的预检代码使用当前平台 `require("path")`。Windows 上 `path.normalize("/cloud-missing")` 为 `\\cloud-missing`，因此路径一致性条件使预检提前放行。这是本机 Windows 下的测试失败记录，**不是运行 Codex 26.1007 后出现的业务故障证据**。本次没有为凑齐绿灯改动或跳过该测试。

### 实际资源的补丁匹配

预检返回：

```json
{
  "nativePetComposition": "gateway-css-fallback",
  "nativePetPrewarm": "unsupported-layout",
  "macPushRegistration": "unsupported-layout",
  "patchedFileCount": 2,
  "unsupportedFiles": [
    "main-BklS_2Y2.js:prewarm,mac-push,worktree-shell-environment"
  ],
  "gitDiscovery": "gateway-coalesced",
  "worktreeShellEnvironment": "unsupported-layout"
}
```

`patchedFileCount` 在本次预检中表示**拟修改**两个文件，不表示写入了原资源。

| 位置 | 实际匹配情况 | 解读 |
| --- | --- | --- |
| Avatar `ensureWindow`、`prewarm` | 各 1 个匹配 | 部分子补丁可定位 |
| Avatar `restoreOpenState` | 标记存在，旧模式 0 匹配 | 新版增加 notch/visibility 判断；组合预热状态降级 |
| `worktree-shell-environment` | 标记存在，旧模式 0 匹配 | 新版改为方法委托，并引入 `signal` |
| macOS push 注册 | 标记存在，旧模式 0 匹配 | 不应当作 Windows 致命错误 |
| Git origin / local prefilter / background timeout | 各 1 个匹配 | 这部分静态适配可应用，但不等于功能端到端验证 |

对应实现：[OfficialRuntimeOptimizer.ts](../gateway/src/official/OfficialRuntimeOptimizer.ts)。

### Windows / OWL 启动链

1. **入口识别符合实际布局。** Windows manifest helper 找到 `ChatGPT.exe`；entry resolver 已接受 `early-bootstrap.js`。不能把兼容壳 `Codex.exe` 当成实际 runtime。
2. **ASAR integrity 处理使用工作副本。** 官方 EXE 存在 `INTEGRITY/ELECTRONASAR/1033` 资源，其 header hash 与 `app.asar` 一致。OWL 的 fuse 位于 `chrome.dll`，embedded integrity / ASAR-only 已开启。现有 runner 修补的是复制的 EXE，而不是官方安装；后续启动验收已通过，没有关闭 fuse。
3. **已确认复制时遗漏 OWL resources 配置。** `portable.cjs` 排除原 `resources` 后生成自己的 runner ASAR，因此不保留 `resources/owl-app.ini` 和 `resources/owl-electron-app.json`。顶层 `owl-shell-runtime.json` 与 `chrome.dll` 会复制。两个配置是否为原生启动必需项**尚未知**，不能直接断言会启动失败。
4. **stock Electron 不是等价替代。** 此版本官方 JS 使用 OWL 专属 runtime feature API；换一个普通 Electron 跑通不能证明 OWL 兼容。

实现依据：[布局识别](../gateway/runner/official-layout.cjs)、[入口解析](../gateway/src/official/OfficialRuntimeEntryResolver.ts)、[Windows 完整性处理](../gateway/runner/platform/windows-integrity.cjs)、[portable runner](../gateway/runner/platform/portable.cjs)。

### 官方 preload / 浏览器桥接契约

对比当前版本的 `preload.js`、renderer 消费端与 OpenCodex，主聊天入口并非空壳：

- `sendMessageFromView`、Worker 消息和订阅使用一致的通道；新版 `worker-request.request.id` 在递归路由识别范围内。
- `connect-app-host` 已有 MessagePort → WebSocket → `MessageChannelMain` 中继和结构化值编码。
- Sidebar bootstrap、shared-object、主题等有实现或明确 Web 降级。分块消息由 gateway 重组并回 ACK，不应因浏览器缺少同名 ACK 方法就误判缺桥。

但以下缺口在代码上可以确认；实际用户影响仍需端到端复现：

| 功能 | 静态发现 | 影响范围 |
| --- | --- | --- |
| 链接拖拽 | 缺少 `startLinkDrag` 实现；adaptive Proxy 却返回可调用函数，发送的方法名不是官方 `codex_desktop:start-link-drag` | renderer 可能先阻止默认拖拽，再调用无效入口；应明确返回 `undefined` 保留浏览器行为或补齐实现 |
| MCP 内嵌应用 sandbox | 官方 preload 转交 `event.ports`；gateway 的通用 `webContents.postMessage` hook 忽略 `transfer`，浏览器事件也未重建 ports | 现有 app-host 专用中继不等于覆盖 MCP sandbox 的 MessagePort 通信 |
| 远程 PiP 视频 | 官方 preload 有 `VideoDecoder` / `VideoFrame` 处理和转移；Web 侧未找到对应实现，合成事件也不具备消费者要求的 source/origin | 通用 JSON 转发不等价于视频管线；这并不证明普通聊天无法使用 |

普通 Worker IPC 的 JSON 保真性、方法业务契约和完整初始化仍未运行验收。`showContextMenu` 的 DOM 菜单回退、`startFileDrag=false` 等明确设计的 Web 降级，不列为“漏实现”。

实现依据：[浏览器 polyfill](../web-shell/internal/providers/codex-bridge-polyfill.js)（消息分发、bridge 对象及 adaptive Proxy）、[官方 runtime 桥接](../gateway/runtime/ipc/official-runtime.cjs)（app-host 专用通道、postMessage hook）、[ws-hub](../gateway/runtime/ipc/ws-hub.cjs)。本机版本的对照材料为 `preload.js` 和 `app-initial-b8e1c8014bb4.js`，未重新分发其源码。

## 初轮为什么没有直接启动现有用户环境

源码默认行为不等于无副作用测试环境：

- `CODEX_HOME` 默认可共享真实官方会话；网关 `HOST` 默认不是仅 loopback。
- 显式设置 `CODEX_DESKTOP_APP_PATH` 不会完全关闭 discovery：默认候选仍可能提前求值并扫描用户日志。有效缓存可以提前返回，但不如 explicit-only / fail-closed 模式可靠。
- runner 设置 `userData`，不代表 Electron `home/appData/logs/sessionData` 和原生 Known Folder 路径都隔离。
- 代理环境变量、`--disable-background-networking` 不能证明 Node、Rust app-server、原生模块或直接 socket 已禁止外联。

因此初轮没有为了“试一下”接入当前登录态、重启正在使用的官方客户端或修改宿主防火墙。后续实机安装是在用户明确授权复用配置后进行，不属于无副作用隔离测试。严格隔离启动验证应在无真实凭据、禁用外网的独立 OS 用户/虚拟环境内完成；路径重定向不是 OS 安全边界。

相关实现：[ASAR 扫描](../gateway/src/official/CodexAsarScanner.ts)、[runner 入口](../gateway/runner/shared/runner-source.cjs)、[隐藏运行时参数](../gateway/runtime/electron/hidden-runtime-command-line.cjs)。

## 复现只读优化预检

先构建 gateway。把以下代码保存到仓库根目录的临时 `.cjs` 文件，通过参数传入**已提取的官方资源副本**。不要调用会自动扫描、提取和写入的 `ensureOfficialBundle()` 作为只读检查。

```js
const fs = require("node:fs");
const path = require("node:path");
const { OfficialRuntimeOptimizer } =
  require("./gateway/dist/official/OfficialRuntimeOptimizer.js");

// 只读副本，全部写入保留在内存；不 require 或执行官方 bundle。
if (!process.argv[2]) throw new Error("必须指定已提取的官方资源副本目录");
const root = path.resolve(process.argv[2]);
const writes = new Map();
const fileSystem = {
  readDir: (...args) => fs.readdirSync(...args),
  readText: p => writes.get(p) ?? fs.readFileSync(p, "utf8"),
  writeFile: (p, source) => writes.set(p, source),
};
console.log(new OfficialRuntimeOptimizer({ fileSystem }).optimize(root));
console.log("拟修改：", [...writes.keys()].map(p => path.relative(root, p)));
```

## 后续验收门槛

1. 增加可验证的 explicit-only 安装选择及路径隔离，默认仅 loopback 并设置测试鉴权。
2. 检查 OWL 原生启动配置的复制规则；保持官方 runtime，不以 stock Electron 冒充等价测试。
3. 更新确实失配的补丁，处理链接拖拽、MCP sandbox ports 和 PiP 视频缺口，加入新版结构 fixture，保留旧版回归测试。
4. 在隔离环境中验证 gateway 启动、浏览器加载、主进程/worker 双桥和重连；确认实际 Electron 路径及监听地址。
5. 再分别验收会话、审批、终端、Git/worktree、文件附件、自动化、远程主机以及移动端交互。涉及登录和实际模型调用时另行授权。

在这些步骤完成前，构建成功和单元测试通过都不能替代“官方完整功能兼容”的结论。
