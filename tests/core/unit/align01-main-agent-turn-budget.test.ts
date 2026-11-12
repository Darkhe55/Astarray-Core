/**
 * ALIGN-01-05：**主 Agent 单条处理预算与记账**（此前 `tests/` 零引用）。
 *
 * 卡内三条硬约束：
 * ① 预算上限 180 秒，且与派发期限同源；
 * ② 耗尽时保留已知进展并明确"待补信息/待继续"，**不得伪造已分发**；
 * ③ 任何 outcome 下 `isTaskDispatched` 都必须是 `false`（答复 ≠ 派发）。
 */
import { describe, expect, it } from "vitest";

import { MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS } from "../../../packages/core/src/orchestration/main-agent-deadline-supervisor.js";
import {
  MAIN_AGENT_TURN_BUDGET_MILLISECONDS,
  buildMainAgentTurnProgressRecord,
} from "../../../packages/core/src/orchestration/main-agent-turn-budget.js";
import type { MainAgentTurnOutcome } from "../../../packages/core/src/orchestration/main-agent-turn-budget.js";

const startedAtMilliseconds = Date.parse("2026-11-12T00:00:00.000Z");

function buildRecord(overrides: Record<string, unknown> = {}) {
  return buildMainAgentTurnProgressRecord({
    turnIdentifier: "turn-1",
    conversationIdentifier: "conversation-1",
    startedAtMilliseconds,
    endedAtMilliseconds: startedAtMilliseconds + 5_000,
    budgetMilliseconds: MAIN_AGENT_TURN_BUDGET_MILLISECONDS,
    outcome: "completed" as MainAgentTurnOutcome,
    streamedCharacterCount: 42,
    ...overrides,
  } as never);
}

describe("主 Agent 单条处理预算", () => {
  it("① 预算为 180 秒且与派发期限同源", () => {
    expect(MAIN_AGENT_TURN_BUDGET_MILLISECONDS).toBe(180_000);
    expect(MAIN_AGENT_TURN_BUDGET_MILLISECONDS).toBe(MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS);
  });

  it("② 任何 outcome 下都不得声称任务已派发", () => {
    for (const outcome of ["completed", "timed-out", "cancelled"] as const) {
      const record = buildRecord({ outcome });
      expect(record.isTaskDispatched).toBe(false);
    }
  });

  it("③ 超时 ⇒ 文案是「待补信息/待继续」，且不得出现已完成/已派发", () => {
    const record = buildRecord({
      outcome: "timed-out",
      endedAtMilliseconds: startedAtMilliseconds + 180_000,
      streamedCharacterCount: 1_234,
    });
    expect(record.nextActionText).toContain("补充信息");
    expect(record.nextActionText).toContain("没有派发任何任务");
    expect(record.knownProgressSummary).toContain("未派发");
    expect(record.knownProgressSummary).not.toContain("已完成");
    expect(record.knownProgressSummary).toContain("1234");
    expect(record.elapsedMilliseconds).toBe(180_000);
  });

  it("④ 完成态也必须写明「答复完成不等于任务已派发」", () => {
    const record = buildRecord({ outcome: "completed" });
    expect(record.knownProgressSummary).toContain("不等于任务已派发");
    expect(record.nextActionText).toContain("任务提案流程");
  });

  it("⑤ 取消态写明「没有派发任何任务」", () => {
    const record = buildRecord({ outcome: "cancelled" });
    expect(record.knownProgressSummary).toContain("未派发任何任务");
    expect(record.nextActionText).toContain("没有派发任何任务");
  });

  it("⑥ elapsed 不为负（时钟回拨也不产生负值），时间戳为 ISO", () => {
    const record = buildRecord({ endedAtMilliseconds: startedAtMilliseconds - 10_000 });
    expect(record.elapsedMilliseconds).toBe(0);
    expect(record.startedAtIso).toBe("2026-11-12T00:00:00.000Z");
    expect(record.endedAtIso).toBe("2026-11-11T23:59:50.000Z");
  });
});
