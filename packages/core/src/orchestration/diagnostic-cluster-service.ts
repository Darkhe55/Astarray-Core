import type { DiagnosticEvent, DiagnosticEventStore } from "./diagnostic-event-store.js";
import type { DiagnosticClusterInput } from "./diagnostic-clusterer.js";
import {
  buildDiagnosticClusterSnapshotForProject,
  type BuildClusterSnapshotResult,
} from "./diagnostic-cluster-build.js";
import {
  readLatestDiagnosticClusterSnapshot,
  saveDiagnosticClusterSnapshot,
  type DiagnosticClusterSnapshot,
} from "./diagnostic-cluster-index.js";
import {
  findRelatedDiagnosticCases,
  type DiagnosticRelatedCasesResult,
} from "./diagnostic-related-cases.js";

/**
 * CLUSTER-01 §5：**应用级服务**（装配层使用的唯一入口）。
 *
 * 卡内硬约束：
 * - 默认关闭；**开启聚类不得偷偷开启采集**（两者是不同开关）；
 * - 无数据与"采集未开启"必须**分别报告**，不能都返回"没有错误"；
 * - 索引落应用管理的状态目录，不落项目源码目录。
 */

export type DiagnosticClusteringStatus =
  | { readonly status: "disabled" }
  | { readonly status: "no-snapshot" }
  | { readonly status: "ready"; readonly snapshot: DiagnosticClusterSnapshot };

export interface DiagnosticClusterServiceOptions {
  readonly store: DiagnosticEventStore;
  readonly stateDirectory: string;
  readonly algorithmVersion: string;
  /** 缺省关：装配层必须显式传入 true。 */
  readonly isEnabled?: boolean;
}

export class DiagnosticClusterService {
  private readonly store: DiagnosticEventStore;
  private readonly stateDirectory: string;
  private readonly algorithmVersion: string;
  private readonly isEnabled: boolean;

  constructor(options: DiagnosticClusterServiceOptions) {
    this.store = options.store;
    this.stateDirectory = options.stateDirectory;
    this.algorithmVersion = options.algorithmVersion;
    this.isEnabled = options.isEnabled === true;
  }

  isDiagnosticClusteringEnabled(): boolean {
    return this.isEnabled;
  }

  /** 状态目录（CLI 适配器写纠正记录时需要；不暴露其他内部状态）。 */
  getStateDirectory(): string {
    return this.stateDirectory;
  }

  /**
   * 构建并保存快照。关闭时**不做任何工作、不创建目录**，返回 `disabled`。
   */
  async buildSnapshot(input: {
    readonly projectIdentifier: string;
    readonly generatedAtIso: string;
    readonly resolveProjectIdentifier: (event: DiagnosticEvent) => string | null;
    readonly cursor?: { readonly byteOffset: number; readonly lineNumber: number };
  }): Promise<
    | { readonly status: "disabled" }
    | ({ readonly status: "built" } & BuildClusterSnapshotResult & { readonly latestUpdated: boolean })
  > {
    if (!this.isEnabled) {
      return { status: "disabled" };
    }
    const result = await buildDiagnosticClusterSnapshotForProject({
      store: this.store,
      stateDirectory: this.stateDirectory,
      projectIdentifier: input.projectIdentifier,
      algorithmVersion: this.algorithmVersion,
      generatedAtIso: input.generatedAtIso,
      resolveProjectIdentifier: input.resolveProjectIdentifier,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    const saved = await saveDiagnosticClusterSnapshot({
      stateDirectory: this.stateDirectory,
      snapshot: result.snapshot,
    });
    return { status: "built", ...result, latestUpdated: saved.latestFilePath !== null };
  }

  /** 读取最后**完整**快照；关闭 ⇒ disabled，未构建过 ⇒ no-snapshot（两者必须可区分）。 */
  async readLatest(projectIdentifier: string): Promise<DiagnosticClusteringStatus> {
    if (!this.isEnabled) {
      return { status: "disabled" };
    }
    const snapshot = await readLatestDiagnosticClusterSnapshot({
      stateDirectory: this.stateDirectory,
      projectIdentifier,
    });
    return snapshot === null ? { status: "no-snapshot" } : { status: "ready", snapshot };
  }

  /** 相似案例检索：只接受已授权事件引用；无快照时返回 `no-snapshot` 而不是空结果。 */
  async findRelated(input: {
    readonly projectIdentifier: string;
    readonly event: DiagnosticClusterInput;
    readonly limit?: number;
    readonly minimumSimilarity?: number;
  }): Promise<
    | { readonly status: "disabled" }
    | { readonly status: "no-snapshot" }
    | { readonly status: "ready"; readonly result: DiagnosticRelatedCasesResult }
  > {
    const latest = await this.readLatest(input.projectIdentifier);
    if (latest.status !== "ready") {
      return latest;
    }
    return {
      status: "ready",
      result: findRelatedDiagnosticCases({
        event: input.event,
        snapshot: latest.snapshot,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.minimumSimilarity === undefined ? {} : { minimumSimilarity: input.minimumSimilarity }),
      }),
    };
  }
}
