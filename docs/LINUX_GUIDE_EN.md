# Linux Deployment Guide (Kali / Android Kernel / ARM64)

This guide covers Linux `arm64` and `x64`, with particular attention to **Kali GNU/Linux Rolling 2026.1, Linux 6.1.138-android14, aarch64**. This is a GNU/Linux deployment, not an Android APK. The target device has **not** been tested; a successful preflight is not device compatibility certification.

Updated **2026-10-12 (Asia/Shanghai)**. [Public prebuilt release](https://github.com/Wolf-L/OpenCodex/releases/tag/linux-2.1.0-c710152); no GitHub login is needed to download it.

| Environment | Recommended path | Local compilation |
| --- | --- | --- |
| Headless Android-kernel Kali / ARM64 Linux | Quick install below | None; no pnpm or compiler |
| Linux desktop / KeX | [Section 8: graphical DEB / archive](#8-github-packages-and-local-builds) | None; no Node/pnpm needed for Launcher |
| Development | Source deployment, sections 1–7 | Node >=22.12.0 and pnpm 10 |

**OpenCodex packages do not embed the Codex/ChatGPT desktop runtime, accounts, passwords, or personal caches. The quick installer separately downloads and checks the complete prebuilt Linux desktop runtime, with no runtime compilation.** Headless packages include `./opencodex init|doctor|start`; graphical archives do not.

## Quick install: Android / Kali ARM64 without KeX or compilation

Run inside Kali as an ordinary user, not in outer Termux and not as root:

```bash
curl -fL https://raw.githubusercontent.com/Wolf-L/OpenCodex/main/docs/install-linux.sh -o /tmp/install-opencodex.sh &&
bash /tmp/install-opencodex.sh &&
"$HOME/.local/bin/opencodex-linux" start
```

Allow apt to install runtime dependencies, then enter a Web password of at least 12 characters. Open **http://127.0.0.1:3737**. The default also listens for LAN access: use trusted networks and no public port forwarding. Ctrl-C stops the service. On subsequent starts, run only the third command.

- [Installer source](install-linux.sh): detects `arm64` / `amd64`, downloads this release's headless archive and the vendor's `chatgpt_26.1007.21434_<arch>.deb` from `persistent.oaistatic.com`, validates fixed SHA-256 values, and extracts into `$HOME/.local/share/opencodex/`.
- Requires Node >=22.12.0, Xvfb and system libraries; apt installs these. Package names target Kali rolling / Debian trixie. Older distributions may need different library names or a newer Node.
- The complete desktop runtime download is approximately 475 MB; allow at least 3 GB of disk space. OpenCodex's headless archive is approximately 2.6 MB.
- Each installation gets a new directory. Existing account/configuration data is preserved; state remains in `${XDG_STATE_HOME:-$HOME/.local/state}/opencodex`, and `~/.codex` is not overwritten. The launcher command is replaced only when marked as owned by this installer.
- A read-only diagnostic runs at the end. Namespace/seccomp/sandbox failures require resolving Android/PRoot restrictions; sandboxing is never automatically disabled. Normal account authentication is still required.

For local access only, use `HOST=127.0.0.1 "$HOME/.local/bin/opencodex-linux" start`. To manually reuse an existing desktop runtime, extract `headless-arm64.tar.gz` into a fresh directory, set `CODEX_DESKTOP_APP_PATH`, then run `./opencodex init`, `./opencodex doctor`, and `./opencodex start`. The headless archive is not a DEB; do not use the graphical archive's `--strip-components=1` option with it.

**After quick installation, skip the source-build instructions in sections 1–7.** The display, sandbox and networking limits in sections 6–7 still apply.

> An Android kernel string alone cannot tell us whether the environment is native Linux, rooted chroot, NetHunter, or PRoot. Rootless/PRoot restrictions on namespaces, seccomp, ptrace, and background processes may prevent Electron or Codex execution sandboxing from working. The scripts do not automatically disable security features. Stop deployment or use a supported Linux host if the necessary capabilities are unavailable.

## What This Adds

- Linux ARM64/x64 ELF architecture and executable-permission checks for Electron and the CLI; invalid explicit paths do not silently fall back.
- Linux support for `CODEX_CLI_PATH` and `CODEX_APP_SERVER_BINARY_PATH`, including ChatGPT and community package layouts.
- `linux:init` for private access configuration, read-only `linux:doctor`, and foreground `linux:start` with child-process cleanup.
- Reuse of an existing X11/KeX `DISPLAY`, or automatic display allocation through `xvfb-run` with xauth. No `-ac` access-control bypass.
- No systemd, FUSE, or AppImage requirement. Default listen address: `0.0.0.0:3737`, allowing LAN access; both local and remote access require a password.
- x64/ARM64 DEB and tar.gz packaging with native CI for both architectures; see section 8 for downloads, architecture naming, and configuration paths.

## 1. Source Deployment: Check the Kali Userspace

Run these commands **inside Kali**, not directly in the outer Termux environment:

```bash
uname -sm
cat /etc/os-release
dpkg --print-architecture
node -p 'process.platform + "/" + process.arch + " node=" + process.versions.node'
id -u
```

For the ARM64 target, expect `aarch64`, `arm64`, and `linux/arm64`; an Intel/AMD 64-bit host normally reports `x86_64`, `amd64`, and `linux/x64`. Source requirements: **glibc, Node >=22.12.0 (24 LTS recommended), and pnpm 10**. An ARM64 kernel is insufficient by itself: do not mix in x64 Node, Windows files, or Termux's Android Node.

Use an ordinary user rather than root. A reported uid of 0 inside PRoot does not grant Android host root or namespace privileges. See the [official Kali NetHunter Rootless documentation](https://www.kali.org/docs/nethunter/nethunter-rootless/) for background on Rootless and KeX.

Keep the checkout, desktop runtime, and caches in Kali's private `$HOME`, not `/sdcard` or `/storage/emulated/0`: shared storage may forbid execution or lack required permissions and symlink support.

## 2. Install Dependencies

Use a Kali terminal with package-management permission. This section describes the manual source path; the quick installer above does install runtime dependencies through apt. If you are currently root inside Kali, omit `sudo` from these apt commands, then switch to an ordinary user to run OpenCodex.

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

## 7. Access from phones and other devices

`pnpm run linux:start` now allows LAN access by default. On another device on the same LAN, open **http://<Kali-device-LAN-IPv4>:3737** and enter the initialized Web password. For example, if Kali uses `192.168.1.10`, open `http://192.168.1.10:3737`. Local access remains available at **http://127.0.0.1:3737**. Do not use `0.0.0.0` as the browser address.

If an earlier shell still exports `HOST=127.0.0.1`, run `unset HOST` first, or explicitly start with:

```bash
HOST=0.0.0.0 pnpm run linux:start
```

**`0.0.0.0` listens on every IPv4 interface, not only LAN interfaces.** The scripts do not modify firewalls or routers. Allow TCP 3737 only from trusted LAN subnets, and do not forward the port from the public Internet. On multi-interface hosts, use `HOST=<actual-LAN-IPv4>` to bind only that address. Android/PRoot networking, firewalls, guest Wi-Fi, or AP isolation may still block connectivity; a configured listener does not prove device-to-device access works.

Use HTTPS/VPN or an SSH tunnel on untrusted networks. HTTP password hashes/session tokens remain authentication secrets; do not disable the Web password for troubleshooting.

To restore local-only access, optionally with an already configured SSH tunnel:

```bash
# On Kali
HOST=127.0.0.1 pnpm run linux:start

# On the accessing device; replace with your verified Kali SSH login.
ssh -N -L 3737:127.0.0.1:3737 user@kali-host
```

Then open `http://127.0.0.1:3737` on the accessing device. The scripts do not install or expose SSH.

## 8. GitHub Packages and Local Builds

### 8.1 Download and select the architecture

Prefer the [public release](https://github.com/Wolf-L/OpenCodex/releases/tag/linux-2.1.0-c710152), which requires no GitHub account. For the ARM64 graphical DEB:

```bash
curl -fLO https://github.com/Wolf-L/OpenCodex/releases/download/linux-2.1.0-c710152/OpenCodex-2.1.0-linux-arm64.deb
sudo apt install ./OpenCodex-2.1.0-linux-arm64.deb
```

This installs the graphical Launcher only; a complete desktop runtime and KeX/desktop are still required. Headless users should use quick install above, which also prepares the runtime. The release includes headless archives and `SHA256SUMS`.

The Actions route below is a developer fallback requiring GitHub login, not a prerequisite for normal installation.

Open [GitHub Actions](https://github.com/Wolf-L/OpenCodex/actions/workflows/build-release.yml), choose the required commit, confirm that its `Build Linux installers (x64/arm64)` job succeeded, and download the corresponding **Artifacts** at the bottom of the run:

| System / `dpkg --print-architecture` | Artifact name prefix | Version 2.1.0 files inside the outer ZIP |
| --- | --- | --- |
| Intel/AMD 64-bit / `amd64` | `opencodex-linux-x64-<full-commit-SHA>` | `OpenCodex-2.1.0-linux-amd64.deb`, `OpenCodex-2.1.0-linux-x64.tar.gz` |
| ARM64 / `arm64` | `opencodex-linux-arm64-<full-commit-SHA>` | `OpenCodex-2.1.0-linux-arm64.deb`, `OpenCodex-2.1.0-linux-arm64.tar.gz` |

**The x64 DEB uses `amd64` in its filename; the archive still uses `x64`.** Actions downloads normally require a GitHub sign-in. Extract the outer ZIP before installing the DEB. Keep the full commit SHA to distinguish builds sharing version 2.1.0 and verify the download source, not just the version. Artifacts expire according to their retention period; expired artifacts require a new build. Ordinary commits do not publish a Release automatically.

The corrected upload run is [Actions #2 / c710152](https://github.com/Wolf-L/OpenCodex/actions/runs/38182788309). It verifies that both formats exist and that the DEB's internal architecture matches, preventing a tar.gz-only upload from appearing complete. Both native architecture jobs succeeded. The [publication run](https://github.com/Wolf-L/OpenCodex/actions/runs/38188596554) reused those packages and added existing headless entrypoints from the same commit.

### 8.2 Install a DEB on Debian / Ubuntu / Kali desktops

Prepare a trusted, complete matching-architecture desktop runtime as described in section 3. Extract the artifact ZIP and run from the directory containing the DEB; ARM64 example:

```bash
dpkg --print-architecture
dpkg-deb --field ./OpenCodex-2.1.0-linux-arm64.deb Architecture
sudo apt install ./OpenCodex-2.1.0-linux-arm64.deb

# Run from an ordinary user's graphical session, without sudo.
CODEX_DESKTOP_APP_PATH="$HOME/src/codex-desktop-linux/codex-app" opencodex
```

On Intel/AMD hosts, replace both package filenames with `OpenCodex-2.1.0-linux-amd64.deb`. Apt installs declared dependencies, but cannot guarantee all libraries required by the separate desktop runtime. The DEB uses electron-builder's standard installation scripts, which may configure Chromium sandbox/AppArmor integration; this is distinct from the source `linux:start` script, which does not change system security settings.

Environment variables apply only to that terminal-launched process. If you later start from the application menu, ensure it can discover the same runtime. Follow the Launcher prompts to configure a Web password and start the gateway, then open its displayed URL. The Web password does not authenticate your Codex account.

### 8.3 Run the portable tar.gz without a system install or FUSE

Extract into a new private directory as an ordinary user, preserving permissions and symlinks; ARM64 example:

```bash
mkdir -p "$HOME/opt"
package_dir="$(mktemp -d "$HOME/opt/opencodex-2.1.0-arm64.XXXXXX")"
tar -xzf ./OpenCodex-2.1.0-linux-arm64.tar.gz --strip-components=1 -C "$package_dir"
cd "$package_dir"
CODEX_DESKTOP_APP_PATH="$HOME/src/codex-desktop-linux/codex-app" ./opencodex
```

For x64, use `OpenCodex-2.1.0-linux-x64.tar.gz`. Avoiding a system installation does not remove shared-library, display, or kernel-sandbox requirements. Keep `resources`, `.so` files, `chrome-sandbox`, and other bundled files together. Do not default to `--no-sandbox` when startup fails. Headless Android/Kali deployments should use the prebuilt headless quick install above; this GUI archive does not provide automatic Xvfb orchestration.

### 8.4 Configuration, upgrades, and startup snapshots

- The Launcher uses Electron's `userData` directory, normally `${XDG_CONFIG_HOME:-$HOME/.config}/OpenCodex` on Linux; confirm the actual runtime path. Its Web configuration is `runtime/config.yaml` and Launcher settings are `launcher-settings.json`.
- The source entrypoint defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/opencodex`, a different path. Do not run both entrypoints on port 3737 or against the same Codex session concurrently, and do not overwrite configurations to merge them.
- Upgrade DEB installations using the explicit new filename. Extract portable upgrades into a new directory rather than overwriting a running copy. Preserve configuration, account data, and rollback packages. Do not substitute Windows Electron/ASAR files or caches for the Linux runtime.
- New packages contain the [permanent startup snapshot implementation](OFFICIAL_STARTUP_CACHE.zh-CN.md), but it is **disabled by default and has no saved responses on a new machine**. Adaptation requires a verified desktop main-source fingerprint. The eight saved responses and no-VPN verification on Windows do not prove Linux compatibility or prewarming. Check `/api/health` → `officialStartupCache.supported`; unknown builds use the original network transport, so offline Linux operation is not guaranteed.
- If adaptation is supported and you want fixed snapshots, explicitly enable the feature in the **active entrypoint's runtime directory** and restart, following the cache document. Capture real responses through normal networking first. Token renewal and model requests are not cached. Never upload private state, `~/.codex`, Web password configuration, or response bodies to GitHub.

### 8.5 Build locally (optional)

Use a separate source build directory on native Linux ARM64, with development dependencies and Electron installed:

```bash
# If Electron binary download was previously skipped, use a separate build environment with a normal dependency installation.
pnpm install --frozen-lockfile
pnpm run launcher:pack:linux:arm64
pnpm run launcher:dist:linux:arm64
```

Outputs include `release/OpenCodex-<version>-linux-arm64.deb` and `.tar.gz`. Use `launcher:dist:linux:x64` for x64; its DEB filename ends in `linux-amd64.deb`. Existing `launcher:*:linux` commands retain their x64 default. CI uses separate native x64 and ARM64 runners. A successful build is not runtime verification on the Android-kernel target; see the [validation record](LINUX_VALIDATION.md).

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
