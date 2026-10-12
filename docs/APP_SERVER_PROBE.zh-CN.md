# 隔离 App Server 试验（D2）

这是可重复的开发诊断入口，不是 OpenCodex 的第二套生产后端。原 Gateway、官方 Electron、app-host、模型菜单和聊天链路不变。工具不新增网络路由，也不在启动器中自动运行。

## 运行

使用 Node 22.12 以上，在仓库根目录运行：

```text
node gateway/dev/app-server-probe.cjs --cli <已核验的CLI绝对路径> --sha256 <版本清单中的SHA256>
```

CLI 路径和 hash 都必须显式提供；不通过 PATH 搜索、不下载更新、不自动重试。SHA-256 只确认文件与所提供清单一致，不代替发布者签名或来源验证。退出码 0 表示本次受限试验通过，1 表示失败；stdout 是一份 JSON 摘要，不输出账号、历史正文、游标或 stderr 原文。

步骤为：校验文件 → 创建全新临时环境 → 读取版本 → 独立 stdio 启动 → initialize → initialized → 未登录检查 → D1 模型目录和空历史单页读取 → 退出和清理。各请求最长 5 秒，不自动翻页。收到取消或失败后也进入清理。

测试：

```text
node --test gateway/test/app-server-probe.test.cjs
pnpm test
```

测试只启动 Node 协议夹具，不依赖本机官方 CLI、真实账号或生产数据库。

## 数据与生命周期边界

- CODEX_HOME、HOME、USERPROFILE、AppData、XDG 目录、工作目录与临时目录均指向本次新建目录；环境不继承 API key、代理或 Node 加载钩子。临时配置要求文件式凭据、关闭分析和反馈；启动时使用 `--strict-config` 拒绝当前 CLI 不认识的配置字段。
- 初始化回报的 CODEX_HOME 必须匹配临时目录，account/read(refreshToken=false) 必须返回 account=null，历史必须为空；否则立即失败。
- 这里的“只读”指业务请求范围。CLI 启动仍可能在隔离目录创建日志、数据库和缓存。环境隔离不是操作系统安全沙箱，也没有建立网络命名空间或提供恶意 CLI 防护。
- 不创建/恢复线程、不发送聊天、不审批、不触发登录。模型列表成功仅代表可以读取目录，不代表可发送请求或拥有相应模型权限。
- 先关闭真实 stdin；必要时仅终止本工具创建的子进程，并等待 close 事件确认。只在确认退出后删除自己创建的临时根目录。
- 退出或目录清理未确认时返回失败，并保留 retainedPid/retainedRoot 供人工排查；不要按 codex 进程名称批量终止，更不能直接删除真实用户目录。

## 决策范围

| 能力 | 本试验覆盖 | 不能由此推出 |
| --- | --- | --- |
| Node 独立启动与初始化 | 固定 CLI、独立 stdio、临时环境 | 已替换生产启动链 |
| 模型目录 | D1 listModels 单页 | 账号权限、推理成功、官方模型菜单等价 |
| 最近历史 | D1 listRecentThreads，要求空目录 | 真实历史迁移、分页完整性、并发数据库安全 |
| 账号 | 确认未登录 | 生产登录、刷新凭据兼容 |
| 退出与取消 | 限时请求、关闭管道、确认进程退出 | 任意孙进程/恶意程序隔离 |
| 官方界面、发送、审批、终端、文件与插件 | 不覆盖 | 可移除 Electron 或直接把 app-host 换成 NDJSON |

只有经验证、功能不退化且有明确收益的能力才考虑逐项迁移。不得把本试验的启动毫秒数与完整官方界面启动时间直接对比，或据此承诺资源占用下降。

## 2026-10-13 固定 CLI 实测

Windows x64，CLI `0.162.0-alpha.17.2`，SHA-256 `d13914ced6c7af174d8d638db938284231227312104b06a25e9608c632a7daec`。同机连续三次使用不同临时目录，均确认未登录、读取到 8 项模型目录与 0 项历史；stdin EOF 后退出码为 0，close 已确认，临时目录已清理，stderr 为 0 字节。

| 次数 | spawn + initialize | 全流程（含 SHA-256、版本、清理） |
| --- | ---: | ---: |
| 1 | 757.82ms | 2994.49ms |
| 2 | 524.49ms | 1623.73ms |
| 3 | 434.75ms | 1430.98ms |

这是三次本机可重复性样本，不是冷启动基准，没有控制系统文件缓存，也没有与完整桌面做同功能对比。生产 Gateway 的 PID、CLI 就绪状态和兼容性健康均保持不变。其他平台由协议夹具测试覆盖，未声称在其上运行过此固定 Windows 二进制。

设计见 [D2 设计](superpowers/specs/2026-10-13-app-server-isolated-probe-design.md)。D1 仍然共用生产唯一 CLI，见 [D1 设计](superpowers/specs/2026-10-13-app-server-read-capabilities-design.md)。
