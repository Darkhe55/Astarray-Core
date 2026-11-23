# COORD-03：上下文包装配与关闭节点回访（策略层）

**状态**：`implemented-unverified`（2026-11-23 对账：无人工验收；已接入上下文提供者：精确映射+按节点严格度；回访工具端到端可执行；**未做**真实用户会话验收）
**立卡**：2026-11-17（用户裁决原文见下）

## 1. 用户裁决（原文保留）

### 上下文包装配
- 采用「当前任务绑定包 + 显式依赖引用」组合装配，**不递归合并**所有依赖节点的完整包；
- 引用**固定 revision**；重复内容去重但**保留来源**；
- 冲突**不得按节点位置静默覆盖**；任务指令按发布权限和明确修订处理；
  事实冲突**提交直属上级裁决**；
- 必要内容超预算须**拆分或阻塞**，**不能截断假装完整**。

### 关闭节点回访
- **默认显式按需回访**，不自动相关性召回正文；
- 任务预先声明的必要依赖可按授权自动读取指定内容；
- 运行中的临时历史需求通过**工具请求**；
- 回访**不重开节点、不恢复任务、不改变原始历史**；
- 首版最多提供基于**显式引用、依赖关系和产物关联**的候选索引，
  **不引入向量模型或自动上下文决策模型**。

## 2. 已实现（纯判定，无 I/O）

| 能力 | 位置 | 关键规则 |
|---|---|---|
| 包装配计划 | `packages/core/src/orchestration/context-pack-assembly.ts` | 只接收"当前任务包 + 显式依赖引用"；不提供递归入口 |
| 版本固定 | 同上 | `pinnedRevision !== currentRevision` ⇒ 排除，不按最新版兜底 |
| 去重保留来源 | 同上 | 按 `contentFingerprint`（无指纹时按标识+摘要）去重，provenances 全留 |
| 冲突处理 | 同上 | 指令冲突按**包 sourcePriority**（user>agent>tool）；同权限 ⇒ 升级；事实冲突 ⇒ 升级 |
| 超预算 | 同上 | `requires-split` / `blocked`（含 atomic 包只能阻塞），**不截断** |
| 跨个体隔离 | 同上 | `ownerAgentInstanceIdentifier` 不是当前个体 ⇒ 不继承 |
| 回访候选索引 | `packages/core/src/orchestration/closed-node-recall-policy.ts` | 只来自显式引用/依赖关系/产物关联 |
| 自动召回 | 同上 | `selectAutomaticRecallCandidates()` **恒为空**（裁决要求，不是未实现） |
| 回访判定 | 同上 | 按需只认显式引用；预声明依赖可授权读固定 revision；side effects 恒 false |

反例：`tests/core/unit/context-pack-assembly-and-recall.test.ts`（12 条，覆盖上述每一条）。

## 3. 未完成（不虚报）

| 项 | 说明 |
|---|---|
| **接线** | 策略尚未接入 `context-prompt-provider` 的默认提供者；`contextPacks` / `recalledContextBlocks` 仍未传入 |
| 包数据源 | 当前任务节点的 `contextPack` 读取、依赖引用登记（固定 revision）尚未实现 |
| 候选索引数据源 | 显式引用/依赖关系/产物关联的实际存储读取未实现 |
| 产物关联 | 只有策略接口，没有从产物登记反查节点的实现 |
| 升级通道 | "事实冲突提交直属上级裁决"目前只产出 `escalations` 数据，未接消息发送 |

## 4. 验证

- 定向：12 条反例通过；
- 全量门禁：811 files / 5373 passed + 3 skipped，exit 0；
- **未做**真实进程级/包级验证（本卡是策略层，未改变外部接口）。
## 5. 接线阻塞点：`contextPack` 不在 mission 任务节点上（2026-11-17 核实）

尝试把"当前任务绑定包"接进 `createContextPromptProvider` 时被类型系统挡住：

| 事实 | 证据 |
|---|---|
| `contextPack` 字段属于 **`AgentTaskNode`**（个体待办序列） | `core/types.ts:694`；schema `core/schemas.ts:368`；使用方 `orchestration/task-sequence-controllers.ts:344` |
| `createContextPromptProvider` 的入参任务类型是 **`TaskDependencyNode`**（mission 任务链节点） | `orchestration/context-prompt-assembler.ts` 第 62-90 行输入契约 + `TaskDependencyNode` 定义中没有 `contextPack` |

也就是说：**"当前任务绑定包"在当前链路里没有可读字段**——不是实现漏了，是两个任务域没有对齐。

### 三条可选接线路径（需裁决）

| 方案 | 做法 | 代价 |
|---|---|---|
| A | 在 **agent 任务序列层**装配（字段已存在） | 与 mission 提供者不是同一条链路；需要新入口 |
| B | 给 `TaskDependencyNode` 增加可选 `contextPack`，由发布者写入 | schema + 生产者的改动；旧任务没有该字段 |
| C | 用既有 `missionTaskSequenceMapStore` 把 mission 任务映射到 agent 任务，再从序列存储读包 | 多一次映射查询；映射缺失时要如实降级 |

**未选择的理由**：三者的影响面不同（A 换链路、B 改 schema、C 依赖映射完整度），
在没有裁决前动手等于替使用者决定"包挂在哪一层"。本轮**不接线**，只记录证据。

## 6. 已回退的尝试（如实记录）

- 曾在 `context-prompt-assembler.ts` 里读 `input.task.contextPack` 并调用 `planContextPackAssembly`，
  **类型检查直接失败**（`TaskDependencyNode` 无该字段）⇒ 已 `git checkout` 回退，未留在仓库。
