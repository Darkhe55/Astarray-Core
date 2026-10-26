/** GUI-03-05：工作时段配置存储。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectWorkWindowStore } from "../../../packages/core/src/orchestration/project-work-window-store.js";

const directories: string[] = [];
async function createStore(): Promise<ProjectWorkWindowStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-work-window-"));
  directories.push(directory);
  return new ProjectWorkWindowStore({ baseDirectory: directory });
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("工作时段配置", () => {
  it("① 保存规则并 revision 递增", async () => {
    const store = await createStore();
    const updated = await store.update({
      projectIdentifier: "project-a",
      expectedRevision: 1,
      rules: [
        {
          ruleIdentifier: "night-rest",
          mode: "rest-blacklist",
          weekdays: [1, 2, 3, 4, 5],
          startMinuteOfDay: 22 * 60,
          endMinuteOfDay: 7 * 60,
          timeZone: "Asia/Shanghai",
          priority: "periodic",
          validFromUtcIso: null,
          validUntilUtcIso: null,
          scopeKind: "project",
        },
      ],
    });
    expect(updated.revision).toBe(2);
    expect(updated.projects["project-a"]).toHaveLength(1);
    expect(await store.readRules("project-b")).toEqual([]);
  });

  it("② 过期 revision 拒绝", async () => {
    const store = await createStore();
    await expect(store.update({ expectedRevision: 2, rules: [] })).rejects.toThrow(
      "已被修改",
    );
  });
});


