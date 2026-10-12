# 上游机制吸收：运行时、更新与移动连接恢复

## 已核验的来源

- [poeck/chatgpt-desktop-app-nix-flake 的 update.sh](https://github.com/poeck/chatgpt-desktop-app-nix-flake/blob/2a61ece6a06a95f694e6edc55d639834789fa764/scripts/update.sh)，固定提交 `2a61ece6a06a95f694e6edc55d639834789fa764`；同提交根许可证为 MIT。参考双架构包身份检查、版本一致性、内容摘要和先校验后发布来源清单的原则，**没有复制 Nix 实现**。其下载后计算的哈希并非独立可信签名，也不等于完整目录事务。
- 直接依赖 `write-file-atomic@6.0.0`，固定版本与 pnpm 完整性摘要；npm 发布记录的源码提交为 `9fcd4021b8a0c86bf54deded4905aec68d968161`。[源码](https://github.com/npm/write-file-atomic/blob/9fcd4021b8a0c86bf54deded4905aec68d968161/lib/index.js)，包内 LICENSE.md 已核对为 ISC，随依赖分发保留。此版本支持项目的 Node >=22.12；没有升级 Electron 或 electron-builder。
- 第二阶段核验 [electron-updater AppUpdater.ts](https://github.com/electron-userland/electron-builder/blob/1e167b8cc73ccd7d10fcd3e2b1bf8e85befb5b06/packages/electron-updater/src/AppUpdater.ts)，固定提交 `1e167b8cc73ccd7d10fcd3e2b1bf8e85befb5b06`，MIT：参考阶段分离、同一任务去重、默认不降级的原则；没有复制源码或直接添加 electron-updater 依赖，尤其不混用 v27 与本项目 electron-builder 26 的 API。
- 第二阶段核验 [code-server install.sh](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/install.sh)，固定提交 `41cf6f7eaffd34eed01a985b6e843e09b0f98ed7`，MIT：参考 `--dry-run` 先展示安装计划、版本目录独立保存的机制，没有照搬安装脚本，也不把其下载步骤当作可信校验或启动回退实现。
- 第三阶段独立实现浏览器草稿和连接恢复，没有复制许可证未确认的 codex-web。依据 [RFC 6455 §7.2.3](https://www.rfc-editor.org/rfc/rfc6455#section-7.2.3) 的随机延迟与退避建议；核验 [MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage) 的标签页/刷新边界及存储异常，以及 [MDN onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine) 不能证明互联网/局域网可用的限制。未新增前端依赖。

## 本轮实现

1. 每个完整运行时在 `<bundle-dir>.versions/<id>` 中保留 `source`、`bundle`、`runner` 三部分；CLI 位于官方目录外时单独复制其可执行文件，不复制用户的整个 CLI 目录。
2. `version.json` 记录版本、build、平台、CPU 架构、来源和组件摘要；三个 `*-files.json` 保存文件路径、大小和 SHA-256 清单。原始来源与副本分别复核，目录内符号链接重定位，越界链接和宽泛系统/用户根目录拒绝复制。
3. 新版复制、解包、runner 生成与内容校验成功后，仍保留原指针；真实子进程通过启动确认才原子切换 `<bundle-dir>.current.json`。准备失败保留原指针；原官方安装删除后，固定快照仍可启动。开启扫描但没有可用安装且没有新的显式来源要求时，也会警告后使用完整快照。
4. 还原切换完整版本，而不只是 bundle。旧版本保留，不自动删除；第一次从历史缓存迁移后还没有上一份“完整快照”，不会把依赖原安装的历史 bundle 冒充完整离线备份。
   Windows 启动使用固定工作目录，而不是直接执行版本快照中的 EXE，以保留已验证的 SxS 加载路径；启动绑定仍校验工作副本和所选快照的内容。工作副本与版本内 runner 完全相同时不重新发布，不一致则强制重建并再次核对摘要，版本化备份不会被它覆盖。
5. Windows/Linux runner 的同大小文件损坏也会强制从已校验快照重建；原快照 source/bundle 损坏则拒绝使用，不静默升级。macOS runner 损坏目前明确报错，不宣称具有同等自动重建能力。
6. Launcher 设置、密码配置、bundle 清单、runner 公共 JSON 写入和版本指针复用单文件原子落盘。更新密码只修改 `auth.password`，保留其他 YAML 字段和注释；不支持或歧义的认证结构拒绝改写，不输出秘密。
7. Launcher 和命令行入口使用独立随机令牌访问私有启动探活接口，核对子进程 PID、bundle/CLI 绑定、IPC 就绪，以及仍在运行的 CLI 已返回成功协议响应。连续就绪至少一秒后确认，等待上限两分钟；这是有界启动检查，不是所有业务功能的长期健康保证。
8. 候选启动失败，先等真实进程退出，再尝试原完整版本一次；退出失败停止回退，绝不并行覆盖执行目录。Windows 原工作目录和 marker 保留至确认后，失败直接移回原目录。还原上一版本同样先确认启动再换指针。失败来源记录在 `.startup.json`，自动扫描跳过；预检后的明确重试复用已有候选，不再复制一整份。
9. Launcher 新增“预检更新 / 应用并重启”。一次性 worker 只读扫描来源、平台架构、内容身份、目录权限和磁盘空间估算，不提取、不写文件、不停止服务；应用前再次核对来源身份。空间数字是保守预算，不是精确峰值，也不保证 Windows ACL/运行依赖全部可用。
10. 应用 release 检查由打包仓库 homepage 确定来源，只显示更高的稳定 semver，排除 draft/prerelease/降级及不匹配外链，增加十秒超时。仍由用户打开 release 页面，未启用静默下载或安装。
11. 文字草稿作为独立受管 Provider（第 106 个修改点）实现：只监听官方 `data-codex-composer=true` 输入框，250ms 有界节流；聚焦期间仅观察该编辑器内部变化，以兼容绕过 input 的富文本粘贴/撤销。隐藏/pagehide/卸载时读取聚焦编辑器并同步保存；避开 IME 中间态。使用同源本标签页 sessionStorage，最多 8 份、每份 32K 字符、有效期 24 小时；不采集密码/设置/搜索框，不上传内容，不写 localStorage。存储失败明确提示，超长内容不静默截断。退出 Gateway 时清除这项草稿键，不清理其他站点数据。
12. 只提供只读预览、复制和清空，不把副本自动写回官方编辑器，不覆盖新草稿。路由只是提示，分屏和新项目可能共用路由，**必须由用户确认正确会话/项目**。清空输入框不等于发送成功，因此保留可能已发送的文字副本；不判断业务确认、不重放不确定的写操作。
13. WebSocket 初始连接/hello-ack 总等待 12 秒；Gateway 明确协商心跳后，前台每 20 秒探测、10 秒未响应退役半开连接。旧服务端不支持心跳时不启用该探测。500ms–30 秒上限的抖动退避，只有连续就绪 10 秒才重置。系统离线暂停自动重连，但手动重试仍允许访问回环/局域网；回到前台/online 重新探测。后台暂停重试和心跳判死，不主动终止已连接任务。旧 socket 迟到回调不能改变新连接状态，生命周期销毁清理所有定时器和监听。

## 验证与边界

- 故障注入覆盖来源复制变化、同大小损坏、指针替换失败、并发准备、非法指针/架构、链接越界、原安装删除后的重启/还原、YAML 保留和原子落盘失败。
- 全量入口包含新增测试，并继续由 Windows、Linux x64/ARM64 CI 执行。夹具不会运行模拟二进制或损坏真实官方文件。
- 当前切换条件包括**文件内容校验和真实 Gateway/IPC/CLI 启动确认**，自动回退只覆盖启动事务，不在每次后续运行故障时切换版本。实际部署另做网页复测。此机制不快照 CODEX_HOME、账号或用户数据库，不能回滚官方进程执行过的数据迁移或其他外部副作用。
- 快照会显著增加磁盘占用和启动校验 I/O；不声称缩短启动耗时。没有自动垃圾回收或跨版本文件去重。状态轮询只读小型版本元数据，不遍历完整文件清单。
- 准备、启动确认、还原共用排他锁；正常退出释放本进程持有的锁。强制 kill/断电留下的锁需要确认没有准备进程后人工处理，不按超时擅自抢锁；不宣称具有崩溃后无人值守恢复能力。
- `write-file-atomic` 的文件 fsync/rename 不是跨进程配置读改写锁，也没有完整文件系统断电事务。运行时排他锁是本项目单独实现的。
- 只管理本机当前平台的官方安装快照，未增加下载器、双架构上游发布清单、公开分发官方二进制或 ETag 获取。源哈希用于一致性验证，不代替供应商签名和软件供应链信任。
- 草稿仅为纯文字恢复副本，不保留附件、富文本结构、选中项目、权限或模型设置；不是跨设备同步、离线消息队列或完整离线运行。IME 未提交文字和浏览器未派发退出事件时最后一个节流窗口仍可能丢失。关闭标签页/浏览器清理存储可丢失副本；浏览器会话恢复、复制标签页可能保留/复制 sessionStorage，不能当作安全擦除或账号隔离保险箱，共用设备须主动清空。
- 连接就绪只表示 Gateway 路由/链路存活，不保证某次消息发送成功或模型服务可用；重连不承诺任务恰好执行一次。没有新增后台持续轮询或整页 DOM 扫描。
- 尚未接入 electron-updater 自动下载安装、签名更新清单，也未复制许可证未确认的 codex-web 代码。现有发布流程尚未提供完整的可信更新链，不贸然启用自动下载/退出安装默认行为。
