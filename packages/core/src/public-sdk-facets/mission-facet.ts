/**
 * AXIOMATIC-DESIGN 阶段②（P2，2026-11-26）：**mission 只读查询子门面**。
 *
 * 从 `public-sdk.ts` 切出 mission 只读查询（状态/任务序列/公开状态/原始状态）：
 * 只依赖 controller 的两个查询入口与门面既有状态映射函数 ⇒ 可独立测试。
 *
 * 约束：
 * - **行为逐字一致**：`queryMissionStatus` 原实现不调用 `assertOpen()`，迁出后也不调用（不改变关闭态语义）；
 *   其余三个方法保留 `assertOpen()`；
 * - 门面保留同名方法并委托（导出面与签名不变）。
 */
import type { MissionStatus } from "../orchestration/mission-manager.js";

export type MissionTaskStatus =
  | "accepted"
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface MissionFacetHost {
  assertOpen(): void;
  queryMissionStatus(missionId: string): Promise<MissionStatus>;
  queryMissionTaskSequence(missionIdentifier: string): Promise<{
    readonly missionIdentifier: string;
    readonly sequenceIdentifier: string;
    readonly taskIdentifier: string;
    readonly ownerAgentInstanceIdentifier: string;
    readonly revision: number;
    readonly readyTaskIdentifiers: readonly string[];
    readonly nodes: ReadonlyArray<{
      taskIdentifier: string;
      title: string;
      status: string;
      dependsOn: readonly string[];
      priorityTier: number | null;
      sequenceOrdinal: number;
      blockReason: string | null;
      assignedAgentInstanceIdentifier: string | null;
    }>;
  } | null>;
  mapMissionStatus(missionStatus: {
    summary?: { status?: string } | null;
    taskChain?: { tasks: Array<{ status: string }> } | null;
  }): MissionTaskStatus;
}

export class MissionFacet {
  constructor(private readonly host: MissionFacetHost) {}

  /** 与主控制器同名（原实现不校验关闭态；迁移保持该行为）。 */
  async queryMissionStatus(missionId: string): Promise<MissionStatus> {
    return await this.host.queryMissionStatus(missionId);
  }

  /**
   * UI-ALIGN-01：只读权威任务序列与就绪集合。
   */
  async queryMissionTaskSequence(missionIdentifier: string) {
    this.host.assertOpen();
    return await this.host.queryMissionTaskSequence(missionIdentifier);
  }

  /** 按 mission 标识查询权威状态（CLI 与 SDK 共用同一状态源）。 */
  async queryMission(missionIdentifier: string): Promise<{
    missionIdentifier: string;
    status: MissionTaskStatus;
  }> {
    this.host.assertOpen();
    const missionStatus = (await this.host.queryMissionStatus(missionIdentifier)) as {
      summary?: { status?: string } | null;
      taskChain?: { tasks: Array<{ status: string }> } | null;
    };
    return {
      missionIdentifier,
      status: this.host.mapMissionStatus(missionStatus),
    };
  }

  /** R87：原始 mission 摘要状态（不做公开状态映射；缺省 running）。 */
  async queryMissionRawStatus(missionIdentifier: string): Promise<string> {
    this.host.assertOpen();
    const missionStatus = (await this.host.queryMissionStatus(missionIdentifier)) as {
      summary?: { status?: string } | null;
    };
    return missionStatus.summary?.status ?? "running";
  }
}
