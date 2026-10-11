# Linux Deployment Guide (Kali / Android Kernel / ARM64)

This guide covers Linux `arm64` and `x64`, with particular attention to **Kali GNU/Linux Rolling 2026.1, Linux 6.1.138-android14, aarch64**. This is a GNU/Linux deployment, not an Android APK. The target device has **not** been tested; a successful preflight is not device compatibility certification.

> An Android kernel string alone cannot tell us whether the environment is native Linux, rooted chroot, NetHunter, or PRoot. Rootless/PRoot restrictions on namespaces, seccomp, ptrace, and background processes may prevent Electron or Codex execution sandboxing from working. The scripts do not automatically disable security features. Stop deployment or use a supported Linux host if the necessary capabilities are unavailable.

## What This Adds

- Linux ARM64/x64 ELF architecture and executable-permission checks for Electron and the CLI; invalid explicit paths do not silently fall back.
- Linux support for `CODEX_CLI_PATH` and `CODEX_APP_SERVER_BINARY_PATH`, including ChatGPT and community package layouts.
- `linux:init` for private access configuration, read-only `linux:doctor`, and foreground `linux:start` with child-process cleanup.
- Reuse of an existing X11/KeX `DISPLAY`, or automatic display allocation through `xvfb-run` with xauth. No `-ac` access-control bypass.
- No systemd, FUSE, or AppImage requirement. Default listen address: `127.0.0.1:3737`; a password is required even for local access.
- ARM64 DEB/tar.gz packaging commands and native ARM64 CI. **Launcher packages do not include the official desktop runtime or account credentials.**

## 1. Check the Kali Userspace

Run these commands **inside Kali**, not directly in the outer Termux environment:

```bash
uname -sm
cat /etc/os-release
dpkg --print-architecture
node -p 'process.platform + "/" + process.arch + " node=" + process.versions.node'
id -u
```

For this target, expect `aarch64`, `arm64`, and `linux/arm64`. Requirements: **glibc, Node >=22.12.0 (24 LTS recommended), and pnpm 10**. An ARM64 kernel is insufficient by itself: do not mix in x64 Node, Windows files, or Termux's Android Node.

