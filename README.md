# OpenCodex

**中文** | [English](docs/README_EN.md)

OpenCodex 是一个Codex Desktop中间层，它可以让你使用手机、平板或另一台电脑通过浏览器里访问并操作目标机器上的 Codex，适合在局域网或远程局域网环境中持续AI Coding。

---
天塌了😭刚准备开源，谁知道一觉醒来 ChatGPT App 就对 Codex 做了支持。

但对比官方还是有一些使用场景上的优势：

1. 无需魔法上网。
2. 无需外区Google Play/苹果账号。
3. 支持 Codex 的完整功能，例如文件树、终端、审查等，便于随时随地 AI Coding。

---

## 特性

- 通过浏览器访问目标机器上的 Codex，无需魔法网络和账号，支持手机、平板、电脑等多种设备。
- 原汁原味Codex使用体验。
- 支持本机访问、局域网访问和配合 Tailscale / ZeroTier / VPN 的远程局域网访问。
- 支持设置访问密码，避免无认证暴露。
- 提供桌面启动器，可可视化配置监听地址、端口和访问密码等。
- 启动时会自动更新到本地 Codex Desktop 版本，自动兼容新版本功能。
- 针对移动端提供优化。

<p align="center">
  <img src="docs/image/start.jpg" alt="OpenCodex start" width="23%" />
  &nbsp;
  <img src="docs/image/settings.jpg" alt="OpenCodex settings" width="23%" />
  &nbsp;
  <img src="docs/image/home.jpg" alt="OpenCodex home" width="23%" />
  &nbsp;
  <img src="docs/image/new.jpg" alt="OpenCodex new session" width="23%" />
</p>

## 环境要求

- Node环境
- pnpm
- 本机已安装 Codex Desktop（无需启动，但也支持同时使用）。
- macOS 或 Windows（Linux暂未测试）。

## 如何使用

### 桌面启动器

下载安装：

打开release下载安装包安装

本地调试：

```bash
pnpm install
```

```bash
pnpm run desktop:dev
```

生成 macOS 安装包：

```bash
pnpm run desktop:dist:mac
```

生成 Windows 安装包：

```bash
pnpm run desktop:dist:win
```

产物会输出到 `release/`。首次启动会随机选择一个可用端口，修改监听地址、端口或访问密码后会自动重启服务让配置生效。

> 使用前需要本机已安装 Codex Desktop。

### 命令行启动

如果只是临时调试，也可以通过命令行启动：

局域网：
```bash
pnpm install
PORT=3737 pnpm run web:dev
```

支持远程访问：
```bash
pnpm install
HOST=0.0.0.0 PORT=3737 pnpm run web:dev
```

`强烈建议设置访问密码和修改端口`。可以复制示例配置后编辑其中的密码：

```bash
cp config.example.yaml config.yaml
```

配置示例：

```yaml
auth:
  password: "你的密码"
```

启动后访问：

```text
http://127.0.0.1:3737
```

如果需要在其他设备访问，请使用 Launcher 展示的局域网地址，或配合 Tailscale、ZeroTier、企业自建 VPN 等方式实现远程局域网访问。

> 不建议把 OpenCodex 直接暴露到公网。

## 常见问题

### 第一次打开会话历史为空

第一次加载可能较慢，也会受到远程局域网网速影响。稍等一会后再刷新或重新进入即可。

### 启动后打不开页面

可以先确认服务是否正常：

```bash
curl http://127.0.0.1:3737/api/health
```

如果端口被占用，可以换一个端口：

```bash
PORT=3738 pnpm run web:dev
```

## 友链

[LinuxDo](https://linux.do/)
