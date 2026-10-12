# Stage D1 implementation plan

用户已批准具体只读能力设计。writing-plans 技能在当前已知目录未安装，使用本手工计划；不重复询问已批准方向。

1. 先加入受限读取回归：固定方法/参数、未知字段拒绝、范围、单页响应、超时、取消、销毁、替换和无重放。
2. 新增通用 read-client，以既有消费者 scope 管理生命周期；仅暴露 isAttached/listModels/listRecentThreads，dispose 保留在 owner。
3. Gateway 装配只读 scope，history-preview 优先使用显式 listRecentThreads；保留旧 transport 适配。保持原私有列表过滤与缓存/导航预算。
4. 验证生产装配和边界，执行完整检查、五平台 CI。
5. 按授权备份更新本机，核验文件/健康/唯一 CLI、实页历史和模型。记录未实现的独立运行模式，不宣称性能改善。

实现检查：受限客户端、生产装配及历史能力优先级测试已由失败转为通过。完整 pnpm test：890 项，879 通过、11 跳过、0 失败；构建、类型和边界检查通过。跨平台和本机验收证据另存工作区交付报告。
