/**
 * R132（2026-11-02）：**任务图变更审计**（追加式 JSONL）。
 *
 * 背景：注入/删除/修订/重连只会保留"最新图"，revision 只增；事后无法回答
 * "谁在什么时候把依赖从 A 改成 B"。本存储按 mission 记录**变更前后**的紧凑字段，
 * 只追加、不覆盖；不含提示词正文。
 *
 * 纪律：
 * - 只记录结构字段（依赖、描述、工具名）与变更类型/时间；
 * - 追加失败不阻断图变更（调用方吞错）；
 * - 读坏行跳过（只读展示）。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface TaskGraphChangeEntry {
  readonly missionIdentifier: string;
  readonly changeKind: "inject" | "remove" | "revise" | "rewire";
  readonly taskIdentifier: string;
  readonly recordedAtIso: string;
  /** 变更前（新节点为 null）。 */
  readonly before: {
    readonly dependsOn: readonly string[];
    readonly description: string;
    readonly toolNames: readonly string[];
  } | null;
  /** 变更后（删除为 null）。 */
  readonly after: {
    readonly dependsOn: readonly string[];
    readonly description: string;
    readonly toolNames: readonly string[];
  } | null;
}

export class TaskGraphChangeJournalStore {
  private readonly filePath: string;

  constructor(options: { baseDirectory: string }) {
    this.filePath = path.join(options.baseDirectory, "task-graph-changes.jsonl");
  }

  async append(entry: TaskGraphChangeEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** 只读：返回该 mission 的变更（按写入顺序）。坏行跳过。 */
  async listForMission(
    missionIdentifier: string,
  ): Promise<readonly TaskGraphChangeEntry[]> {
    const content = await readFile(this.filePath, "utf8").catch(() => "");
    const entries: TaskGraphChangeEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as TaskGraphChangeEntry;
        if (parsed.missionIdentifier === missionIdentifier) {
          entries.push(parsed);
        }
      } catch {
        // 坏行不阻塞其余记录
      }
    }
    return entries;
  }
}
