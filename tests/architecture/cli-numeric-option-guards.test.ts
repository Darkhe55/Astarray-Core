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
  it("① 严格解析器本身拒绝 parseInt 会截断的输入（5abc / 1e5 / 10.5）", async () => {
    const helperText = await readSource("packages/tui/src/cli/strict-integer-option.ts");
    // 纯数字判定必须在（不许用 parseInt 宽容截断）
    expect(helperText).toContain("/^\\d+$/.test(trimmedValue)");
  });

  it("② profile list 分页走严格解析（含 1..500 上界）", async () => {
    const cliText = await readSource("packages/tui/src/cli.tsx");
    expect(cliText).toContain('parseStrictPositiveIntegerOption(options.page ?? "1", "--page")');
    expect(cliText).toContain("maximum: 500,");
  });

  it("③ run 两个秒数走严格解析", async () => {
    const cliText = await readSource("packages/tui/src/cli.tsx");
    expect(cliText).toContain('"--timeout-seconds"');
    expect(cliText).toContain('"--provider-request-timeout-seconds"');
  });

  it("④ workflow run 的 --task-revision 走严格解析", async () => {
    const cliText = await readSource("packages/tui/src/cli.tsx");
    expect(cliText).toContain('"--task-revision"');
  });

  it("⑤ commands.ts：三处 --page-size 与 --input-token-budget 走严格纯数字（防回归）", async () => {
    const commandsText = await readSource("packages/tui/src/cli/commands.ts");
    const pageSizeGuardCount =
      commandsText.split(
        'if (\n    parsedPageSize !== undefined &&\n    (!/^\\d+$/.test(String(options.pageSize ?? "").trim()) || parsedPageSize < 1)\n  ) {',
      ).length - 1;
    expect(pageSizeGuardCount).toBe(3);
    expect(commandsText).toContain(
      'if (\n    parsedBudget !== undefined &&\n    (!/^\\d+$/.test(String(options.inputTokenBudget ?? "").trim()) || parsedBudget < 0)\n  ) {',
    );
  });
});
