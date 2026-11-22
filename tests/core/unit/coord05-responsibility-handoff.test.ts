/**
 * COORD-05 05-01（2026-11-22）：责任与交接。
 *
 * 覆盖：权威字段推导、发布者缺失时按归属回退、缺失如实报告、验收/依赖影响"能否自行决定"、
 * 组队提示顺序，以及既有字段不被覆盖。
 */
import { describe, expect, it } from "vitest";

import {
  buildResponsibilityRecord,
  describeResponsibilityInstructions,
} from "../../../packages/core/src/orchestration/responsibility-handoff.js";
import type { TaskDependencyNode } from "../../../packages/core/src/core/types.js";

function task(overrides: Partial<TaskDependencyNode> = {}): TaskDependencyNode {
  return {
    id: "T-1",
    description: "导出 docs/ 全部文件",
    dependsOn: [],
    taskType: "data",
    toolNames: ["readFile", "listDirectory"],
    assignedAgentId: "w1",
    status: "pending",
    resultLocation: null,
    acceptanceCriteria: "导出 docs/ 下全部文件且清单与文件一致",
    publishedByRecipientId: "s1",
    ...overrides,
  };
}

describe("COORD-05 05-01：责任与交接", () => {
  it("① 完整记录：可自行决定、材料与交付物保留，无缺失字段", async () => {
    const record = await buildResponsibilityRecord({
      task: task(),
      handoff: {
        inputReferences: [{ documentIdentifier: "docs/spec.md", revision: 2 }],
        outputReferences: [{ documentIdentifier: "out/export.json", revision: 0 }],
      },
    });
    expect(record.missingFields).toEqual([]);
    expect(record.publisherResolution).toBe("recorded");
    expect(record.ownerAgentInstanceId).toBe("w1");
    expect(record.canDecideIndependently.length).toBeGreaterThan(0);
    expect(record.escalationTriggers).toEqual([]);

    const lines = describeResponsibilityInstructions(record);
    expect(lines.join("\n")).toContain("docs/spec.md@rev2");
    expect(lines.join("\n")).toContain("可自行决定");
  });

  it("② 发布者缺失 ⇒ 按归属关系回退；仍无法确定则如实报告缺失", async () => {
    const viaCreator = await buildResponsibilityRecord({
      task: task({ publishedByRecipientId: null }),
      handoff: { inputReferences: [], outputReferences: [] },
      resolveCreatorOf: async (agentInstanceId) => (agentInstanceId === "w1" ? "s1" : null),
    });
    expect(viaCreator.publisherAgentInstanceId).toBe("s1");
    expect(viaCreator.publisherResolution).toBe("via-creator");
    expect(describeResponsibilityInstructions(viaCreator).join("\n")).toContain("归属关系回退");

    const missing = await buildResponsibilityRecord({
      task: task({ publishedByRecipientId: null, assignedAgentId: null }),
      handoff: { inputReferences: [], outputReferences: [] },
    });
    expect(missing.publisherAgentInstanceId).toBeNull();
    expect(missing.missingFields).toEqual(
      expect.arrayContaining(["ownerAgentInstanceId", "publisherAgentInstanceId"]),
    );
    expect(missing.escalationTriggers.join(" ")).toContain("发布者未记录");
  });

  it("③ 验收要求未声明 ⇒ 不能自行决定且必须请示确认", async () => {
    const record = await buildResponsibilityRecord({
      task: task({ acceptanceCriteria: undefined }),
      handoff: { inputReferences: [], outputReferences: [] },
    });
    expect(record.acceptanceCriteria).toBeNull();
    expect(record.missingFields).toContain("acceptanceCriteria");
    expect(record.canDecideIndependently).toEqual([]);
    expect(record.escalationTriggers.join(" ")).toContain("验收要求未声明");
  });

  it("④ 存在前置依赖 ⇒ 不得自行推进", async () => {
    const record = await buildResponsibilityRecord({
      task: task({ dependsOn: ["T-0"] }),
      handoff: { inputReferences: [], outputReferences: [] },
    });
    expect(record.canDecideIndependently).toEqual([]);
    expect(record.escalationTriggers.join(" ")).toContain("前置依赖：T-0");
  });

  it("⑤ 既有字段不被覆盖；输入/交付物原样保留", async () => {
    const record = await buildResponsibilityRecord({
      task: task({ publishedByRecipientId: "s-other" }),
      handoff: {
        inputReferences: [{ documentIdentifier: "docs/a.md", revision: 1 }],
        outputReferences: [{ documentIdentifier: "out/a.json", revision: 3 }],
      },
      resolveCreatorOf: async () => "s-creator",
    });
    expect(record.publisherAgentInstanceId).toBe("s-other");
    expect(record.publisherResolution).toBe("recorded");
    expect(record.inputReferences).toEqual([{ documentIdentifier: "docs/a.md", revision: 1 }]);
    expect(record.outputReferences).toEqual([
      { documentIdentifier: "out/a.json", revision: 3 },
    ]);
  });

  it("⑥ 非法交接引用 ⇒ 直接拒绝（不猜测）", async () => {
    await expect(
      buildResponsibilityRecord({
        task: task(),
        handoff: {
          inputReferences: [{ documentIdentifier: "", revision: 1 }],
          outputReferences: [],
        },
      }),
    ).rejects.toThrow(/非空标识/);
  });
});
