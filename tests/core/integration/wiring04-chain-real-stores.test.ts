/**
 * WIRING-04 整链（组件级）证据（2026-11-25）：
 * 真实映射存储 + 真实序列存储 → 解析端口 → 固定版本读取 → 回访块登记。
 *
 * 说明：这证明"映射→包→回访"链在**真实存储**上贯通；
 * 真实模型请求载荷的端到端（假 Provider）仍单列为未完成。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_TASK_SEQUENCE_SCHEMA_VERSION } from "../../../packages/core/src/core/types.js";
import { AgentTaskSequenceStore } from "../../../packages/core/src/orchestration/agent-task-sequence-store.js";
import {
  createSequenceContextPackResolutionPort,
  resolveContextPackForMissionTask,
} from "../../../packages/core/src/orchestration/context-pack-resolution.js";
import { MissionTaskSequenceMapStore } from "../../../packages/core/src/orchestration/mission-task-sequence-map-store.js";
import { RecalledContextBlockStore } from "../../../packages/core/src/orchestration/recalled-context-block-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-wiring-chain-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sequenceDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_TASK_SEQUENCE_SCHEMA_VERSION,
    sequenceId: "seq-1",
    ownerAgentInstanceId: "agent-1",
    revision: 3,
    updatedAtIso: "2026-11-25T00:00:00.000Z",
    nodes: [
      {
        taskId: "seq-task-1",
        title: "任务一",
        dependsOn: [],
        sourceKind: "agent",
        publisherId: "agent-0",
        priorityTier: 1,
        status: "pending",
        blockReason: null,
        externalReference: null,
        sequenceOrdinal: 1,
        createdAtIso: "2026-11-25T00:00:00.000Z",
        contextPack: {
          packIdentifier: "pack-1",
          mergePolicy: "atomic",
          sourcePriority: "user",
          members: [
            {
              memberIdentifier: "m-1",
              sourceKind: "user",
              summary: "选定正文：A 方案",
              contentFingerprint: "sha256:m1",
            },
          ],
        },
      },
    ],
    bundles: [],
    auditEntries: [],
    ...overrides,
  } as never;
}

async function buildChain(options: { readonly sequenceRevision?: number } = {}) {
  const sequenceStore = new AgentTaskSequenceStore({ baseDirectory });
  await sequenceStore.writeSequenceDirect(
    sequenceDocument(
      options.sequenceRevision === undefined ? {} : { revision: options.sequenceRevision },
    ),
  );
  const mapStore = new MissionTaskSequenceMapStore({ baseDirectory });
  await mapStore.bind({
    missionIdentifier: "mission-1",
    sequenceIdentifier: "seq-1",
    ownerAgentInstanceIdentifier: "agent-1",
    missionTaskIdentifier: "T-1",
    sequenceTaskIdentifier: "seq-task-1",
  });
  const port = createSequenceContextPackResolutionPort({ mapStore, sequenceStore });
  return { sequenceStore, mapStore, port };
}

describe("WIRING-04 整链（真实存储）", () => {
  it("① 映射 → 序列包 → 固定当前版本：解析出选定正文与内容哈希", async () => {
    const chain = await buildChain();
    const result = await resolveContextPackForMissionTask({
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-1",
      sequenceIdentifier: "seq-1",
      sequenceOwnerAgentInstanceIdentifier: "agent-1",
      port: chain.port,
      pinnedRevision: 3,
    });
    expect(result.kind).toBe("pack");
    if (result.kind !== "pack") return;
    expect(result.pack.members[0]?.summary).toBe("选定正文：A 方案");
    expect(result.revision).toBe(3);
    expect(result.contentHash).toHaveLength(64);
  });

  it("② 固定旧版本但无历史存储 ⇒ blocked（不用最新内容冒充旧版本）", async () => {
    const chain = await buildChain();
    const result = await resolveContextPackForMissionTask({
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-1",
      sequenceIdentifier: "seq-1",
      sequenceOwnerAgentInstanceIdentifier: "agent-1",
      port: chain.port,
      pinnedRevision: 2,
    });
    expect(result).toMatchObject({ kind: "declared-but-missing" });
  });

  it("③ 没有映射 ⇒ mapping-missing（不按名称猜）", async () => {
    const sequenceStore = new AgentTaskSequenceStore({ baseDirectory });
    await sequenceStore.writeSequenceDirect(sequenceDocument());
    const mapStore = new MissionTaskSequenceMapStore({ baseDirectory });
    const port = createSequenceContextPackResolutionPort({ mapStore, sequenceStore });
    const result = await resolveContextPackForMissionTask({
      missionIdentifier: "mission-1",
      missionTaskIdentifier: "T-1",
      sequenceIdentifier: "seq-1",
      sequenceOwnerAgentInstanceIdentifier: "agent-1",
      port,
    });
    expect(result).toMatchObject({ kind: "mapping-missing" });
  });

  it("④ 显式回访块按任务登记且只被该任务读回（另一个任务读不到）", async () => {
    const store = new RecalledContextBlockStore({ baseDirectory });
    await store.register({
      missionIdentifier: "mission-1",
      agentInstanceIdentifier: "agent-1",
      missionTaskIdentifier: "T-1",
      contextNodeIdentifier: "node-1",
      sourceRevision: 2,
      text: "回访片段：接口约定",
      registeredAtIso: "2026-11-25T00:00:00.000Z",
    });
    expect(
      await store.listFor({
        missionIdentifier: "mission-1",
        agentInstanceIdentifier: "agent-1",
        missionTaskIdentifier: "T-1",
      }),
    ).toHaveLength(1);
    expect(
      await store.listFor({
        missionIdentifier: "mission-1",
        agentInstanceIdentifier: "agent-1",
        missionTaskIdentifier: "T-2",
      }),
    ).toHaveLength(0);
  });
});
