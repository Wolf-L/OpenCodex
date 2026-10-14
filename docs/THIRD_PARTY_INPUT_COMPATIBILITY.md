# 第三方 Provider 输入兼容

此功能处理一种局部兼容问题：本地会话使用自己的第三方 API，但官方账号额度耗尽时，官方前端仍把发送按钮禁用。

## 使用

1. 在 OpenCodex 的“运行时兼容调试”页面（`/opencodex/runtime-compatibility`，或 `/settings/developer/runtime-compatibility`）开启“第三方 Provider 输入兼容”。默认关闭。
2. 已打开的旧版会话页面需要刷新一次。开关使用原有插件设置存储，仅作用于当前浏览器、当前站点；同源标签页会同步变化。
3. 关闭同一开关即可立即恢复原额度判断，不必修改配置或重新安装官方应用。

只有以下条件全部满足才解除这一项额度分支：

- 本地普通新会话或已知的本地会话；不包括云端、远程项目、Native Work 或 ASB Direct。
- 工作区配置已经解析完成（含当前 profile），提供显式 `model_providers.<id>.base_url` 和 `wire_api = "responses"` 或 `"chat"`。
- 新会话使用配置中明确的 `model_provider`；已有会话必须能确认其自身 Provider，不会猜测或退回当前默认值。
- Provider 不是 `openai` / `codex_vscode_copilot`，端点是合法 HTTP(S) URL，且不是官方 OpenAI/ChatGPT 域名。URL 含凭据、查询参数、片段等不明确配置不适配。

使用 `openai` 这个 Provider ID 配自定义端点、尚未获得会话路由、隐式配置以及其他无法确认的情况，均保留官方行为。

## 保留的限制

- 不增加官方额度、不伪造余额或服务端响应、不跳过认证或审批。
- 不改变真实提交路径；第三方服务自己的限额、认证失败等仍由该服务处理。
- 登录状态、工作区策略、线程加载/恢复、处理中等其他禁用条件不变；额度提示也不会被伪造为有余额。
- 官方模型会话不会因此解锁。

## 实现与版本边界

思路参考 [codex-input-unlock](https://github.com/1zero224/codex-input-unlock)，但不运行其 CDP 调试器或启动器。在 OpenCodex 的官方资源**响应副本**上，只替换本地 Composer 中的额度判定，官方安装文件不变。

当前审计的是 Windows / Linux 官方前端 `26.1007.21434`。完整 Composer、额度 atom 摘要及模块导入绑定都必须一致；未知或变化的契约不做修改，并由修改点 `static.cache.renderer.third-party-input-compat` 报告回退。版本号相同不代表资产必然匹配。

诊断修改点“已命中”表示资源转换已执行，不代表此浏览器已开启，也不代表真实发送成功。是否启用看页面开关；真实额度耗尽、第三方服务可用的端到端发送仍需在对应环境验证。

开关声明为内置浏览器插件 `opencodex.third-party-input-compat`，复用 `opencodex_web_settings_v1` 中的 `plugin.opencodex.third-party-input-compat.enabled`；只有字面量 `true` 才启用，不读取 API 密钥。

## 开发验证

```sh
pnpm test
node --test gateway/test/third-party-input-*.test.cjs
```

测试覆盖两个审计资产、严格 opt-in、会话/配置切换、官方端点排除、其余禁用分支保留、设置事件与跨标签页同步、Worker 成功/失败/复用诊断和响应缓存。资产夹具仅含被审计的导入、组件和额度 atom，不含账号、会话或凭据。
