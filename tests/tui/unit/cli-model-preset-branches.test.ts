/**
 * B9（2026-11-24）：`model` / `preset` / `craftsman status` 只读命令分支。
 *
 * 覆盖：模型目录（含/不含演示条目，凭据字段不泄漏）、模型解析（JSON/文本）、
 * 预设列表（模块可加载语义），工匠状态（内置三模板 + 组件装配如实标注）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeCraftsmanStatusCommand,
  executeModelCatalogCommand,
  executeModelResolveCommand,
  executePresetListCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-model-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function run(action: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

describe("B9：model / preset / craftsman 只读命令", () => {
  it("① model catalog：不栽演示条目 ⇒ 空；栽入后 2 条且不含凭据字段", async () => {
    const empty = await run(() =>
      executeModelCatalogCommand({ isJsonOutput: true, seedDemoEntries: false }),
    );
    const emptyParsed = JSON.parse(empty.output) as { entries: unknown[] };
    expect(emptyParsed.entries).toEqual([]);

    const seeded = await run(() =>
      executeModelCatalogCommand({ isJsonOutput: true, seedDemoEntries: true }),
    );
    const seededParsed = JSON.parse(seeded.output) as { entries: unknown[] };
    expect(seededParsed.entries).toHaveLength(2);
    expect(seeded.output).not.toContain("cred-ref-");
  });

  it("② model catalog（文本）⇒ 列出模型显示名", async () => {
    const { output } = await run(() =>
      executeModelCatalogCommand({ isJsonOutput: false, seedDemoEntries: true }),
    );
    expect(output).toContain("GPT-4o");
    expect(output).toContain("Claude 3");
  });

  it("③ model resolve：JSON 与文本都给出 selected/blocked 结论", async () => {
    const json = await run(() => executeModelResolveCommand({ isJsonOutput: true }));
    const parsed = JSON.parse(json.output) as { outcome: string };
    expect(["selected", "blocked"]).toContain(parsed.outcome);

    const text = await run(() => executeModelResolveCommand({ isJsonOutput: false }));
    expect(text.output).toMatch(/^(selected|blocked): /u);
  });

  it("④ preset list：JSON 标注「模块可加载 ≠ 已装配」；文本同样如实", async () => {
    const json = await run(() => executePresetListCommand({ isJsonOutput: true }));
    const parsed = JSON.parse(json.output) as {
      totalCount: number;
      componentsReadySemantics: string;
    };
    expect(parsed.totalCount).toBeGreaterThan(0);
    expect(parsed.componentsReadySemantics).toBe("module-loadable-not-assembly");

    const text = await run(() => executePresetListCommand({ isJsonOutput: false }));
    expect(text.output).toContain("可加载");
    expect(text.output).toContain("另需核实");
  });

  it("⑤ craftsman status：JSON 三模板；文本组件状态如实", async () => {
    const json = await run(() =>
      executeCraftsmanStatusCommand({ stateDirectory, isJsonOutput: true }),
    );
    const parsed = JSON.parse(json.output) as {
      profiles: Array<{ profileId: string }>;
      componentsReady: { actionExecutor: boolean };
    };
    expect(parsed.profiles.map((profile) => profile.profileId)).toEqual([
      "craftsman-stage-early",
      "craftsman-stage-balanced",
      "craftsman-stage-conservative",
    ]);
    expect(typeof parsed.componentsReady.actionExecutor).toBe("boolean");

    const text = await run(() =>
      executeCraftsmanStatusCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(text.output).toContain("动作执行器:");
    expect(text.output).toContain("工作流生命周期:");
  });
});
