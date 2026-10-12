# D2：隔离 App Server 可行性试验

用户在对照原路线后要求“下一步 继续”，批准先补手机验收并开展范围明确的独立运行试验。基线为 `9d32edc`。本试验只作为开发工具，不接入生产 Gateway 或替代官方 app-host。

## 可验证结果

用 Node 启动指定且 SHA-256 匹配的固定 CLI，完成 initialize → initialized，检查未登录状态，通过 D1 的 listModels/listRecentThreads 单页读取，再结束进程。记录版本、握手和读取耗时、条目数量、退出方式以及临时目录清理结果。模型目录有数据不等于账号拥有推理权限，空历史不等于生产历史兼容，单次最小进程耗时不与完整 Electron 页面直接比较。

## 隔离和接口

- 入口置于 `gateway/dev/app-server-probe.cjs`，不被生产入口导入，不新增网络路由或监听端口。
- 显式指定 CLI 绝对路径和预期 SHA-256；不搜索 PATH、不下载/更新 CLI，不默认选择最新版本。
- 每次创建自己的临时根目录、CODEX_HOME、HOME/USERPROFILE、XDG/AppData/TEMP 和工作目录。环境采用最小白名单，不继承 API key、代理、真实 CODEX_HOME 或用户配置。
- 临时配置强制凭据使用文件存储，关闭分析和反馈。握手声明 explicitGatewayOauth，避免自动授权浏览器。诊断用 account/read(refreshToken=false) 确认 account=null；不登录、复制凭据或读取生产数据库。
- 业务调用复用现有 transport 与 D1 read-client。只调用 initialize、initialized、account/read、model/list、thread/list；不发送聊天、创建会话、恢复线程、审批或重试业务请求。
- 初始化响应必须回报预期临时 CODEX_HOME；不匹配或已有账号立即失败并清理。

## 生命周期

每个步骤有超时，并支持 AbortSignal。保存 decorateChild 前的真实 stdin；退出先结束 stdin，再在限定时间内对本工具创建的子进程发送终止信号，等待 close 确认。不能仅凭 kill 返回值宣称退出，也不按进程名称批量结束进程。

成功、启动失败、握手失败、超时、取消、读取中退出均释放 scope 和 transport，无业务重放。退出无法确认时报告 PID 和保留临时目录，不把清理失败当成功。删除临时目录前确认绝对路径位于本次新建根目录，绝不接受用户指定目录作为清理对象。

## 验收与后续边界

测试真实管道/假协议子进程的握手顺序、错误目录/账号拒绝、超时、取消、提前退出、强制退出以及摘要输出；验证敏感环境变量不继承和 hash 不匹配时不执行。

实际固定 CLI 试验和手机验收分别记录。真机必须明确设备、Chrome、软键盘及实际网络条件；模拟视口、人工关闭 WebSocket 不算真机网络切换。本轮仅根据结果提供可迁移能力和仍依赖 Electron 的功能清单。生产账号、真实历史、浏览器 app-host、发送和审批都需要后续独立验收。
