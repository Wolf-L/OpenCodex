# 第四阶段 A：App Server 传输实现解耦

日期：2026-10-13（Asia/Shanghai）  
基线：`183a49237deb297869e321196c03991e982f449f`，分支 `fix/runtime-recovery`  
状态：用户已确认渐进解耦方向；本设计稿待审阅，尚未开始实现。

## 1. 目标与边界

把通用 App Server 协议传输从智能路由模块中抽离，使传输层可以脱离 Auto 分类策略独立测试和复用。本阶段保留当前官方 Electron、CLI 子进程、网页与 IPC 路径，只调整实现依赖，并加强进程替换时的隔离。

**本阶段不等于“移除 Electron”或“网页直连独立 App Server”。** 不增加第二个 CLI 进程、后端切换开关、新 HTTP/WebSocket 入口或账号初始化流程；不迁移账号、配置、会话数据库，不改变模型选择、审批权限或发送语义。不引入新依赖。

实现通过验证后，沿用已授权交付流程：备份安装文件、更新本机、重启、核验文件与服务、实际网页复测。设计稿阶段不更新或重启应用。

## 2. 已核验的现状

以下定位以基线提交为准，而非对未来 OpenAI 协议版本的承诺：

| 位置 | 当前职责与耦合 |
| --- | --- |
| [model-router/transport.cjs](../../../gateway/runtime/model-router/transport.cjs)，约 715 行 | 同时包含 NDJSON/UTF-8 分帧、流代理、请求关联、通知等待、队列排序、子进程替换，以及分类线程隔离/回收策略。 |
| [model-router/service.cjs](../../../gateway/runtime/model-router/service.cjs)：164、651、666 | 创建 transport，向官方 Runtime 暴露装饰器，向 classifier 提供内部请求能力；销毁时目前调用 `rejectPending`。 |
| [plugins/service.cjs](../../../gateway/runtime/plugins/service.cjs) | 组装模型路由服务及兼容性诊断；开关控制 Auto 行为，不能据此关闭整个传输连接。 |
| [server.cjs](../../../gateway/runtime/server.cjs)：848–870 | 先创建插件服务，把装饰器交给官方 Runtime，再把 `modelRouter.transport` 注入历史预览。 |
| [history-preview.cjs](../../../gateway/runtime/history-preview.cjs)：44–77 | 依赖 `isAttached`、`request`，并过滤内部分类线程；没有自行管理子进程。 |
| [ipc/official-runtime.cjs](../../../gateway/runtime/ipc/official-runtime.cjs) | 官方 Bootstrap 仍负责启动 CLI；捕获其 stdio 后装饰。另有 Electron MessagePort/app-host 中继，不能用 NDJSON transport 直接替换。 |
| [ipc/app-server-health.cjs](../../../gateway/runtime/ipc/app-server-health.cjs) | 装饰前观察真实 stdout，仅做存活/成功响应检查，不额外发请求。 |

现有业务链路保持：

`浏览器 → Gateway WebSocket/IPC → 官方 Electron app-host → 官方 App Server 子进程`

历史预览与分类器通过已附着的 stdio 发送内部请求，不另起 App Server。

## 3. 方案取舍

1. **选用：抽离通用传输，旧模块保留兼容入口。** 改动限定在协议实现及其生命周期，既有调用点和业务链路保持稳定，可用原有测试验证等价性。
2. 后续可评估：独立后端只读试点。需要另行明确初始化、账号、数据库并发访问及官方界面的适配边界；本阶段不实现。
3. 不选用：直接替换官方 Electron/app-host。它还提供桌面服务与 MessagePort RPC，不能把这一层当作单纯 NDJSON 转发；一次性替换扩大兼容风险。

## 4. 模块边界

拟划分四个职责单元，避免只把原文件整体换目录：

| 文件 | 职责 | 不应承担 |
| --- | --- | --- |
| `gateway/runtime/app-server/transport.cjs`（新增） | 通用请求/响应关联、通知等待、双向 NDJSON/UTF-8 流、背压、附着代际、流资源生命周期；导出通用错误类型。 | Auto 模型、分类线程、用户配置、Electron、进程启动/终止。 |
| `gateway/runtime/app-server/request-order.cjs`（新增） | App Server 方法的依赖描述与冲突判断：同线程顺序、独立只读、索引读取、未知方法屏障、服务端请求的回包。 | 选择模型、创建分类线程、文件/网络访问。 |
| `gateway/runtime/model-router/internal-sessions.cjs`（新增） | 内部 thread/turn 标识、短期 tombstone、隐藏内部消息、拒绝内部 host 交互、迟到 ephemeral 线程的既有回收逻辑。 | 分帧、Node 流替换、启动新进程。 |
| `gateway/runtime/model-router/transport.cjs`（保留） | 兼容入口，组装通用传输与内部会话策略，继续导出原有 API。 | 重复实现通用传输或保留另一套运行路径。 |

