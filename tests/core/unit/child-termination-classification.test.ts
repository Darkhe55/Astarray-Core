/**
 * 子进程终止原因分类（2026-11-13，新模块）。
 *
 * 重点：**自报原因优先于退出码推断**；信号杀与"非零退出码崩溃"必须分开，
 * 否则日志会继续把人引向"操作系统在杀进程"的错误结论。
 */
import { describe, expect, it } from "vitest";

import {
  classifyChildTermination,
  isFailureTerminationCategory,
} from "../../../packages/core/src/feedback-process/child-termination-classification.js";

describe("子进程终止分类", () => {
  it("① 自报原因优先：心跳失联 / 父进程断开 / 正常关机", () => {
    expect(
      classifyChildTermination({ exitCode: 1, exitSignal: null, reportedReason: "heartbeat-lost" }),
    ).toBe("heartbeat-lost");
    expect(
      classifyChildTermination({
        exitCode: 1,
        exitSignal: null,
        reportedReason: "parent-disconnected",
      }),
    ).toBe("parent-disconnected");
    expect(
      classifyChildTermination({
        exitCode: 0,
        exitSignal: null,
        reportedReason: "shutdown-completed",
      }),
    ).toBe("shutdown-completed");
  });

  it("② 无自报时按退出形态推断：信号杀 ≠ 非零退出 ≠ 零退出", () => {
    expect(classifyChildTermination({ exitCode: null, exitSignal: "SIGKILL", reportedReason: null })).toBe(
      "killed-by-signal",
    );
    expect(classifyChildTermination({ exitCode: 1, exitSignal: null, reportedReason: null })).toBe(
      "crashed",
    );
    expect(classifyChildTermination({ exitCode: 0, exitSignal: null, reportedReason: null })).toBe(
      "clean-exit-unexpected",
    );
    expect(classifyChildTermination({ exitCode: null, exitSignal: null, reportedReason: null })).toBe(
      "unknown",
    );
  });

  it("③ 空信号字符串不被当成信号（避免误判为被信号杀）", () => {
    expect(classifyChildTermination({ exitCode: 1, exitSignal: "", reportedReason: null })).toBe(
      "crashed",
    );
  });

  it("④ 只有正常关机不算故障；其余类别都要按故障计数", () => {
    expect(isFailureTerminationCategory("shutdown-completed")).toBe(false);
    for (const category of [
      "heartbeat-lost",
      "parent-disconnected",
      "killed-by-signal",
      "crashed",
      "clean-exit-unexpected",
      "unknown",
    ] as const) {
      expect(isFailureTerminationCategory(category)).toBe(true);
    }
  });
});
