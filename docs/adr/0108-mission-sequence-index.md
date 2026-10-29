# ADR-0108 mission ↔ 权威序列的持久索引（两套记账收口 R21）

- 状态：已采纳（写入 + CLI 读取；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R21
- 相关：ADR-0078（记账对照）、ADR-0085（`task-ledger status`）

## 1. 背景

`MainController` 只在内存里维护 `missionTaskSequences`；进程重启即丢，
于是对账 CLI 与运行中插入都必须**手填** sequence 与 owner。仓库里没有该映射的持久索引。

## 2. 设计（冻结）

1. **存储**：`<state>/task-ledger/mission-sequences.json`；一条 mission → 一个序列
   （`sequenceIdentifier` / `ownerAgentInstanceIdentifier` / `boundAtIso`）。
2. **写入**：登记序列映射时落盘（发布路径 + 关系索引回填路径）；
   **写失败不阻断发布**，但 `streamOutput` 如实告知（索引是辅助观测，不能假装已落盘）。
3. **不改绑**：同一 mission 已有不同序列 ⇒ `journal-corrupted` 拒绝（不静默改绑）；
   重复绑定同一序列 ⇒ 幂等。
4. **不推断**：没有绑定 ⇒ `null`；调用方必须如实报"未知"，**不按任务名/路径猜**。
5. **CLI**：`task-ledger status --mission X` 时，若缺 `--sequence`/`--owner`，
   先查本索引补全；索引缺失 ⇒ 仍报"缺参数"。
6. **原子写 + 备份恢复**；损坏读回空文档（宁可未知）。

## 3. 生产调用链（源码位置）

```
MainController（发布/恢复时）
├─ missionTaskSequences.set(...)
└─ persistMissionSequenceBinding → MissionSequenceBindingStore.bind
   └─ <state>/task-ledger/mission-sequences.json
CLI task-ledger status                        packages/tui/src/cli/task-ledger-command.ts
└─ MissionSequenceBindingStore.readForMission（缺省才要求手填）
```

## 4. 未完成（如实）

- **只索引、不修复**：序列与 mission 链的差异仍由 ADR-0078 的对照与 ADR-0084 的历史记录呈现，
  本索引不触发任何同步。
- **没有 revoke/改绑入口**：绑定写错只能人工删文件（无 CLI）。
- **一个 mission 一个序列**：若未来出现多序列场景，该模型不够用。
- **未运行验证**：没跑过"写入后 CLI 免手填""不同序列拒绝改绑""索引缺失 ⇒ 仍要求手填"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
