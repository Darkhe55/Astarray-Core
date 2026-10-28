# ADR-0062 mission 关系索引与重启恢复（ALIGN-04-01）

- 状态：部分采纳（显式关联落盘 + 启动恢复；group 与旧数据迁移未做）
- 日期：2026-10-28
- 来源：[ALIGN-04](../tasks/ALIGN04_RECOVERY_AND_STATUS.md) 检查点 01
- 相关：ADR-0044（身份分层）、ADR-0048（旧身份只读审计）、ADR-0049（序列先于 mission）

## 1. 背景

卡内要求：持久化 project/conversation/agent/sequence/**group**/mission 的**显式关联**，
不只存在 `MainController` 的 Map；重启从权威记录恢复映射，**不按昵称或路径字符串猜归属**。

实测（之前）：`missionProjectIdentifiers`、`missionConversationIdentifiers`、
`missionTaskSequences`、`missionTargetAgentIdentifiers` 都是**进程内 Map**；
`summary.json` 里虽有 `projectIdentifier/conversationIdentifier/taskSequenceIdentifier`，
但**没有** agent/sequence owner/group 的显式记录，也没有"重启后恢复映射"的代码路径。

## 2. 契约（冻结）

1. **一 mission 一文件**：`<state>/mission-relations/<missionId>.json`（+ `.bak`，
   原子写、写前备份、损坏从备份恢复、读不出即 `journal-corrupted`，绝不返回空记录冒充"没有关联"）。
2. **只记事实**：字段空 = **当时没有**（不是"没记"）。`revision` 单调递增；
   `recordedAtIso` 首次登记时间、`updatedAtIso` 最近更新。
3. **合并登记**：只为**显式给出**的字段写新值（`undefined` 保留原值）；
   数组（任务包/参与个体）取**并集**，登记新成员不会抹掉旧成员。
4. **绝不推断**：本索引不从 missionId、目录名、昵称推导任何归属。
5. **启动恢复**：`hydratePersistedMissionRelations()` 只恢复记录里写过的字段；
   会话标识会与身份存储核对，**查不到就不恢复**并计入 `unresolvedConversationCount`
   （不改写成别的会话）。
6. **序列 revision 不推断**：恢复后置 `0`（未知）；此时任何"运行中插入"都以
   `stale-revision` 拒绝，要求调用方**重新读取**序列后再插入（不拿 0 去比对）。
7. **写失败可见**：登记失败通过 `streamOutput` 输出 `[关系索引] 写入失败…`；
   mission 已在运行不回滚，但重启后它**会缺映射**（不会被猜出来）。

## 3. 生产调用链（源码位置）

```
用户消息（assist/devolve）
└─ MainController.handleUserMessage → recordMissionRelation        packages/core/src/orchestration/main-controller.ts
   └─ MissionRelationIndexStore.upsert                            mission-relation-index.ts
      └─ <state>/mission-relations/<missionId>.json
启动
└─ createApplicationRuntime → controller.hydratePersistedMissionRelations()
   └─ MissionRelationIndexStore.listAll → 恢复 project/conversation/sequence 映射
      （会话对不上 ⇒ 计入 unresolved；序列 revision 置 0=未知）
```

## 4. 未完成（如实）

- **group（任务包）未写入**：`createTaskBundle` 仍无生产调用方，索引里的
  `taskBundleIdentifiers` 目前只会是空数组。
- **个体清单不完整**：只登记主个体、序列 owner（次级）、目标投递 agent；
  三级 Worker 个体没有在收口/派发时补登记。
- **旧 mission 无记录**：ALIGN-04 之前的 mission 没有关系文件 ⇒ 恢复不会"猜"它们；
  可用 ALIGN-01-07 的只读审计查看可关联项，迁移入口仍未实现。
- **没有冲突处理 UI**：`unresolvedConversationCount` 只作为返回值，不会被展示或要求人工裁决。
- **未验证**：没有跑过"写入 → 重启 → 恢复 → 插入被拒（revision 未知）"的完整链路。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
