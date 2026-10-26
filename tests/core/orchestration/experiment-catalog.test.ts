/** GUI-03-04：实验能力目录。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPERIMENT_CATALOG,
  ExperimentSettingsStore,
} from "../../../packages/core/src/orchestration/experiment-catalog.js";

const directories: string[] = [];
async function createStore(): Promise<ExperimentSettingsStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-experiments-"));
  directories.push(directory);
  return new ExperimentSettingsStore({ baseDirectory: directory });
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("实验能力目录", () => {
  it("① 默认全关且没有运行时消费者的实验不能启用", async () => {
    const store = await createStore();
    const initial = await store.read();
    expect(initial.enabledExperimentIdentifiers).toEqual([]);
    expect(EXPERIMENT_CATALOG.every((entry) => !entry.runtimeConsumerWired)).toBe(true);
    await expect(
      store.update({
        expectedRevision: 1,
        enabledExperimentIdentifiers: ["FOLD-01"],
      }),
    ).rejects.toThrow("不能启用");
  });

  it("② 未知实验拒绝", async () => {
    const store = await createStore();
    await expect(
      store.update({
        expectedRevision: 1,
        enabledExperimentIdentifiers: ["UNKNOWN"],
      }),
    ).rejects.toThrow("未知实验");
  });
});
