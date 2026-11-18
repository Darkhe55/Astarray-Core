/**
 * mission 关系索引与序列绑定的跨实例并发（2026-11-18）。
 *
 * 两处都会累积条目：
 * - 关系索引：同一 mission 并发 upsert 会把成员数组按旧快照抹掉；
 * - 序列绑定：单一文档累积所有 mission 绑定，并发登记会互相覆盖。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissionRelationIndexStore } from "../../../packages/core/src/orchestration/mission-relation-index.js";
import { MissionSequenceBindingStore } from "../../../packages/core/src/orchestration/mission-sequence-binding-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mission-index-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

describe("mission 序列绑定跨实例并发", () => {
  it("① 两个实例并发绑定 40 个 mission ⇒ 40 条绑定全部可见", async () => {
    const firstStore = new MissionSequenceBindingStore({ baseDirectory: stateDirectory });
    const secondStore = new MissionSequenceBindingStore({ baseDirectory: stateDirectory });
    const binds: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      binds.push(
        firstStore.bind({
          missionIdentifier: `mission-a-${String(index)}`,
          sequenceIdentifier: "sequence-1",
          ownerAgentInstanceIdentifier: "agent-1",
          boundAtIso: "2026-11-18T00:00:00.000Z",
        }),
        secondStore.bind({
          missionIdentifier: `mission-b-${String(index)}`,
          sequenceIdentifier: "sequence-1",
          ownerAgentInstanceIdentifier: "agent-1",
          boundAtIso: "2026-11-18T00:00:00.000Z",
        }),
      );
    }
    await Promise.all(binds);

    const document = await new MissionSequenceBindingStore({
      baseDirectory: stateDirectory,
    }).read();
    expect(document.bindings).toHaveLength(40);
  }, 90_000);
});

describe("mission 关系索引跨实例并发", () => {
  it("② 同一 mission 并发追加不同成员 ⇒ 两组成员都在（不按旧快照抹掉）", async () => {
    const firstIndex = new MissionRelationIndexStore({ baseDirectory: stateDirectory });
    const secondIndex = new MissionRelationIndexStore({ baseDirectory: stateDirectory });
    await Promise.all([
      firstIndex.upsert({
        missionIdentifier: "mission-1",
        taskBundleIdentifiers: ["bundle-a"],
      }),
      secondIndex.upsert({
        missionIdentifier: "mission-1",
        taskBundleIdentifiers: ["bundle-b"],
      }),
    ]);

    const record = await new MissionRelationIndexStore({ baseDirectory: stateDirectory }).read(
      "mission-1",
    );
    expect(record?.taskBundleIdentifiers).toEqual(
      expect.arrayContaining(["bundle-a", "bundle-b"]),
    );
  }, 90_000);
});
