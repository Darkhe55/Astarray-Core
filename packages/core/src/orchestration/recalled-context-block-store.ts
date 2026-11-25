/**
 * WIRING-04-05 补口（2026-11-25）：**已回访块的登记存储**。
 *
 * 卡内要求：回访结果"进入现有工具响应，**或**登记为当前任务选定的 recalledContextBlocks；
 * 不得两处重复注入"。本存储负责后者：
 * - 按（mission, 个体, 任务, 节点, revision）**幂等登记**（重复登记不追加、不覆盖正文）；
 * - 只登记**显式请求后**取得的块（本层不主动召回，不做相似度/向量）；
 * - 不修改节点关闭状态、不恢复任务、不改原始档案（只存返回片段的副本引用）；
 * - 读取损坏 ⇒ **空**并保留原文件（不覆盖、不猜），由上层按"未登记"处理。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { readJsonWithBackupRecovery, writeAtomicJson } from "../infra/atomic-json.js";

export interface RecalledContextBlockRecord {
  readonly missionIdentifier: string | null;
  readonly agentInstanceIdentifier: string;
  readonly missionTaskIdentifier: string;
  readonly contextNodeIdentifier: string;
  readonly sourceRevision: number;
  readonly text: string;
  readonly registeredAtIso: string;
}

interface RecalledContextBlockDocument {
  readonly schemaVersion: 1;
  readonly blocks: readonly RecalledContextBlockRecord[];
}

export type RegisterRecalledBlockResult =
  | { readonly kind: "registered" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "rejected"; readonly reason: string };

function blockKey(block: RecalledContextBlockRecord): string {
  return [
    block.missionIdentifier ?? "",
    block.agentInstanceIdentifier,
    block.missionTaskIdentifier,
    block.contextNodeIdentifier,
    String(block.sourceRevision),
  ].join("\u0000");
}

export class RecalledContextBlockStore {
  constructor(private readonly options: { readonly baseDirectory: string }) {}

  private filePath(): string {
    return path.join(this.options.baseDirectory, "recalled-context-blocks.json");
  }

  async register(block: RecalledContextBlockRecord): Promise<RegisterRecalledBlockResult> {
    if (
      block.agentInstanceIdentifier.trim() === "" ||
      block.missionTaskIdentifier.trim() === "" ||
      block.contextNodeIdentifier.trim() === "" ||
      block.text.trim() === ""
    ) {
      return { kind: "rejected", reason: "回访块缺少来源（个体/任务/节点/正文）" };
    }
    if (!Number.isInteger(block.sourceRevision) || block.sourceRevision <= 0) {
      return { kind: "rejected", reason: "回访块必须绑定正整数 sourceRevision" };
    }
    const document = await this.readDocument();
    const existingKeys = new Set(document.blocks.map(blockKey));
    if (existingKeys.has(blockKey(block))) {
      return { kind: "duplicate" };
    }
    await this.writeDocument({
      schemaVersion: 1,
      blocks: [...document.blocks, block],
    });
    return { kind: "registered" };
  }

  async listFor(input: {
    readonly missionIdentifier: string | null;
    readonly agentInstanceIdentifier: string;
    readonly missionTaskIdentifier: string;
  }): Promise<readonly RecalledContextBlockRecord[]> {
    const document = await this.readDocument();
    return document.blocks.filter(
      (block) =>
        block.missionIdentifier === input.missionIdentifier &&
        block.agentInstanceIdentifier === input.agentInstanceIdentifier &&
        block.missionTaskIdentifier === input.missionTaskIdentifier,
    );
  }

  private async readDocument(): Promise<RecalledContextBlockDocument> {
    /** readJsonWithBackupRecovery 返回的是**已解析对象**（content: unknown），不是字符串。 */
    const recovered = await readJsonWithBackupRecovery(
      this.filePath(),
      `${this.filePath()}.bak`,
    ).catch(() => null);
    const parsed = recovered?.content;
    if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { schemaVersion: 1, blocks: [] };
    }
    const candidate = parsed as Partial<RecalledContextBlockDocument>;
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.blocks)) {
      return { schemaVersion: 1, blocks: [] };
    }
    return {
      schemaVersion: 1,
      blocks: candidate.blocks.filter((block): block is RecalledContextBlockRecord => {
        const item = block as Partial<RecalledContextBlockRecord>;
        return (
          typeof item.agentInstanceIdentifier === "string" &&
          typeof item.missionTaskIdentifier === "string" &&
          typeof item.contextNodeIdentifier === "string" &&
          typeof item.sourceRevision === "number" &&
          typeof item.text === "string"
        );
      }),
    };
  }

  private async writeDocument(document: RecalledContextBlockDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
    await writeAtomicJson(this.filePath(), document);
  }
}
