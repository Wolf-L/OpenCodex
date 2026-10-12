# 第四阶段 D1：受限 App Server 只读能力

日期：2026-10-13（Asia/Shanghai）。状态：用户明确选择“按提案继续 D1”，批准实施。基线 `3e2de5d`。

## 目标与取舍

为未来独立后端建立可以替换实现的最小业务接口：模型目录、最近历史。当前通用 client 只有生命周期隔离，仍允许任意 request/writeMessage；仅把它命名为只读不足以形成受限能力。

推荐先在现有唯一 CLI 上实现这个内部接口，迁移已有历史预览调用。相比直接启动隔离 CLI，此步骤能用现有历史链路验收；相比直接替换官方 Electron/app-host，不需要重建官方服务对象协议。

这一步不提供独立运行模式，不启动第二个 CLI，不新增 HTTP/WS 路由，不改账号/配置/会话数据库，不扩大权限，不改官方模型选择、审批或发送语义，也不承诺启动和内存改善。

## 接口

新增 `gateway/runtime/app-server/read-client.cjs`，内部创建现有消费者 scope，返回分开的 `client` 与 `dispose`。业务 client 冻结，仅暴露：

- `isAttached()`：沿用传输附着含义，不当作模型可用性判断。
- `listModels({cursor=null, limit=100}, {timeoutMs, signal}={})`：只调用 model/list，固定 includeHidden=false；单页返回，不自动翻页。
- `listRecentThreads({cursor=null, limit=12}, {timeoutMs, signal}={})`：只调用 thread/list，固定 archived=false、sortKey=updated_at、modelProviders=null、useStateDbOnly=true；单页返回。

参数仅允许以上明确字段。cursor 为 null 或不超过 4096 字符的字符串；limit 为 1–100 的安全整数；timeoutMs 默认 5000、范围 1–10000 毫秒；signal 遵循既有 AbortSignal 取消语义。异常参数在写入前拒绝，不静默截断或传入更多协议字段。首轮不提供任意 method、writeMessage、initialize、thread/resume、审批或 turn/start 能力。

响应维持现有上游结构，不在这一步发明新的公开 schema；不缓存、不自动重试，不记录正文。该内部能力限制调用范围，不是 Node 进程内恶意代码的安全沙箱。排序分类集合不用于构建授权列表。

## 装配与迁移

Gateway owner 新建只读 scope，与 router scope 共用原 transport；所有权和正常退出次序保持。history-preview 的生产路径改为接收 listRecentThreads 能力，保留 700ms 导航预算、12 条、1 秒缓存、并发合并和既有私有线程过滤。保留现有可选 transport 输入作为内部兼容测试/调用适配，但生产不再传通用 request。

模型读取能力通过 owner 的只读对象提供给将来消费者，本轮不另起刷新任务、不改变路由分类器或官方模型菜单。函数存在与模型数据真实可用是不同验收点。

私有列表过滤继续在原连接策略、request Promise 完成前发生，不能把过滤移动到可能已切换连接代际的续体。通用 read-client 不反向导入 model-router、plugins、Electron，也不直接读取配置。

## 失败与资源

底层 timeout/write/response/closed 分类保留。scope 取消只结束自己的等待，不撤回已写帧、不关共享连接。dispose 幂等并释放订阅/等待；销毁后请求不能写出。连接替换使旧请求明确失败，不迁移请求到新进程。

不新增监听端口、认证上下文或持久化。未来若给浏览器增加网络入口，需要单独设计鉴权、输出字段和跨页访问规则；本稿不预先批准。

## 验收与回退

1. 隔离 fake child 检查只有两个固定方法能写出；错误字段、范围、cursor、timeout 在发送前拒绝；输出保留，单次调用只产生一个协议请求。
2. 两个消费者并发时，取消/销毁只读 scope 不影响 router 请求；退出、超时与替换释放等待，无自动重试。
3. 历史预览生产装配使用受限能力，原私有列表竞态、缓存与700ms导航预算测试保留。模型目录能力用当前已有协议参数夹具验收，不假称已经驱动官方菜单。
4. 完整测试、类型/边界检查和五平台 CI。按既有授权备份、更新本机并重启，校验文件和健康，实页确认历史预览、历史正文、模型及连接正常。
5. 无数据迁移；失败时按本轮应用备份清单回退全部变化代码。

## 后续独立试点准入

后续单独批准 Node 入口、固定 CLI 来源、临时 CODEX_HOME、初始化/能力握手、退出和不确定请求处理。隔离的未登录/空数据成功不能证明生产账号、真实历史或官方 app-host 等价。当前审计未证实可以安全直接切换生产链路。
