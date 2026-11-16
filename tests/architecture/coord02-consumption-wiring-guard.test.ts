/**
 * 架构守卫（COORD 检查点 2，2026-11-16）：**消费必须接在启动恢复上**。
 *
 * 背景：`runConsumptionStep` 曾在生产代码里零调用，"四检查点全部有生产接线"的说法因此站不住。
 * 本守卫钉住两件事，防止接线被悄悄摘掉：
 * 1. 启动恢复里确实调用 `runCoordinationConsumptionOnce(...)`；
 * 2. 消费结果确实被送进**权威任务链**（`applyCoordinationMessageToTaskState`），
 *    而不是只更新协调器内部状态。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RUNTIME_FILE_PATH = path.join(
  process.cwd(),
  "packages",
  "core",
  "src",
  "application",
  "application-runtime.ts",
);

async function readProductionCode(): Promise<string> {
  const content = await fs.readFile(RUNTIME_FILE_PATH, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("COORD 消费接线守卫", () => {
  it("① 启动恢复必须真的调用消费入口", async () => {
    const code = await readProductionCode();
    expect(code).toContain("runCoordinationConsumptionOnce({");
  }, 30_000);

  it("② 消费结果必须落到权威任务链（不得只改协调器内部状态）", async () => {
    const code = await readProductionCode();
    expect(code).toContain("applyCoordinationMessageToTaskState({");
  }, 30_000);
});
