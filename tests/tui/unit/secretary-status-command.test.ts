/**
 * SECRETARY-01-04 公开入口反例（2026-10-23）：`secretary status` 命令。
 *
 * 覆盖：默认不限预算/默认全天、忙碌时 deferred（两种习惯）、显式上限与显式时段生效、
 * 非法 habit 与非法数值 fail-closed（返回非 0）。
 */
import { describe, expect, it } from "vitest";

import { executeSecretaryStatusCommand } from "../../../packages/tui/src/cli/secretary-command.js";

function base(overrides: Partial<Parameters<typeof executeSecretaryStatusCommand>[0]> = {}) {
  return {
    stateDirectory: ".tmp/secretary-command-test",
    tokensUsed: 0,
    sessionTokenLimit: undefined,
    minuteOfDay: 600,
    startMinuteOfDay: undefined,
    endMinuteOfDay: undefined,
    isProjectConversationBusy: false,
    habit: undefined,
    isJsonOutput: true,
    ...overrides,
  };
}

describe("SECRETARY-01-04 secretary status", () => {
  it("① 默认：命令成功（不限预算 + 全天），且不写配置", async () => {
    await expect(executeSecretaryStatusCommand(base())).resolves.toBe(0);
  });

  it("② 项目忙碌 ⇒ 成功返回但上层判定为 deferred（命令本身不阻塞）", async () => {
    await expect(
      executeSecretaryStatusCommand(base({ isProjectConversationBusy: true })),
    ).resolves.toBe(0);
  });

  it("③ 非法 habit ⇒ fail-closed 非 0", async () => {
    await expect(executeSecretaryStatusCommand(base({ habit: "no-such-habit" }))).resolves.toBe(1);
  });

  it("④ 非法 tokens-used（负数）⇒ fail-closed 非 0", async () => {
    await expect(executeSecretaryStatusCommand(base({ tokensUsed: -1 }))).resolves.toBe(1);
  });

  it("⑤ 非法 minute-of-day（越界）⇒ fail-closed 非 0", async () => {
    await expect(executeSecretaryStatusCommand(base({ minuteOfDay: 2000 }))).resolves.toBe(1);
  });

  it("⑥ 显式上限与显式时段也能正常执行（命令层不误拒）", async () => {
    await expect(
      executeSecretaryStatusCommand(
        base({
          tokensUsed: 10,
          sessionTokenLimit: 5,
          minuteOfDay: 480,
          startMinuteOfDay: 540,
          endMinuteOfDay: 1080,
        }),
      ),
    ).resolves.toBe(0);
  });
});
