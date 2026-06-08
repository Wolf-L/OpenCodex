# OpenCodex

[中文](../README.md) | **English**

OpenCodex is a middleware layer for Codex Desktop. It lets you use a phone, tablet, or another computer to access and operate Codex on a target machine through a browser, making it suitable for continuous AI Coding in LAN or remote LAN environments.

---

Bad timing😭 Just as this project was about to be open sourced, ChatGPT App added Codex support.

Compared with the official option, OpenCodex still has advantages in several usage scenarios:

1. No proxy network required.
2. No overseas Google Play / Apple account required.
3. Supports full Codex capabilities, including file tree, terminal, review, and more, making anytime-anywhere AI Coding easier.

---

## Features

- Access Codex on the target machine through a browser, with no proxy network or extra account requirements, and support for phones, tablets, computers, and other devices.
- Native Codex experience.
- Supports local access, LAN access, and remote LAN access with Tailscale / ZeroTier / VPN.
- Supports setting an access password to avoid unauthenticated exposure.
- Provides a desktop launcher for visual configuration of the listen address, port, access password, and more.
- Automatically updates to the local Codex Desktop version on startup, keeping compatibility with new-version features.
- Provides optimizations for mobile devices.

<p align="center">
  <img src="image/start.jpg" alt="OpenCodex start" width="23%" />
  &nbsp;
  <img src="image/settings.jpg" alt="OpenCodex settings" width="23%" />
  &nbsp;
  <img src="image/home.jpg" alt="OpenCodex home" width="23%" />
  &nbsp;
  <img src="image/new.jpg" alt="OpenCodex new session" width="23%" />
</p>

## Requirements

- Node.js environment.
- pnpm.
- Codex Desktop installed locally. It does not need to be running, and it can still be used at the same time.
- macOS or Windows. Linux has not been tested yet.

## How To Use

### Desktop Launcher

Download and install:

Open the release page, download the installer, and install it.

Local debugging:

```bash
pnpm install
```

```bash
pnpm run desktop:dev
```

Build a macOS installer:

```bash
pnpm run desktop:dist:mac
```

Build a Windows installer:

```bash
pnpm run desktop:dist:win
```

Artifacts are written to `release/`. On first startup, OpenCodex randomly selects an available port. After changing the listen address, port, or access password, it automatically restarts the service so the configuration takes effect.

> Codex Desktop must be installed locally before use.

### Command-Line Startup

For temporary debugging, you can also start OpenCodex from the command line.

LAN:

```bash
pnpm install
PORT=3737 pnpm run web:dev
```

Remote access support:

```bash
pnpm install
HOST=0.0.0.0 PORT=3737 pnpm run web:dev
```

`Setting an access password and changing the port are strongly recommended`. You can copy the example config and edit the password:

```bash
cp config.example.yaml config.yaml
```

Config example:

```yaml
auth:
  password: "your-password"
```

After startup, visit:

```text
http://127.0.0.1:3737
```

If you need to access it from another device, use the LAN address shown by the Launcher, or use Tailscale, ZeroTier, a company VPN, or a similar private network solution for remote LAN access.

> Directly exposing OpenCodex to the public Internet is not recommended.

## FAQ

### Chat history is empty the first time a session is opened

The first load can be slow and is also affected by remote LAN bandwidth. Wait for a while, then refresh or re-enter the session.

### The page does not open after startup

You can first check whether the service is running:

```bash
curl http://127.0.0.1:3737/api/health
```

If the port is already in use, switch to another port:

```bash
PORT=3738 pnpm run web:dev
```

## Links

[LinuxDo](https://linux.do/)
