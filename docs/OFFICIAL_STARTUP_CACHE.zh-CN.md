# 官方启动响应的本机永久快照

这是显式启用的本机功能，默认关闭。首次正常联网取得成功响应后保存；相同账号、用户、设备和构建的请求后续优先读本地，不因时间过期、不后台刷新、不自动清理。VPN 开关不参与缓存选择。

## 启用与存放位置

在 OpenCodex 的 `runtime/official-startup-cache.json` 写入：

```json
{"schemaVersion":1,"enabled":true}
```

重启 OpenCodex 后生效。Windows 安装版通常位于 `%APPDATA%/OpenCodex/runtime`。独立设置文件不读取、不修改 `.codex/config.toml` 或 `auth.json`；不改变原有 ChatGPT 登录和自定义模型中转配置。

响应保存在 `runtime/cache/official-startup-responses`，属于本机私人数据，不应提交 Git、上传日志或对外共享。文件名使用哈希，正文仍可能包含原始账号、工作区与实验配置。POSIX 新目录/文件权限为 0700/0600；Windows 应位于仅本用户、管理员和 SYSTEM 可访问的目录。

设置 `enabled:false` 后重启可停用，已有文件保留。需要重新取得快照时，先停用/退出应用，把该缓存目录改名留作备份，再启用并联网重启。没有自动刷新或删除命令。

## 覆盖范围

精确匹配 `chatgpt.com`（及保留独立来源的 `gov.chatgpt.com`）上这些读取接口：

- GET `/backend-api/wham/accounts/check`
- GET `/backend-api/accounts/check/v4-2023-04-27`
- GET `/backend-api/me`（当前用户资料）
- GET `/backend-api/profiles/me`（当前账号个人资料）
- GET `/backend-api/accounts/{id}/settings`
- GET `/backend-api/accounts/{id}/workspace_policy`
- GET `/backend-api/accounts/{id}/workspace_policy/acknowledge`
- POST `/backend-api/wham/statsig/bootstrap`（只读初始化）
- POST `https://ab.chatgpt.com/v1/initialize`（完整 SDK 初始化结果）

不缓存模型请求、对话内容、上传、登录/令牌续期、设备验证、遥测、实际 POST 确认策略操作或其它任意 API。不缓存 401/403 等失败结果，也不生成“成功”、身份或实验开关。

只接受实际 HTTP 200、未重定向、有界 JSON。Statsig 额外校验完整 gates/configs/layers；不保存增量、无更新、live overlay 或恢复错误响应。SDK 反转 Base64 请求体仅用于生成键，不修改原请求；未知压缩透传。

## 身份、版本和快照语义

- 原生请求仍先执行官方认证、工作区路由和身份检查。命中前后还要执行原生网络策略、取消信号及当前账号复验；账户键同时包含账号和用户，不能只依赖工作区 ID。
- 不解析、持久化或伪造登录令牌。响应头仅保留 content-type/cache-control/etag/last-modified；Cookie、鉴权完整性更新及追踪头不重放。
- 本地命中带 `X-OpenCodex-Startup-Cache: hit` 和保存时间头，不表示服务器刚刚确认。
- 为跨启动复用，仅从键中移除明确的会话 ID/请求时间和 SDK 增量游标；保留用户、工作区、设备、语言、系统、版本和其它 targeting 字段。响应正文原样保存，因此会保留旧实验选择和旧会话归因。
- 账号权限、额度、工作区设置和实验可能过时。这是用户选择固定快照的结果；真实业务接口依然由服务器执行其验证。
- 官方构建和缓存 schema 隔离。升级或 targeting 变化后可能需要重新联网取得对应响应，旧文件不会自动删除。

## 原生适配与诊断

当前仅适配已核验的官方 `26.1007.2314.0` main 源码指纹，在内存中修改一个请求调用点。官方安装和抽取的源码文件保持原样；未知指纹/上下文放弃适配，使用原网络 transport。没有全局 fetch、代理、DNS、TLS 或认证绕过。

独立 preauth Statsig session 未适配；该版本 Windows 不运行这个初始化分支。原生配置要求读取、首次登录/续期及其它服务仍可能需要网络，所以不能把本功能描述为“全部官方网络请求永远离线”。

`/api/health` 的 `officialStartupCache` 显示启用、源码匹配、固定接口家族命中/写入数等汇总，不含请求头、URL、账号标识或正文。兼容性修改点为 `gateway.runtime.network.startup-response-cache`；安装成功和真正缓存命中分开记录。

## 验证

- 缓存、消息编解码和 WebSocket 专项：Windows 与 WSL 均 72 通过、1 个平台专属测试跳过；包含 7.3 MB 合成响应与浏览器无 Buffer 分支。
- 补充当前用户资料的两个 GET 后，Windows 同组专项 74 通过、1 项平台测试跳过；覆盖资料读写边界、账号隔离和跨进程重建后的原文回放。
- Windows 最终定向回归：242 通过、1 个 POSIX 权限测试跳过；另排除了既有报告文件 POSIX 权限断言和旧中文标题断言。
- 完整 Gateway 构建、类型/边界检查通过；对当前官方源码只做内存转换和语法编译检查，不执行供应商模块。
- 扩展回归中已有 13 个 CRLF 敏感的性能源码定位测试失败，未修改其功能代码，也不将此报告为全仓库测试通过。

真实联网写入、刷新命中和 VPN 关闭后的验证见 `WEB_REFRESH_PERFORMANCE.zh-CN.md` 的本机记录。

### 大响应重放注意事项

Statsig 初始化正文可能超过 7 MB。不能直接把完整字符串作为一个响应流块发送：旧消息编解码器的重复分组 Base64 正则可被这种大块触发 `RangeError: Maximum call stack size exceeded`，断开 AppHost 通道，使启动请求超时、账号订阅一直等待而呈现白屏。

缓存命中现在按需输出至多 64 KiB 的独立缓冲区，遵守流背压与取消。消息解码器使用线性字符/padding 校验，保持原有严格 Base64 语法而不消耗递归匹配栈。不修改保存的响应正文、实验值或账号身份。
