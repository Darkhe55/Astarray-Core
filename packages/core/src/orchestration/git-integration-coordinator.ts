/**
 * Git 集成协调器（T05B / ADR-0012）。
 * 由具体且不可复用的次级 Agent 个体绑定 mission 集成会话；只有它能写集成分支。
 * 流程：固定基线 → 创建集成分支 → 分配 worker → 三级 Agent 提交 →
 * 验证（身份/祖先/越界/敏感信息/测试证据）→ 通过后保留来源合并 →
 * 集成测试 → 模式/用户门禁 → 目标分支合并 → 生成结构化报告。
 *
 * 门禁规则：git push、PR、发布、强制推送、受保护分支修改始终需要独立授权；
 * 协调器只提供受控的本地合并，不允许模型可控的"跳过审查/跳过备份/强制合并"。
 */
import { spawnSync } from "node:child_process";

import { DomainError } from "../core/errors.js";
import type {
  GitCheckExecutionRecord,
  GitContributionReviewRecord,
  GitIntegrationReport,
} from "../core/types.js";
import type { GitContributionVerifier } from "./git-contribution-verifier.js";
import type { GitIntegrationReportStore } from "./git-integration-report-store.js";
import { GitProcess } from "./git-process.js";
import type { GitRecoveryPointService } from "./git-recovery-point-service.js";
import { GitWorktreeAllocator, decodeGitRefSegment } from "./git-worktree-allocator.js";
import { evaluateContributionReviewEvidence } from "./git-review-evidence.js";
import { buildRestrictedSubprocessEnvironment } from "../infra/subprocess-environment-allowlist.js";

export interface StartIntegrationSessionInput {
  missionId: string;
  /** 具体次级 Agent 实例（集成分支唯一写入者）。 */
  integratingAgentInstanceId: string;
  repositoryPath: string;
  targetBranchName: string;
}

export interface SubmitContributionInput {
  missionId: string;
  taskId: string;
  repositoryPath: string;
  baseCommit: string;
  headCommit: string;
  executedChecks: GitCheckExecutionRecord[];
  /**
   * ALIGN-03-04（2026-10-28）：审查者（具体个体）。给出时必须与贡献者不同，
   * 且（若装配了注册目录）必须已登记；缺省 ⇒ 视为"未指定审查者"并如实记录。
   */
  reviewingAgentInstanceIdentifier?: string | null;
}

export interface FinalizeIntegrationInput {
  missionId: string;
  integratingAgentInstanceId: string;
  repositoryPath: string;
  integrationTestCommands: string[];
  /** 目标分支合并是否被模式与用户授权允许（由 harness 注入，协调器不自行判定）。 */
  isTargetBranchMergeAllowed: boolean;
}

export interface GitIntegrationCoordinatorOptions {
  worktreeAllocator: GitWorktreeAllocator;
  verifier: GitContributionVerifier;
  reportStore: GitIntegrationReportStore;
  recoveryPointService: GitRecoveryPointService;
  gitProcess?: GitProcess;
  /**
   * ALIGN-03-05（2026-10-28）：合并前是否**要求审查者**已指定（缺省 false）。
   *
   * 无论开关如何，"accepted 的贡献其 headCommit 必须在集成分支历史里"这一条**始终**生效
   * —— 它拦的是"审的和合的不是同一份产物"（过期/不匹配证据）。
   */
  isReviewRequiredForMerge?: boolean;
}

export class GitIntegrationCoordinator {
  private readonly gitProcess: GitProcess;
  private readonly integrationTestTimeoutSeconds = 300;

  constructor(private readonly options: GitIntegrationCoordinatorOptions) {
    this.gitProcess = options.gitProcess ?? new GitProcess();
  }

  /** 供上级（harness/测试）访问分配器以创建 worker。 */
  worktreeAllocator(): GitWorktreeAllocator {
    return this.options.worktreeAllocator;
  }

