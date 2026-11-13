/**
 * 指导变更意图日志（此前 `tests/` 零引用）：跨进程共享的 history/revision 状态。
 *
 * 反例优先：**没有状态就返回 null**（不伪造空状态）、未知 schema 版本拒绝读取、损坏文件返回 null、
 * 写入是整体替换而非追加。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileGuidanceChangeIntentJournal } from "../../../packages/core/src/runtime-guidance/guidance-change-intent-journal.js";
import type { GuidanceChangeIntentState } from "../../../packages/core/src/runtime-guidance/guidance-change-intent.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "guidance-intent-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildState(overrides: Partial<GuidanceChangeIntentState> = {}): GuidanceChangeIntentState {
  return {
    schemaVersion: 1,
    taskSequenceRevisionByTaskIdentifier: { "T-001": 3 },
    historyByTaskIdentifier: {},
    decisionByDeliveryKey: {},
    knownTaskIdentifiers: ["T-001"],
    ...overrides,
  } as GuidanceChangeIntentState;
}

function journalPath(): string {
  return path.join(baseDirectory, "guidance", "change-intent.json");
}

describe("指导变更意图日志", () => {
  it("① 从未写入 ⇒ null（不伪造空状态）", async () => {
    const journal = new FileGuidanceChangeIntentJournal({ baseDirectory });
    expect(await journal.read()).toBeNull();
  });

  it("② 写入后可读回（深相等）", async () => {
    const journal = new FileGuidanceChangeIntentJournal({ baseDirectory });
    const state = buildState();
    await journal.write(state);
    expect(await journal.read()).toEqual(state);
  });

  it("③ 未知 schema 版本 ⇒ null（不猜、不迁移）", async () => {
    const journal = new FileGuidanceChangeIntentJournal({ baseDirectory });
    await fs.mkdir(path.dirname(journalPath()), { recursive: true });
    await fs.writeFile(
      journalPath(),
      JSON.stringify({ ...buildState(), schemaVersion: 2 }),
      "utf8",
    );
    expect(await journal.read()).toBeNull();
  });

  it("④ 损坏文件 ⇒ null（不抛错）", async () => {
    const journal = new FileGuidanceChangeIntentJournal({ baseDirectory });
    await fs.mkdir(path.dirname(journalPath()), { recursive: true });
    await fs.writeFile(journalPath(), "{ 不是合法 JSON", "utf8");
    expect(await journal.read()).toBeNull();
  });

  it("⑤ 写入是整体替换（不追加），且自动创建目录", async () => {
    const journal = new FileGuidanceChangeIntentJournal({ baseDirectory });
    await journal.write(buildState({ knownTaskIdentifiers: ["T-001", "T-002"] }));
    await journal.write(buildState({ knownTaskIdentifiers: ["T-003"] }));

    const readBack = await journal.read();
    expect(readBack?.knownTaskIdentifiers).toEqual(["T-003"]);

    const rawContent = await fs.readFile(journalPath(), "utf8");
    expect(() => JSON.parse(rawContent)).not.toThrow();
    expect(JSON.parse(rawContent).schemaVersion).toBe(1);
  });

  it("⑥ 决策表原样往返（不丢字段、不改内容）", async () => {
    const journal = new FileGuidanceChangeIntentJournal({ baseDirectory });
    const state = buildState({
      decisionByDeliveryKey: {
        "delivery-1": {
          decisionKind: "applied",
          reason: "已应用",
        },
      } as never,
    });
    await journal.write(state);
    expect(await journal.read()).toEqual(state);
  });
});
