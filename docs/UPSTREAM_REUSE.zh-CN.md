# 上游机制吸收：运行时版本与原子落盘

## 已核验的来源

- [poeck/chatgpt-desktop-app-nix-flake 的 update.sh](https://github.com/poeck/chatgpt-desktop-app-nix-flake/blob/2a61ece6a06a95f694e6edc55d639834789fa764/scripts/update.sh)，固定提交 `2a61ece6a06a95f694e6edc55d639834789fa764`；同提交根许可证为 MIT。参考双架构包身份检查、版本一致性、内容摘要和先校验后发布来源清单的原则，**没有复制 Nix 实现**。其下载后计算的哈希并非独立可信签名，也不等于完整目录事务。
- 直接依赖 `write-file-atomic@6.0.0`，固定版本与 pnpm 完整性摘要；npm 发布记录的源码提交为 `9fcd4021b8a0c86bf54deded4905aec68d968161`。[源码](https://github.com/npm/write-file-atomic/blob/9fcd4021b8a0c86bf54deded4905aec68d968161/lib/index.js)，包内 LICENSE.md 已核对为 ISC，随依赖分发保留。此版本支持项目的 Node >=22.12；没有升级 Electron 或 electron-builder。
- 第二阶段核验 [electron-updater AppUpdater.ts](https://github.com/electron-userland/electron-builder/blob/1e167b8cc73ccd7d10fcd3e2b1bf8e85befb5b06/packages/electron-updater/src/AppUpdater.ts)，固定提交 `1e167b8cc73ccd7d10fcd3e2b1bf8e85befb5b06`，MIT：参考阶段分离、同一任务去重、默认不降级的原则；没有复制源码或直接添加 electron-updater 依赖，尤其不混用 v27 与本项目 electron-builder 26 的 API。
- 第二阶段核验 [code-server install.sh](https://github.com/coder/code-server/blob/41cf6f7eaffd34eed01a985b6e843e09b0f98ed7/install.sh)，固定提交 `41cf6f7eaffd34eed01a985b6e843e09b0f98ed7`，MIT：参考 `--dry-run` 先展示安装计划、版本目录独立保存的机制，没有照搬安装脚本，也不把其下载步骤当作可信校验或启动回退实现。

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

## 验证与边界

- 故障注入覆盖来源复制变化、同大小损坏、指针替换失败、并发准备、非法指针/架构、链接越界、原安装删除后的重启/还原、YAML 保留和原子落盘失败。
- 全量入口包含新增测试，并继续由 Windows、Linux x64/ARM64 CI 执行。夹具不会运行模拟二进制或损坏真实官方文件。
- 当前切换条件包括**文件内容校验和真实 Gateway/IPC/CLI 启动确认**，自动回退只覆盖启动事务，不在每次后续运行故障时切换版本。实际部署另做网页复测。此机制不快照 CODEX_HOME、账号或用户数据库，不能回滚官方进程执行过的数据迁移或其他外部副作用。
- 快照会显著增加磁盘占用和启动校验 I/O；不声称缩短启动耗时。没有自动垃圾回收或跨版本文件去重。状态轮询只读小型版本元数据，不遍历完整文件清单。
- 准备、启动确认、还原共用排他锁；正常退出释放本进程持有的锁。强制 kill/断电留下的锁需要确认没有准备进程后人工处理，不按超时擅自抢锁；不宣称具有崩溃后无人值守恢复能力。
- `write-file-atomic` 的文件 fsync/rename 不是跨进程配置读改写锁，也没有完整文件系统断电事务。运行时排他锁是本项目单独实现的。
- 只管理本机当前平台的官方安装快照，未增加下载器、双架构上游发布清单、公开分发官方二进制或 ETag 获取。源哈希用于一致性验证，不代替供应商签名和软件供应链信任。
- 尚未接入 electron-updater 自动下载安装、签名更新清单、手机草稿/重连状态机，也未复制许可证未确认的 codex-web 代码。现有发布流程尚未提供完整的可信更新链，不贸然启用自动下载/退出安装默认行为。
