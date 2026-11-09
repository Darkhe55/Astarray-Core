/**
 * ALIGN-03-01/04（2026-11-10）：**Worker 直属上级**——唯一上级、恢复一致性、跨项目拒绝。
 *
 * 依据用户归属裁决：调度器不是上级；三级 Worker 的唯一直属上级是 mission 责任次级；
 * 禁止默认绑主 Agent；四级挂派生它的三级；缺失/不匹配 ⇒ 阻断并报告。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissionManager } from "../../../packages/core/src/orchestration/mission-manager.js";
import { TaskStore } from "../../../packages/core/src/infra/task-store.js";
import { resolveWorkerDirectSuperior } from "../../../packages/core/src/orchestration/worker-ownership.js";

vi.setConfig({ testTimeout: 30_000 });

const MAIN_AGENT = "main-agent-1";
const RESPONSIBLE_SECONDARY = "secondary-mission-1";

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveWorkerDirectSuperior({
    missionResponsibleSecondaryAgentInstanceId: RESPONSIBLE_SECONDARY,
    derivedFromTertiaryAgentInstanceId: null,
    mainAgentInstanceId: MAIN_AGENT,
    missionProjectIdentifier: "project-alpha",
    ...overrides,
  } as never);
}

describe("ALIGN-03 归属：唯一上级", () => {
  it("三级 Worker ⇒ 上级是 mission 责任次级（不是主 Agent、不是调度器）", () => {
    const resolution = resolve();
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.superiorAgentInstanceId).toBe(RESPONSIBLE_SECONDARY);
    expect(resolution.superiorAgentInstanceId).not.toBe(MAIN_AGENT);
  });

  it("**未绑定责任次级 ⇒ 阻断**（不得退回主 Agent）", () => {
    const resolution = resolve({ missionResponsibleSecondaryAgentInstanceId: null });
    expect(resolution.kind).toBe("blocked");
    if (resolution.kind !== "blocked") return;
    expect(resolution.reasonCode).toBe("mission-responsible-secondary-unbound");
  });

  it("责任次级被写成主 Agent ⇒ 阻断", () => {
    const resolution = resolve({
      missionResponsibleSecondaryAgentInstanceId: MAIN_AGENT,
    });
    expect(resolution.kind).toBe("blocked");
    if (resolution.kind !== "blocked") return;
    expect(resolution.reasonCode).toBe("responsible-secondary-is-main-agent");
  });

  it("四级 Worker ⇒ 上级是**派生它的三级**，不挂 mission 责任次级", () => {
    const resolution = resolve({ derivedFromTertiaryAgentInstanceId: "tertiary-9" });
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.superiorAgentInstanceId).toBe("tertiary-9");
    expect(resolution.basis).toBe("derived-from-tertiary");
  });
});

describe("ALIGN-03 归属：跨项目拒绝", () => {
  it("派发目标与 mission 项目不一致 ⇒ 阻断", () => {
    const resolution = resolve({ dispatchProjectIdentifier: "project-beta" });
    expect(resolution.kind).toBe("blocked");
    if (resolution.kind !== "blocked") return;
    expect(resolution.reasonCode).toBe("project-mismatch");
  });

  it("同项目 ⇒ 放行（不误伤）", () => {
    expect(resolve({ dispatchProjectIdentifier: "project-alpha" }).kind).toBe("resolved");
  });
});

describe("ALIGN-03 归属：恢复一致性", () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-owner-"));
  });

  afterEach(async () => {
    await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
  });

  it("责任次级**持久化后可读回**（恢复后绑定不变）", async () => {
    const missionManager = new MissionManager(
      new TaskStore({ baseDirectory: stateDirectory }),
      stateDirectory,
    );
    await missionManager.createMission({
      missionId: "mission-owned",
      mode: "assist",
      prompt: "任务",
      taskNodes: [
        {
          id: "T-1",
          description: "任务",
          dependsOn: [],
          taskType: "data",
          toolNames: ["readFile"],
          assignedAgentId: null,
          status: "pending",
          resultLocation: null,
        },
      ],
      responsibleSecondaryAgentInstanceId: RESPONSIBLE_SECONDARY,
    });
    const rawContent = await fs.readFile(
      path.join(stateDirectory, "missions", "mission-owned", "summary.json"),
      "utf8",
    );
    const summary = JSON.parse(rawContent) as Record<string, unknown>;
    expect(summary["responsibleSecondaryAgentInstanceId"]).toBe(RESPONSIBLE_SECONDARY);

    /** 恢复一致性：同一份持久化值解析出的上级必须相同（不因重启而换人）。 */
    const firstResolution = resolve({
      missionResponsibleSecondaryAgentInstanceId: summary[
        "responsibleSecondaryAgentInstanceId"
      ] as string,
    });
    const secondResolution = resolve({
      missionResponsibleSecondaryAgentInstanceId: summary[
        "responsibleSecondaryAgentInstanceId"
      ] as string,
    });
    expect(firstResolution).toEqual(secondResolution);
  }, 30_000);

  it("未提供责任次级 ⇒ 摘要里**不写**该字段（不得伪造主 Agent）", async () => {
    const missionManager = new MissionManager(
      new TaskStore({ baseDirectory: stateDirectory }),
      stateDirectory,
    );
    await missionManager.createMission({
      missionId: "mission-unbound",
      mode: "assist",
      prompt: "任务",
      taskNodes: [
        {
          id: "T-1",
          description: "任务",
          dependsOn: [],
          taskType: "data",
          toolNames: ["readFile"],
          assignedAgentId: null,
          status: "pending",
          resultLocation: null,
        },
      ],
    });
    const rawContent = await fs.readFile(
      path.join(stateDirectory, "missions", "mission-unbound", "summary.json"),
      "utf8",
    );
    const summary = JSON.parse(rawContent) as Record<string, unknown>;
    expect(summary["responsibleSecondaryAgentInstanceId"]).toBeUndefined();
  }, 30_000);
});
