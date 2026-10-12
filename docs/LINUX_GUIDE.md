# Linux 部署指南（含 Kali / Android 内核 / ARM64）

本文适用于 Linux `arm64` / `x64`，重点覆盖 **Kali GNU/Linux Rolling 2026.1、Linux 6.1.138-android14、aarch64**。这是 GNU/Linux 部署方案，不是 Android APK。该目标机尚未实测，不能把预检通过等同于设备兼容认证。

更新日期：**2026-10-12（Asia/Shanghai）**。预编译安装包已[公开发布](https://github.com/Wolf-L/OpenCodex/releases/tag/linux-2.1.0-mobile-cache)，下载不需要登录 GitHub。

| 使用场景 | 推荐入口 | 本机编译 |
| --- | --- | --- |
| Android 内核上的 Kali / 无桌面 ARM64 Linux | 下方快捷安装：预编译无头包 | 不需要，不安装 pnpm / 编译工具 |
| Linux 桌面 / 已有 KeX | [第 8 节：DEB / 图形便携包](#8-github-安装包与本地打包) | 不需要 Node/pnpm 来启动 Launcher |
| 修改代码或自行构建 | 第 1–7 节源码部署 | 需要 Node >=22.12.0、pnpm 10 |

**OpenCodex 包不内置 Codex/ChatGPT 桌面运行时、账号、密码或个人缓存。快捷安装脚本会另行下载并校验完整的 ARM64/x64 Linux 桌面运行时，无需你编译它。** 无头包包含 `./opencodex init|doctor|start`；普通图形包没有该入口。

## 快捷安装：Android / Kali ARM64，无需 KeX、无需编译

在 **Kali 内的普通用户终端**执行（不是 Termux 外层，也不要用 root 运行整个脚本）：

```bash
curl -fL https://raw.githubusercontent.com/Wolf-L/OpenCodex/main/docs/install-linux.sh -o /tmp/install-opencodex.sh &&
bash /tmp/install-opencodex.sh &&
"$HOME/.local/bin/opencodex-linux" start
```

按提示授权 apt 安装运行依赖，并设置至少 12 字符的 Web 访问密码。随后打开 **http://127.0.0.1:3737**。默认也监听局域网；仅在可信网络使用，不做公网端口映射。Ctrl-C 停止。以后只需运行第三条命令；不必重复下载安装。

- [安装脚本源码](install-linux.sh)：自动检测 `arm64` / `amd64`，下载本 Release 的无头包和 `persistent.oaistatic.com` 上的原厂 `chatgpt_26.1007.21434_<arch>.deb`，按固定 SHA-256 验证，解压到 `$HOME/.local/share/opencodex/`。
- 需要 Node >=22.12.0、Xvfb 与系统共享库；脚本通过 apt 安装。包名面向 Kali rolling / Debian trixie 系列。旧版发行版可能需要调整库名或升级 Node。
- 完整桌面运行时下载约 475 MB，解压后更大；请留出至少 3 GB 可用空间。无头 OpenCodex 包约 2.6 MB。
- 每次安装使用新目录，保留已有配置与账号；状态仍位于 `${XDG_STATE_HOME:-$HOME/.local/state}/opencodex`，不会覆盖 `~/.codex`。同名启动命令只有确认由本脚本创建才替换。
- 安装结束会执行只读诊断。出现 namespace/seccomp/sandbox 错误时，先检查 Android/PRoot 限制；脚本不会关闭沙箱。首次账号认证仍按正常客户端流程完成。

只监听本机可用 `HOST=127.0.0.1 "$HOME/.local/bin/opencodex-linux" start`。已有桌面运行时、想手动部署的用户，可从 Release 下载 `headless-arm64.tar.gz`，解压到新目录，设置 `CODEX_DESKTOP_APP_PATH` 后运行 `./opencodex init`、`./opencodex doctor`、`./opencodex start`。不要把无头包当成 DEB 或套用图形压缩包的 `--strip-components=1`。

**完成快捷安装后可跳过第 1–7 节源码构建步骤。** 第 6–7 节的沙箱与网络限制仍适用。

> Android 内核版本不能单独判断你用的是原生系统、rooted chroot、NetHunter 还是 PRoot。Rootless/PRoot 的 namespace、seccomp、ptrace 和后台进程限制可能导致 Electron 或 Codex 执行沙箱不可用。脚本不会自动关闭安全机制；不满足条件时应停止部署或换用支持的 Linux 主机。

## 本次适配提供什么

- Linux ARM64 / x64 的 Electron、CLI ELF 架构与执行权限检查，错误路径不静默回退。
- Linux 下生效的 `CODEX_CLI_PATH` / `CODEX_APP_SERVER_BINARY_PATH`；支持 ChatGPT 和社区包布局。
- `linux:init` 创建私有访问配置；`linux:doctor` 只读诊断；`linux:start` 前台启动与统一进程清理。
- 有 X11 / KeX 时复用 `DISPLAY`，否则用带 xauth 的 `xvfb-run` 自动分配显示号；不使用 `-ac`。
- 不要求 systemd、FUSE 或 AppImage；默认监听 `0.0.0.0:3737`，允许局域网访问，本机和远程访问都必须输入密码。
- Linux x64 / ARM64 的 DEB、tar.gz 打包与原生双架构 CI；安装包下载、架构差异和配置目录见第 8 节。

## 安卓已安装但关 VPN 白屏：更新与预热

之前的缓存代码已经发布，但旧 Linux 包未创建启用配置，而且只识别 Windows 官方主程序。`enabled:false`、`reason:disabled`、`settingsReason:missing` 表示尚未启用，不能据此判断源码是否受支持。新版补齐了原厂 Linux `26.1007.21434` 主请求与 preauth Statsig 两条精确指纹适配。

1. 在运行旧服务的终端按 Ctrl-C 停止，保持 VPN/网络可用。
2. 重新执行本页开头的快捷安装命令。安装脚本会使用已核验的原厂运行时，保留账号、访问密码与旧安装目录，补建缺失的私有缓存设置；已有 `enabled:false` 或无效文件不会被覆盖。
3. 打开主界面和个人资料，正常完成自身账号认证。查看 `/api/health`：`officialStartupCache.enabled` 和 `supported` 为 true，Linux `coverage.desktop`、`coverage.preauth` 为 true，`cache` / `preauthCache` 中出现实际写入或命中后，再关闭 VPN 刷新验证。

如果此前主动关闭过缓存，明确重新启用：

```bash
"$HOME/.local/bin/opencodex-linux" cache enable
"$HOME/.local/bin/opencodex-linux" start
```

该设置需要重启。只查设置可运行 `opencodex-linux cache status`，关闭用 `cache disable`；均不会修改账号或删除已有响应。`supported:true` 只代表某条路径已适配，Linux 仍需同时检查两个 coverage 字段。个人快照必须在安卓本机正常联网取得，不从 Windows 复制、不包含在 GitHub 包中。模型请求和登录续期仍按正常流程联网。用户修改过的社区运行时如果指纹不同，会明确回退原生请求，不保证离线；快捷安装使用固定原厂包避免此差异。

## 1. 源码部署：在 Kali 内确认用户空间

以下命令在 **Kali 的终端内**执行，不是在 Termux 外层直接运行：

```bash
uname -sm
cat /etc/os-release
dpkg --print-architecture
node -p 'process.platform + "/" + process.arch + " node=" + process.versions.node'
id -u
```

你的 ARM64 目标应为 `aarch64`、`arm64`、`linux/arm64`；普通 Intel/AMD 64 位主机通常为 `x86_64`、`amd64`、`linux/x64`。源码部署需要 **glibc、Node >= 22.12.0（推荐 24 LTS）、pnpm 10**。仅 ARM64 内核不够，不能混用 x64 Node / Windows 文件 / Termux 的 Android Node。

尽量以普通用户运行，勿用 root 启动 Electron。PRoot 中显示 uid 0 不等于获得 Android 主机的真正 root 或 namespace 权限。NetHunter Rootless 与 KeX 的背景说明见 [Kali 官方文档](https://www.kali.org/docs/nethunter/nethunter-rootless/)。

仓库、官方运行时和缓存都放在 Kali 私有的 `$HOME` 中，不要放 `/sdcard` 或 `/storage/emulated/0`：共享存储可能禁止执行或不支持所需权限/符号链接。

## 2. 安装依赖

在有包管理权限的 Kali 终端安装；本节为手动源码路径；上方快捷安装脚本会调用 apt 安装运行依赖。若当前就是 Kali 内的 root，下面两条 apt 命令去掉 `sudo`，之后仍应切换普通用户运行 OpenCodex。

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nodejs npm python3 make g++ \
  gpgv dpkg-dev xz-utils xvfb xauth dbus \
  libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libx11-xcb1 \
  libxss1 libdrm2 libxkbcommon0 libxshmfence1
```

这是 Kali rolling 常见基础依赖，不保证覆盖未来官方桌面包的全部动态库；包名变化时以 Kali 仓库和所下载桌面包的依赖声明为准。不要对来源不明的二进制直接执行 `ldd`。若 apt 提供的 Node 太旧，应先通过可信的 Node 安装方式升级到上述版本。

无需全局 npm 写权限的 pnpm 安装方式：

```bash
npm install --prefix "$HOME/.local" --global pnpm@10.33.2
export PATH="$HOME/.local/bin:$PATH"
node --version
pnpm --version
```

后续新开终端也需要上述 PATH，或将该 PATH 设置加入自己的 shell 配置。

## 3. 准备匹配架构的 Linux 桌面运行时

OpenCodex 不是纯 Node HTTP 服务：隐藏运行时仍需 Linux Electron、`resources/app.asar`、配套 `.node` 原生模块和 Codex CLI。**只安装 npm 的 Codex CLI，或只拷贝 Windows/macOS 的 app.asar，都不够。**

可以使用可信来源的完整 Linux ARM64 桌面包，或社区项目 [codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)。截至本指南核对时，该社区项目采用签名稳定仓库中的 Linux `.deb`，支持 amd64/arm64，不再走旧的 macOS DMG 转换流程；详细信任与构建说明见其 [上游构建文档](https://github.com/ilysenko/codex-desktop-linux/blob/main/docs/build-and-packaging.md)。社区项目并非 OpenAI 官方发行。

以下构建的是本地应用目录，不安装系统服务、不启动桌面：

```bash
mkdir -p "$HOME/src"
cd "$HOME/src"
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
# 先审阅该项目的安装脚本和依赖说明；不要跳过签名校验。
make build-app
```

预期生成 `$HOME/src/codex-desktop-linux/codex-app/`。其当前布局以 `ChatGPT` 为 Electron 入口，并携带 `resources/codex`。若上游提示缺依赖，按它的说明补齐；不要使用来源不明的预改包或任意关闭校验。

- 已安装社区原生包时通常使用 `/opt/codex-desktop`。
- 已持有可信的 ARM64 `.deb` 时，可以按上游文档用 `UPSTREAM_DEB=/absolute/path/...deb make build-app`；本地包方式跳过签名仓库发现，**来源验证由你负责**。
- 不需要运行 `make run-app`、`make install-native` 或启用更新服务来使用 OpenCodex。
- 第三方可选特性默认不启用；OpenCodex 直接复用 ELF，不执行社区 `start.sh` 的 feature hooks，因此不要假设其桌面增强特性会生效。

## 4. 安装 OpenCodex 源码

```bash
cd "$HOME/src"
git clone https://github.com/Wolf-L/OpenCodex.git
cd OpenCodex

# 源码无头部署使用上一节的官方 Electron，无须再下载 Launcher 开发用 Electron。
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm run build

export CODEX_DESKTOP_APP_PATH="$HOME/src/codex-desktop-linux/codex-app"
```

默认自动发现该目录下的桌面 ELF 与 CLI；只有非标准布局才需要下面两个覆盖变量，**必须指向实际 ELF，不是 shell 包装器**：

```bash
# 示例：确认这些文件确实存在且为 Linux ARM64 后才设置。
# export CODEX_DESKTOP_EXECUTABLE_PATH="$CODEX_DESKTOP_APP_PATH/ChatGPT"
# export CODEX_CLI_PATH="$CODEX_DESKTOP_APP_PATH/resources/codex"
```

`CODEX_APP_SERVER_BINARY_PATH` 优先于 `CODEX_CLI_PATH`。改用自动发现时应 `unset` 旧覆盖变量，不要留下失效路径。不要让 CLI 指向 Electron 本身。

## 5. 初始化、诊断、启动

在同一个 Kali 终端、OpenCodex 仓库目录内：

```bash
pnpm run linux:init       # 两次输入至少 12 字符的 Web 密码，不回显；不覆盖已有文件
pnpm run linux:doctor     # 只读检查，不启动 Electron、不调用模型、不执行被检查的二进制
pnpm run linux:start --dry-run
pnpm run linux:start
```

启动不自动重编译；更新源码后必须重新 `pnpm run build`。`doctor` / `start` 遇到 ERROR 会退出非零；WARN 仍需结合设备实际情况处理。doctor 在依赖安装前也可直接运行 `node scripts/linux-doctor.cjs`，此时缺少运行时/构建/配置的错误是正常的。

默认状态目录：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencodex/
  config.yaml        # mode 0600，Web 访问密码的 sha256-v1 格式，与现有 gateway 一致
  runtime/
  reports/
  cache/official-bundle/
  official-user-data/
```

哈希文件也应当作秘密保护，不能上传。`linux:init` 不处理账号密码，不改写 `~/.codex`；OpenCodex 仍使用 `CODEX_HOME`（默认 `~/.codex`）中的 Codex 账号数据。首次模型访问还需要你按可信客户端流程完成自己的登录，Web 密码不能代替模型账号认证。不要让官方桌面与 OpenCodex 同时操作同一会话。

如需自定义位置，**初始化、诊断和启动必须使用相同的环境变量**：

```bash
export OPENCODEX_LINUX_DATA_DIR="$HOME/.local/state/opencodex-kali"
# 已有访问配置可显式复用；必须是有效 auth.password，且 chmod 600。
# export CODEX_WEB_CONFIG_PATH="$HOME/private/opencodex.yaml"
```

不要复制带 `your-password` 的示例配置后直接启动。自动化初始化可用 `node scripts/linux-init.cjs --password-stdin` 从受保护的 stdin 输入；不要把密码放在命令行参数、shell 历史或环境模板中。

## 6. Android 内核上的显示与沙箱

| 情形 | 行为 / 建议 |
| --- | --- |
| 已进入 KeX / X11 会话，`DISPLAY` 有效 | 默认复用现有显示，不创建 Xvfb |
| 没有 `DISPLAY` | 自动 `xvfb-run` + xauth，自动显示号并关闭 X11 TCP；可配合临时 D-Bus 会话 |
| 想强制无头，不受当前桌面影响 | `OPENCODEX_LINUX_HEADLESS=1 pnpm run linux:start` |
| 只想用已有显示 | `OPENCODEX_LINUX_HEADLESS=0 pnpm run linux:start`，无 `DISPLAY` 则失败 |
| 只有 Wayland | 当前部署入口优先 X11/XWayland，或强制 Xvfb；不把 Wayland 变量当作 X11 已就绪 |
| GPU / EGL 初始化失败 | 可显式设置 `OPENCODEX_LINUX_DISABLE_GPU=1` 后重试，不保证 Android GPU 加速 |
| `/dev/shm` 太小或不可用 | 可显式设置 `OPENCODEX_LINUX_DISABLE_DEV_SHM=1`，使用 Chromium 临时文件后备；需可写临时目录和足够空间 |
| uid 0 | 默认拒绝启动；优先使用普通用户和支持的内核 |
| PRoot / namespace / seccomp 失败 | 不是“缺一个 npm 包”；普通用户也未必能解决，建议迁移到支持沙箱的主机 |

**无头不等于需要关闭沙箱。** `OPENCODEX_LINUX_NO_SANDBOX=1` 是单次显式的高风险兼容开关，会把 `--no-sandbox` 传给隐藏 Electron，并输出警告；不建议生产使用。它降低恶意页面/依赖攻击时的进程隔离，不能将 Xvfb、PRoot 或普通密码认证变成替代沙箱。[Electron 官方沙箱说明](https://www.electronjs.org/docs/latest/tutorial/sandbox/)

脚本不会自动打开该开关、修改系统 user namespace / AppArmor / setuid 配置，也**不会**因此关闭 Codex 命令执行沙箱或更改审批策略。两层沙箱分别受内核能力限制；即便页面启动，执行任务仍可能失败。若必须在受限环境尝试，先理解风险并隔离数据，不要把禁用沙箱作为公开服务的默认配置。

按 Ctrl-C 停止前台服务，会向独立进程组转发退出信号，并清理 Xvfb / D-Bus / 子进程；拒绝退出的进程会在宽限期后强制终止。可手动放到 tmux 内运行，但 Android 的省电/后台杀进程策略仍可能结束整个 Kali 会话，不承诺自动保活。

## 7. 手机 / 其他设备访问

默认启动即允许局域网访问：

```bash
pnpm run linux:start
```

同一局域网的设备在浏览器打开 **http://<Kali设备的局域网IPv4地址>:3737**，然后输入初始化时设置的 Web 密码。例如设备地址为 `192.168.1.10` 时，访问 `http://192.168.1.10:3737`。同一设备仍可打开 **http://127.0.0.1:3737**。不要在浏览器里填 `0.0.0.0`，它只是监听地址。

如果以前导出过 `HOST=127.0.0.1`，需先 `unset HOST`，或明确启动：

```bash
HOST=0.0.0.0 pnpm run linux:start
```

**`0.0.0.0` 监听所有 IPv4 网卡，不只局域网。** 脚本不会修改防火墙或路由器；请仅允许可信局域网访问 TCP 3737，不要做公网端口映射。多网卡设备可用 `HOST=<实际局域网IPv4地址>` 限定监听网卡。Android/PRoot 的网络隔离、防火墙、Wi-Fi 访客网络或 AP 隔离可能阻止连接，允许监听不等于已验证目标设备间连通。

不可信网络应使用 HTTPS/VPN 或 SSH 隧道；HTTP 密码哈希/会话令牌仍具有认证价值，不要为排错关闭密码。

若希望恢复仅本机访问，或只通过已经配置好的 SSH 隧道接入：

```bash
# Kali 上仅监听回环
HOST=127.0.0.1 pnpm run linux:start

# 在访问端运行；替换成实际 Kali 用户/SSH 地址，先自行配置并验证 SSH 登录。
ssh -N -L 3737:127.0.0.1:3737 user@kali-host
```

然后在访问端打开 `http://127.0.0.1:3737`。脚本不安装或开放 SSH。

## 8. GitHub 安装包与本地打包

### 8.1 下载并选择架构

优先从 [公开 Release](https://github.com/Wolf-L/OpenCodex/releases/tag/linux-2.1.0-mobile-cache) 下载，无需 GitHub 账号。ARM64 图形 DEB：

```bash
curl -fLO https://github.com/Wolf-L/OpenCodex/releases/download/linux-2.1.0-mobile-cache/OpenCodex-2.1.0-linux-arm64.deb
sudo apt install ./OpenCodex-2.1.0-linux-arm64.deb
```

此命令仅安装图形 Launcher；仍需第 3 节的完整运行时和 KeX/桌面。无桌面设备请用文档开头的快捷安装，它会自动准备运行时。Release 还包含 `headless-arm64.tar.gz` / `headless-x64.tar.gz` 与 `SHA256SUMS`。

以下是开发者的 Actions 备用下载路径，只有这条路径需要登录 GitHub；它不是普通用户安装的前置步骤。

打开 [GitHub Actions 构建列表](https://github.com/Wolf-L/OpenCodex/actions/workflows/build-release.yml)，选择需要的提交，确认对应 `Build Linux installers (x64/arm64)` 为成功，再从页面底部 **Artifacts** 下载：

| 系统 / `dpkg --print-architecture` | Artifact 名称前缀 | 解开外层 ZIP 后的 2.1.0 文件 |
| --- | --- | --- |
| Intel/AMD 64 位 / `amd64` | `opencodex-linux-x64-<完整提交哈希>` | `OpenCodex-2.1.0-linux-amd64.deb`、`OpenCodex-2.1.0-linux-x64.tar.gz` |
| ARM64 / `arm64` | `opencodex-linux-arm64-<完整提交哈希>` | `OpenCodex-2.1.0-linux-arm64.deb`、`OpenCodex-2.1.0-linux-arm64.tar.gz` |

注意：**x64 的 DEB 名称是 `amd64`，压缩包名称仍是 `x64`**。下载 Actions Artifact 通常需要登录 GitHub；外层是 ZIP，不是直接可安装的 DEB。保留完整提交哈希来区分同为 2.1.0 的不同构建，核对下载来源，不要只看版本号。Artifacts 有保留期限，过期后需重新构建；此工作流的普通提交不会自动发布到 Releases。

本次修正上传规则的构建为 [Actions #2 / c710152](https://github.com/Wolf-L/OpenCodex/actions/runs/38182788309)。它增加了两种文件存在性和 DEB 内部架构检查，避免仅上传 tar.gz 却误报安装包完整。原生 x64 / ARM64 任务均已成功；公开发布由[发布流水线](https://github.com/Wolf-L/OpenCodex/actions/runs/38188596554)完成，复用原构建并补入同提交已有的无头入口。

### 8.2 DEB 安装（Debian / Ubuntu / Kali 桌面）

先按第 3 节准备可信、同架构的完整桌面运行时。解开 Artifact ZIP，并在含 DEB 的目录执行；ARM64 示例：

```bash
dpkg --print-architecture
dpkg-deb --field ./OpenCodex-2.1.0-linux-arm64.deb Architecture
sudo apt install ./OpenCodex-2.1.0-linux-arm64.deb

# 回到普通用户的图形会话，不要 sudo 启动。
CODEX_DESKTOP_APP_PATH="$HOME/src/codex-desktop-linux/codex-app" opencodex
```

Intel/AMD 主机将两处包名替换为 `OpenCodex-2.1.0-linux-amd64.deb`。`apt` 根据包声明安装依赖，但不能保证补齐另行准备的桌面运行时所需库。DEB 使用 electron-builder 的标准安装脚本，可能配置 Electron 的 Chromium 沙箱/AppArmor 集成；这不等于源码 `linux:start` 会修改系统安全设置。

环境变量只传给这次从终端启动的程序；若之后改为应用菜单启动，必须保证它同样能发现桌面运行时。在 Launcher 界面按提示配置 Web 访问密码、启动网关，再打开它显示的地址；不要把 Web 密码当作 Codex 账号登录。

### 8.3 tar.gz 便携运行（无需 root 安装、无需 FUSE）

在普通用户的私有目录中解压到一个新目录，保留包内权限与符号链接；ARM64 示例：

```bash
mkdir -p "$HOME/opt"
package_dir="$(mktemp -d "$HOME/opt/opencodex-2.1.0-arm64.XXXXXX")"
tar -xzf ./OpenCodex-2.1.0-linux-arm64.tar.gz --strip-components=1 -C "$package_dir"
cd "$package_dir"
CODEX_DESKTOP_APP_PATH="$HOME/src/codex-desktop-linux/codex-app" ./opencodex
```

x64 使用 `OpenCodex-2.1.0-linux-x64.tar.gz`。这里只是不需要安装到系统目录，并不免除共享库、图形显示和内核沙箱要求。不要删除 `resources`、`.so`、`chrome-sandbox` 等配套文件，也不要在失败时默认加 `--no-sandbox`。无头 Android/Kali 使用本页开头的预编译无头包；GUI 压缩包不会自动提供该入口的 Xvfb 编排。

### 8.4 配置、更新与启动响应缓存

- Launcher 使用 Electron 的 `userData` 目录（Linux 通常是 `${XDG_CONFIG_HOME:-$HOME/.config}/OpenCodex`，以实际运行目录为准）；访问配置为其下 `runtime/config.yaml`，启动器设置为 `launcher-settings.json`。
- 源码入口默认使用 `${XDG_STATE_HOME:-$HOME/.local/state}/opencodex`，与 Launcher 不是同一套路径。两种入口不要同时占用 3737 或操作同一 Codex 会话，也不要覆盖式合并配置。
- 升级 DEB 时安装新的明确文件名；便携包解压到新目录再启动，不覆盖正在运行的目录。保留已有配置、账号和回滚包，不复制 Windows 的 Electron/ASAR 或缓存来替代 Linux 运行时。
- 新包包含[永久启动响应缓存代码](OFFICIAL_STARTUP_CACHE.zh-CN.md)，但新机器**默认未启用、没有已保存响应**。当前适配针对已经核验的官方主进程源码指纹；Windows 实机的 8 条缓存和免 VPN 验收不代表 Linux 构建匹配或已预热。先确认启用配置，再查看 `/api/health` 的 `officialStartupCache.coverage` 与实际写入/命中数。新版支持已核验的 Linux 主程序和 preauth；未知构建仍回到原网络请求。
- 确认适配受支持后，如需固定快照，按缓存文档在**当前入口的 runtime 目录**显式启用并重启，首次正常联网保存真实响应；不保存登录续期或模型请求。私有目录、`~/.codex`、密码配置和响应正文均不要上传 GitHub。

### 8.5 自行构建（可选）

在原生 Linux ARM64、已安装开发依赖和 Electron 的独立源码构建目录执行：

```bash
# 若先前设置过 ELECTRON_SKIP_BINARY_DOWNLOAD，使用独立构建环境正常安装开发依赖。
pnpm install --frozen-lockfile
pnpm run launcher:pack:linux:arm64
pnpm run launcher:dist:linux:arm64
```

产物是 `release/OpenCodex-<version>-linux-arm64.deb` 和 `.tar.gz`。x64 使用 `launcher:dist:linux:x64`，其中 DEB 后缀为 `linux-amd64.deb`；既有 `launcher:*:linux` 保持 x64 默认。CI 分别使用原生 x64 / ARM64 runner。构建成功不等于目标 Android 内核上的运行验证，详细结果见 [Linux 验证记录](LINUX_VALIDATION.md)。

## 9. 排错与可分享报告

```bash
node scripts/linux-doctor.cjs --json > linux-doctor.json
```

诊断不读取模型密钥、不转储整个环境、不输出密码或哈希；它会包含本地路径/内核版本，分享前仍请人工脱敏。

| 错误 | 优先检查 |
| --- | --- |
| `Expected a Linux ELF64` / `architecture mismatch` | 安装同架构 Linux 桌面/CLI，不要指向包装脚本、Windows exe、macOS 文件或 x64 包 |
| 找不到 `app.asar` / CLI | 完整桌面包是否解包，`CODEX_DESKTOP_APP_PATH` 与覆盖路径是否正确 |
| 有文件却 `Permission denied` / `ENOENT` | 执行权限、noexec 挂载、动态加载器是否匹配；移到 Kali 私有文件系统，勿盲目 chmod 全盘 |
| `.node` / shared library / ABI 错误 | 保持 Electron、ASAR、原生模块来自同一个受信的 Linux ARM64 包，不用任意 Electron 替代 |
| `Missing X server` / display 错误 | 旧 DISPLAY 可能失效；进入正确 KeX 会话或强制 Xvfb，确认 xauth 已安装 |
| `No usable sandbox` / root / seccomp | 优先普通用户与受支持内核；PRoot 不保证可运行，参见沙箱章节 |
| 预检成功但页面/任务失败 | 预检只读静态检查，不验证 Electron ABI、运行库完整性、账号网络、OWL 功能或 Codex 执行沙箱 |

验证边界：本次改动已覆盖离线 ELF/路径/安全选项测试、Windows 回归检查，以及本地 Kali WSL **x64** 的权限/进程启动与退出测试；它们不能替代你这台 **Android 内核 ARM64** 设备上的运行验证。
