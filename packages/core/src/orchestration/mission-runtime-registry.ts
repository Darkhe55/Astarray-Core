/**
 * GUI-03 / 方案 A2：mission → runtime lease 登记表。
 *
 * 在 mission 调度前解析模型 binding 并获取 lease；期间 worker/main runtime
 * 工厂同步取用；mission 结束统一释放。登记表不持有对话/权限状态。
 */
import type { AgentRuntime } from "../core/types.js";

export interface MissionRuntimeLease {
  readonly leaseId: string;
  readonly missionId: string;
  readonly configurationKey: string;
  readonly runtime: AgentRuntime;
  release(): void;
}

export class MissionRuntimeRegistry {
  private readonly missions = new Map<string, MissionRuntimeLease>();

  register(lease: MissionRuntimeLease): void {
    if (this.missions.has(lease.missionId)) {
      throw new Error("mission 已有运行时租约: " + lease.missionId);
    }
    this.missions.set(lease.missionId, lease);
  }

  has(missionId: string): boolean {
    return this.missions.has(missionId);
  }

  /** 工厂同步取用；缺失返回 null，调用方回退当前 Provider 配置。 */
  get(missionId: string): MissionRuntimeLease | null {
    return this.missions.get(missionId) ?? null;
  }

  /** mission 结束统一释放；重复调用幂等。 */
  release(missionId: string): void {
    const lease = this.missions.get(missionId);
    if (lease === undefined) return;
    this.missions.delete(missionId);
    lease.release();
  }

  releaseAll(): void {
    for (const missionId of [...this.missions.keys()]) this.release(missionId);
  }
}
