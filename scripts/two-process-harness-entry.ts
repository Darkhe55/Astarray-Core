/**
 * WIRING-04 §36.4 双进程反例的**测试入口**（2026-11-18）。
 *
 * 由 `scripts/verify-two-process-stale-write.mjs` 用 tsup 打成单文件 ESM，
 * 再由两个**独立 node 进程**通过 IPC 消息驱动，避免"睡眠赌顺序"。
 */
import { TaskStore } from "../packages/core/src/infra/task-store.js";

export { TaskStore };

export function openStore(stateDirectory: string): TaskStore {
  return new TaskStore({ baseDirectory: stateDirectory });
}

export async function readChainRevision(
  stateDirectory: string,
): Promise<{ revision: number; status: string }> {
  const chain = await openStore(stateDirectory).readTaskChain("mission-1");
  return {
    revision: chain?.revision ?? 0,
    status: chain?.tasks[0]?.status ?? "missing",
  };
}

/**
 * 以**调用方持有的 revision** 提交新状态。
 * 旧 revision ⇒ 期望被 `stale-revision` 拒绝（权威记录的 CAS 语义）。
 */
export async function submitStaleOrFresh(input: {
  stateDirectory: string;
  expectedRevision: number;
  status: "running" | "done";
}): Promise<{ outcome: "accepted" | "rejected"; errorCode: string | null; revision: number }> {
  const store = openStore(input.stateDirectory);
  const chain = await store.readTaskChain("mission-1");
  if (chain === null) {
    return { outcome: "rejected", errorCode: "task-not-found", revision: 0 };
  }
  try {
    await store.writeTaskChain({
      ...chain,
      revision: input.expectedRevision + 1,
      tasks: chain.tasks.map((task) => ({ ...task, status: input.status })),
    } as never);
    return {
      outcome: "accepted",
      errorCode: null,
      revision: input.expectedRevision + 1,
    };
  } catch (error) {
    return {
      outcome: "rejected",
      errorCode: (error as { errorCode?: string }).errorCode ?? "unknown",
      revision: chain.revision,
    };
  }
}
