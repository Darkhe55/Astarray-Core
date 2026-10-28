# ADR 只读索引

日期：2026-10-29。**本文件由脚本生成，只读**（勿手工增删条目；新增 ADR 后重新生成）。

- 目录内共 **89** 份 ADR，编号 `0001`–`0089` **连续无缺号**（已用脚本核对）。
- `未完成节` / `验证状态节`：`0044`–`0089`（本窗口新增的 46 份）**全部具备两节**；
  `0001`–`0043` 早于该约定，**没有**这两节（历史文件不追改，如实标注 `—`）。
- 所有 ADR 的"运行证据"口径：**本仓库当前没有任何实机运行验证**；`implemented-unverified`
  表示代码通过 `typecheck`/`eslint`/`build`，**不代表验收通过**。

| 编号 | 文件 | 标题 | 未完成节 | 验证状态节 |
|---|---|---|---|---|
| 0001 | [0001-feedback-process-is-separate-process.md](0001-feedback-process-is-separate-process.md) | ADR-0001：反馈工具必须是独立进程 | — | — |
| 0002 | [0002-prime-backoff-with-3-hour-cap.md](0002-prime-backoff-with-3-hour-cap.md) | ADR-0002：质数退避与 3 小时单次封顶 | — | — |
| 0003 | [0003-priority-queue-with-fifo-within-priority.md](0003-priority-queue-with-fifo-within-priority.md) | ADR-0003：优先级队列 + 优先级内 FIFO | — | — |
| 0004 | [0004-versioned-task-chain-location.md](0004-versioned-task-chain-location.md) | ADR-0004：版本化任务链 JSON 与固定路径 | — | — |
| 0005 | [0005-cache-side-effect-free-only.md](0005-cache-side-effect-free-only.md) | ADR-0005：仅缓存确定性且无副作用的调用 | — | — |
| 0006 | [0006-assist-session-authorization-ttl.md](0006-assist-session-authorization-ttl.md) | ADR-0006：Assist 会话授权 10 分钟 TTL | — | — |
| 0007 | [0007-feedback-message-source-is-required.md](0007-feedback-message-source-is-required.md) | ADR-0007：反馈消息必须携带不可变的原始来源 | — | — |
| 0008 | [0008-per-agent-work-archives-and-selective-attachment.md](0008-per-agent-work-archives-and-selective-attachment.md) | ADR-0008：每个 Agent 独立工作存档和选择性附加 | — | — |
| 0009 | [0009-tool-internal-backup-before-destructive-mutation.md](0009-tool-internal-backup-before-destructive-mutation.md) | ADR-0009：破坏性变更必须由工具内部先自动备份 | — | — |
| 0010 | [0010-controlled-backup-access-and-deletion.md](0010-controlled-backup-access-and-deletion.md) | ADR-0010：受控备份访问与按模式删除策略 | — | — |
| 0011 | [0011-permission-ask-message-kind.md](0011-permission-ask-message-kind.md) | ADR-0011：新增 permission-ask 消息类型（优先级位于 failure 与 ambiguous 之间） | — | — |
| 0012 | [0012-secondary-agent-owns-git-integration.md](0012-secondary-agent-owns-git-integration.md) | ADR-0012：次级 Agent 负责 Git 分流、审查与合并 | — | — |
| 0013 | [0013-agent-pending-task-poset.md](0013-agent-pending-task-poset.md) | ADR-0013：Agent 待办任务采用带优先级的偏序集 | — | — |
| 0014 | [0014-ponder-local-readonly-policy.md](0014-ponder-local-readonly-policy.md) | ADR-0014：思索模式采用本地只读工具边界 | — | — |
| 0015 | [0015-explicit-completion-and-early-stop-recovery.md](0015-explicit-completion-and-early-stop-recovery.md) | ADR-0015：明确完成事件与本地早停恢复 | ✅ | — |
| 0016 | [0016-evidence-assistance-for-high-rigor-tasks.md](0016-evidence-assistance-for-high-rigor-tasks.md) | ADR-0016：高严谨性任务强制生成辅助证据包 | — | — |
| 0017 | [0017-self-reference-and-livelock-guards.md](0017-self-reference-and-livelock-guards.md) | ADR-0017：工具反自指与活锁保护 | — | — |
| 0018 | [0018-universal-sensitive-content-read-deny.md](0018-universal-sensitive-content-read-deny.md) | ADR-0018：所有模式禁止模型读取本地敏感内容 | — | — |
| 0019 | [0019-assist-installation-preflight-and-authorization.md](0019-assist-installation-preflight-and-authorization.md) | ADR-0019：Assist 安装前置询问、独立开关与逐次授权 | — | — |
| 0020 | [0020-configurable-permission-profiles-and-custom-modes.md](0020-configurable-permission-profiles-and-custom-modes.md) | ADR-0020：可配置权限组与命名自定义模式 | — | — |
| 0021 | [0021-main-agent-readonly-and-session-permission-elevation.md](0021-main-agent-readonly-and-session-permission-elevation.md) | ADR-0021：主 Agent 永久只读、次级权限上限与会话临时提升 | — | — |
| 0022 | [0022-default-agent-control-flow-and-tertiary-lifecycle.md](0022-default-agent-control-flow-and-tertiary-lifecycle.md) | ADR-0022：默认 Agent 控制流与三级 Agent 生命周期 | ✅ | — |
| 0023 | [0023-per-agent-memory-and-context-isolation.md](0023-per-agent-memory-and-context-isolation.md) | ADR-0023：每个 Agent 的记忆与上下文严格隔离 | ✅ | — |
| 0024 | [0024-tool-documentation-recall-and-delegated-agent-communication.md](0024-tool-documentation-recall-and-delegated-agent-communication.md) | ADR-0024：工具说明回访与受权 Agent 通信转交 | — | — |
| 0025 | [0025-scoped-secondary-direct-lane-and-quaternary-delegation.md](0025-scoped-secondary-direct-lane-and-quaternary-delegation.md) | ADR-0025：次级 Agent 任务直达、职责分离与四级委派 | — | — |
| 0026 | [0026-agent-model-provider-policies-and-task-presets.md](0026-agent-model-provider-policies-and-task-presets.md) | ADR-0026：Agent 独立模型/提供商策略与任务类型预设 | — | — |
| 0027 | [0027-staged-craftsman-tertiary-agent-preset.md](0027-staged-craftsman-tertiary-agent-preset.md) | ADR-0027：阶段性显现的“工匠”三级 Agent 预设 | — | — |
| 0028 | [0028-human-agent-concurrent-change-and-controlled-merge.md](0028-human-agent-concurrent-change-and-controlled-merge.md) | ADR-0028：人工与 Agent 并行编码、冲突协调与受控合并 | — | — |
| 0029 | [0029-agent-working-set-and-read-budget.md](0029-agent-working-set-and-read-budget.md) | ADR-0029：Agent 工作集与默认 10 文件读取预算 | — | — |
| 0030 | [0030-unified-session-recovery-and-reconciliation.md](0030-unified-session-recovery-and-reconciliation.md) | ADR-0030：统一会话恢复、任务续接与外部状态对账 | — | — |
| 0031 | [0031-context-node-closure-and-recall.md](0031-context-node-closure-and-recall.md) | ADR-0031：全局决策提升与局部上下文节点关闭及分级回访 | — | — |
| 0032 | [0032-external-tool-bridge-mcp-stdio.md](0032-external-tool-bridge-mcp-stdio.md) | ADR-0032：外部工具桥接采用 MCP（2026-07-28）与 stdio 传输 | — | — |
| 0033 | [0033-micro-edit-workbench-scope.md](0033-micro-edit-workbench-scope.md) | ADR-0033：细节微淘原型的能力边界与来源契约 | — | — |
| 0034 | [0034-summary-manifest-and-dynamic-detail.md](0034-summary-manifest-and-dynamic-detail.md) | ADR-0034：会话摘要清单与动态详细度契约 | — | — |
| 0035 | [0035-token-measurement-adapters.md](0035-token-measurement-adapters.md) | ADR-0035：token 计量适配与保守估算 | — | — |
| 0036 | [0036-summary-fact-verification.md](0036-summary-fact-verification.md) | ADR-0036：摘要事实核验与依据原始分块重建叙述 | — | — |
| 0037 | [0037-measurement-cache-and-quality-evaluation.md](0037-measurement-cache-and-quality-evaluation.md) | ADR-0037：内容/计量缓存分离、Provider usage 捕获与质量评估 | — | — |
| 0038 | [0038-runtime-guidance-contract.md](0038-runtime-guidance-contract.md) | ADR-0038：运行中指导的事件契约（来源、作用域、sequence 与取消能力） | — | — |
| 0039 | [0039-auth-scope-and-adjudication-matrix.md](0039-auth-scope-and-adjudication-matrix.md) | ADR-0039：按作用范围与裁决者的授权模型（AUTH-SCOPE） | ✅ | — |
| 0040 | [0040-accuracy-tiers-budget-and-skip-status.md](0040-accuracy-tiers-budget-and-skip-status.md) | ADR-0040：可关闭的任务准确性检查（档位、预算与跳过状态） | — | — |
| 0041 | [0041-local-preservation-after-remote-sync-failure.md](0041-local-preservation-after-remote-sync-failure.md) | ADR-0041 远端同步失败后的本地保全（本地快照定义） | — | — |
| 0042 | [0042-read-format-strategy-and-receipt.md](0042-read-format-strategy-and-receipt.md) | ADR-0042 内置多格式读取视图（策略注册表、能力矩阵与回执契约） | — | — |
| 0043 | [0043-governance-rule-migration-and-unification.md](0043-governance-rule-migration-and-unification.md) | ADR-0043 治理规则迁移与文档统一（安装/外部软件与范围裁决） | — | — |
| 0044 | [0044-conversation-individual-and-run-identity.md](0044-conversation-individual-and-run-identity.md) | ADR-0044 会话、个体与运行的身份分层（ALIGN-01 前置） | ✅ | ✅ |
| 0045 | [0045-main-agent-task-proposal-boundary.md](0045-main-agent-task-proposal-boundary.md) | ADR-0045 主 Agent 的任务提案边界（只读工具 + 本地提案控制面） | ✅ | ✅ |
| 0046 | [0046-main-agent-turn-budget.md](0046-main-agent-turn-budget.md) | ADR-0046 主 Agent 单条处理预算与超期记账（180 秒） | ✅ | ✅ |
| 0047 | [0047-main-agent-report-index.md](0047-main-agent-report-index.md) | ADR-0047 主 Agent 报告索引：终态写入、来源认证与按需读取 | ✅ | ✅ |
| 0048 | [0048-legacy-identity-migration-audit.md](0048-legacy-identity-migration-audit.md) | ADR-0048 旧身份映射的只读迁移判定 | ✅ | ✅ |
| 0049 | [0049-authoritative-task-sequence-before-mission.md](0049-authoritative-task-sequence-before-mission.md) | ADR-0049 用户任务先入权威任务序列，再建 mission 投影（ALIGN-02-01） | ✅ | ✅ |
| 0050 | [0050-task-decomposition-validation.md](0050-task-decomposition-validation.md) | ADR-0050 任务分解：本地强制校验 + 显式降级（ALIGN-02-02） | ✅ | ✅ |
| 0051 | [0051-ready-set-unit-selection.md](0051-ready-set-unit-selection.md) | ADR-0051 ready set 的工作单元选择（ALIGN-02-03） | ✅ | ✅ |
| 0052 | [0052-dispatch-loop-real-ports-and-claims.md](0052-dispatch-loop-real-ports-and-claims.md) | ADR-0052 派发循环去假值：真实占用、原子领取与"第二调度器"发现（ALIGN-02-05） | ✅ | ✅ |
| 0053 | [0053-runtime-task-insertion.md](0053-runtime-task-insertion.md) | ADR-0053 运行中插入：本地判定与安全分支（ALIGN-02-06） | ✅ | ✅ |
| 0054 | [0054-scheduling-events-and-backoff.md](0054-scheduling-events-and-backoff.md) | ADR-0054 事件驱动唤醒、有界退避与失败重派上限（ALIGN-02-07） | ✅ | ✅ |
| 0055 | [0055-independent-review-gate.md](0055-independent-review-gate.md) | ADR-0055 独立审查门禁：直属上级、非自报证据与纵深防御（ALIGN-03-01） | ✅ | ✅ |
| 0056 | [0056-task-bundle-dispatch-envelope.md](0056-task-bundle-dispatch-envelope.md) | ADR-0056 任务包派发信包：权限求交、边界与工具说明引用（ALIGN-03-02） | ✅ | ✅ |
| 0057 | [0057-worker-completion-receipt-gate.md](0057-worker-completion-receipt-gate.md) | ADR-0057 Worker 完成收据与编排层完成门禁（ALIGN-03-03） | ✅ | ✅ |
| 0058 | [0058-git-integration-reviewer-and-clean-worktree.md](0058-git-integration-reviewer-and-clean-worktree.md) | ADR-0058 Git 集成：审查者独立与"干净工作区"守卫（ALIGN-03-04） | ✅ | ✅ |
| 0059 | [0059-review-evidence-binding-before-merge.md](0059-review-evidence-binding-before-merge.md) | ADR-0059 合并前审查证据绑定校验（ALIGN-03-05） | ✅ | ✅ |
| 0060 | [0060-feedback-idempotent-journal-and-outbox.md](0060-feedback-idempotent-journal-and-outbox.md) | ADR-0060 反馈消息幂等入库与本地补送（ALIGN-03-06） | ✅ | ✅ |
| 0061 | [0061-tertiary-lifecycle-hooks.md](0061-tertiary-lifecycle-hooks.md) | ADR-0061 三级收口：真实生命周期钩子与"先存档案再释放"（ALIGN-03-07） | ✅ | ✅ |
| 0062 | [0062-mission-relation-index.md](0062-mission-relation-index.md) | ADR-0062 mission 关系索引与重启恢复（ALIGN-04-01） | ✅ | ✅ |
| 0063 | [0063-recovery-readonly-gate.md](0063-recovery-readonly-gate.md) | ADR-0063 恢复前只读对账门禁（ALIGN-04-02） | ✅ | ✅ |
| 0064 | [0064-resume-readiness-and-lease.md](0064-resume-readiness-and-lease.md) | ADR-0064 恢复：就绪分类、已产出待对账与租约幂等领取（ALIGN-04-03） | ✅ | ✅ |
| 0065 | [0065-work-window-resume-entry.md](0065-work-window-resume-entry.md) | ADR-0065 工作时段恢复：同一入口、区分暂停来源、不重复恢复（ALIGN-04-04） | ✅ | ✅ |
| 0066 | [0066-capsule-recall-entry.md](0066-capsule-recall-entry.md) | ADR-0066 胶囊 → 回访：按节点关闭重建上下文（ALIGN-04-05） | ✅ | ✅ |
| 0067 | [0067-sensitive-scan-contract.md](0067-sensitive-scan-contract.md) | ADR-0067 敏感扫描四态契约（SEC-02-01） | ✅ | ✅ |
| 0068 | [0068-credential-detector-registry.md](0068-credential-detector-registry.md) | ADR-0068 版本化凭据检测器注册表：阻断与掩码两套出口（SEC-02-02） | ✅ | ✅ |
| 0069 | [0069-entry-fail-closed-and-hardlink-identity.md](0069-entry-fail-closed-and-hardlink-identity.md) | ADR-0069 生产入口装配 fail-closed 与硬链接身份（SEC-02-03） | ✅ | ✅ |
| 0070 | [0070-outbound-content-gate.md](0070-outbound-content-gate.md) | ADR-0070 通用外发门禁与静态反例（SEC-02-04） | ✅ | ✅ |
| 0071 | [0071-credential-isolation-and-least-read.md](0071-credential-isolation-and-least-read.md) | ADR-0071 凭据隔离与最小读取（SEC-02-07） | ✅ | ✅ |
| 0072 | [0072-run-evidence-snapshot.md](0072-run-evidence-snapshot.md) | ADR-0072 只读运行记录快照（REMOTE-01-01） | ✅ | ✅ |
| 0073 | [0073-remote-identity-and-two-step-export.md](0073-remote-identity-and-two-step-export.md) | ADR-0073 远程主体绑定、范围与双步骤投递（REMOTE-01-02） | ✅ | ✅ |
| 0074 | [0074-remote-delivery-outbox.md](0074-remote-delivery-outbox.md) | ADR-0074 幂等投递 outbox 与 unknown 语义（REMOTE-01-03） | ✅ | ✅ |
| 0075 | [0075-goal-contract-and-potential.md](0075-goal-contract-and-potential.md) | ADR-0075 冻结目标契约与候选势函数（GOAL-02-01） | ✅ | ✅ |
| 0076 | [0076-goal-dispatch-gate.md](0076-goal-dispatch-gate.md) | ADR-0076 目标模式本地门禁与有界绕行（GOAL-02-02） | ✅ | ✅ |
| 0077 | [0077-goal-mode-persistence.md](0077-goal-mode-persistence.md) | ADR-0077 目标模式持久化、恢复对账与实验退出（GOAL-02-03） | ✅ | ✅ |
| 0078 | [0078-task-ledger-bridge.md](0078-task-ledger-bridge.md) | ADR-0078 两套记账的只读对照与显式拒绝（接线缺口第 ① 项） | ✅ | ✅ |
| 0079 | [0079-completion-gate.md](0079-completion-gate.md) | ADR-0079 完成门禁：任务链完成 + 收据 + 独立裁决（接线缺口第 ② 项） | ✅ | ✅ |
| 0080 | [0080-provider-egress-scan.md](0080-provider-egress-scan.md) | ADR-0080 模型请求最终出口扫描（接线缺口第 ③ 项 / SEC-02-06 通道 13） | ✅ | ✅ |
| 0081 | [0081-work-window-transition-monitor.md](0081-work-window-transition-monitor.md) | ADR-0081 工作时段变化检测器与关闭时停止（接线缺口第 ④ 项） | ✅ | ✅ |
| 0082 | [0082-goal-gate-readonly-wiring.md](0082-goal-gate-readonly-wiring.md) | ADR-0082 目标门禁的只读接线（清单第 ⑥ 项） | ✅ | ✅ |
| 0083 | [0083-runtime-task-injection.md](0083-runtime-task-injection.md) | ADR-0083 运行中插入的真实安全点注入（清单第 ① 项下半场） | ✅ | ✅ |
| 0084 | [0084-task-ledger-divergence-journal.md](0084-task-ledger-divergence-journal.md) | ADR-0084 两套记账的差异历史（清单第 ① 项收尾） | ✅ | ✅ |
| 0085 | [0085-task-ledger-cli.md](0085-task-ledger-cli.md) | ADR-0085 只读对账 CLI：`task-ledger status`（清单第 ① 项出口） | ✅ | ✅ |
| 0086 | [0086-summary-publishability.md](0086-summary-publishability.md) | ADR-0086 摘要写入前的发布性检查（SEC-02-06 通道 12） | ✅ | ✅ |
| 0087 | [0087-memory-and-report-write-scan.md](0087-memory-and-report-write-scan.md) | ADR-0087 长期记忆与三级汇报的写入侧检查（SEC-02-06 通道 12 续） | ✅ | ✅ |
| 0088 | [0088-read-side-scan-labels.md](0088-read-side-scan-labels.md) | ADR-0088 派生内容的读取侧扫描标注（SEC-02-06 通道 12 续） | ✅ | ✅ |
| 0089 | [0089-memory-read-scan-label.md](0089-memory-read-scan-label.md) | ADR-0089 记忆读取的扫描标注（SEC-02-06 通道 12 收口） | ✅ | ✅ |
## 说明

- 编号连续性与两节完整性由第 52 轮脚本核对；**本轮未运行任何代码**。
- 本索引**不评价** ADR 内容是否正确，只登记"编号与章节是否存在"。
- 若新增 ADR：按 `0090+` 续号，并在本表补一行（或重新生成）。