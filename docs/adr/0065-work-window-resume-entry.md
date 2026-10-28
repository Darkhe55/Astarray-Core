# ADR-0065 工作时段恢复：同一入口、区分暂停来源、不重复恢复（ALIGN-04-04）

- 状态：部分采纳（判定与入口已接；时段变化检测器未接）
- 日期：2026-10-28
- 来源：[ALIGN-04](../tasks/ALIGN04_RECOVERY_AND_STATUS.md) 检查点 04
- 相关：ADR-0063（恢复门禁）、ADR-0064（就绪分类与租约）

## 1. 背景

卡内要求：工作时段到期恢复**复用同一调度入口**；区分**人工暂停**与**休息暂停**；
只唤醒**有恢复资格**的任务；**不得引入另一份自动恢复队列**。

实测：`evaluateWorkWindowResume`（rest→working 只恢复一次、手动取消不复活、休息中不发新请求）
**已实现但没有任何调用方**；`resumeMission` 也没有"是否已在运行"的幂等守卫
（同一 mission 被重复恢复会启动第二个调度器 ⇒ 同一任务跑两遍）。

## 2. 契约（冻结）

1. **同一入口**：恢复只调用 `resumeMission`（其内部已有 ADR-0063 门禁与 ADR-0064 就绪分类），
   不新建队列、不新建状态机、不并行另一套恢复逻辑。
2. **区分暂停来源**：`pauseKind: "manual"` ⇒ 按手动取消处理（时段变化**不复活**）；
   `pauseKind: "rest"` ⇒ 只有 `rest → working` 变化才恢复**一次**。
   人工暂停优先于调用方传入的 `isManuallyCancelled`（两者任一为真即抑制）。
3. **最多一次**：`hasResumedSinceWake` 由调用方维护；已恢复过 ⇒ `already-resumed`，不做动作。
4. **运行中不重复调度**：`activeOrchestrators` 已有该 mission ⇒ 返回 `already-running`；
   `resumeMission` 自身也以同一判据幂等跳过。
5. **如实返回**：恢复被门禁/就绪判定拒绝时返回 `resume-rejected` + 原因，`didResume:false`
   —— 不把"没恢复"写成"已恢复"。
6. **事件唤醒**：真正恢复后 `notifySchedulingEvent("work-window-resumed")`（复用 02-07 的事件通道）。

## 3. 生产调用链（源码位置）

```
时段变化（由调用方/UI/timer 检测）
└─ MainController.handleWorkWindowResume                     packages/core/src/orchestration/main-controller.ts
   ├─ evaluateWorkWindowResume（既有纯函数）                  work-window-resume.ts
   │  （手动取消 > 仍休息 > 无待恢复 > 已恢复过 > 状态未变化 > resume-once）
   ├─ 非 resume-once ⇒ 返回 decision + reason（不动作）
   ├─ 已有活动编排器 ⇒ already-running
   ├─ resumeMission（同一入口）                                → 04-02 门禁 / 04-03 就绪分类 / 租约
   └─ notifySchedulingEvent("work-window-resumed")
调度器结束
└─ startSchedulerSafely.then → activeOrchestrators.delete（否则幂等守卫会永久挡住恢复）
```

## 4. 未完成（如实）

- **没有时段变化检测器**：谁在 `rest → working` 时调用 `handleWorkWindowResume` 尚未接线
  （需要 timer 或调度循环挂钩）；本检查点只提供入口与判定，不新增轮询。
- **`hasResumedSinceWake` 未持久化**：由调用方维护；重启后"本次唤醒已恢复过"会丢失
  （保守方向：可能多恢复一次，但被 `activeOrchestrators`/租约/就绪分类兜住）。
- **暂停来源无权威标记**：`pauseKind` 由调用方给出，没有从暂停原因存储里推导
  （`mergePauseReasons` 有种类，但没有"人工/休息"的单一权威映射）。
- **未验证**：没有跑过"人工暂停 ⇒ 时段恢复被抑制""rest→working ⇒ 只恢复一次"
  "已在运行 ⇒ 不重复调度"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
