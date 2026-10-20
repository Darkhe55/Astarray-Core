/**
 * LESSON-01-02 反例（2026-10-20）：跨任务命中不带任务细节、不同模型不误套、原文不可越域读、去重与版本失效。
 */
import { describe, expect, it } from "vitest";

import {
  computeLessonContentFingerprint,
  evaluateLessonRawTextAccess,
  selectLessonsForTask,
  type LessonSelectionCandidate,
} from "../../../packages/core/src/orchestration/lesson-selection.js";
import type { LessonModelSnapshot } from "../../../packages/core/src/orchestration/lesson-record-contract.js";

const modelA: LessonModelSnapshot = {
  providerIdentifier: "provider-a",
  modelIdentifier: "model-a",
  modelVersionIdentifier: "2026-10",
  effectiveConfiguration: { reasoning: "high" },
};

const modelB: LessonModelSnapshot = {
  ...modelA,
  modelIdentifier: "model-b",
};

function candidate(overrides: Partial<LessonSelectionCandidate> = {}): LessonSelectionCandidate {
  return {
    recordIdentifier: "lesson-1",
    revision: 1,
    scopeKind: "project",
    ownerAgentInstanceId: "agent-1",
    sourceTaskIdentifier: "task-old",
    sourceEvidenceReferences: ["evidence-old"],
    taskContextDescription: "旧任务的细节",
    observableFacts: ["构建慢 3 倍"],
    causeHypotheses: ["缺少缓存"],
    nextActionAdvice: ["先查缓存"],
    validityStatus: "valid",
    publisherModelSnapshot: modelA,
    recipientModelSnapshot: modelA,
    isEnabled: true,
    ...overrides,
  };
}

function select(
  candidates: ReadonlyArray<LessonSelectionCandidate>,
  overrides: Partial<Parameters<typeof selectLessonsForTask>[0]> = {},
) {
  return selectLessonsForTask(
    {
      requestingAgentInstanceId: "agent-1",
      taskIdentifier: "task-new",
      currentModelSnapshot: modelA,
      ...overrides,
    },
    candidates,
  );
}

describe("LESSON-01-02 跨任务选择", () => {
  it("① 跨任务命中 ⇒ 保留可迁移内容，剔除任务细节", () => {
    const result = select([candidate()]);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.isCrossTask).toBe(true);
    expect(entry?.isTaskDetailStripped).toBe(true);
    expect(entry?.strippedFieldNames).toEqual(
      expect.arrayContaining(["sourceTaskIdentifier", "sourceEvidenceReferences", "taskContextDescription"]),
    );
    expect(entry?.observableFacts).toEqual(["构建慢 3 倍"]);
  });

  it("② 同一任务 ⇒ 不算跨任务，不去细节", () => {
    const result = select([candidate({ scopeKind: "project", sourceTaskIdentifier: "task-new" })]);
    expect(result.entries[0]?.isCrossTask).toBe(false);
    expect(result.entries[0]?.strippedFieldNames).toEqual([]);
  });

  it("③ 不同模型 ⇒ role-model-config 不误套，并记录排除原因", () => {
    const result = select([
      candidate({ scopeKind: "role-model-config", recipientModelSnapshot: modelB }),
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedByModelMismatch).toEqual(["lesson-1"]);
  });

  it("④ 同模型但参数不同 ⇒ 仍不误套", () => {
    const result = select([
      candidate({
        scopeKind: "role-model-config",
        recipientModelSnapshot: { ...modelA, effectiveConfiguration: { reasoning: "low" } },
      }),
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedByModelMismatch).toHaveLength(1);
  });

  it("⑤ 模型无关规范可跨模型", () => {
    const result = select([
      candidate({ scopeKind: "model-independent-norm", recipientModelSnapshot: modelB }),
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.scopeKind).toBe("model-independent-norm");
  });

  it("⑥ 去重：同内容只留最高 revision，其余记入去重列表", () => {
    const base = candidate({ recordIdentifier: "lesson-old", revision: 1 });
    const newer = candidate({ recordIdentifier: "lesson-new", revision: 3 });
    expect(computeLessonContentFingerprint(base)).toBe(computeLessonContentFingerprint(newer));
    const result = select([base, newer]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.recordIdentifier).toBe("lesson-new");
    expect(result.deduplicatedRecordIdentifiers).toEqual(["lesson-old"]);
  });

  it("⑦ 版本失效（stale / superseded）⇒ 排除并记录", () => {
    const result = select([
      candidate({ recordIdentifier: "stale", validityStatus: "stale" }),
      candidate({ recordIdentifier: "superseded", validityStatus: "superseded" }),
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedByValidity).toEqual(["stale", "superseded"]);
  });

  it("⑧ 开关关闭 ⇒ 一条都不用，但仍给出原因", () => {
    const result = select([candidate({ isEnabled: false })]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedByDisabledSwitch).toEqual(["lesson-1"]);
  });

  it("⑨ 作用域过滤：只允许 task ⇒ project 条目被排除并记录", () => {
    const result = select([candidate()], { allowedScopeKinds: ["task"] });
    expect(result.entries).toHaveLength(0);
    expect(result.excludedByScope).toEqual(["lesson-1"]);
  });

  it("⑩ 原文不可跨个体读（同项目也不行）", () => {
    const decision = evaluateLessonRawTextAccess({
      requestingAgentInstanceId: "agent-2",
      ownerAgentInstanceId: "agent-1",
      recordProjectIdentifier: "project-a",
      requestingProjectIdentifier: "project-a",
    });
    expect(decision.kind).toBe("deny");
    expect(decision.reasonCode).toBe("cross-agent-raw-text-forbidden");
  });

  it("⑪ 原文不可跨项目读（同一个体也不行）", () => {
    const decision = evaluateLessonRawTextAccess({
      requestingAgentInstanceId: "agent-1",
      ownerAgentInstanceId: "agent-1",
      recordProjectIdentifier: "project-a",
      requestingProjectIdentifier: "project-b",
    });
    expect(decision.kind).toBe("deny");
    expect(decision.reasonCode).toBe("cross-project-raw-text-forbidden");
  });

  it("⑫ 同项目同一个体 ⇒ 允许读原文", () => {
    const decision = evaluateLessonRawTextAccess({
      requestingAgentInstanceId: "agent-1",
      ownerAgentInstanceId: "agent-1",
      recordProjectIdentifier: "project-a",
      requestingProjectIdentifier: "project-a",
    });
    expect(decision.kind).toBe("allow");
  });

  it("⑬ task 作用域只对同任务生效：不同任务一律不返回", () => {
    const result = select([candidate({ scopeKind: "task", sourceTaskIdentifier: "task-old" })]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedByCrossTaskScope).toEqual(["lesson-1"]);
  });

  it("⑭ task 作用域 + 同任务 ⇒ 正常返回且不去细节", () => {
    const result = select([candidate({ scopeKind: "task", sourceTaskIdentifier: "task-new" })]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.isTaskDetailStripped).toBe(false);
  });
});

