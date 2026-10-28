# ADR-0066 胶囊 → 回访：按节点关闭重建上下文（ALIGN-04-05）

- 状态：部分采纳（回访入口已接；尚未注入提示词装配）
- 日期：2026-10-28
- 来源：[ALIGN-04](../tasks/ALIGN04_RECOVERY_AND_STATUS.md) 检查点 05
- 相关：ADR-0013（上下文节点）、ADR-0047（报告索引不自动注入）

## 1. 背景

卡内要求：保留**原始上下文与个体档案**，按**节点关闭/回访**重建必要上下文；
**不把全局摘要当完整历史**、**不拼接全部角色日志**恢复。

实测：

- 节点收口链路完整：`ContextNodeLifecycleController` → `ContextClosureCapsuleStore`
  （胶囊不可变、带 contentHash、owner + mission + node）。
- 但 **`ContextRecallController` 从未被构造** ⇒ 胶囊**只写不读**，
  "按节点关闭/回访重建"在产品里不可达。
- 顺带核对两处"看似违规"的路径，结论是**没有**违规：
  - 任务重试的档案附加（`selectArchiveAttachmentsForTask`）按 `taskId` 过滤、按属主分别生成附件，
    不拼接全部角色日志；
  - 没有任何路径把 `summarization` 的全局摘要当完整历史喂给恢复。

## 2. 契约（冻结）

1. **只有关闭胶囊可被回访**：`ContextRecallController.recall` 的输入面只有
   `{callerAgentInstanceId, request}`（节点/revision/原因码/token 上限）；
   它**没有**"包含全部 Agent""用全局摘要当历史"这类字段 —— 越权组合在结构上不可表达。
2. **按调用者隔离**：每个调用者使用自己的 `FileContextRecallLedgerStore`
   （`<state>/agent-memory/<caller>/recall-ledger.json`），冷却与任务级预算互不干扰。
3. **既有约束不变**：身份由 harness 注入（空身份直接拒）；次数上限 ⇒ 活锁拒；
   冷却期内重复 ⇒ `repeat-receipt`；命中敏感内容 ⇒ 丢弃整个结果；token 预算有界。
4. **如实失败**：控制器未装配 ⇒ `context-recall-invalid`（拒绝伪造历史）；
   节点无胶囊且无完整片段 ⇒ `not-found`，不返回"空历史当完整"。
5. **入口**：`MainController.recallClosedContext({callerAgentInstanceId, request})`。

## 3. 生产调用链（源码位置）

```
节点收口（已有）
└─ ContextNodeLifecycleController → ContextClosureCapsuleStore.createCapsule
回访（本轮接通）
└─ MainController.recallClosedContext                      packages/core/src/orchestration/main-controller.ts
   └─ contextRecallControllerFactory(callerAgentInstanceId)  application-runtime.ts
      └─ new ContextRecallController({ capsuleStore, ledgerPort: FileContextRecallLedgerStore })
         └─ recall → { ok(tier, nodeIndex, capsule, evidence, token 预算) | repeat-receipt | refused | not-found }
```

## 4. 未完成（如实）

- **没有注入提示词装配**：主/次级/三级在组装上下文时**不会自动调用回访**；
  回访目前只能由上层（UI/CLI/测试）显式调用 `recallClosedContext`。
- **`nodeIndexProvider` / `fullFragmentProvider` 未接管**：缺省返回 null ⇒
  没有胶囊的节点回访会 `not-found`，也不会返回"有界完整片段"。
- **敏感内容判定用默认实现**：没有接 SEC 系列的 DLP 策略（SEC-02 尚未实施）。
- **未验证**：没有跑过"胶囊存在 ⇒ ok / 冷却 ⇒ repeat-receipt / 超预算 ⇒ refused / 无胶囊 ⇒ not-found"。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
