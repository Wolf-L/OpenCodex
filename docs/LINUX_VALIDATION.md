# Linux ARM64 适配验证记录

日期：2026-10-11（Asia/Shanghai）。目标：运行 Kali Linux 的 Android ARM64 测试环境。

## 已验证

- `pnpm run build:gateway`：通过（TypeScript、浏览器 bundle、模块边界和版本检查）。
- 新增 Linux runtime / deployment / packaging，加已有 auth-request / auth-rate-limit：Windows Node 24.14.0 下 **56 通过、5 个 Linux 专用测试跳过、0 失败**；本地 Kali WSL x64 / Node 24.19.0 下 **61/61 通过**。
- Linux 真正运行 Xvfb / xauth / D-Bus，用无账号的 Node 夹具代替 Electron；验证显示与会话启动、Xauthority 清理、进程退出、连续 Ctrl-C 及顽固孙进程清理。没有启动官方桌面。
- CLI 端到端隔离夹具：stdin 初始化、配置 0600、不覆盖已有文件、doctor JSON、start dry-run、不创建账号数据、错误 CLI 架构拒绝，均通过。虚拟 ELF 只被读取，从未执行。
- 更广的既有启动/官方运行时回归在 Windows 上：150 通过、3 跳过、1 个既有失败。失败为 `official-desktop-compat.test.cjs` 的 sidebar Git/POSIX 路径夹具，在未改动版本也可复现；不是本次新测试失败，也未宣称全量套件全绿。

## 尚未验证

- Android 内核 ARM64 环境中的实际 Electron/OWL 启动、native addon ABI、共享库、图形能力及 namespace/seccomp。
- Codex 登录、网络/模型调用、命令执行沙箱与审批功能。
- Android 后台保活与长时间稳定性。

2026-10-12 已取得原生 x64 / ARM64 构建成功与公开发布结果，详见下方记录。即便原生 ARM64 CI 成功，也不代表 Android 内核通过运行验证。

部署入口与安全限制见 [Linux / Kali 指南](LINUX_GUIDE.md)。首次在目标机上先运行 `node scripts/linux-doctor.cjs --json`；分享输出前检查其中的本地路径。不要上传访问配置、`~/.codex` 或环境变量完整转储。

## 默认局域网访问调整

随后按要求统一 Windows/macOS/Linux Launcher、通用 gateway 和 Linux 部署入口的默认监听地址为 `0.0.0.0`。显式本机模式/环境覆盖仍优先；健康检查和本机 PWA 地址继续使用回环。没有修改已有密码、目标机防火墙或已安装程序的配置。

- 重新构建通过。
- 网络默认值、Launcher UI 回退、认证、Linux 部署、生命周期、PWA 与日志定向回归：Kali WSL x64 **68/68 通过**。
- Windows 同组测试：63 通过、4 个 Linux 专用测试跳过，1 个既有 PWA POSIX 路径断言失败；该测试与对应实现未改动。
- 未实测目标机局域网连通性。`0.0.0.0` 是全部 IPv4 网卡监听，不是防火墙的“仅局域网”规则；应限制可信网段，不做公网端口映射。


## 2026-10-12：预编译产物与公开发布

