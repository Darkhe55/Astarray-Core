/**
 * 启动自动恢复：启动报告持久化（Phase 4，2026-11-05）。
 *
 * 每次执行（无论是启动自动触发还是显式调用）都落一份
 * `<state>/startup-recovery/last-report.json`：
 * 扫描结果 + 执行结果 + 动态上限原因。GUI 只读该文件，不重新跑扫描。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { cleanStaleTempFiles, readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import type { StartupRecoveryReport } from "./startup-recovery-scanner.js";
import type { StartupRecoveryRunReport } from "./startup-recovery-runner.js";

export const STARTUP_RECOVERY_REPORT_SCHEMA_VERSION = 1;

export interface StartupRecoveryBootReport {
  readonly schemaVersion: typeof STARTUP_RECOVERY_REPORT_SCHEMA_VERSION;
  readonly generatedAtIso: string;
  readonly scan: StartupRecoveryReport;
  readonly run: StartupRecoveryRunReport;
}

export class StartupRecoveryReportStore {
  private readonly directoryPath: string;
  private readonly filePath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "startup-recovery");
    this.filePath = path.join(this.directoryPath, "last-report.json");
  }

  async readReport(): Promise<StartupRecoveryBootReport | null> {
    const result = await readJsonWithBackupRecovery(
      this.filePath,
      `${this.filePath}.bak`,
    ).catch(() => null);
    if (result === null) return null;
    const content = result.content as Partial<StartupRecoveryBootReport> | null;
    if (
      content === null ||
      content.schemaVersion !== STARTUP_RECOVERY_REPORT_SCHEMA_VERSION ||
      content.scan === undefined ||
      content.run === undefined
    ) {
      return null;
    }
    return content as StartupRecoveryBootReport;
  }

  async writeReport(input: {
    readonly scan: StartupRecoveryReport;
    readonly run: StartupRecoveryRunReport;
    readonly generatedAtIso: string;
  }): Promise<StartupRecoveryBootReport> {
    const report: StartupRecoveryBootReport = {
      schemaVersion: STARTUP_RECOVERY_REPORT_SCHEMA_VERSION,
      generatedAtIso: input.generatedAtIso,
      scan: input.scan,
      run: input.run,
    };
    return this.writeLock.runExclusive(async () => {
      await fs.mkdir(this.directoryPath, { recursive: true });
      await cleanStaleTempFiles(this.directoryPath, "last-report.json");
      await writeAtomicJson(this.filePath, report);
      return report;
    });
  }
}
