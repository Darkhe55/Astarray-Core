/**
 * HISTORY-01-02（最小历史持久化）：**运行历史数据层**（2026-10-18 第 36 轮）。
 *
 * 依据 `docs/tasks/HISTORY01_LOCAL_RUN_HISTORY_AND_RESUME_VIEW_TASK_CARD.md` §2/§3/§7：
 * - 必须能回溯：**工具调用**、**失败调用（含原因）**、模型说明、**恢复分界**；
 * - resume 追加新段并标出分界，**不覆盖**旧事件；
 * - 重复事件**去重**（幂等）；
 * - 坏日志**如实报错**，不得伪造完整。
 *
 * 只做数据层：不做视图、不做虚拟列表（那属 03）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeAtomicJson } from "../infra/atomic-json.js";

/** 事件种类（覆盖卡内 §2 要求的最小集合）。 */
export type RunHistoryEventKind =
  | "tool-call"
  | "tool-failure"
  | "model-note"
  | "checkpoint"
  | "resume-boundary";

/** 一条历史事件（`payloadJson` 已序列化，避免存任意对象）。 */
export interface RunHistoryEvent {
  /** 去重键（同一事件重复写入只保留一条）。 */
  readonly eventIdentifier: string;
  readonly kind: RunHistoryEventKind;
  readonly recordedAtIso: string;
  readonly payloadJson: string;
}

/** 一个运行段（每次 resume 开启新段）。 */
export interface RunHistorySegment {
  readonly segmentRevision: number;
  readonly startedAtIso: string;
  readonly events: RunHistoryEvent[];
}

/** 一份运行历史文档。 */
export interface RunHistoryDocument {
  readonly schemaVersion: 1;
  readonly missionIdentifier: string;
  readonly segments: RunHistorySegment[];
}

/** 读取结论。 */
export type RunHistoryReadOutcome =
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "valid"; readonly document: RunHistoryDocument };

/** 追加结论。 */
export interface RunHistoryAppendOutcome {
  /** 是否真的写入了（重复事件 ⇒ false）。 */
  readonly wasAppended: boolean;
  readonly segmentRevision: number;
  readonly reason: string;
}

/** 运行历史存储（每 mission 一份文件；写盘走白名单原子写）。 */
export class RunHistoryStore {
  private readonly rootDirectory: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.rootDirectory = path.join(options.baseDirectory, "run-history");
  }

  private filePath(missionIdentifier: string): string {
    const sanitized = missionIdentifier.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
    return path.join(this.rootDirectory, (sanitized === "" ? "unnamed" : sanitized) + ".json");
  }

  /** 读取；文件不存在 ⇒ absent；坏 JSON 或结构非法 ⇒ invalid（**不伪造完整**）。 */
  async read(missionIdentifier: string): Promise<RunHistoryReadOutcome> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.filePath(missionIdentifier), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "absent", reason: "该 mission 没有运行历史文件。" };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { kind: "invalid", reason: "运行历史文件不是合法 JSON；按损坏处理，不伪称完整。" };
    }

    return validateDocument(parsed, missionIdentifier);
  }

  /**
   * 追加一条事件。
   *
   * - 同一 `eventIdentifier` 已存在 ⇒ **不重复写入**（幂等）；
   * - `resume-boundary` ⇒ **开启新段**（旧段与旧事件原样保留）；
   * - 其余事件追加到**最后一段**；没有段时自动开第 1 段。
   */
  async appendEvent(input: {
    readonly missionIdentifier: string;
    readonly event: RunHistoryEvent;
  }): Promise<RunHistoryAppendOutcome> {
    const current = await this.read(input.missionIdentifier);

    if (current.kind === "invalid") {
      // 坏文件不得被覆盖（否则等于销毁用户历史）
      return {
        wasAppended: false,
        segmentRevision: 0,
        reason:
          "运行历史文件已损坏；拒绝写入以免覆盖（请先按待恢复处理）。" + current.reason,
      };
    }

    const baseDocument: RunHistoryDocument =
      current.kind === "valid"
        ? current.document
        : {
            schemaVersion: 1,
            missionIdentifier: input.missionIdentifier,
            segments: [],
          };

    const isDuplicate = baseDocument.segments.some((segment) =>
      segment.events.some(
        (event) => event.eventIdentifier === input.event.eventIdentifier,
      ),
    );
    if (isDuplicate) {
      return {
        wasAppended: false,
        segmentRevision:
          baseDocument.segments[baseDocument.segments.length - 1]?.segmentRevision ?? 0,
        reason: "该事件已记录（按 eventIdentifier 去重），未重复写入。",
      };
    }

    const segments = baseDocument.segments.map((segment) => ({
      ...segment,
      events: [...segment.events],
    }));

    if (input.event.kind === "resume-boundary" || segments.length === 0) {
      segments.push({
        segmentRevision: segments.length + 1,
        startedAtIso: input.event.recordedAtIso,
        events: [input.event],
      });
    } else {
      const lastSegment = segments[segments.length - 1];
      if (lastSegment === undefined) throw new Error("不可能状态：段列表为空");
      lastSegment.events.push(input.event);
    }

    const nextDocument: RunHistoryDocument = {
      schemaVersion: 1,
      missionIdentifier: baseDocument.missionIdentifier,
      segments,
    };

    await fs.mkdir(this.rootDirectory, { recursive: true });
    await writeAtomicJson(this.filePath(input.missionIdentifier), nextDocument);

    return {
      wasAppended: true,
      segmentRevision: segments[segments.length - 1]?.segmentRevision ?? 0,
      reason: "已写入运行历史。",
    };
  }
}

function validateDocument(
  raw: unknown,
  missionIdentifier: string,
): RunHistoryReadOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", reason: "运行历史不是对象。" };
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) {
    return { kind: "invalid", reason: "不认识的运行历史版本；拒绝按 v1 解释。" };
  }
  if (record["missionIdentifier"] !== missionIdentifier) {
    return { kind: "invalid", reason: "运行历史所属 mission 与请求不一致。" };
  }
  if (!Array.isArray(record["segments"])) {
    return { kind: "invalid", reason: "运行历史缺少 segments。" };
  }
  return { kind: "valid", document: raw as RunHistoryDocument };
}
