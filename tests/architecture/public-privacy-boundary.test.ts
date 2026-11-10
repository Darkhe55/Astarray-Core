/**
 * 公开仓库隐私边界（2026-11-10）：**公开文档不得描述外部 UI 仓库的存在或结构**。
 *
 * 规则来源：`AGENTS.md` §0「公开仓库不得出现外部仓库的任何信息：仓库名、
 * 绝对/相对路径、目录结构、包名、测试路径、'存在外部仓库'的描述」。
 *
 * 现状：历史报告里已有 159 处此类措辞（57 个文件）。本轮**不清洗历史**——
 * 大规模改写历史报告会破坏记录，且是否需要改写历史属用户决策。
 * 本守卫的作用是**阻止新增**：新文件出现这些措辞即失败，
 * 已知文件记入 `KNOWN_LEGACY_FILES`，每删一项就少一处债务。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const DOCS_DIRECTORY_PATH = path.join(process.cwd(), "docs");

/** 会暴露外部 UI 仓库存在/结构的措辞（含仓库名与路径片段）。 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "外部 UI 包目录", pattern: /外部\s*GUI\s*包/u },
  { label: "外部 TUI 包目录", pattern: /外部\s*TUI\s*包/u },
  { label: "外部 UI 测试目录", pattern: /外部\s*GUI\s*测试/u },
  { label: "外部仓库名", pattern: /ui-package/u },
  { label: "本机用户目录", pattern: /C:\\Users\\<username>st KNOWN_LEGACY_FILES: ReadonlySet<string> = new Set([
  "docs/reports/BRIDGE01_04_STDIO_CLOSED_LOOP_EVIDENCE_2026-09-19.md",
  "docs/reports/CROSS_CARD_RECONCILIATION_2026-10-10_SESSION_END.md",
  "docs/reports/E2E01_04_LOCAL_REFRESH_2026-10-09.md",
  "docs/reports/GUI_MANUAL_ACCEPTANCE_2026-10-12.md",
  "docs/reports/GUI_MANUAL_EXPERIENCE_ROUND3_2026-11-08.md",
  "docs/reports/GUI01_R_01_SCOPE_FREEZE.md",
  "docs/reports/GUI01_R_02_LOCAL_SERVER_EVIDENCE.md",
  "docs/reports/GUI01_R_03_SETTINGS_RECOVERY_EVIDENCE.md",
  "docs/reports/GUI01_R_03B_VERIFICATION_DECISION_EVIDENCE.md",
  "docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_CHECKLIST.md",
  "docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_RECORD_2026-10-10.md",
  "docs/reports/GUI01_R_04_MANUAL_ACCEPTANCE_RECORD_2026-10-11.md",
  "docs/reports/GUI01_R_04A_UX_STATIC_EVIDENCE.md",
  "docs/reports/GUI01_R_04B_DANGLING_PROFILE_SELECTION_FINDING_2026-09-19.md",
  "docs/reports/GUI02_04_RESUME_PATH_2026-11-08.md",
  "docs/reports/HANDOFF_2026-09-28.md",
  "docs/reports/INT00_PRODUCT_PATH_MATRIX.md",
  "docs/reports/INT00_STATUS_RECONCILIATION.md",
  "docs/reports/LINUX_ACCEPTANCE_ENVIRONMENT_PROBE_2026-09-19.md",
  "docs/reports/OBS01_RECONCILIATION_2026-11-08.md",
  "docs/reports/PLATFORM_EVIDENCE_INDEX_2026-11-08.md",
  "docs/reports/RELIABILITY_01_01_AUDIT_MATRIX_2026-10-02.md",
  "docs/reports/RELIABILITY_SHUTDOWN_FIX_AND_FLAKE_QUANTIFICATION_2026-11-08.md",
  "docs/reports/SESSION_HANDOFF_2026-10-12.md",
  "docs/reports/T07D_R1_04_CONSUMER_PARITY_EVIDENCE.md",
  "docs/reports/T08_GIT_INTEGRATION_PRODUCT_PATH_GAP_2026-11-08.md",
  "docs/reports/TASKCARD_BACKLOG_2026-10-17.md",
  "docs/tasks/ALIGN_CORE_HANDOFF.md",
  "docs/tasks/GUI_MVP_CODING_TASK_CARD.md",
  "docs/tasks/GUI01_R_PRODUCT_WORKBENCH_TASK_CARD.md",
  "docs/tasks/HISTORY01_LOCAL_RUN_HISTORY_AND_RESUME_VIEW_TASK_CARD.md",
  "docs/tasks/MERGE01_NODECTX01_TASK_CARDS.md",
  "docs/tasks/PROJECT01_ISOLATION_AND_CROSS_PROJECT_BORROWING_TASK_CARD.md",
  "docs/tasks/SMART01_INSTRUCTION_WINDOW_AND_MAIN_RESPONSIVENESS_TASK_CARD.md",
  "docs/tasks/TOOLKIT01_PROJECT_TO_GENERAL_TOOL_LIFECYCLE_TASK_CARD.md",
  "docs/tasks/UX01_IMPLEMENTATION_MAP.md",
]);

async function listMarkdownFiles(directoryPath: string): Promise<string[]> {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(entryPath)));
      continue;
    }
    if (entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

describe("公开文档隐私边界", () => {
  it("**新增**文档不得出现外部 UI 仓库的存在或结构描述", async () => {
    const markdownFiles = await listMarkdownFiles(DOCS_DIRECTORY_PATH);
    const offendingFiles: string[] = [];
    for (const filePath of markdownFiles) {
      const relativePath = path.relative(process.cwd(), filePath).replace(/\\/gu, "/");
      if (KNOWN_LEGACY_FILES.has(relativePath)) continue;
      const content = await fs.readFile(filePath, "utf8");
      if (FORBIDDEN_PATTERNS.some((entry) => entry.pattern.test(content))) {
        offendingFiles.push(relativePath);
      }
    }
    expect(offendingFiles).toEqual([]);
  }, 60_000);
});