Use an ordinary user rather than root. A reported uid of 0 inside PRoot does not grant Android host root or namespace privileges. See the [official Kali NetHunter Rootless documentation](https://www.kali.org/docs/nethunter/nethunter-rootless/) for background on Rootless and KeX.

Keep the checkout, desktop runtime, and caches in Kali's private `$HOME`, not `/sdcard` or `/storage/emulated/0`: shared storage may forbid execution or lack required permissions and symlink support.

## 2. Install Dependencies

Use a Kali terminal with package-management permission. Deployment scripts do not install or alter system dependencies. If you are currently root inside Kali, omit `sudo` from these apt commands, then switch to an ordinary user to run OpenCodex.

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nodejs npm python3 make g++ \
  gpgv dpkg-dev xz-utils xvfb xauth dbus \
  libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libx11-xcb1 \
  libxss1 libdrm2 libxkbcommon0 libxshmfence1
```

These are common Kali rolling dependencies, not a guarantee that all future desktop libraries are covered. Follow the Kali repository and the downloaded desktop package's dependency declarations if names change. Do not run `ldd` directly on untrusted binaries. If apt provides an older Node, upgrade through a trusted installation method first.

Install pnpm without requiring global npm write access:

```bash
npm install --prefix "$HOME/.local" --global pnpm@10.33.2
export PATH="$HOME/.local/bin:$PATH"
node --version
pnpm --version
```

Repeat the PATH export in new terminals or add it to your own shell configuration.

## 3. Prepare a Matching Linux Desktop Runtime

OpenCodex is not just a Node HTTP service. Its hidden runtime needs Linux Electron, `resources/app.asar`, matching native `.node` modules, and the Codex CLI. **Installing only the npm Codex CLI, or copying only a Windows/macOS app.asar, is insufficient.**

Use a complete Linux ARM64 desktop package from a trusted source, or the community [codex-desktop-linux project](https://github.com/ilysenko/codex-desktop-linux). At the time this guide was checked, that project used a Linux `.deb` from a signed stable repository and supported amd64/arm64; it no longer used the old macOS DMG conversion workflow. See its [build and packaging documentation](https://github.com/ilysenko/codex-desktop-linux/blob/main/docs/build-and-packaging.md) for trust and build details. The community project is not an official OpenAI distribution.

The following builds a local application directory without installing a system service or starting the desktop:

```bash
mkdir -p "$HOME/src"
cd "$HOME/src"
git clone https://github.com/ilysenko/codex-desktop-linux.git
cd codex-desktop-linux
# Review the project's installation scripts and dependencies first. Do not bypass signature checks.
make build-app
```

The expected output is `$HOME/src/codex-desktop-linux/codex-app/`. Its current layout uses `ChatGPT` as the Electron entrypoint and includes `resources/codex`. Install any missing prerequisites according to the upstream instructions. Do not substitute unknown modified packages or disable verification.

- A natively installed community package usually lives in `/opt/codex-desktop`.
- For a trusted local ARM64 `.deb`, upstream supports `UPSTREAM_DEB=/absolute/path/...deb make build-app`. This bypasses signed-repository discovery: **you are responsible for verifying the package's provenance**.
- OpenCodex does not require `make run-app`, `make install-native`, or an update service.
- Optional third-party features are not enabled by default. OpenCodex directly reuses the ELF runtime and does not execute the community `start.sh` feature hooks; do not assume those desktop enhancements apply.

## 4. Install OpenCodex From Source

```bash
cd "$HOME/src"
git clone https://github.com/Wolf-L/OpenCodex.git
cd OpenCodex

# Headless source deployment uses the desktop Electron prepared above, not the Launcher development binary.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm run build

export CODEX_DESKTOP_APP_PATH="$HOME/src/codex-desktop-linux/codex-app"
```

The desktop ELF and CLI are discovered within this directory. Only nonstandard layouts need the following overrides, which **must point to actual ELF binaries, not shell wrappers**:

```bash
# Set these only after confirming that the files exist and are Linux ARM64 binaries.
# export CODEX_DESKTOP_EXECUTABLE_PATH="$CODEX_DESKTOP_APP_PATH/ChatGPT"
# export CODEX_CLI_PATH="$CODEX_DESKTOP_APP_PATH/resources/codex"
```

`CODEX_APP_SERVER_BINARY_PATH` takes precedence over `CODEX_CLI_PATH`. `unset` old overrides when returning to automatic discovery. Do not point the CLI override at Electron itself.

## 5. Initialize, Diagnose, and Start

In the same Kali terminal, from the OpenCodex checkout:

```bash
pnpm run linux:init       # Enter a Web password of at least 12 characters twice; input is hidden; existing files are preserved.
pnpm run linux:doctor     # Read-only: no Electron startup, model requests, or execution of inspected binaries.
pnpm run linux:start --dry-run
pnpm run linux:start
```

Startup does not rebuild automatically; run `pnpm run build` after updating source. `doctor` and `start` exit nonzero on ERROR; review WARN findings in the context of your device. You can run `node scripts/linux-doctor.cjs` before installing dependencies, but missing runtime/build/config errors are then expected.

Default state directory:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/opencodex/
  config.yaml        # Mode 0600; Web password in the gateway's existing sha256-v1 format.
  runtime/
  reports/
  cache/official-bundle/
  official-user-data/
```

Treat the hash file as a secret; do not upload it. `linux:init` does not handle model account passwords or modify `~/.codex`. OpenCodex still uses Codex account data in `CODEX_HOME` (default `~/.codex`). Authenticate your own account through a trusted client before using models: the Web password does not replace model-account authentication. Do not let the official desktop and OpenCodex operate on the same session concurrently.

For custom paths, use **the same environment variables during initialization, diagnosis, and startup**:

```bash
export OPENCODEX_LINUX_DATA_DIR="$HOME/.local/state/opencodex-kali"
# To reuse an existing configuration, it must contain a valid auth.password and have mode 0600.
# export CODEX_WEB_CONFIG_PATH="$HOME/private/opencodex.yaml"
```

Do not start with the example `your-password` placeholder. For automated initialization, `node scripts/linux-init.cjs --password-stdin` accepts input from protected stdin. Never put the password in command-line arguments, shell history, or environment templates.

## 6. Display and Sandboxing on Android Kernels

| Situation | Behavior / recommendation |
| --- | --- |
| Valid KeX/X11 `DISPLAY` | Reuses the existing display by default. |
| No `DISPLAY` | Uses `xvfb-run` with xauth, an automatic display number, and X11 TCP disabled; may use a temporary D-Bus session. |
| Force headless mode | `OPENCODEX_LINUX_HEADLESS=1 pnpm run linux:start`. |
| Use only an existing display | `OPENCODEX_LINUX_HEADLESS=0 pnpm run linux:start`; fails without `DISPLAY`. |
| Wayland only | Use X11/XWayland or force Xvfb. Wayland variables alone do not establish X11 readiness. |
| GPU/EGL startup errors | Explicitly try `OPENCODEX_LINUX_DISABLE_GPU=1`; Android GPU acceleration is not guaranteed. |
| Small or unavailable `/dev/shm` | Explicitly use `OPENCODEX_LINUX_DISABLE_DEV_SHM=1` for Chromium's temporary-file fallback; ensure a writable temporary directory and enough space. |
| uid 0 | Startup is rejected by default; prefer an ordinary user and a supported kernel. |
| PRoot / namespace / seccomp failures | Not simply a missing npm dependency; an ordinary user may still lack the required kernel features. Prefer a host with working sandbox support. |

**Headless operation does not require disabling the sandbox.** `OPENCODEX_LINUX_NO_SANDBOX=1` is an explicit, high-risk compatibility opt-in for that invocation. It passes `--no-sandbox` to the hidden Electron runtime and emits a warning; production use is not recommended. It weakens process isolation against malicious pages or dependencies. Xvfb, PRoot, and password authentication are not substitutes. See [Electron's sandbox documentation](https://www.electronjs.org/docs/latest/tutorial/sandbox/).

The scripts do not enable this switch automatically or modify system user namespaces, AppArmor, or setuid configuration. This switch also does **not** disable Codex's command-execution sandbox or change approval policy. The two sandbox layers have separate kernel requirements; tasks may fail even if the page opens. Understand the risks and isolate data before experimenting in a constrained environment. Do not make sandbox bypass the default for a publicly exposed service.

Ctrl-C stops the foreground service, forwards termination to the separate process group, and cleans up Xvfb, D-Bus, and child processes. Processes that refuse to exit are forcibly terminated after a grace period. You may run it manually in tmux, but Android power management can still terminate the entire Kali session; automatic background survival is not guaranteed.

## 7. Access From a Phone or Another Computer

On the same device, open **http://127.0.0.1:3737**. For other devices, prefer an already configured SSH tunnel:

```bash
# Run on the accessing device. Replace the Kali username/address and verify SSH login first.
ssh -N -L 3737:127.0.0.1:3737 user@kali-host
```

Then open the same localhost URL on that device. The scripts do not install or expose SSH.

If you explicitly need a trusted-LAN listener, use `HOST=0.0.0.0 pnpm run linux:start`. A Web password remains mandatory; configure firewall and HTTPS/VPN protection yourself. Password hashes and session tokens transmitted over HTTP still have authentication value: do not expose plain HTTP to the public Internet. Do not disable Web authentication to troubleshoot.

## 8. Optional ARM64 Launcher Packaging

For Android/Kali headless deployment, prefer the source entrypoint above. The GUI Launcher itself needs a display and working Chromium sandbox; when run as root it may exit before application code executes. A GUI package is not a substitute for diagnosis.

Build on native Linux ARM64 with development dependencies and Electron installed:

```bash
# If Electron binary download was previously skipped, use a separate build environment with a normal dependency installation.
pnpm install --frozen-lockfile
pnpm run launcher:pack:linux:arm64
pnpm run launcher:dist:linux:arm64
```

Outputs include `release/OpenCodex-<version>-linux-arm64.deb` and `.tar.gz`; tar.gz needs no FUSE. Existing `launcher:*:linux` commands retain their x64 default, with explicit x64 suffixes also available. CI uses separate native Linux x64 and ARM64 runners. Configuration does not mean a build has already succeeded or that the Android-kernel target has been tested. Packages still do not include the official runtime.

## 9. Troubleshooting and Shareable Reports

```bash
node scripts/linux-doctor.cjs --json > linux-doctor.json
```

Diagnosis does not read model keys, dump the full environment, or print passwords/hashes. Reports contain local paths and the kernel version; review and redact them before sharing.

| Error | Check first |
| --- | --- |
| `Expected a Linux ELF64` / `architecture mismatch` | Use a matching Linux desktop/CLI, not a wrapper, Windows exe, macOS file, or x64 package on ARM64. |
| Missing `app.asar` / CLI | Confirm the complete desktop package was unpacked and runtime/override paths are correct. |
| Existing file but `Permission denied` / `ENOENT` | Check execute permission, noexec mounts, and dynamic-loader compatibility. Use Kali's private filesystem; do not recursively chmod unrelated files. |
| `.node` / shared-library / ABI errors | Keep Electron, ASAR, and native modules from the same trusted Linux ARM64 package; do not substitute arbitrary Electron versions. |
| `Missing X server` / display errors | A stale DISPLAY may be invalid. Enter the correct KeX session or force Xvfb; ensure xauth is installed. |
| `No usable sandbox` / root / seccomp | Prefer an ordinary user and supported kernel. PRoot compatibility is not guaranteed; see the sandbox section. |
| Preflight passes but the page/tasks fail | Static checks do not validate Electron ABI, all dynamic libraries, account/network access, OWL functionality, or the Codex execution sandbox. |

Validation boundary: offline ELF/path/security-option tests, Windows regression checks, and local Kali WSL **x64** permission/process-lifecycle tests do not replace runtime verification on your **Android-kernel ARM64** device.
