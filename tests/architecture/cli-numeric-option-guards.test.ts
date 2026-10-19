/**
 * 活规则：CLI **数字参数**必须在边界校验（2026-10-19 R78）。
 *
 * 事故模型（两次真实发生）：``Number.parseInt("abc")`` ⇒ ``NaN`` 一路传进领域判定/分页，
 * 结果不是"报错"而是**静默的错误结果**（全部样本被判超预算、分页返回空列表）。
 * 本守卫只校验**已知高风险站点**的校验语句存在。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "..", "..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("CLI 数字参数边界校验", () => {
  it("① profile list：页码/每页必须校验（NaN/0/负数一律拒绝）", async () => {
    const cliText = await readSource("packages/tui/src/cli.tsx");
    expect(cliText).toContain("if (!Number.isInteger(page) || page < 1) {");
    expect(cliText).toContain("if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {");
  });

  it("② obs perf-rotate：预算/保留时长必须校验（正的有限数）", async () => {
    const rotateText = await readSource("packages/tui/src/cli/obs-perf-rotate-command.ts");
    expect(rotateText).toContain("if (!Number.isFinite(value) || value <= 0) {");
  });

  it("③ run：--timeout-seconds / --provider-request-timeout-seconds 必须是 ≥1 的整数秒", async () => {
    const cliText = await readSource("packages/tui/src/cli.tsx");
    // 校验语句必须在（放行 NaN 会让 setTimeout 立即超时）
    expect(cliText).toContain("if (!Number.isInteger(parsedValue) || parsedValue < 1) {");
    // 并且确实用了校验后的值（不再直接 parseInt 进选项）
    expect(cliText).toContain('parsePositiveSeconds(options.timeoutSeconds, "--timeout-seconds")');
    expect(cliText).toContain("providerRequestTimeoutMilliseconds: providerRequestTimeoutSeconds * 1_000");
  });
});
