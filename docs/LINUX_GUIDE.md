# Linux 部署指南（含 Kali / Android 内核 / ARM64）

本文适用于 Linux `arm64` / `x64`，重点覆盖 **Kali GNU/Linux Rolling 2026.1、Linux 6.1.138-android14、aarch64**。这是 GNU/Linux 部署方案，不是 Android APK。该目标机尚未实测，不能把预检通过等同于设备兼容认证。

> Android 内核版本不能单独判断你用的是原生系统、rooted chroot、NetHunter 还是 PRoot。Rootless/PRoot 的 namespace、seccomp、ptrace 和后台进程限制可能导致 Electron 或 Codex 执行沙箱不可用。脚本不会自动关闭安全机制；不满足条件时应停止部署或换用支持的 Linux 主机。

## 本次适配提供什么

- Linux ARM64 / x64 的 Electron、CLI ELF 架构与执行权限检查，错误路径不静默回退。
- Linux 下生效的 `CODEX_CLI_PATH` / `CODEX_APP_SERVER_BINARY_PATH`；支持 ChatGPT 和社区包布局。
- `linux:init` 创建私有访问配置；`linux:doctor` 只读诊断；`linux:start` 前台启动与统一进程清理。
- 有 X11 / KeX 时复用 `DISPLAY`，否则用带 xauth 的 `xvfb-run` 自动分配显示号；不使用 `-ac`。
- 不要求 systemd、FUSE 或 AppImage；默认监听 `0.0.0.0:3737`，允许局域网访问，本机和远程访问都必须输入密码。
- Linux ARM64 的 DEB / tar.gz 打包入口及原生 ARM64 CI。**启动器包不包含官方桌面运行时或登录凭据。**

## 1. 在 Kali 内确认用户空间

以下命令在 **Kali 的终端内**执行，不是在 Termux 外层直接运行：

```bash
uname -sm
cat /etc/os-release
dpkg --print-architecture
node -p 'process.platform + "/" + process.arch + " node=" + process.versions.node'
id -u
```

你的目标应为 `aarch64`、`arm64`、`linux/arm64`。需要 **glibc、Node >= 22.12.0（推荐 24 LTS）、pnpm 10**。仅 ARM64 内核不够，不能混用 x64 Node / Windows 文件 / Termux 的 Android Node。

尽量以普通用户运行，勿用 root 启动 Electron。PRoot 中显示 uid 0 不等于获得 Android 主机的真正 root 或 namespace 权限。NetHunter Rootless 与 KeX 的背景说明见 [Kali 官方文档](https://www.kali.org/docs/nethunter/nethunter-rootless/)。

仓库、官方运行时和缓存都放在 Kali 私有的 `$HOME` 中，不要放 `/sdcard` 或 `/storage/emulated/0`：共享存储可能禁止执行或不支持所需权限/符号链接。

## 2. 安装依赖

在有包管理权限的 Kali 终端安装；已有依赖不会被部署脚本自动改动。若当前就是 Kali 内的 root，下面两条 apt 命令去掉 `sudo`，之后仍应切换普通用户运行 OpenCodex。

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

## 8. ARM64 启动器打包（可选）

Android/Kali 无头部署优先使用上面的源码入口。桌面 Launcher 本身也需要显示与正常 Chromium 沙箱，root 下它可能在应用脚本运行前就退出；不要用 GUI 包代替诊断。

在原生 Linux ARM64、已安装开发依赖和 Electron 的环境构建：

```bash
# 若先前设置过 ELECTRON_SKIP_BINARY_DOWNLOAD，使用独立构建环境正常安装开发依赖。
pnpm install --frozen-lockfile
pnpm run launcher:pack:linux:arm64
pnpm run launcher:dist:linux:arm64
```

产物是 `release/OpenCodex-<version>-linux-arm64.deb` 和 `.tar.gz`；tar.gz 不依赖 FUSE。既有 `launcher:*:linux` 保持 x64 默认，x64 也有显式后缀入口。CI 分别使用原生 x64 / ARM64 Linux runner；配置存在不代表每次打包已经成功，也不意味着目标 Android 内核通过测试。包中仍不含官方运行时。

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
