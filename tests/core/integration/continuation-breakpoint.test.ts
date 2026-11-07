/**
 * RESUME-02（2026-11-07，用户裁决版）：断点卡与显式续接。
 *
 * 语义：断点由**真实中断**派生（不是设置开关）；不点一直保留；终态留档。
 * 同一 mission 的**多次中断**各有独立卡片（最新可操作，旧的留档且不可恢复）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  ContinuationController,
  ContinuationBreakpointStore,
  continuityBreakpointIdentifier,
  deriveContinuationBreakpoint,
  interruptionRevisionOf,
  type ContinuationMissionFacts,
} from "../../../packages/core/src/orchestration/continuation-breakpoint.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

function facts(overrides: Partial<ContinuationMissionFacts> = {}): ContinuationMissionFacts {
  return {
    missionIdentifier: "mission-1",
    conversationIdentifier: "conversation-1",
    projectIdentifier: "project-1",
    prompt: "实现登录页的错误提示",
    status: "blocked",
    createdAtIso: "2026-11-07T01:00:00.000Z",
    statusUpdatedAtIso: "2026-11-07T01:00:00.000Z",
    hasTrustedCheckpoint: true,
    ...overrides,
  };
}

describe("断点派生", () => {
  it("运行中/已完成不是断点；阻塞中断是断点且可恢复", () => {
    expect(deriveContinuationBreakpoint(facts({ status: "running" }))).toBeNull();
    expect(deriveContinuationBreakpoint(facts({ status: "done" }))).toBeNull();
    const blocked = deriveContinuationBreakpoint(facts());
    expect(blocked?.status).toBe("open");
    expect(blocked?.canResume).toBe(true);
    expect(blocked?.taskShortName).toBe("实现登录页的错误提示");
    expect(blocked?.breakpointIdentifier).toBe(
      continuityBreakpointIdentifier("mission-1", "2026-11-07T01:00:00.000Z"),
    );
  });

  it("无稳定会话不生成卡片；无检查点不可恢复；取消不可恢复", () => {
    expect(deriveContinuationBreakpoint(facts({ conversationIdentifier: null }))).toBeNull();
    const noCheckpoint = deriveContinuationBreakpoint(facts({ hasTrustedCheckpoint: false }));
    expect(noCheckpoint?.canResume).toBe(false);
    expect(noCheckpoint?.blockedReason).toContain("可信检查点");
    const cancelled = deriveContinuationBreakpoint(facts({ status: "cancelled" }));
    expect(cancelled?.canResume).toBe(false);
    expect(cancelled?.interruptionReason).toBe("mission-cancelled");
  });

  it("长提示词截断为任务短名（不是模型摘要）", () => {
    const longPrompt = "很长的任务描述".repeat(20);
    const view = deriveContinuationBreakpoint(facts({ prompt: longPrompt }));
    expect(view?.taskShortName.endsWith("…")).toBe(true);
    expect(view?.taskShortName.length).toBeLessThanOrEqual(41);
  });

  it("同一 mission 不同中断时刻 ⇒ 不同断点标识；无变更时刻退回创建时刻", () => {
    const first = continuityBreakpointIdentifier("mission-1", "2026-11-07T01:00:00.000Z");
    const second = continuityBreakpointIdentifier("mission-1", "2026-11-07T02:00:00.000Z");
    expect(first).not.toBe(second);
    expect(
      interruptionRevisionOf({ createdAtIso: "2026-11-07T01:00:00.000Z", statusUpdatedAtIso: null }),
    ).toBe("2026-11-07T01:00:00.000Z");
    expect(
      interruptionRevisionOf({
        createdAtIso: "2026-11-07T01:00:00.000Z",
        statusUpdatedAtIso: "2026-11-07T02:00:00.000Z",
      }),
    ).toBe("2026-11-07T02:00:00.000Z");
  });
});

describe("断点存储与续接控制器", () => {
  async function createController(
    resumeMission: (missionIdentifier: string) => Promise<void> = async () => {},
    missionFacts: ContinuationMissionFacts = facts(),
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-breakpoint-"));
    directories.push(directory);
    const store = new ContinuationBreakpointStore({ baseDirectory: directory });
    const controller = new ContinuationController({
      store,
      readConversationMissions: async () => [missionFacts.missionIdentifier],
      readMission: async (missionIdentifier) =>
        missionIdentifier === missionFacts.missionIdentifier ? missionFacts : null,
      hasTrustedCheckpoint: async () => true,
      resumeMission,
    });
    return { controller, store, directory };
  }

  it("按会话列出断点：只含真实中断（已完成不出现）", async () => {
    const { controller } = await createController();
    const views = await controller.listForConversation("conversation-1");
    expect(views).toHaveLength(1);
    expect(views[0]?.missionIdentifier).toBe("mission-1");
    expect(await controller.listForConversation("conversation-none")).toEqual([]);
  });

  it("点击恢复：转 resumed 并保留卡片；重复请求幂等", async () => {
    const resumeMission = vi.fn(async () => {});
    const { controller } = await createController(resumeMission);
    const [view] = await controller.listForConversation("conversation-1");
    const first = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-1",
    });
    expect(first.outcome).toBe("resumed");
    expect(first.breakpoint?.status).toBe("resumed");
    expect(resumeMission).toHaveBeenCalledTimes(1);

    const repeated = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-1",
    });
    expect(repeated.outcome).toBe("already-requested");
    expect(resumeMission).toHaveBeenCalledTimes(1);
  });

  it("revision 过期拒绝（不自动给新版本授权）", async () => {
    const { controller } = await createController();
    const [view] = await controller.listForConversation("conversation-1");
    const stale = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision + 5,
      requestIdentifier: "req-stale",
    });
    expect(stale.outcome).toBe("stale-revision");
    expect(stale.reason).toContain("刷新");
  });

  it("恢复被门禁拒绝 ⇒ 回到 open 并写明原因（不假装已恢复）", async () => {
    const { controller } = await createController(async () => {
      throw new Error("恢复被拒（先完成只读对账）");
    });
    const [view] = await controller.listForConversation("conversation-1");
    const result = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-blocked",
    });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("只读对账");
    expect(result.breakpoint?.status).toBe("open");
    expect(result.breakpoint?.canResume).toBe(true);
  });

  it("重启后卡片仍在（覆盖层 + 派生一致），不重复", async () => {
    const { controller, directory } = await createController();
    const [view] = await controller.listForConversation("conversation-1");
    await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-restart",
    });
    const restarted = new ContinuationController({
      store: new ContinuationBreakpointStore({ baseDirectory: directory }),
      readConversationMissions: async () => ["mission-1"],
      readMission: async () => facts(),
      hasTrustedCheckpoint: async () => true,
      resumeMission: async () => {},
    });
    const views = await restarted.listForConversation("conversation-1");
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe("resumed");
    expect(views[0]?.lastRequestIdentifier).toBe("req-restart");
  });

  it("不可恢复的断点：请求被拒且不调用恢复", async () => {
    const resumeMission = vi.fn(async () => {});
    const { controller } = await createController(resumeMission, facts({ status: "cancelled" }));
    const views = await controller.listForConversation("conversation-1");
    expect(views).toHaveLength(1);
    const result = await controller.requestContinuation({
      breakpointIdentifier: views[0]!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: views[0]!.revision,
      requestIdentifier: "req-cancelled",
    });
    expect(result.outcome).toBe("not-resumable");
    expect(resumeMission).not.toHaveBeenCalled();
  });

  it("同一 mission 多次中断：两张独立卡；旧轮次不可恢复且留档", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-breakpoint-multi-"));
    directories.push(directory);
    const store = new ContinuationBreakpointStore({ baseDirectory: directory });

    /** 第一轮中断：用户点了恢复。 */
    const firstFacts = facts({ statusUpdatedAtIso: "2026-11-07T01:00:00.000Z" });
    const firstController = new ContinuationController({
      store,
      readConversationMissions: async () => ["mission-1"],
      readMission: async () => firstFacts,
      hasTrustedCheckpoint: async () => true,
      resumeMission: async () => {},
    });
    const [firstView] = await firstController.listForConversation("conversation-1");
    const firstResult = await firstController.requestContinuation({
      breakpointIdentifier: firstView!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: firstView!.revision,
      requestIdentifier: "req-round-1",
    });
    expect(firstResult.outcome).toBe("resumed");

    /** 同一 mission 再次中断（更晚的时刻）⇒ 新卡可操作，旧卡留档。 */
    const secondFacts = facts({ statusUpdatedAtIso: "2026-11-07T02:00:00.000Z" });
    const secondController = new ContinuationController({
      store,
      readConversationMissions: async () => ["mission-1"],
      readMission: async () => secondFacts,
      hasTrustedCheckpoint: async () => true,
      resumeMission: async () => {},
    });
    const views = await secondController.listForConversation("conversation-1");
    expect(views).toHaveLength(2);
    expect(views[0]?.interruptionRevision).toBe("2026-11-07T01:00:00.000Z");
    expect(views[0]?.status).toBe("resumed");
    expect(views[0]?.canResume).toBe(false);
    expect(views[1]?.interruptionRevision).toBe("2026-11-07T02:00:00.000Z");
    expect(views[1]?.status).toBe("open");
    expect(views[1]?.canResume).toBe(true);

    /** 点旧卡 ⇒ 拒绝（不恢复到过期状态）。 */
    const staleClick = await secondController.requestContinuation({
      breakpointIdentifier: views[0]!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: views[0]!.revision,
      requestIdentifier: "req-round-old",
    });
    expect(staleClick.outcome).toBe("not-resumable");
  });
});
