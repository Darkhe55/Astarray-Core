/**
 * COORD-01-03（卡 §2/§5）：**控制旁路**。
 *
 * 反例优先：
 * - **agent 来源**自标 control ⇒ 拒绝（不得自授控制权）；
 * - 控制事件**立即**设置门禁（不等 idle、不等模型阅读）；
 * - 重复事件标识 ⇒ 幂等忽略，不重复计数；
 * - 在途能力 `unknown` ⇒ **不得**报成 `confirmed-stopped`；
 * - 不支持取消 ⇒ 如实报 `unsupported`，门禁仍阻止后续动作。
 */
import { describe, expect, it } from "vitest";

import { ControlBypassController } from "../../../packages/core/src/orchestration/control-bypass.js";
import type { ControlEvent } from "../../../packages/core/src/orchestration/control-bypass.js";

function buildEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
  return {
    eventIdentifier: "control-1",
    kind: "cancel",
    source: { sourceKind: "user", sourceIdentifier: "user:alice" },
    targetMissionIdentifier: "mission-1",
    issuedAtIso: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("控制旁路", () => {
  it("① 可信来源 ⇒ 立即阻止后续动作", () => {
    const controller = new ControlBypassController();
    expect(controller.isExecutionBlocked("mission-1")).toBe(false);
    const result = controller.applyControlEvent({ event: buildEvent() });
    expect(result.outcome).toBe("applied");
    expect(result.isExecutionBlocked).toBe(true);
    expect(controller.isExecutionBlocked("mission-1")).toBe(true);
  });

  it("② **agent 来源** ⇒ 拒绝且不改变门禁", () => {
    const controller = new ControlBypassController();
    const result = controller.applyControlEvent({
      event: buildEvent({ source: { sourceKind: "agent", sourceIdentifier: "worker-1" } }),
    });
    expect(result.outcome).toBe("rejected-untrusted-source");
    expect(controller.isExecutionBlocked("mission-1")).toBe(false);
  });

  it("③ 重复事件标识 ⇒ 幂等忽略", () => {
    const controller = new ControlBypassController();
    controller.applyControlEvent({ event: buildEvent() });
    const duplicate = controller.applyControlEvent({ event: buildEvent() });
    expect(duplicate.outcome).toBe("duplicate-ignored");
  });

  it("④ 在途能力 unknown ⇒ 报 unknown，**不得**报 confirmed-stopped", () => {
    const controller = new ControlBypassController();
    const result = controller.applyControlEvent({
      event: buildEvent(),
      hasInFlightOperation: true,
      inFlightCapability: "unknown",
    });
    expect(result.inFlightResolution).toBe("unknown");
    expect(result.inFlightResolution).not.toBe("confirmed-stopped");
  });

  it("⑤ 不支持取消 ⇒ unsupported，门禁仍阻止后续动作", () => {
    const controller = new ControlBypassController();
    const result = controller.applyControlEvent({
      event: buildEvent(),
      hasInFlightOperation: true,
      inFlightCapability: "does-not-support-cancel",
    });
    expect(result.inFlightResolution).toBe("unsupported");
    expect(controller.isExecutionBlocked("mission-1")).toBe(true);
  });

  it("⑥ 支持取消 ⇒ confirmed-stopped（唯一可宣称已停止的分支）", () => {
    const controller = new ControlBypassController();
    const result = controller.applyControlEvent({
      event: buildEvent(),
      hasInFlightOperation: true,
      inFlightCapability: "supports-cancel",
    });
    expect(result.inFlightResolution).toBe("confirmed-stopped");
  });
});
