#!/usr/bin/env bash
set -euo pipefail

# 从公开 Release 安装已编译的无头包；桌面运行时从原厂 HTTPS 地址下载，不编译、不关闭沙箱。
if [[ "${1:-}" == --help ]]; then
  printf '%s\n' 'Usage: bash install-linux.sh' 'Run as a normal user inside Kali/Debian Linux; sudo is used only for apt dependencies.'
  exit 0
fi
if (( $# )); then printf 'Unknown argument: %s\n' "$1" >&2; exit 2; fi
if [[ "$(uname -s)" != Linux ]] || ! command -v dpkg >/dev/null; then
  printf '%s\n' '请在 Kali/Debian Linux 内执行，不是在 Windows 或 Termux 外层。' >&2; exit 1
fi
if (( EUID == 0 )); then
  printf '%s\n' '请切换 Kali 普通用户后执行；Electron 不能默认以 root 启动。' >&2; exit 1
fi

case "$(dpkg --print-architecture)" in
  arm64)
    arch=arm64
    runtime_sha=55fae1e3fb1d6069a90620e9e70737dcf8bf2255604d157e282cc6748a1baf49
    ;;
  amd64)
    arch=x64
    runtime_sha=276b5341c3d74b261d3ad52106f7fa7edde06841e4767fe2a40cb54099b1f3ed
    ;;
  *) printf '%s\n' '仅支持 arm64 / amd64 用户空间。' >&2; exit 1 ;;
esac
deb_arch="$(dpkg --print-architecture)"

# 只安装运行依赖，不需要 Git、pnpm、npm 或编译工具链。
sudo apt-get update
sudo apt-get install -y curl ca-certificates nodejs xz-utils xvfb xauth dbus \
  libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libx11-xcb1 \
  libxss1 libdrm2 libxkbcommon0 libxshmfence1
EXPECTED_ARCH="$arch" node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.platform !== "linux" || process.arch !== process.env.EXPECTED_ARCH ||
      major < 22 || (major === 22 && minor < 12)) {
    console.error("需要匹配架构的 Linux Node >=22.12.0；请先升级 Node。"); process.exit(1);
  }
'

# 每次使用新私有目录，保留已有版本、配置和账号；下载失败也不删除已有安装。
umask 077
mkdir -p "$HOME/.local/share/opencodex" "$HOME/.local/bin"
install_dir="$(mktemp -d "$HOME/.local/share/opencodex/install-2.1.0.XXXXXX")"
app_file="OpenCodex-2.1.0-linux-headless-$arch.tar.gz"
runtime_file="chatgpt_26.1007.21434_$deb_arch.deb"
release_base=https://github.com/Wolf-L/OpenCodex/releases/download/linux-2.1.0-mobile-cache
runtime_base=https://persistent.oaistatic.com/codex-app-prod/linux/deb/pool/main/c/chatgpt
curl --fail --location --retry 3 --proto '=https' "$release_base/$app_file" -o "$install_dir/$app_file"
curl --fail --location --retry 3 --proto '=https' "$release_base/SHA256SUMS" -o "$install_dir/SHA256SUMS"
# 精确选取当前架构的单个摘要，拒绝缺失、重复或非标准记录。
app_sha="$(awk -v file="$app_file" '$2 == file {print $1}' "$install_dir/SHA256SUMS")"
[[ "$app_sha" =~ ^[a-f0-9]{64}$ ]] || { printf '%s\n' 'Release 校验文件缺失或无效。' >&2; exit 1; }
curl --fail --location --retry 3 --proto '=https' "$runtime_base/$runtime_file" -o "$install_dir/$runtime_file"
(
  cd "$install_dir"
  printf '%s  %s\n' "$app_sha" "$app_file" "$runtime_sha" "$runtime_file" | sha256sum --check --strict -
)
test "$(dpkg-deb --field "$install_dir/$runtime_file" Architecture)" = "$deb_arch"
mkdir "$install_dir/app" "$install_dir/runtime"
tar -xzf "$install_dir/$app_file" -C "$install_dir/app"
dpkg-deb --extract "$install_dir/$runtime_file" "$install_dir/runtime"
runtime_asar="$install_dir/runtime/usr/lib/chatgpt/resources/app.asar"
test -s "$runtime_asar"
test -x "$install_dir/runtime/usr/lib/chatgpt/ChatGPT"
test -x "$install_dir/runtime/usr/lib/chatgpt/resources/codex"

# 只替换本脚本创建的启动入口，避免覆盖用户同名文件；绝不写入 ~/.codex。
launcher="$HOME/.local/bin/opencodex-linux"
marker='# OpenCodex prebuilt Linux launcher'
if [[ -e "$launcher" || -L "$launcher" ]]; then
  if ! grep -Fqx "$marker" "$launcher"; then
    printf '拒绝覆盖已有文件：%s\n安装文件保留在：%s\n' "$launcher" "$install_dir" >&2; exit 1
  fi
fi
launcher_tmp="$(mktemp "$HOME/.local/bin/.opencodex-linux.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n%s\n' "$marker"
  printf 'export CODEX_DESKTOP_APP_PATH=%q\n' "$runtime_asar"
  printf 'export OPENCODEX_LINUX_HEADLESS=1\n'
  printf 'exec %q "$@"\n' "$install_dir/app/opencodex"
} > "$launcher_tmp"
chmod 755 "$launcher_tmp"
mv -f -- "$launcher_tmp" "$launcher"

config_path="${CODEX_WEB_CONFIG_PATH:-${OPENCODEX_LINUX_DATA_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/opencodex}/config.yaml}"
if [[ ! -e "$config_path" ]]; then "$launcher" init; fi
# 部署入口按本分支的离线启动需求创建显式配置；不覆盖用户已关闭或无效的设置。
"$launcher" cache enable --if-missing
"$launcher" doctor
printf '\n安装完成。先保持 VPN/网络可用并启动：\n  %q start\n打开主界面和个人资料，确认 /api/health 中 desktop/preauth 覆盖及缓存写入后，再关闭 VPN 刷新验证。\n浏览器访问 http://127.0.0.1:3737\n' "$launcher"
