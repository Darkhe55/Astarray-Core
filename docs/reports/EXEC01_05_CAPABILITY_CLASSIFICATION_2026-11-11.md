# 17 项"未接入"能力的逐项定性（2026-11-11）

> 依据用户要求：**逐项对照原设计与任务卡**分类，**不接受**整批作为"待产品裁决"。
> 三类口径：
> - **返修**：原设计/已验收卡**要求**的生产接线缺失（属接线缺口，按返修处理）；
> - **替代**：已有等价实现承担同一职责 ⇒ **不重复接线**；
> - **未来**：设计上**既定延后**、或明确不在当前产品范围 ⇒ **不擅自扩大范围**。

先前的整体分诊见 `EXEC01_05_CAPABILITY_TRIAGE_2026-11-09.md`（本表以它的逐项结论为基线，
并补上"该怎么办"的分类）。

## 明细

| # | 能力 | 原设计 / 卡依据 | 分类 | 处理动作 |
|---|---|---|---|---|
| 1 | `BoundedProviderFallbackGuard` | T07D 提供方运行时与独立 Agent 卡（兜底预算/退避语义）；本文件无等价实现 | **返修** | 接到 runtime 选择链路的兜底分支，补"退避/预算"装配级用例 |
| 2 | `OpenAiResponsesAdapter` | T07D 卡（`openai-responses` 协议）；旧报告称"被替代"**不成立**（生产无等价实现） | **返修** | 注册 `openai-responses` 协议并接选择链路 |
| 3 | `QuaternaryPermissionIntersectionGuard` | 权限求交体系（ALIGN/权限族）；四级求交与其创建入口都未接 | **返修** | 接进权限判定装配；补"求交后不得放大"用例 |
| 4 | `TaskChainCumulativeBudgetController` | **已验收卡** `docs/tasks/accepted/T07E_AGENT_WORKING_SET_READ_BUDGET_TASK_CARD.md`（T07E-04 文件/token 累计预算） | **返修** | 接进任务链预算判定；补超预算拒绝用例 |
| 5 | `SecondaryAgentSessionController` | **ADR-0021**（主 Agent 只读与次级会话权限提升） | **返修** | 接次级会话控制面；补"会话权限只升不越界"用例 |
| 6 | `HumanWorktreeObserver` | T05D Git 集成可达性（读端已有、**写端从未构造** ⇒ journal 生产恒空） | **返修** | 构造写端并接进 Git 集成事件流；补"journal 非空"用例 |
| 7 | `TertiaryAgentAssignmentPlanner` | **ADR-0022**（默认 Agent 控制流与三级生命周期） | **返修** | 接"复用/新建"判定；补判定用例 |
| 8 | `TertiarySingleChainExecutionGuard` | **ADR-0022**（"一次激活一条链"的本地拒绝） | **返修** | 接进激活路径；补"第二条链必须被拒"用例 |
| 9 | `MetricsRegistry` | OBS-01-01 审计与事件契约；影响面**仅 TUI 头栏** | **返修（低优先）** | 接 TUI 头栏计量；若是唯一消费者则先补"最小可观测口径"再接 |
| 10 | `AnthropicMessagesAdapter` | T07D 卡；协议由 `AnthropicMessagesRuntime` 直接实现 | **替代** | **不接线**；在能力清单标"替代历史" |
| 11 | `GenericOpenAiCompatibleAdapter` | T07D 卡；公共子集由 `OpenAiCompatibleRuntime` 实现 | **替代** | **不接线** |
| 12 | `OpenAiChatCompletionsAdapter` | T07D 卡；生产用 `OpenAiCompatibleRuntime` | **替代** | **不接线**；`AzureOpenAiAdapter` 继承关系保留 |
| 13 | `AzureOpenAiAdapter` | `PROVIDER_ADAPTER_COVERAGE_2026-10-29.md`：azure/bedrock/gemini **当前不在任何请求路径上**；既有分诊判为"既定延后" | **未来** | **不接线**；从"缺陷清单"移出，改为"延后项" |
| 14 | `BedrockConverseAdapter` | 同上 | **未来** | 同上 |
| 15 | `GeminiInteractionsAdapter` | 同上（协议未进产品目录） | **未来** | 同上 |
| 16 | `LocalCompletionVerifier`（附：虽不计入 17，但同批发现） | T07D 八条结案条件；替代实现只覆盖 3 条（事件/任务 ID/产物），**证据包/活锁/预算**无落点 | **返修（子缺口）** | **不重复接线**旧类，但必须把 3 条缺失条件补进现有门禁 |
| 17 | `AgentModelAssignmentController` | 既有分诊判"被替代"（绑定存储+运行时池承担），但"仅安全点切换/切换事件"未实现 | **替代 + 子缺口** | **不重复接线**控制器；把"安全点切换"作为子项转入返修清单 |

## 汇总

| 分类 | 数量 | 说明 |
|---|---|---|
| **返修** | 9（1–9） | 均有卡/ADR 依据，属原范围接线缺口 |
| **替代** | 4（10–13 中的 10/11/12 + 17） | 不重复接线，仅更新能力清单 |
| **未来** | 3（13/14/15） | 既定延后，移出缺陷清单 |
| 子缺口 | 2（16、17） | 不重复接线，但缺失条件/语义转返修 |

## 边界声明

- 本表**未改任何代码**，只做定性；
- `替代` 与 `未来` 两类明确**不做接线**，避免重复实现与范围扩张；
- `返修` 9 项按公开库既有纪律逐项施工（先写反例、再实现、跑定向 + 全量、按显式路径提交）。
