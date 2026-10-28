# ADR-0048 旧身份映射的只读迁移判定

- 状态：已采纳（只读审计；**不执行迁移**）
- 日期：2026-10-28
- 来源：[ALIGN-01](../tasks/ALIGN01_IDENTITY_AND_MAIN_AGENT.md) 检查点 07
- 相关：ADR-0044（身份分层）、ADR-0047（报告索引）

## 1. 背景

ALIGN-01 之前的状态目录里，身份关系是零散的：

- `missions/<id>/summary.json` 大多**没有** `conversationIdentifier`（该字段是本轮才加的）；
- 个体标识存在 `agent-memory/<编码名>/`，其中既有稳定的 `main-<8hex>`（按 state dir 派生），
  也有**每次调用生成**的 `main:ponder:<8hex>`、**每个 mission 生成**的 `scheduler:<missionId>`；
- 会话映射文件 `conversation-identity/conversations.json` 只从本轮开始写。

卡内规则：**只能根据可核对关联迁移；不能按同名角色拼接历史；无唯一关联保持独立并标未知。**

## 2. 契约（冻结）

1. **只读、不改写**：审计产物 `isMigrationApplied: false`，也不存在写回路径。
   真正的迁移需要另开显式授权入口（本轮不做）。
2. **声明不是证据**：mission 摘要写了 `conversationIdentifier`，但**没有任何会话运行记录**
   引用该 mission ⇒ 保持独立并标未知，不按"它自己说的"迁移。
3. **唯一引用才算可关联**：mission 没有声明会话、但**恰好一个**会话的运行记录引用了它
   ⇒ 关联，证据 `single-run-reference`；声明与会话运行一致的 ⇒ 证据 `mission-summary-field`。
4. **多引用不猜**：≥2 个会话引用同一 mission ⇒ 保持独立、计入 `ambiguousMissionCount`，
   不允许"挑最近的/挑项目匹配的"这类启发式。
5. **绝不按名字合并**：`main:ponder:*` / `scheduler:*` 属**每次调用/每个 mission** 的身份，
   永远保持独立并列入 `ephemeralAgentIdentifiers`；同前缀不代表同一历史。
6. **个体归属只认唯一**：Agent 记忆目录反解出的个体，只有**恰好一个**会话的运行记录
   引用它时才归属（`single-conversation-reference`）；多个会话引用或零引用 ⇒ 独立 + 未知。
7. **缺失不是损坏**：旧目录缺文件按"该项不存在"处理；读取失败不伪造关联，也不中止审计。

## 3. 生产调用链（源码位置）

```
SDK 调用方
└─ auditLegacyIdentityMapping(stateDirectory)                 packages/core/src/public-sdk.ts
   ├─ collectLegacyIdentitySnapshot({ stateDirectory })       packages/core/src/orchestration/legacy-identity-migration.ts
   │  ├─ conversation-identity/conversations.json             （可缺）
   │  ├─ missions/<id>/summary.json                           （可缺）
   │  └─ agent-memory/<编码名> → decodePathSegment             （可缺）
   └─ analyzeLegacyIdentityAssociations(snapshot)             纯函数：四条规则，确定性
      → LegacyIdentityAudit { linkedMissions, attributedAgentIndividuals, keptIndependent,
                              ambiguousMissionCount, ephemeralAgentIdentifiers, unknownSubjectCount }
```

## 4. 未完成（如实）

- **没有写回**：本 ADR 只判定，不迁移；迁移入口需要显式用户授权设计（含备份与回滚）。
- **没有 CLI 入口**：目前只有 SDK 函数；`astarray` 子命令未注册。
- **ALIGN-04 尚未消费**：重启对账（看历史/恢复租约）还没调用这份审计。
- **没有在真实旧状态目录上跑过**：本项目工作目录的 `.astarray/` 既有旧数据，
  但本轮按卡内口径未运行测试/未执行端到端审计，**不宣称"旧数据审计通过"**。
- 审计只覆盖三类来源（会话映射、mission 摘要、个体记忆目录）；run-history / 报告索引里的
  旧身份尚未纳入。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
