# ALIGN-04：主干重启恢复与完成状态纠偏

日期：2026-10-27。状态：in_progress（01 部分交付 implemented-unverified；2026-10-28）。

执行约定：只修改本卡负责范围；先备份覆盖前文件，保留并行工作。每轮一个编号步骤，超过 3 小时拆分剩余步骤继续。允许更新本卡与所属仓库索引，不授权安装依赖、提交推送或调用真实付费模型。本轮沿用用户要求，不编写/运行测试，不构建或人工验收；按源码调用链交付证据，完成只能标 implemented-unverified，不得宣称运行验证通过。既有测试和 CI 不删除、不弱化。发现相关实现已存在则复用，不重复造轮子；缺少可信授权或遇并行覆盖冲突只阻塞对应步骤。具体模型是否曾替换设计无可靠证据，不作来源归罪。

前置：ALIGN-01/02/03。负责持久关系、租约恢复、任务对账与核心任务状态；不处理工作中目录迁移。
## 固定实现
1. 持久化 project/conversation/agent/sequence/group/mission 的显式关联，不只保存在 MainController 的 Map。重启从权威记录恢复映射，不从昵称或路径字符串猜归属。
2. 恢复先只读对账：哪些已完成、哪些租约失效、哪些副作用未知、哪些等待授权。用户可查看历史但查看不启动任务；旧授权不可仅凭恢复档案重用。
3. 获得现有合法恢复许可后从未完成且 ready 的节点恢复，执行恢复租约幂等领取；已产出但未回执的结果先对账，不盲目重跑。对不确定副作用保持待裁决。
4. 工作时段到期恢复复用同一调度入口，区分人工暂停和休息暂停；只唤醒有恢复资格的任务。不得引入另一份自动恢复队列。
5. 保留原始上下文及个体档案，按节点关闭/回访重建必要上下文；不把全局摘要当完整历史，不通过拼接全部角色日志恢复。
6. 按调用链修正核心计划状态：接口存在、组件存在、生产接线、代码完成、运行证据分别登记。空回调/硬编码假值/未持久化关联列为未完成，历史证据按原版本保留。
## 交付
新建同目录 ALIGN_CORE_HANDOFF.md，逐卡列出入口/控制器/存储/消费者/结果回流、剩余问题、备份和未验证说明。不得引入私有界面材料。
全部编码到位才标 implemented-unverified；不把此次静态检查写成恢复验收通过。


## 检查点记录

### 01 mission 关系索引与重启恢复——**部分交付**（2026-10-28）

**审查发现**：project/conversation/sequence/agent 映射此前**只在 `MainController` 的进程内 Map**；
`summary.json` 只有 project/conversation/sequence 三个字段，没有 agent/owner/group 的显式记录，
也没有任何"重启恢复映射"的代码路径。

**交付**：
| 层 | 位置 | 作用 |
|---|---|---|
| 索引存储 | `packages/core/src/orchestration/mission-relation-index.ts` | 一 mission 一文件 `<state>/mission-relations/<id>.json`（原子写 + `.bak` + revision）；合并登记（`undefined` 保留原值、数组取并集）；损坏即抛错不冒充"无关联" |
| 写入 | `main-controller.ts` `recordMissionRelation` | mission 创建后登记 project/conversation/主个体/序列/序列 owner/参与个体；失败经 `streamOutput` 如实告知 |
| 恢复 | `hydratePersistedMissionRelations` | 只恢复记录写过的字段；会话与身份存储核对，查不到**不恢复**、计入 `unresolvedConversationCount`；序列 revision 置 0（未知） |
| 启动接线 | `application-runtime.ts` | 构造后立即 `await hydrate…`；失败写 stderr、不阻断启动 |
| 防猜测 | `requestRuntimeTaskInsertion` | revision 未知（0）⇒ `stale-revision`，要求重新读取后再插入 |

**未做（如实）**：group（任务包）未写入（`createTaskBundle` 无生产调用方）；个体清单只有主/序列 owner/目标 agent，
三级 Worker 未补登记；旧 mission 无关系文件（恢复不会猜，迁移入口未实现）；`unresolvedConversationCount`
只作为返回值无 UI 呈现；未跑过"写入 → 重启 → 恢复 → 插入被拒"完整链路。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。