依赖只从路由模块指向 `app-server/`，后者不能反向导入 `model-router/`、插件服务或 Electron。通用层应能在不加载路由模块、不读取用户配置的 Node 测试中使用。

本阶段**不迁移整个服务的创建所有权**：`server.cjs` 中历史预览仍可通过兼容入口取得同一 transport。历史预览与模型路由服务的组装关系留待下一阶段，不能把本次交付宣传为完全运行时解耦。

## 5. 接口与数据流

### 5.1 兼容入口

保留当前导出：`AppServerTransportError`、`DECORATED_CHILD`、`createAppServerTransport`、`threadIdFromMessage`、`turnIdFromMessage`。错误类和装饰标记复用同一对象，不能产生两份类/标记造成判断失效。

返回对象保留 `decorateChild`、`isAttached`、`request`、`writeMessage`、`waitForNotification`、`observeNotifications`、`rejectPending`，以及内部 thread/turn 查询与登记方法。保留现有 `processClientMessage`、`processServerMessage`、`onAttached`、`onClosed` 调用约定。

- 通用层的请求 ID 前缀由调用方传入；兼容入口继续传入现有 `opencodex.router:`，不改变在途协议身份。计数器在同一 transport 实例中单调递增，换进程不复用旧 ID。
- `isAttached` 仍只表示可用的附着写通道，不提升为“模型可用”或“请求执行成功”。启动就绪继续由现有 health/startup 机制判定。
- 新增幂等 `dispose(error)`，仅释放本层持有的资源和等待者；它不负责 kill 官方进程。服务退出时调用它，而不只拒绝当前 pending 请求。

### 5.2 发往 App Server

官方请求沿用：UTF-8 解码/分行 → 方法依赖描述 → 异步路由 middleware → 按冲突关系选择可发送帧 → 写入该帧所属连接的真实 stdin。

内部请求直接使用所附着连接的写通道，以免等待分类结果的用户请求反过来阻塞分类请求。每次完整 NDJSON 写入不交叉拼接；内部请求仍由本层关联响应，不进入官方外部请求表。

### 5.3 来自 App Server

保持处理顺序：分帧 → 消费本实例拥有的内部响应 → 发布通知供分类器观察 → 内部会话过滤/拒绝交互 → 公共响应 middleware → 官方消费者。

通用层为路由策略提供“本地请求结果/迟到结果”和“连接代际”的最小回调，不自行解析 `thread/start`、`turn/start` 的业务含义。正常内部响应的 thread/turn 登记必须先于对应 request Promise 的完成，避免后续通知竞态。

公共不可解析行保持原行内容透传，保留现有换行规范化语义，不承诺所有输入字节完全不变。公共响应处理异常仍可回退原始响应；**已识别为本地响应或内部会话的帧不能因策略异常而泄漏给官方界面**。异常须在内部请求/诊断中体现，不能伪装成功。

## 6. 生命周期与失败处理

每次成功附着创建独立连接代际，持有自己的真实流、解码器、队列、回调和清理函数。当前代际引用仅用于新请求选路，不能被旧异步闭包当作可变写入目标。

| 情况 | 要求 |
| --- | --- |
| 重复装饰同一 child | 保持幂等，不重复监听，不再生成一层代理流。 |
| child 缺少有效流或无法安全替换属性 | 不报告附着成功，不留下部分替换状态；不能静默继续使用半装饰对象。 |
| 正常完成写入/输出 | 保留 stdin final 等待已接受帧完成，以及 stdout end 等待既有输出排空的语义。 |
| 请求超时、写入失败、服务端错误 | 保留 `timeout`、`write`、`response`、`closed` 分类及 response 错误内容；计时器与关联表及时释放。 |
| 当前进程 close/error | 挂起请求和通知等待者结束一次；停止接受该连接的新工作，清理自己登记的监听。物理 close 的 `onClosed` 不重复触发。 |
| 新 child 替换旧 child | 先退役旧代际，再发布新代际；旧等待者失败，旧队列中尚未写出的业务帧不得写入新 stdin。旧 child 的迟到响应、middleware 完成、write 回调或 close 不得改变新代际状态。 |
| 主动 dispose | 幂等释放等待、订阅、计时器和本层队列；拒绝后续 request，不自动附着、重试、重放或终止官方进程。 |

退役与正常 EOF 不同：退役时无法确认是否执行的请求明确失败，不把它们搬到新连接。进程替换本身不额外伪造一次物理 close 回调；内部策略按代际复位，现有业务关闭回调时机不随意扩大。

只解除本层注册的监听，禁止 `removeAllListeners`；健康观察器和官方自己的监听必须保留。私有会话的迟到清理请求也必须绑定原代际，绝不能误发给替换后的进程。普通业务请求不因本次重构获得自动重试。

这是本阶段明确的安全强化，不把“旧异步任务串入新进程”当作必须保留的历史行为。除此以外不扩充方法白名单、不改变并发/超时默认值，也不增加可能拒绝合法大消息的新帧大小限制。

