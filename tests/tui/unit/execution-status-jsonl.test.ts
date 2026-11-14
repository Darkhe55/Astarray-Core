/**
 * CLI 执行状态事件输出（2026-11-14；EXEC-01-04「CLI 消费同一事件」第一步）。
 *
 * 钉住三件事：**只转发执行状态**、**字段白名单**（不含句柄/原始命令）、**失败原因脱敏**。
 */
import { describe, expect, it } from "vitest";

import {
  EXECUTION_STATUS_LINE_TYPE,
  formatExecutionStatusJsonLine,
} from "../../../packages/tui/src/cli/execution-status-jsonl.js";
import type { PublicAstarrayEvent } from "../../../packages/core/src/public-sdk.js";

const SECRET = `sk-${"q".repeat(24)}`;

function executionStatusEvent(overrides: Record<string, unknown> = {}): PublicAstarrayEvent {
  return {
    eventType: "execution-status",
    executionId: "execution-1",
    status: "succeeded",
    exitCode: 0,
    failureReason: null,
    terminationKind: null,
    revision: 3,
    ...overrides,
  } as unknown as PublicAstarrayEvent;
}

describe("执行状态事件 JSONL", () => {
  it("① 执行状态事件 ⇒ 一行可解析 JSON，字段与类型固定", () => {
    const line = formatExecutionStatusJsonLine(executionStatusEvent());
    expect(line).not.toBeNull();
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(parsed["type"]).toBe(EXECUTION_STATUS_LINE_TYPE);
    expect(parsed["executionId"]).toBe("execution-1");
    expect(parsed["status"]).toBe("succeeded");
    expect(parsed["exitCode"]).toBe(0);
    expect(parsed["failureReason"]).toBeNull();
    expect(parsed["terminationKind"]).toBeNull();
    expect(parsed["revision"]).toBe(3);
    /** 不含换行符：调用方负责分行。 */
    expect(line).not.toContain("\n");
  });

  it("② 非执行状态事件 ⇒ 返回 null（不把无关内容塞进输出）", () => {
    expect(
      formatExecutionStatusJsonLine({
        eventType: "permission-ask",
        requestIdentifier: "r-1",
      } as unknown as PublicAstarrayEvent),
    ).toBeNull();
  });

  it("③ 字段白名单：句柄/原始命令即使出现在事件里也不得输出", () => {
    const line = formatExecutionStatusJsonLine(
      executionStatusEvent({
        backendExecutionHandle: "handle-secret",
        commandText: "node -e 'console.log(1)'",
        stdinText: "敏感输入",
      }),
    );
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(parsed["backendExecutionHandle"]).toBeUndefined();
    expect(parsed["commandText"]).toBeUndefined();
    expect(parsed["stdinText"]).toBeUndefined();
    expect(line).not.toContain("handle-secret");
    expect(line).not.toContain("敏感输入");
  });

  it("④ 失败原因含密钥 ⇒ 输出前脱敏（防上游回归）", () => {
    const line = formatExecutionStatusJsonLine(
      executionStatusEvent({ status: "failed", failureReason: `bad token ${SECRET}` }),
    );
    expect(line).not.toContain(SECRET);
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(String(parsed["failureReason"])).toContain("[REDACTED]");
  });

  it("⑤ 缺 executionId 或 revision 非法 ⇒ 返回 null（不输出无法归属的状态行）", () => {
    expect(formatExecutionStatusJsonLine(executionStatusEvent({ executionId: "  " }))).toBeNull();
    expect(formatExecutionStatusJsonLine(executionStatusEvent({ revision: "3" }))).toBeNull();
    expect(formatExecutionStatusJsonLine(executionStatusEvent({ status: null }))).toBeNull();
  });

  it("⑥ exitCode 非整数 ⇒ 归一为 null（不输出 NaN/浮点误导消费方）", () => {
    const line = formatExecutionStatusJsonLine(executionStatusEvent({ exitCode: 1.5 }));
    const parsed = JSON.parse(line as string) as Record<string, unknown>;
    expect(parsed["exitCode"]).toBeNull();
  });
});