- [原始构建 38182788309](https://github.com/Wolf-L/OpenCodex/actions/runs/38182788309)，提交 `c7101525282bd3c785b2bcaca0f372eaf161c0f1`：Linux x64、ARM64 均成功，含 gateway 构建、Linux 定向回归、DEB/tar.gz 产出与 DEB 架构校验。
- 修复 x64 DEB 使用 Debian `amd64` 文件名而上传规则寻找 `x64` 的遗漏；相关本地打包回归 **7/7 通过**。
- [发布流水线 38188596554](https://github.com/Wolf-L/OpenCodex/actions/runs/38188596554)：双架构原生准备任务与发布任务均成功，复用上述产物，没有要求目标设备重新编译。
- 无头包提取原产物里的已编译 gateway 和生产依赖，补入同一提交已有的 4 个 Linux 部署脚本与 `gateway/dev/run-gateway.cjs`；增加 `./opencodex init|doctor|start` 包装器。原生双架构均检查模块加载、Bash 语法、私有密码初始化与配置权限 0600；未启动真实账号或模型。
- [公开 Release](https://github.com/Wolf-L/OpenCodex/releases/tag/linux-2.1.0-c710152) 包含 2 个 DEB、2 个图形 tar.gz、2 个无头 tar.gz、SHA256SUMS。已通过无认证 API 核对公开状态，并实际下载公开校验文件与 x64 无头包。
- 公开下载的 x64 无头包校验和一致；在 Kali WSL 的全新隔离目录内完成密码初始化，doctor 的平台、Node、glibc、认证、已编译文件检查均通过。该夹具未安装桌面运行时，doctor 按预期报告运行时缺失并退出非零。快捷安装脚本通过 Bash 语法和 `--help` 检查；未在 Android 设备上执行整套 apt 安装/启动。
- 快捷安装脚本另行下载原厂 `chatgpt_26.1007.21434_<arch>.deb`，不会把运行时来源替换成社区编译。ARM64 原厂包已实际下载，SHA-256 为 `55fae1e3fb1d6069a90620e9e70737dcf8bf2255604d157e282cc6748a1baf49`；归档内 Electron、ASAR、CLI 路径为 `usr/lib/chatgpt/` 下的对应文件。固定摘要的上游元数据来源为 [codex-desktop-linux 的包清单](https://github.com/ilysenko/codex-desktop-linux/blob/main/nix/upstream-linux-packages.json)，下载地址属于 `persistent.oaistatic.com`。

上述检查不代表 Android 内核的 Electron、模型登录或命令执行沙箱已经验证，也不代表 Linux 启动响应缓存已经预热。

## 2026-10-13：手机 Kali ARM64 实际部署

- 在 Android ARM64 测试设备的 Kali chroot 中验证独立无头服务。基础代码为 `4f5ebe2`，使用原生 ARM64 CI `38334947387` 的已编译产物，并验证 Linux 目录准备修复 `eeef5dc`。
- 真实启动检查发现 runner 新增空目录 `extensions` 会导致全树摘要变化，source 与 bundle 摘要未改变。修复在 Linux 准备阶段预建该目录并纳入封存，仍严格拒绝启动后新增文件或其它内容变化。
- 手机 Node 24.21.0 / Linux ARM64 执行 portable recovery、portable manifest、runtime version store、runtime version integration、startup 五组定向回归：**48 通过、5 个 Windows 专用测试跳过、0 失败**。Windows 同组 **52 通过、1 个 Linux 专用测试跳过、0 失败**。
- 修复后完成真实 IPC/CLI 启动确认、版本指针发布和服务重启。独立复验 source、bundle、runner 三份完整摘要均通过，`extensions` 保持空目录。
- 局域网入口和本机健康接口可用，Gateway 正确指向新代码目录，CLI activeCount 为 1。7 项健康检查通过，兼容性点共 106 项、异常 0、待触发 43；这不代表所有前端交互点都已执行。
- 受保护账号、配置、缓存设置及控制器文件前后摘要一致。
- 本次确认范围为部署、运行时校验、重启和 HTTP 可达性，补充了上方历史记录中尚缺的目标机实际启动证据。没有发送模型消息，也没有新增验证手机输入法、全部前端交互、命令审批或长期后台保活。

## 2026-10-14：手机适配纳入正式代码

- `a43abe4` 将已审核的 ARM64 社区包原始/优化源码完整指纹纳入正式启动缓存适配器，继续要求唯一完整上下文及原生账号校验；未知源码仍拒绝适配。
- Linux 密码存储统一由 `linuxRuntimeArgs` 读取正式配置 `OPENCODEX_LINUX_PASSWORD_STORE=auto|basic`。部署选择可保存在版本目录之外的服务环境文件，无需修改 `run-gateway.cjs`，也不把所有 Linux 或无头部署自动降级为 `basic`。Launcher、无头启动及 doctor 共用该逻辑。
- Windows 全量测试 **1065 通过、13 跳过、0 失败**；手机 ARM64 定向测试 **141 通过、0 跳过、0 失败**，包含从实际安装包读取的原始源码及其优化源码变换/编译检查，未执行该测试夹具中的厂商代码。
- 测试设备使用纯仓库代码与构建输出运行 `a43abe4`，源码覆盖列表为空。运行时准备完成后确认 `coverage.desktop`、`coverage.preauth` 均为 `true`；显式配置 `basic` 时，主进程使用且仅使用一个 `--password-store=basic`。受保护配置文件摘要保持一致。
- 验收应检查健康接口所指主进程的参数边界，并等待准备锁释放，不能把 Electron 合并后的进程标题当成分隔的 argv。遗留准备锁只有在确认持有进程已退出且无准备进程后才可归档。
- 验收必须分开记录后台健康与浏览器可用性。新浏览器入口观察到登录后 Statsig 请求因上游网络失败而等待，不能据后台健康宣称全新浏览器或离线启动已通过；正式集成版的手机首页和设置页已通过浏览器验收。