## 7. 必须保持的策略与容量边界

- 未知方法、无明确上下文的方法及按 history/path resume，继续按全局屏障处理。
- 同线程操作保持顺序；既有独立只读和不同线程的安全请求仍可越过等待中的分类。对服务端主动请求的回包不能被分类队列卡住。
- 输入积压阈值保持 64 帧，降到阈值以下及时解除 write callback 背压；这个阈值不是整条通道的总字节内存上限。
- 公共输出沿用 pause/drain/resume，慢消费者不能造成无节制主动读取。
- 私有线程 tombstone 保持 5 分钟、最多 512 条；内部 turn 终止标识及分类清理顺序保留。
- 既有 Auto/手动模型选择、分类失败回退、内部会话隐藏和审批拒绝行为保持。
- 兼容性修改点 ID、目录数量和语义命中位置不因拆文件变化；不开启 Auto 也不能破坏通用连接或历史预览。
- 不记录请求正文、账号 token、用户提示词或完整原始协议帧来诊断新层。

## 8. 验证与交付准入

### 8.1 原有回归套件

| 套件 | 重点 |
| --- | --- |
| [model-router-transport.test.cjs](../../../gateway/test/model-router-transport.test.cjs) | 分片/UTF-8、并发内部请求、同线程顺序、独立只读、全局屏障、final、64 帧输入背压和输出 drain。 |
| [smart-model-router.integration.test.cjs](../../../gateway/test/smart-model-router.integration.test.cjs) | 同一 App Server 上的分类、重写/隐藏、回退、手动选择、内部标识回收、历史缓存。 |
| [history-preview.test.cjs](../../../gateway/test/history-preview.test.cjs) | 内部线程过滤、并发合并、导航等待预算、过期快照和销毁后迟到结果。 |
| [app-server-health.test.cjs](../../../gateway/test/app-server-health.test.cjs)、[official-runtime.test.cjs](../../../gateway/test/official-runtime.test.cjs) | 装饰前健康观察、spawn 重定向和官方进程生命周期。 |

### 8.2 新增专项验证

使用隔离的 fake child/stream 和可控异步完成点，不对真实任务注入失败：

1. 通用层不加载路由模块也可完成请求/响应/通知往返；不含私有线程业务策略。
2. 重复装饰、无效 child、不能替换的属性和失败撤销，不遗留半装饰状态或重复监听。
3. 请求超时、写回调失败/同步抛错、EOF/close/error 交错以及反复 dispose，仅结束等待者一次。
4. 分类或写队列未完成时替换 child；随后释放旧异步任务，断言新 stdin 没有旧请求、新 pending 不被旧回包完成。
5. 旧 stdout/close/迟到内部清理不能影响新代际，旧代际的监听/等待资源得到回收。
6. 仅移除自己的监听；健康观察器仍收到应有数据。正常 EOF 的背压排空不因清理而丢帧。
7. 同名旧入口的导出身份、函数返回约定和错误分类不变；公共异常回退与内部隐私边界同时成立。

新增测试必须加入 `package.json` 的显式测试列表。断言事件和结果，不通过放大 sleep 掩盖竞态。

### 8.3 最终验收

- 先通过专项回归，再执行完整 `pnpm test`、类型/边界检查和跨平台 CI；不把基线第三阶段的 791 项结果当作新实现的验证。
- 确認模块依赖方向：`app-server/` 不反向依赖路由/插件/Electron，也不自行读用户配置或启动 CLI。
- 保持修改点及现有接口契约；受影响语义必须经过原有兼容骨架，不绕开诊断生命周期。
- 更新本机前备份全部变更文件；新文件列入清单。安装后逐文件校验、核对 Gateway/IPC/CLI 健康和 prepare 锁已释放。
- 实页检查主页、已有历史打开、模型目录、草稿保护与连接状态；不自动发送测试消息、不修改真实会话。需要真实发送/审批验证时另行确认测试范围。
- 本轮不承诺启动加速、内存下降、完全离线或独立后端已经可用。收益是可复用的实现边界、独立测试能力与代际隔离。

## 9. 回退

这是一次无配置/数据格式迁移的应用代码变更。若实页或健康检查失败，停止已核验的 OpenCodex 进程，按清单恢复同一份更新前应用备份，再启动并复核。新增模块不能单独覆盖旧入口混用；不用旧协议帧重放来“恢复”未确认请求。

运行时版本快照、官方安装、账号和用户会话均不属于本次回退修改范围。不要以回退名义删除用户数据或关闭认证。

## 10. 审阅结论与下一步

本稿已按现有源码和测试入口自查：区分了协议实现解耦与运行方式切换，列明了有意强化的代际隔离、兼容边界、故障处理和验收条件。当前只提交设计稿，不改生产代码。

请用户审阅本文件；确认后再形成具体实施计划，按测试先行的小步提交执行。独立 App Server 后端不包含在本稿授权范围中。
