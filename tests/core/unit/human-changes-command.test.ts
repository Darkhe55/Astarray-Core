/**
 * REPAIR（HumanWorktreeObserver）：journal 只读展示入口。
 *
 * 反例：目录不存在是"还没观察"（空列表 + 0），**不是**读不出来（5）；
 * 指定 id 不存在 ⇒ observation-not-found + 4。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runHumanChangesCommand } from "../../../packages/tui/src/cli/human-changes-command.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "human-changes-cli-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

describe("human-changes 只读命令", () => {
  it("目录不存在 ⇒ 空列表且退出码 0（不是错误）", async () => {
    const result = await runHumanChangesCommand({ stateDirectory });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", observations: [] });
  });

  it("列出已落盘观察；指定 id 可读回完整记录", async () => {
    const journal = path.join(stateDirectory, "human-change-journal");
    await fs.mkdir(journal, { recursive: true });
    await fs.writeFile(
      path.join(journal, "obs-2.json"),
      JSON.stringify({ observationIdentifier: "obs-2" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(journal, "obs-1.json"),
      JSON.stringify({ observationIdentifier: "obs-1" }),
      "utf8",
    );

    const listed = await runHumanChangesCommand({ stateDirectory });
    expect(JSON.parse(listed.stdout).observations.map((item: { observationIdentifier: string }) => item.observationIdentifier)).toEqual([
      "obs-1",
      "obs-2",
    ]);

    const single = await runHumanChangesCommand({ stateDirectory, observationIdentifier: "obs-2" });
    expect(single.exitCode).toBe(0);
    expect(JSON.parse(single.stdout).observationIdentifier).toBe("obs-2");
  });

  it("指定 id 不存在 ⇒ observation-not-found 与退出码 4", async () => {
    const result = await runHumanChangesCommand({ stateDirectory, observationIdentifier: "nope" });
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).status).toBe("observation-not-found");
  });
});
