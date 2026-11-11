/**
 * COORD-01-03 §2/§5：控制门禁**优先于派发**（真实控制器路径）。
 *
 * 反例优先：撤权/取消后，即使任务已存在也必须拒绝派发（不得因"任务在窗口里"放行）。
 */
import { describe, expect, it } from "vitest";

import { ControlBypassController } from "../../../packages/core/src/orchestration/control-bypass.js";
import { MainController } from "../../../packages/core/src/orchestration/main-controller.js";

function buildController(controlBypass: ControlBypassController) {
  return new MainController({ feedbackTransport: { enqueue: async () => 0 }, controlBypass } as never);
}

describe("控制门禁优先于派发", () => {
  it("① 未受控 ⇒ 不走 control-blocked 分支", () => {
    const controller = buildController(new ControlBypassController());
    const result = controller.dispatchMissionTask("mission-1", "T-001");
    expect(result.reasonCode).not.toBe("control-blocked");
  });

  it("② 控制事件生效后 ⇒ 派发被拒且原因 control-blocked", () => {
    const controlBypass = new ControlBypassController();
    controlBypass.applyControlEvent({
      event: {
        eventIdentifier: "control-1",
        kind: "revoke",
        source: { sourceKind: "user", sourceIdentifier: "user:alice" },
        targetMissionIdentifier: "mission-1",
        issuedAtIso: "2026-11-11T00:00:00.000Z",
      },
    });
    const controller = buildController(controlBypass);
    const result = controller.dispatchMissionTask("mission-1", "T-001");
    expect(result.outcome).toBe("refused");
    expect(result.reasonCode).toBe("control-blocked");
  });

  it("③ 只影响被控制的目标 mission", () => {
    const controlBypass = new ControlBypassController();
    controlBypass.applyControlEvent({
      event: {
        eventIdentifier: "control-2",
        kind: "cancel",
        source: { sourceKind: "system", sourceIdentifier: "system:watchdog" },
        targetMissionIdentifier: "mission-1",
        issuedAtIso: "2026-11-11T00:00:00.000Z",
      },
    });
    const controller = buildController(controlBypass);
    const otherMission = controller.dispatchMissionTask("mission-2", "T-001");
    expect(otherMission.reasonCode).not.toBe("control-blocked");
  });
});
