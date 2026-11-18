/**
 * WIRING-04 §36.2 反例：工具包生命周期与操作反馈（2026-11-19）。
 *
 * - 生命周期文档是权威状态：旧快照覆盖会逆转"已停用/已锁定"。
 * - 操作反馈是累积审计：并发追加若互相覆盖，会丢审计记录。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolPackageLifecycleService } from "../../../packages/core/src/toolkit/tool-package-lifecycle-service.js";
import { ToolPackageOperationFeedbackStore } from "../../../packages/core/src/toolkit/tool-package-operation-control.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "toolkit-package-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function registration(toolPackageId: string, version: number) {
  return {
    toolPackageId,
    version,
    contentHash: `sha256:${String(version).padStart(64, "0")}`,
    sourceProjectIdentifier: "project-alpha",
    declaredSideEffects: ["none"],
    declaredDependencies: [],
    permissionRequirements: [],
  } as never;
}

function feedbackInput(detail: string) {
  return {
    toolPackageId: "package-1",
    projectIdentifier: "project-alpha",
    requestingAgentInstanceId: "agent-1",
    actionKind: "enable" as const,
    revision: 1,
    outcome: "succeeded" as const,
    detail,
  } as never;
}

describe("工具包生命周期：旧快照不得覆盖", () => {
  it("① A 基于旧版本落盘 ⇒ stale-revision；磁盘保留 B 的状态", async () => {
    const serviceA = new ToolPackageLifecycleService({ baseDirectory: stateDirectory });
    const serviceB = new ToolPackageLifecycleService({ baseDirectory: stateDirectory });

    /** 先让 A 载入版本 0（之后 A 的快照就是"旧值"）。 */
    await serviceA.install(registration("package-1", 1));

    /** B 载入版本 1 并安装新版本 ⇒ 版本推进到 2。 */
    await serviceB.install(registration("package-1", 2));

    /** A 仍基于版本 1 的快照：必须被拒。 */
    await expect(serviceA.install(registration("package-1", 3))).rejects.toMatchObject({
      errorCode: "stale-revision",
    });

    const stored = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "tool-packages", "lifecycle.json"), "utf8"),
    ) as { documentRevision: number; versions: Array<{ registration: { version: number } }> };
    expect(stored.documentRevision).toBe(2);
    expect(stored.versions.map((entry) => entry.registration.version)).toContain(2);
  }, 60_000);
});

describe("工具包操作反馈：并发追加不丢", () => {
  it("② 两个实例并发追加 40 条反馈 ⇒ 40 条都在", async () => {
    const firstStore = new ToolPackageOperationFeedbackStore({ stateDirectory });
    const secondStore = new ToolPackageOperationFeedbackStore({ stateDirectory });
    const appends: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      appends.push(
        firstStore.appendRecord(feedbackInput(`a-${String(index)}`)),
        secondStore.appendRecord(feedbackInput(`b-${String(index)}`)),
      );
    }
    await Promise.all(appends);

    const records = await new ToolPackageOperationFeedbackStore({ stateDirectory }).listRecords();
    expect(records).toHaveLength(40);
  }, 60_000);
});
