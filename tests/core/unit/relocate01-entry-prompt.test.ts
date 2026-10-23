/**
 * RELOCATE-01 进入项目提示反例（2026-10-23）。
 *
 * 用户口径：提示只在**进入项目**时出现；身份一致也要提示（不能让人以为会自动重跑）；
 * 阻断级必须写清"需要做什么"。
 */
import { describe, expect, it } from "vitest";

import {
  buildProjectEntryRelocationPrompt,
} from "../../../packages/core/src/orchestration/project-relocation-entry-prompt.js";
import type { ProjectRelocationDescription } from "../../../packages/core/src/orchestration/project-relocation-controller.js";
import type { ProjectRelocationOutcome } from "../../../packages/core/src/orchestration/project-relocation-classification.js";

function description(
  classification: ProjectRelocationOutcome["classification"],
  overrides: Partial<ProjectRelocationOutcome> = {},
): ProjectRelocationDescription {
  return {
    registrationReadKind: "valid",
    outcome: {
      classification,
      isHistoryLoadable: classification === "identity-confirmed",
      isExecutionAllowed: false,
      requiredUserAction:
        classification === "identity-confirmed" ? "只读恢复对账" : "用户选择继续原项目或独立打开",
      reason:
        classification === "identity-confirmed"
          ? "身份一致：可加载历史并进入只读恢复对账；不直接重跑历史任务。"
          : "登记位置不可达，需要用户选择正确位置。",
      ...overrides,
    },
  };
}

describe("RELOCATE-01 进入项目提示", () => {
  it("① 身份一致 ⇒ 提示（信息级），并明确不会自动重跑", () => {
    const prompt = buildProjectEntryRelocationPrompt(description("identity-confirmed"));
    expect(prompt).toMatchObject({ shouldPrompt: true, isBlocking: false });
    expect(prompt.messageText).toContain("不会自动重跑");
  });

  it("② 位置不可达 ⇒ 阻断级，且写清需要用户做什么", () => {
    const prompt = buildProjectEntryRelocationPrompt(description("location-unreachable"));
    expect(prompt).toMatchObject({ shouldPrompt: true, isBlocking: true });
    expect(prompt.messageText).toContain("需要你执行");
    expect(prompt.messageText).toContain("用户选择继续原项目或独立打开");
  });

  it("③ 身份不符/歧义 ⇒ 阻断级", () => {
    expect(buildProjectEntryRelocationPrompt(description("identity-mismatch")).isBlocking).toBe(true);
    expect(buildProjectEntryRelocationPrompt(description("identity-ambiguous")).isBlocking).toBe(true);
  });

  it("④ 未登记/旧格式 ⇒ 阻断级，且提示不冒充已验证", () => {
    const prompt = buildProjectEntryRelocationPrompt(description("unregistered"));
    expect(prompt.isBlocking).toBe(true);
    expect(prompt.messageText).not.toContain("已确认");
  });

  it("⑤ 任何分类都要提示（进入项目时不能静默）", () => {
    for (const classification of [
      "identity-confirmed",
      "location-unreachable",
      "identity-mismatch",
      "identity-ambiguous",
      "identity-missing",
      "unregistered",
    ] as const) {
      expect(buildProjectEntryRelocationPrompt(description(classification)).shouldPrompt).toBe(true);
    }
  });
});
