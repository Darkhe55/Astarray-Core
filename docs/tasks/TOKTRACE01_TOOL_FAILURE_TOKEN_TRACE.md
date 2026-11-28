# TOKTRACE-01：工具失败 → 下一次成功的 token 消耗与日志关联

状态：**已实现（1–4 完成；未做热路径埋点/CLI 子命令/跨 mission 合并，见 §2）**（2026-11-28）。基线：`9331528b`。

## 0. 需求（用户原话）

> 当工具调用失败时，统计该工具到下一次成功调用中途消耗的 token 数量和日志，便于调试优化。

## 1. 现状核对（源码事实）

| 事实 | 位置 |
|---|---|
| 工具成功/失败都会被记录到 mission 运行历史（`tool-call` / `tool-failure`，含工具名、脱敏原因、时间戳） | `orchestration/run-history-store.ts`（`recordToolCall` / `recordToolFailure`） |
| 真实 Provider 用量按**请求**落账（`inputTokenCount` / `outputTokenCount` / `recordedAtIso` / `missionIdentifier` / `taskIdentifier`），未知用量记 `null` 不补 0 | `orchestration/usage-ledger-store.ts`、`orchestration/provider-usage-ledger-observer.ts` |
| 两套数据**没有关联**：运行历史只关心"调用了什么"，用量账目只关心"请求花了多少" | 现状即缺口 |

结论：不需要在热路径上新增埋点即可实现——用**时间轴关联**（同一 mission 内，失败时刻之后、该工具下一次成功时刻之前的所有 provider 请求用量求和），属于纯函数 + 只读查询，不影响执行路径。

## 2. 范围

必做：
1. 纯函数 `buildToolFailureTokenTraces({ toolEvents, usageObservations })`：
   - 以 `(missionIdentifier, toolName)` 为窗口键；
   - 第一次失败开窗，后续同工具失败**并入同一窗口**并计数（不另开窗、不覆盖）；
   - 该工具下一次成功 ⇒ 关窗，产出一条 trace；
   - 窗口内 provider 请求用量求和；未知用量（null）计入 `missingUsageRequestCount`，total 只累加已知值，`isComplete=false`；
   - 日志按时间升序：`tool-failure` → 中间 `provider-request` → `tool-success`。
2. `RunHistoryStore` 的只读解析：从 `RunHistoryDocument` 提取工具活动（不改存储格式）。
3. 门面查询入口 `facade.ops.queryToolFailureTokenTraces({ missionIdentifier })`：
   - 读运行历史 + 用量账目，调用纯函数；
   - 历史缺失 ⇒ 返回空数组并给出原因字段，不伪造。
4. 反例测试（先写）：见 §4。

不做（本轮明确不做，避免范围膨胀）：
- 不做热路径埋点（不改 tool-loop / provider runtime）；
- 不做跨 mission 合并（窗口严格按 mission 隔离）；
- 不做 CLI 子命令（下一轮按需要补，SDK 入口先可用）。

## 3. 数据契约

```ts
export interface ToolFailureTokenTrace {
  missionIdentifier: string;
  toolName: string;
  failureReason: string | null;      // 首次失败原因（脱敏后）
  failedAtIso: string;
  resolvedAtIso: string;             // 下一次成功时间
  durationMilliseconds: number | null;
  failureCount: number;              // 窗口内失败次数（≥1）
  providerRequestCount: number;
  inputTokenCount: number;           // 仅累加已知值
  outputTokenCount: number;
  totalTokenCount: number;
  missingUsageRequestCount: number;  // 用量未知（null）的请求数
  isComplete: boolean;               // 全部请求都有已知用量
  log: Array<{
    observedAtIso: string;
    kind: "tool-failure" | "provider-request" | "tool-success";
    detail: string;
    inputTokenCount: number | null;
    outputTokenCount: number | null;
  }>;
}
```

纪律：
- 时间解析失败（非法时间戳）⇒ 该事件**不参与关联**并在返回的 `skippedEventCount` 中计数，不静默丢弃；
- 未关窗（失败后没有成功调用）⇒ 不产出 trace（只有已收口的窗口才统计），并在 `openWindowCount` 中给出数量；
- 同一时刻（相同时间戳）按"失败 → 用量 → 成功"稳定排序。

## 4. 反例（先红后绿）

1. 失败后同工具成功：只统计窗口内请求，前后请求不计入；
2. 失败后**其他**工具成功不关窗；
3. 连续两次失败后成功：一条 trace，`failureCount=2`，日志两条失败；
4. 窗口内请求用量为 null ⇒ `missingUsageRequestCount>0`、`isComplete=false`、total 不补 0；
5. 未关窗（失败后无成功）⇒ 不产出 trace，`openWindowCount=1`；
6. 非法时间戳 ⇒ `skippedEventCount>0`，不影响其余窗口；
7. 不同 mission 同名工具互不串窗；
8. 未见失败的普通成功调用 ⇒ 不产 trace、不报错。

## 5. 验收

- `typecheck / lint / test / test:scripts / 隐私` 全绿；新增反例全部通过；
- 覆盖率不低于改造前 83.05%；
- 文档：本卡状态、`PLAN_STATUS` 记录；提交并推送。
