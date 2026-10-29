/**
 * GOAL-02 R3（2026-10-29）：**目标契约存储**。
 *
 * 目标模式此前只有内存契约；门禁解析器需要"按 mission 找到目标契约 + 持久化门禁快照"
 * 才能还原 `GoalDispatchGate`。本模块补契约的落盘与读取（不可变文件、原子写、备份恢复）。
 *
 * 边界：
 * - **只存契约**（版本、owner、要求、权重等），不存运行状态（状态在 `GoalModeStateStore`）；
 * - 写入前用 `validateGoalContract` 校验，非法契约**拒绝落盘**；
 * - 不提供"模型改目标"入口（改版本仍须 `assertGoalRevisionChangeAllowed`，由调用方先校验）。
 */
import path from "node:path";

import { AsyncMutex } from "../infra/async-mutex.js";
import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";
import { DomainError } from "../core/errors.js";
import { validateGoalContract } from "./goal-contract.js";
import type { GoalContract } from "./goal-contract.js";

export class GoalContractStore {
  private readonly directoryPath: string;
  private readonly writeLock = new AsyncMutex();

  constructor(options: { baseDirectory: string }) {
    this.directoryPath = path.join(options.baseDirectory, "goal-mode", "contracts");
  }

  private contractFilePath(goalIdentifier: string): string {
    const sanitized = goalIdentifier.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.directoryPath, `${sanitized}.json`);
  }

  async save(contract: GoalContract): Promise<void> {
    const validation = validateGoalContract(contract);
    if (!validation.isValid) {
      throw new DomainError(
        "invalid-task-chain",
        `目标契约非法，拒绝落盘: ${validation.reasons.join("；")}`,
      );
    }
    await this.writeLock.runExclusive(async () => {
      await writeAtomicJson(this.contractFilePath(contract.goalIdentifier), contract);
    });
  }

  async read(goalIdentifier: string): Promise<GoalContract | null> {
    const filePath = this.contractFilePath(goalIdentifier);
    const readResult = await readJsonWithBackupRecovery(filePath, `${filePath}.bak`);
    if (readResult === null) {
      return null;
    }
    const content = readResult.content as Partial<GoalContract> | null;
    if (
      content === null ||
      typeof content !== "object" ||
      typeof content.goalIdentifier !== "string" ||
      !Array.isArray(content.requirements)
    ) {
      return null;
    }
    const validation = validateGoalContract(content as GoalContract);
    return validation.isValid ? (content as GoalContract) : null;
  }

  /** 列出所有可读契约（非法/损坏的跳过；调用方按需再报）。 */
  async list(): Promise<GoalContract[]> {
    const { readdir } = await import("node:fs/promises");
    let fileNames: string[];
    try {
      fileNames = await readdir(this.directoryPath);
    } catch {
      return [];
    }
    const contracts: GoalContract[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      const goalIdentifier = fileName.slice(0, -".json".length);
      const contract = await this.read(goalIdentifier);
      if (contract !== null) {
        contracts.push(contract);
      }
    }
    return contracts;
  }
}