  /**
   * 固定任务基线并创建集成分支。只有绑定本次会话的次级 Agent 能推进会话；
   * 会话记录（目标分支、基线）持久化到报告存储。
   */
  async startIntegrationSession(
    input: StartIntegrationSessionInput,
  ): Promise<GitIntegrationReport> {
    const baseResolve = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `${input.targetBranchName}^{commit}`],
        `解析目标分支 ${input.targetBranchName}`,
      )
      .catch(() => null);
    const targetBaseCommit = baseResolve?.stdoutText.trim() ?? "";
    if (targetBaseCommit === "") {
      throw new DomainError(
        "dependency-not-found",
        `目标分支无效: ${input.targetBranchName}`,
      );
    }
    const integrationBranchName = GitWorktreeAllocator.buildIntegrationBranchName(
      input.missionId,
      input.integratingAgentInstanceId,
    );
    const integrationExists = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${integrationBranchName}`],
        `检查集成分支是否存在`,
      )
      .catch(() => null);
    if (
      integrationExists === null ||
      integrationExists.stdoutText.trim() === ""
    ) {
      await this.gitProcess.run(
        input.repositoryPath,
        ["branch", integrationBranchName, targetBaseCommit],
        `创建集成分支 ${integrationBranchName}`,
      );
    }
    const report: GitIntegrationReport = {
      missionId: input.missionId,
      integratingAgentInstanceId: input.integratingAgentInstanceId,
      targetBranchName: input.targetBranchName,
      integrationBranchName,
      targetBaseCommit,
      reviewedContributions: [],
      integrationCommit: null,
      unresolvedRisks: [],
      createdAtIso: new Date().toISOString(),
    };
    await this.options.reportStore.saveReport(report);
    return report;
  }

  /**
   * 三级 Agent 上报贡献后调用：读取分配记录 → 验证 → 通过则保留来源合并
   * （merge --no-ff 创建合并提交）→ 更新报告。审查失败返回结构化拒绝。
   */
  async submitContribution(
    input: SubmitContributionInput,
  ): Promise<{
    reviewDecision: "accepted" | "rejected" | "needs-rework";
    rejectionReasons: string[];
    report: GitIntegrationReport;
  }> {
    const allocation = await this.options.worktreeAllocator.readAllocation(
      input.taskId,
    );
    if (allocation === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `未找到任务 ${input.taskId} 的 worker 分配记录`,
      );
    }
    /**
     * ALIGN-03-04（2026-10-28）：**审查者不得是贡献者**（作者不能自审）。
     * 缺省未指定时如实记 null；给出非法审查者则拒绝，不静默降级。
     */
    const reviewingAgentInstanceIdentifier =
      input.reviewingAgentInstanceIdentifier?.trim() ?? null;
    if (
      reviewingAgentInstanceIdentifier !== null &&
      reviewingAgentInstanceIdentifier !== "" &&
      reviewingAgentInstanceIdentifier === allocation.tertiaryAgentInstanceId
    ) {
      throw new DomainError(
        "task-sequence-permission-denied",
        `贡献者不能担任自己的审查者（作者自审被拒）: ${reviewingAgentInstanceIdentifier}`,
      );
    }
    const verification = await this.options.verifier.verifyContribution({
      allocation,
      repositoryPath: input.repositoryPath,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      executedChecks: input.executedChecks,
    });
    const contributionRecord: GitContributionReviewRecord = {
      taskId: input.taskId,
      contributingAgentInstanceId: allocation.tertiaryAgentInstanceId,
      workerBranchName: allocation.workerBranchName,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      changedPaths: verification.changedPaths,
      reviewDecision: verification.reviewDecision,
      rejectionReason:
        verification.failureReasons.length > 0
          ? verification.failureReasons.join("；")
          : null,
      executedChecks: input.executedChecks.map((check) => ({ ...check })),
      reviewingAgentInstanceIdentifier:
        reviewingAgentInstanceIdentifier === "" ? null : reviewingAgentInstanceIdentifier,
    };
    if (verification.reviewDecision === "accepted") {
      /**
       * ALIGN-03-04：合并前**必须**确认共享仓库工作区干净。
       *
       * 下面会 `checkout` 集成分支并 `merge` —— 如果工作区里有未提交改动
       * （常见于人工并行修改），切分支/合并会覆盖或携带它们。此处**拒绝操作**，
       * 不自动 stash、不 reset、不 checkout 丢弃。
       *
       * 只看**已跟踪**文件的改动（`--untracked-files=no`）：未跟踪文件不会被
       * checkout/merge 静默覆盖（git 会拒绝冲突的覆盖），把它们也算进来只会
       * 让正常构建产物（dist/tmp）误挡合并。
       */
      const worktreeStatus = await this.gitProcess.run(
        input.repositoryPath,
        ["status", "--porcelain", "--untracked-files=no"],
        "检查共享仓库工作区是否干净",
      );
      if (worktreeStatus.stdoutText.trim() !== "") {
        throw new DomainError(
          "stale-human-change",
          "共享仓库存在未提交改动（可能来自人工并行修改）：拒绝自动切换分支/合并；" +
            "请先由人工提交或转移这些改动（本流程不会 stash/reset/checkout 丢弃它们）。",
        );
      }
      await this.gitProcess.run(
        input.repositoryPath,
        [
          "checkout",
          allocation.integrationBranchName,
        ],
        `切换集成分支 ${allocation.integrationBranchName}`,
      );
      // 恢复点：合并本身非破坏性，但若冲突处理失败需要可回退（先记录当前集成 tip）
      const recoveryPoint = await this.options.recoveryPointService.createRecoveryPoint(
        {
          missionId: input.missionId,
          repositoryPath: input.repositoryPath,
          operationDescription: `合并 ${allocation.workerBranchName} 到集成分支`,
          affectedReferenceNames: [
            `refs/heads/${allocation.integrationBranchName}`,
          ],
          affectedWorktreePath: null,
          affectedWorkingTreeRoot: null,
        },
      );
      await this.gitProcess
        .run(
          input.repositoryPath,
          [
            "merge",
            "--no-ff",
            "--no-edit",
            allocation.workerBranchName,
          ],
          `保留来源合并 ${allocation.workerBranchName}`,
        )
        .catch((error: unknown) => {
          throw new DomainError(
            "tool-execution-failed",
            `合并失败（冲突需创建独立修复任务，禁止静默选边）: ${(error as Error).message}；恢复点 ${recoveryPoint.recoveryPointId} 可用`,
          );
        });
      await this.gitProcess
        .run(input.repositoryPath, ["checkout", "--detach", "HEAD"], `完成集成分支合并后脱离分支`)
        .catch(() => {});
    }
    // 更新会话报告：读取既有会话记录（目标分支/集成者身份不可变），追加本次贡献。
    // 分支名末段为 git ref 段编码后的集成者 ID，需解码回原始实例 ID 以读取报告。
    const encodedIntegratingAgentInstanceId = allocation.integrationBranchName
      .split("/")
      .at(-1)!;
    const integratingAgentInstanceId = decodeGitRefSegment(
      encodedIntegratingAgentInstanceId,
    );
    const sessionReport = await this.options.reportStore.readReport(
      input.missionId,
      integratingAgentInstanceId,
    );
    if (sessionReport === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `集成会话不存在: ${input.missionId}（集成者 ${integratingAgentInstanceId}）`,
      );
    }
    const integrationCommitResult = await this.gitProcess
      .run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${allocation.integrationBranchName}^{commit}`],
        `解析集成分支 tip`,
      )
      .catch(() => null);
    const integrationCommit =
      integrationCommitResult?.stdoutText.trim() ?? null;
    const report: GitIntegrationReport = {
      ...sessionReport,
      reviewedContributions: [
        ...sessionReport.reviewedContributions,
        contributionRecord,
      ],
      integrationCommit,
      unresolvedRisks: sessionReport.unresolvedRisks,
    };
    await this.options.reportStore.saveReport(report);
    return {
      reviewDecision: verification.reviewDecision,
      rejectionReasons: verification.failureReasons,
      report,
    };
  }

  /**
   * ALIGN-03-05：只读探测某个 commit 是否为分支祖先。
   *
   * `git merge-base --is-ancestor` 在"不是祖先"时以非零退出 ⇒ `GitProcess.run` 抛错
   * ⇒ 这里如实返回 `false`（不把"探测失败"当成"通过"）。
   */
  private async isCommitInBranchHistory(input: {
    repositoryPath: string;
    commit: string;
    branchName: string;
  }): Promise<boolean> {
    try {
      await this.gitProcess.run(
        input.repositoryPath,
        [
          "merge-base",
          "--is-ancestor",
          input.commit,
          `refs/heads/${input.branchName}`,
        ],
        `探测 ${input.commit} 是否在 ${input.branchName} 历史中`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 全部 worker 集成后：运行集成测试与质量门禁 → 门禁通过且模式/用户授权
   * 允许时把集成分支合入目标分支。未授权时报告保留，目标分支不动。
   */
  async finalizeIntegration(
    input: FinalizeIntegrationInput,
  ): Promise<GitIntegrationReport> {
    const report = await this.options.reportStore.readReport(
      input.missionId,
      input.integratingAgentInstanceId,
    );
    if (report === null) {
      throw new DomainError(
        "task-sequence-not-found",
        `集成会话不存在: ${input.missionId}`,
      );
    }
    if (report.integrationCommit === null) {
      throw new DomainError(
        "invalid-task-chain",
        "集成分支尚无合并提交，不能收尾",
      );
    }
    /**
     * ALIGN-03-05（2026-10-28）：**合并前逐条核对审查证据是否仍匹配**。
     *
     * 对每条 `accepted` 贡献：
     * - headCommit 必须真的在集成分支历史里（否则审的与要合的不是同一份产物）；
     * - 条目绑定的任务必须与记录一致、base/head 不得为空或相同；
     * - 若要求审查者：必须存在且不等于贡献者（未指定 ≠ 已审查）。
     *
     * 任一条不满足 ⇒ 写进 `unresolvedRisks` 并**直接返回**（不合入目标分支）。
     */
    const reviewEvidenceReasons: string[] = [];
    for (const contribution of report.reviewedContributions) {
      if (contribution.reviewDecision !== "accepted") {
        continue;
      }
      const isHeadCommitInIntegrationHistory = await this.isCommitInBranchHistory({
        repositoryPath: input.repositoryPath,
        commit: contribution.headCommit,
        branchName: report.integrationBranchName,
      });
      const evidenceEvaluation = evaluateContributionReviewEvidence({
        record: contribution,
        expectedTaskIdentifier: contribution.taskId,
        isHeadCommitInIntegrationHistory,
        requiresReviewer: this.options.isReviewRequiredForMerge === true,
      });
      if (!evidenceEvaluation.isAcceptable) {
        reviewEvidenceReasons.push(
          `任务 ${contribution.taskId}: ${evidenceEvaluation.reasons.join("；")}`,
        );
      }
    }
    if (reviewEvidenceReasons.length > 0) {
      report.unresolvedRisks.push(
        `审查证据与产物不匹配，未合入目标分支：${reviewEvidenceReasons.join(" | ")}`,
      );
      await this.options.reportStore.saveReport(report);
      return report;
    }
    // 集成测试（命令由会话配置，在仓库目录以 shell 执行，全部必须成功）
    for (const testCommand of input.integrationTestCommands) {
      const testResult = this.runIntegrationTestCommand(
        input.repositoryPath,
        testCommand,
      );
      if (!testResult) {
        report.unresolvedRisks.push(`集成测试失败: ${testCommand}`);
      }
    }
    if (report.unresolvedRisks.length > 0) {
      await this.options.reportStore.saveReport(report);
      return report;
    }
    if (input.isTargetBranchMergeAllowed) {
      /**
       * ALIGN-03-04：目标分支合并前同样的**工作区干净**守卫。
       *
       * 有未提交改动（人工并行修改）时**不合入**、也**不** stash/reset/checkout 丢弃，
       * 只把风险如实写进报告，由人工处理后再收尾。
       */
      const targetWorktreeStatus = await this.gitProcess.run(
        input.repositoryPath,
        ["status", "--porcelain", "--untracked-files=no"],
        "检查共享仓库工作区是否干净（目标分支合并前）",
      );
      if (targetWorktreeStatus.stdoutText.trim() !== "") {
        report.unresolvedRisks.push(
          "共享仓库存在未提交改动（可能来自人工并行修改）：未合入目标分支；" +
            "本流程不会 stash/reset/checkout 丢弃这些改动。",
        );
        await this.options.reportStore.saveReport(report);
        return report;
      }
      // 目标分支合并前自动创建恢复点（目标分支引用可回退）
      await this.options.recoveryPointService.createRecoveryPoint({
        missionId: input.missionId,
        repositoryPath: input.repositoryPath,
        operationDescription: `集成分支合入目标分支 ${report.targetBranchName}`,
        affectedReferenceNames: [`refs/heads/${report.targetBranchName}`],
        affectedWorktreePath: null,
        affectedWorkingTreeRoot: null,
      });
      await this.gitProcess.run(
        input.repositoryPath,
        ["checkout", report.targetBranchName],
        `切换目标分支 ${report.targetBranchName}`,
      );
      try {
        await this.gitProcess.run(
          input.repositoryPath,
          ["merge", "--no-ff", "--no-edit", report.integrationBranchName],
          `目标分支合并集成分支`,
        );
      } catch (mergeError) {
        /**
         * 合并失败/超时**不得**等同于"未合并"（RELIABILITY-01-02 · R3）：
         * 只读探测目标分支是否已包含集成分支，把结果记入未决风险，由用户/恢复流程裁决。
         */
        const settlement = await this.settleTargetBranchMerge({
          repositoryPath: input.repositoryPath,
          targetBranchName: report.targetBranchName,
          integrationBranchName: report.integrationBranchName,
        });
        report.unresolvedRisks.push(
          `目标分支合并未确认（${settlement.outcome}）：${settlement.detail}；` +
            `原始错误: ${(mergeError as Error).message}`,
        );
      }
      try {
        await this.gitProcess.run(
          input.repositoryPath,
          ["checkout", "--detach", "HEAD"],
          `脱离目标分支`,
        );
      } catch (detachError) {
        // 不得静默吞掉：工作区可能仍停留在目标分支上。
        report.unresolvedRisks.push(
          `合并后脱离目标分支失败（工作区可能仍在 ${report.targetBranchName}）：` +
            (detachError as Error).message,
        );
      }
    }
    await this.options.reportStore.saveReport(report);
    return report;
  }

  /**
   * 目标分支合并的**只读对账**（RELIABILITY-01-02 · R3）。
   *
   * 合并失败或超时时，结果可能"已生效"、"未生效"或"未知（探测本身失败）"，
   * 三者必须可区分；不得把超时当作"未合并"，也不得假定成功。
   */
  private async settleTargetBranchMerge(input: {
    repositoryPath: string;
    targetBranchName: string;
    integrationBranchName: string;
  }): Promise<{ outcome: "merged" | "not-merged" | "unknown"; detail: string }> {
    try {
      await this.gitProcess.run(
        input.repositoryPath,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${input.targetBranchName}`],
        `对账：确认目标分支 ${input.targetBranchName}`,
      );
      await this.gitProcess.run(
        input.repositoryPath,
        ["merge-base", "--is-ancestor", input.integrationBranchName, input.targetBranchName],
        "对账：集成分支是否为目标分支祖先",
      );
      return {
        outcome: "merged",
        detail: `已确认 ${input.integrationBranchName} 是 ${input.targetBranchName} 的祖先`,
      };
    } catch (probeError) {
      return {
        outcome: "unknown",
        detail: `只读探测失败，合并状态未知: ${(probeError as Error).message}`,
      };
    }
  }

  /** 在仓库目录以 shell 执行集成测试命令（命令由会话配置，非模型输入）。 */  private runIntegrationTestCommand(
    repositoryPath: string,
    command: string,
  ): boolean {
    const result = spawnSync(command, {
      cwd: repositoryPath,
      shell: true,
      windowsHide: true,
      timeout: this.integrationTestTimeoutSeconds * 1000,
      encoding: "utf8",
      /** SEC-02-07：集成测试命令不继承宿主凭据环境（只带运行必需变量）。 */
      env: buildRestrictedSubprocessEnvironment({ hostEnvironment: process.env })
        .environment,
    });
    return result.status === 0;
  }
}
