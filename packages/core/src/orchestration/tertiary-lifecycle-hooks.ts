/**
 * ALIGN-03-07（2026-10-28）：三级 Agent 收口的**真实**生命周期钩子。
 *
 * 卡内要求：成功/中断/上下文过长后的关闭与接手复用生命周期控制器；**先保存个体档案
 * 再释放进程**；移交**只附选定档案**、不合并兄弟记忆；Git 远端失败是本地保全待同步，
 * 不把本地成功写成推送成功。
 *
 * 背景（实测）：生产装配里 `TertiaryAgentLifecycleController` 是**空 hooks** 构造的 ——
 * `runPhase` 在 hook 缺失时把该阶段记为 `none` 并继续 ⇒ 收口"看起来完成"，
 * 实际没有保存检查点、没有写移交、没有处理 Git 资源。
 *
 * 本工厂接线后：
 * - `persisting-checkpoint`：读取**该个体自己的**记忆档案（存在则记录 revision；
 *   不存在就如实返回 `no-archive`，**不编造记忆**）；
 * - `writing-handoff`：把移交写成独立文件，只列**本次显式选定**的档案哈希，
 *   并显式声明 `doesMergeSiblingMemory: false`；
 * - `handling-git-resources`：报告"无本地 Git 分配/远端失败按本地保全"的**实际**状态，
 *   不把本地成功写成推送成功；
 * - 其余阶段在无对应端口时返回**明确的** `no-*` 结果（不再静默 `none`）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import type { AgentIndividualMemoryStore } from "./agent-individual-memory.js";
import type { TertiaryLifecycleHookSet } from "./tertiary-lifecycle.js";

export interface TertiaryLifecycleHooksFactoryInput {
  /** 个体记忆存储（用于"先保存个体档案"）。 */
  readonly individualMemoryStore: AgentIndividualMemoryStore;
  /** 移交文件目录（通常是 `<stateDirectory>/agent-handoffs`）。 */
  readonly handoffDirectoryPath: string;
  /** 本次移交**显式选定**的附件哈希（空数组 = 不带附件）。 */
  readonly selectedAttachmentHashes?: readonly string[];
  /** 可选：权限租约撤销端口（返回结果字符串）。 */
  readonly revokePermissionLease?: (agentInstanceId: string) => Promise<string>;
  /** 可选：邮箱注销端口。 */
  readonly unregisterMailbox?: (agentInstanceId: string) => Promise<string>;
  /** 可选：未确认反馈确认端口。 */
  readonly confirmFeedback?: (agentInstanceId: string) => Promise<string>;
  /** 可选：Git 资源处理端口（释放 worktree/分支；远端失败必须返回本地保全态）。 */
  readonly handleGitResources?: (agentInstanceId: string) => Promise<string>;
  /** 可选：检查点端口（缺省只读档案 revision）。 */
  readonly persistCheckpoint?: (agentInstanceId: string) => Promise<string>;
}

export function buildTertiaryLifecycleHooks(
  input: TertiaryLifecycleHooksFactoryInput,
): TertiaryLifecycleHookSet {
  const selectedAttachmentHashes = [...(input.selectedAttachmentHashes ?? [])];

  return {
    /** 进程内 Worker 没有独立调度器：停派发是"不再给它新任务"的本地动作。 */
    stopDispatch: async () => "dispatch-stopped",
    /** 进程内调用为 await 语义：到收口点已无在途调用。 */
    drainUnconfirmedCalls: async () => "no-unconfirmed-calls",

    /**
     * **先保存个体档案**：只读取该个体自己的档案并记录 revision。
     * 没有档案就返回 `no-archive`（不创建、不伪造记忆）。
     */
    persistCheckpoint: async (agentInstanceId) => {
      if (input.persistCheckpoint !== undefined) {
        return input.persistCheckpoint(agentInstanceId);
      }
      const archiveRead = await readArchiveQuietly(
        input.individualMemoryStore,
        agentInstanceId,
      );
      if (archiveRead.archive === null) {
        return archiveRead.note ?? "no-archive";
      }
      return `archive-revision:${archiveRead.archive.revision}`;
    },

    /**
     * 移交文件只含**选定**档案；显式声明不合并兄弟记忆。
     *
     * 文件名含时间戳与个体标识，内容不含任何兄弟个体的记忆正文。
     */
    writeHandoff: async (agentInstanceId) => {
      const archiveRead = await readArchiveQuietly(
        input.individualMemoryStore,
        agentInstanceId,
      );
      await fs.mkdir(input.handoffDirectoryPath, { recursive: true });
      const handoffFileName = `${sanitizeFileSegment(agentInstanceId)}-${Date.now()}.json`;
      const handoffFilePath = path.join(input.handoffDirectoryPath, handoffFileName);
      await fs.writeFile(
        handoffFilePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            agentInstanceId,
            createdAtIso: new Date().toISOString(),
            memoryArchiveRevision: archiveRead.archive?.revision ?? null,
            /** 只列本次显式选定的附件（哈希），不内联正文。 */
            selectedAttachmentHashes,
            /** 关键声明：不合并兄弟记忆、不复制他人档案正文。 */
            doesMergeSiblingMemory: false,
            note:
              "移交仅包含该个体自己的档案 revision 与显式选定附件哈希；" +
              "兄弟个体的记忆不在本文件中。",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return `handoff:${handoffFileName}`;
    },

    confirmFeedback: async (agentInstanceId) =>
      input.confirmFeedback === undefined
        ? "no-pending-feedback"
        : input.confirmFeedback(agentInstanceId),

    revokePermissionLease: async (agentInstanceId) =>
      input.revokePermissionLease === undefined
        ? "no-lease-registered"
        : input.revokePermissionLease(agentInstanceId),

    unregisterMailbox: async (agentInstanceId) =>
      input.unregisterMailbox === undefined
        ? "no-mailbox-registered"
        : input.unregisterMailbox(agentInstanceId),

    /**
     * Git 资源：有端口就用端口的结果（端口必须区分"远端已推送"与"本地保全待同步"）；
     * 没端口就如实报"无本地分配"，**不**声明推送成功。
     */
    handleGitResources: async (agentInstanceId) =>
      input.handleGitResources === undefined
        ? "no-git-allocation"
        : input.handleGitResources(agentInstanceId),

    /** 进程内 Worker：没有独立进程可杀。 */
    terminateProcess: async () => "in-process-worker",
  };
}

/** 文件名安全化（只保留字母数字与 `-_.`，其余替换为 `_`）。 */
function sanitizeFileSegment(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/**
 * 读取个体档案：**命名空间被拒**（不是个体记忆域）按"无档案"处理并给出明确标记；
 * 其它错误（损坏/IO）照常抛出 —— 不能把损坏伪装成"没有档案"。
 */
async function readArchiveQuietly(
  store: AgentIndividualMemoryStore,
  agentInstanceId: string,
): Promise<{
  archive: Awaited<ReturnType<AgentIndividualMemoryStore["readMemoryArchive"]>>;
  note: string | null;
}> {
  try {
    return { archive: await store.readMemoryArchive(agentInstanceId), note: null };
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.errorCode === "task-sequence-permission-denied"
    ) {
      return { archive: null, note: "namespace-not-individual-memory" };
    }
    throw error;
  }
}
