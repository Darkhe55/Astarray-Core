/**
 * RELOCATE-01 进入项目提示与三选项反例（2026-10-23）。
 *
 * 用户口径：提示提供「仅查看历史」「重定位项目位置」「直接退出」三选项；
 * 仅查看历史只在历史可加载时可用；重定位不自动改写登记；退出不做任何恢复。
 */
import { describe, expect, it } from "vitest";

import {
  applyProjectEntryRelocationChoice,
  buildProjectEntryRelocationPrompt,
} from "../../../packages/core/src/orchestration/project-relocation-entry-prompt.js";
import type { ProjectRelocationDescription } from "../../../packages/core/src/orchestration/project-relocation-controller.js";
import type { ProjectRelocationOutcome } from "../../../packages/core/src/orchestration/project-relocation-classification.js";

function description(
  classification: ProjectRelocationOutcome["classification"],
  overrides: Partial<ProjectRelocationOutcome> = {},
): ProjectRelocationDescription {
  const isConfirmed = classification === "identity-confirmed";
  return {
    registrationReadKind: "valid",
    outcome: {
      classification,
      isHistoryLoadable: isConfirmed,
      isExecutionAllowed: false,
      requiredUserAction: isConfirmed ? "只读恢复对账" : "用户选择继续原项目或独立打开",
      reason: isConfirmed ? "身份一致：可加载历史并进入只读恢复对账。" : "登记位置不可达，需要用户选择正确位置。",
      ...overrides,
    },
  };
}

describe("RELOCATE-01 进入项目：三选项", () => {
  it("① 选项顺序固定：仅查看历史 / 重定位项目位置 / 直接退出", () => {
    const prompt = buildProjectEntryRelocationPrompt(description("identity-confirmed"));
    expect(prompt.options.map((option) => option.label)).toEqual([
      "仅查看历史",
      "重定位项目位置",
      "直接退出",
    ]);
  });

  it("② 身份一致 ⇒ 仅查看历史可用，且提示不会自动重跑", () => {
    const prompt = buildProjectEntryRelocationPrompt(description("identity-confirmed"));
    expect(prompt.isBlocking).toBe(false);
    const viewHistory = prompt.options.find((option) => option.identifier === "view-history-only");
    expect(viewHistory?.isEnabled).toBe(true);
    expect(prompt.messageText).toContain("不会自动重跑");
  });

  it("③ 位置不可达 ⇒ 仅查看历史**禁用**并给出原因（不提供假入口）", () => {
    const prompt = buildProjectEntryRelocationPrompt(description("location-unreachable"));
    const viewHistory = prompt.options.find((option) => option.identifier === "view-history-only");
    expect(prompt.isBlocking).toBe(true);
    expect(viewHistory?.isEnabled).toBe(false);
    expect(viewHistory?.reasonIfDisabled ?? "").toContain("不能加载历史");
  });

  it("④ 选择「直接退出」⇒ exit，不执行任何恢复", () => {
    const outcome = applyProjectEntryRelocationChoice({
      description: description("location-unreachable"),
      choice: "exit",
    });
    expect(outcome.kind).toBe("exit");
    expect(outcome.message).toContain("未做任何恢复");
  });

  it("⑤ 选择「仅查看历史」：可加载时允许且不批准执行；不可加载时拒绝", () => {
    const allowed = applyProjectEntryRelocationChoice({
      description: description("identity-confirmed"),
      choice: "view-history-only",
    });
    expect(allowed).toMatchObject({ kind: "allowed", isExecutionAllowed: false });

    const blocked = applyProjectEntryRelocationChoice({
      description: description("location-unreachable"),
      choice: "view-history-only",
    });
    expect(blocked).toMatchObject({ kind: "blocked", reasonCode: "history-not-loadable" });
  });

  it("⑥ 选择「重定位项目位置」⇒ 只给指引，不自动改写登记", () => {
    const outcome = applyProjectEntryRelocationChoice({
      description: description("location-unreachable"),
      choice: "relocate",
    });
    expect(outcome).toMatchObject({ kind: "blocked", reasonCode: "relocation-not-applied" });
    expect(outcome.message).toContain("不自动改写登记");
  });

  it("⑦ 未知选项 ⇒ 明确拒绝（不当作退出）", () => {
    const outcome = applyProjectEntryRelocationChoice({
      description: description("identity-confirmed"),
      choice: "delete-everything",
    });
    expect(outcome).toMatchObject({ kind: "blocked", reasonCode: "unknown-option" });
  });
});
