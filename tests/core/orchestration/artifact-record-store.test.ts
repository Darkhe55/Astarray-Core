/** GUI-03-06：权威成果记录。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactRecordStore } from "../../../packages/core/src/orchestration/artifact-record-store.js";

const directories: string[] = [];
async function createStore(): Promise<ArtifactRecordStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-artifacts-"));
  directories.push(directory);
  return new ArtifactRecordStore({ baseDirectory: directory });
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("成果记录", () => {
  it("① 登记记录并去重", async () => {
    const store = await createStore();
    const first = await store.register({
      projectIdentifier: "p",
      missionIdentifier: "m",
      taskIdentifier: "T-1",
      artifactType: "file",
      displayName: "报告",
      location: "docs/report.md",
    });
    const second = await store.register({
      projectIdentifier: "p",
      missionIdentifier: "m",
      taskIdentifier: "T-1",
      artifactType: "file",
      displayName: "报告",
      location: "docs/report.md",
    });
    expect(second.artifactIdentifier).toBe(first.artifactIdentifier);
    expect(first.verificationStatus).toBe("unverified");
  });

  it("② 可更新核验状态", async () => {
    const store = await createStore();
    const record = await store.register({
      projectIdentifier: "p",
      missionIdentifier: "m",
      taskIdentifier: "T-1",
      artifactType: "file",
      displayName: "报告",
      location: "docs/report.md",
    });
    const verified = await store.verify({
      artifactIdentifier: record.artifactIdentifier,
      status: "verified",
    });
    expect(verified.verificationStatus).toBe("verified");
  });
});
