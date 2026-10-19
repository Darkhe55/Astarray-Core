/**
 * 活规则：**人工体验清单**必须存在且完整（2026-10-19 R66）。
 *
 * 为什么需要这条守卫：
 * ① "人工体验已通过"是**唯一不能由代码自证**的验收项；清单一旦被删/被简化到只剩一句
 *    "已人工验收"，就没有任何东西能证明**到底验了什么**；
 * ② 反过来，清单存在**也不等于**通过 —— 所以本测试**只**校验清单结构与边界声明，
 *    **不**校验"是否通过"（那必须由人填）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "..", "..");
const checklistPath = path.join(
  repositoryRoot,
  "docs/reports/UI_MANUAL_ACCEPTANCE_CHECKLIST_2026-10-19.md",
);

async function readChecklist(): Promise<string> {
  return fs.readFile(checklistPath, "utf8");
}

describe("UI 人工体验清单", () => {
  it("① 清单文件存在，且明确声明「未填写即未验证」", async () => {
    const checklistText = await readChecklist();
    expect(checklistText).toContain("未填写的项一律视为**未验证**");
    expect(checklistText).toContain("不得因为清单存在就宣称");
  });

  it("② 五个必测流程齐全（冷启动/待授权/历史/设置/证据包）", async () => {
    const checklistText = await readChecklist();
    for (const requiredFlow of [
      "冷启动项目状态",
      "待授权卡批准 / 否决",
      "历史与过程说明",
      "设置修改",
      "证据包导出",
    ]) {
      expect(checklistText, `缺少必测流程：${requiredFlow}`).toContain(requiredFlow);
    }
  });

  it("③ 含可执行前置（junction + build + 启动命令），不是纯口号", async () => {
    const checklistText = await readChecklist();
    expect(checklistText).toContain("setup-links.ps1");
    expect(checklistText).toContain("npm run build");
    expect(checklistText).toContain("dist/cli.js gui serve");
    // 平台信息必须如实填写（不得跨平台冒充）
    expect(checklistText).toContain("跨平台结论不能互相冒充");
  });
});
