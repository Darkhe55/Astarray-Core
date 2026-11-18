/**
 * 成果登记跨实例并发（2026-11-18）。
 *
 * 成果记录是"任务产出了什么"的权威登记：并发登记丢记录 ⇒ 验收/摘要缺产物。
 * 两个独立实例并发登记不同产物，读-改-写必须串行化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactRecordStore } from "../../../packages/core/src/orchestration/artifact-record-store.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): ArtifactRecordStore {
  return new ArtifactRecordStore({ baseDirectory: stateDirectory });
}

function registerOne(store: ArtifactRecordStore, sequence: number): Promise<unknown> {
  return store.register({
    projectIdentifier: "project-alpha",
    missionIdentifier: "mission-1",
    taskIdentifier: `T-${String(sequence)}`,
    artifactType: "file",
    displayName: `out-${String(sequence)}.md`,
    location: `out-${String(sequence)}.md`,
  });
}

describe("成果登记跨实例并发", () => {
  it("① 两个实例并发登记 40 个产物 ⇒ 40 条记录全部落盘", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const registrations: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      registrations.push(
        registerOne(firstStore, index * 2),
        registerOne(secondStore, index * 2 + 1),
      );
    }
    await Promise.all(registrations);

    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "artifacts", "records.json"), "utf8"),
    ) as { records: Array<unknown> };
    expect(document.records).toHaveLength(40);
  }, 90_000);

  it("② 同一产物被两个实例并发登记 ⇒ 只留一条（幂等，不重复计数）", async () => {
    const firstStore = buildStore();
    await Promise.all([registerOne(firstStore, 1), registerOne(buildStore(), 1)]);
    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "artifacts", "records.json"), "utf8"),
    ) as { records: Array<unknown> };
    expect(document.records).toHaveLength(1);
  }, 90_000);
});
