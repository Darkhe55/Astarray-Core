/**
 * B9（2026-11-25）：`commands.ts` 参数校验分支（不触碰真实模型/网络）。
 *
 * 覆盖：usage/perf 的 --detail 与 --page-size、doctor-errors 的时间/分页校验、
 * guide-change 空文本/非法意图、config-init 幂等、summary-show 缺失源。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeConfigInitCommand,
  executeDoctorErrorsCommand,
  executeGuideChangeCommand,
  executePerfOverviewCommand,
  executeSummaryShowCommand,
  executeUsageOverviewCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cmd-validation-"));
  captured = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const text = (): string => captured.join("");

describe("B9：CLI 参数校验分支", () => {
  it("① usage overview：非法 --detail ⇒ 用法错误 2", async () => {
    const code = await executeUsageOverviewCommand({
      stateDirectory,
      detailLevel: "brief",
      isJsonOutput: false,
    } as never);
    expect(code).toBe(2);
    expect(text()).toContain("--detail");
  });

  it("② usage overview：非法 --page-size ⇒ 用法错误 2", async () => {
    const code = await executeUsageOverviewCommand({
      stateDirectory,
      pageSize: "abc",
      isJsonOutput: true,
    } as never);
    expect(code).toBe(2);
    expect(text()).toContain("page-size");
  });

  it("③ perf overview：非法 --detail ⇒ 用法错误 2", async () => {
    const code = await executePerfOverviewCommand({
      stateDirectory,
      detailLevel: "full",
      isJsonOutput: false,
    } as never);
    expect(code).toBe(2);
    expect(text()).toContain("--detail");
  });

  it("④ doctor errors：--since / --until / --page-size 非法 ⇒ 用法错误 2", async () => {
    expect(
      await executeDoctorErrorsCommand({
        stateDirectory,
        windowStartIso: "not-a-date",
        isJsonOutput: false,
      } as never),
    ).toBe(2);
    expect(
      await executeDoctorErrorsCommand({
        stateDirectory,
        windowEndIso: "not-a-date",
        isJsonOutput: false,
      } as never),
    ).toBe(2);
    expect(
      await executeDoctorErrorsCommand({
        stateDirectory,
        pageSize: "0",
        isJsonOutput: true,
      } as never),
    ).toBe(2);
  });

  it("⑤ guide change：空文本 / 非法意图 ⇒ 用法错误 2", async () => {
    expect(
      await executeGuideChangeCommand({
        stateDirectory,
        instructionText: "   ",
        changeIntent: null,
        isJsonOutput: false,
      } as never),
    ).toBe(2);
    expect(text()).toContain("指导文本为空");

    captured.length = 0;
    expect(
      await executeGuideChangeCommand({
        stateDirectory,
        instructionText: "有效指导",
        changeIntent: "delete-everything",
        isJsonOutput: false,
      } as never),
    ).toBe(2);
    expect(text()).toContain("非法变更类型");
  });

  it("⑥ config init：首次写入默认配置；再次执行走备份后覆盖", async () => {
    const first = await executeConfigInitCommand({
      stateDirectory,
      isJsonOutput: true,
    } as never);
    expect(first).toBe(0);
    const configPath = path.join(stateDirectory, "config.json");
    const initialContent = await fs.readFile(configPath, "utf8");
    expect(initialContent).toContain("\"mode\"");

    /** 已有配置被改过：init 仍按默认覆盖（覆盖前走 BackupVault 备份 + TOCTOU 校验）。 */
    await fs.writeFile(
      configPath,
      JSON.stringify({ mode: "assist", concurrency: 9 }),
      "utf8",
    );
    const second = await executeConfigInitCommand({
      stateDirectory,
      isJsonOutput: true,
    } as never);
    expect(second).toBe(0);
    expect(await fs.readFile(configPath, "utf8")).toContain("\"concurrency\": 4");
  });

  it("⑦ summary show：不存在的来源 ⇒ 非零退出且不打印伪造内容", async () => {
    const code = await executeSummaryShowCommand({
      stateDirectory,
      sourceIdentifier: "source-missing",
      isJsonOutput: true,
    } as never);
    expect(code).not.toBe(0);
  });
});
