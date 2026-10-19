#!/usr/bin/env node
import { Command } from "commander";

import packageMetadata from "../../../package.json" with { type: "json" };
import { defaultStateDirectory } from "./cli/run-command.js";
import { executeRunCommand } from "./cli/run-command.js";
// RELOCATE-01-04（2026-10-18）：冷启动重定位状态只读查询（命令名经用户确认=项目状态）。
import {
  executeProjectReconcileCommand,
  executeProjectStatusCommand,
} from "./cli/project-relocation-command.js";
// OBS-01（2026-10-19 R38）：性能/诊断的只读查询入口。
import {
  executeObsDiagCommand,
  executeObsPerfCommand,
  executeObsProcessCommand,
} from "./cli/observability-command.js";
// HISTORY-01-03（2026-10-18）：本地运行历史的只读视图（list / show）。
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  executeHistoryListCommand,
  executeHistoryShowCommand,
} from "./cli/history-command.js";
// FOLDER-01-03（2026-10-18）：文件夹授权的 CLI 共用入口（命令名经用户确认＝选项 A）。
import {
  executeFolderApproveCommand,
  executeFolderCheckCommand,
  executeFolderRequestCommand,
  executeFolderRevokeCommand,
  loadRegisteredProjectRoots,
  mergeProjectRoots,
  parseKnownProjectRootSpecifications,
  resolveFolderDurationKind,
  resolveFolderPermissionKind,
} from "./cli/folder-command.js";
import type {
  FolderGrantDurationKind,
  FolderGrantPermissionKind,
} from "../../core/src/public-sdk.js";
import { EXIT_CODES } from "./cli/json-output.js";
import {
  executeCancelCommand,
  executeConfigContextBudgetCommand,
  executeConfigInitCommand,
  executeConfigInstallEnabledCommand,
  executeContextMetricsCommand,
  executeContextRecallCommand,
  executeContextStatusCommand,
  executeContextTransactionCommand,
  executeDoctorCommand,
  // G10（2026-11-08 第 184 轮）：把两个"已实现但从未分发"的状态命令接入 CLI。
  executePresetListCommand,
  executeConcurrentStatusCommand,
  executeDoctorProviderCommand,
  executeProfileCopyCommand,
  executeProfileCreateCommand,
  executeProfileDeleteCommand,
  executeProfileExportCommand,
  executeProfileImportCommand,
  executeProfileListCommand,
  executeProfileRenameCommand,
  executeProfileResetCommand,
  executeProfileSetCapabilityCommand,
  executeProfileShowCommand,
  executeProfileSwitchCommand,
  executeProviderCredentialSetCommand,
  executeProviderListCommand,
  executeProviderRegisterCommand,
  executeProviderShowCommand,
  executeRecoverAbandonCommand,
  executeRecoverListCommand,
  executeRecoverResumeCommand,
  executeRecoverShowCommand,
  executeResumeCommand,
  executeSessionElevateCommand,
  executeSessionElevationListCommand,
  executeSessionRevokeElevationCommand,
  executeSessionShutdownCommand,
  executeGuiServeCommand,
  executeAccuracyConfigureCommand,
  executeGuideChangeCommand,
  executeGuideHistoryCommand,
  executePreserveCreateCommand,
  executePreserveRestoreCommand,
  executePreserveShowCommand,
  executePreserveStatusCommand,
  executeAccuracyStatusCommand,
  executeGuideStatusCommand,
  executeGuideSubmitCommand,
  executeMcpServeCommand,
  executeSummaryBuildCommand,
  executeSummaryListCommand,
  executeSummaryShowCommand,
  executeStatusCommand,
  executeWorkflowScenarioCommand,
  executeCrossProjectListCommand,
  executeCrossProjectImportCopyCommand,
  executeCrossProjectReadCommand,
  executeDoctorErrorsCommand,
  executeInstructionAcceptCommand,
  executeInstructionDeadlineCommand,
  executeInstructionListCommand,
  executePerfOverviewCommand,
  executeToolPackageAuthorizeUpgradeCommand,
  executeToolPackageCancelCommand,
  executeToolPackageChangeCommand,
  executeToolPackageDescribeCommand,
  executeToolPackageFeedbackCommand,
  executeToolPackageListCommand,
  executeParameterAuthorizationSettingsCommand,
  executeToolPackageRecoverCommand,
  executeToolPackageStatusCommand,
  executeUsageOverviewCommand,
} from "./cli/commands.js";

const program = new Command();

program
  .name("astarray")
  .description("TUI agent orchestration tool with Ponder / Assist / Devolve modes")
  .version(packageMetadata.version, "-v, --version")
    .action(async () => {
      /**
       * 仓库分层（2026-10-18 用户决策）：终端 UI 属**私有/本地**部分，公开构建不含 `./cli/tui.js`。
       *
       * 只保护**模块加载**（缺失 ⇒ 明确提示 + 非 0 退出）；**不吞** TUI 运行期错误。
       */
      let launchTui: ((stateDirectory: string) => Promise<void>) | null = null;
      try {
        /**
         * 说明符用**非字面量**拼出：`astarray-ui` 私有构建会提供该模块，
         * 公开构建**没有**这个文件 ⇒ 字面量会被 tsc 静态解析成\"找不到模块\"并把公开构建卡死。
         * 运行期缺失由下方 catch 处理（明确提示 + 非 0 退出）。
         */
        const tuiModuleSpecifier = `./cli/tui.js`;
        ({ launchTui } = (await import(tuiModuleSpecifier)) as {
          launchTui: (stateDirectory: string) => Promise<void>;
        });
      } catch {
        // 模块缺失：保持 null（公开构建不含终端 UI），下方给出明确提示
      }
      if (launchTui === null) {
        process.stderr.write(
          "此构建不含终端 UI（TUI 未随本构建发布）。\n" +
            "请使用具体命令（如 `astarray run <prompt>`）或 `--json` 输出。\n",
        );
        process.exitCode = 2;
        return;
      }
      await launchTui(defaultStateDirectory());
    });

program
  .command("run <prompt>")
  .description("运行一个任务")
  .option("--mode <mode>", "运行模式: ponder | assist | devolve")
  .option("--runtime <runtime>", "运行时: mock | openai-compatible")
  .option("--json", "输出机器可解析 JSON")
  .option(
    "--timeout-seconds <seconds>",
    "等待上限秒数；缺省不设固定上限，等待任务终态",
  )
  .option(
    "--provider-endpoint <url>",
    "openai-compatible 协议端点（本地协议服务器或真实服务；必填）",
  )
  .option("--provider-model <identifier>", "Provider 模型标识（必填）")
  .option(
    "--provider-protocol <protocol>",
    "Provider 协议（缺省 openai-compatible；可选 anthropic-messages）",
  )
  .option(
    "--provider-api-key-env <variable>",
    "存放 API key 的环境变量名（缺省 ASTARRAY_PROVIDER_API_KEY；不落盘、不回显）",
  )
  .option("--provider-credential-reference <reference>", "受保护凭据引用（优先于环境变量）")
  .option(
    "--provider-request-timeout-seconds <seconds>",
    "Provider 单次请求超时秒数（缺省 30；长任务需放宽）",
  )
  .action(
    async (
      prompt: string,
      options: {
        mode?: string;
        runtime?: string;
        json?: boolean;
        timeoutSeconds?: string;
        providerEndpoint?: string;
        providerModel?: string;
        providerApiKeyEnv?: string;
        providerCredentialReference?: string;
        providerProtocol?: string;
        providerRequestTimeoutSeconds?: string;
      },
    ) => {
      process.exitCode = await executeRunCommand({
        prompt,
        mode: options.mode,
        runtime: options.runtime,
        isJsonOutput: options.json === true,
        stateDirectory: defaultStateDirectory(),
        timeoutSeconds:
          options.timeoutSeconds === undefined
            ? undefined
            : Number.parseInt(options.timeoutSeconds, 10),
        ...(options.providerEndpoint !== undefined
          ? { providerEndpoint: options.providerEndpoint }
          : {}),
        ...(options.providerModel !== undefined
          ? { providerModelIdentifier: options.providerModel }
          : {}),
        ...(options.providerApiKeyEnv !== undefined
          ? { providerApiKeyEnvironmentVariable: options.providerApiKeyEnv }
          : {}),
        ...(options.providerCredentialReference !== undefined
          ? { providerCredentialReference: options.providerCredentialReference }
          : {}),
        ...(options.providerProtocol !== undefined
          ? { providerProtocol: options.providerProtocol }
          : {}),
        ...(options.providerRequestTimeoutSeconds !== undefined
          ? {
              providerRequestTimeoutMilliseconds:
                Number.parseInt(options.providerRequestTimeoutSeconds, 10) * 1_000,
            }
          : {}),
      });
    },
  );

program
  .command("resume <mission-id>")
  .description("恢复一个任务")
  .option("--json", "输出机器可解析 JSON")
  .action(async (missionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeResumeCommand({
      missionId,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

program
  .command("status [mission-id]")
  .description("查询任务状态")
  .option("--json", "输出机器可解析 JSON")
  .action(async (missionId: string | undefined, options: { json?: boolean }) => {
    process.exitCode = await executeStatusCommand({
      missionId,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

/**
 * USAGE-01-03：用量最小概览（只读；由已落盘账目复算；不虚报官方余额，不泄漏他人明细）。
 */
const usageCommand = program.command("usage").description("用量概览（只读；由已落盘账目复算）");
usageCommand
  .command("overview")
  .description("用量最小概览：范围/明细分页/预算（只报本地账目估算，不冒充官方余额）")
  .option("--mission <mission-id>", "限定可见范围（mission）")
  .option("--agent <agent-instance-id>", "限定可见范围（具体 agentInstanceId，避免读取他人明细）")
  .option("--detail <level>", "summary | detail（缺省 summary）")
  .option("--page-size <count>", "detail 模式每页条数（缺省 20）")
  .option("--cursor <cursor>", "detail 模式分页游标（上一页 nextCursor）")
  .option("--input-token-budget <tokens>", "可选输入 token 预算（给出时做预算判定）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      mission?: string;
      agent?: string;
      detail?: string;
      pageSize?: string;
      cursor?: string;
      inputTokenBudget?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeUsageOverviewCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        ...(options.mission === undefined ? {} : { missionIdentifier: options.mission }),
        ...(options.agent === undefined ? {} : { sourceAgentInstanceId: options.agent }),
        ...(options.detail === undefined ? {} : { detailLevel: options.detail }),
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.inputTokenBudget === undefined
          ? {}
          : { inputTokenBudget: options.inputTokenBudget }),
      });
    },
  );

/**
 * SMART-01-04：指令窗口 CLI 入口（与 SDK 入口共享同一状态目录的同一窗口）。
 */
const instructionCommand = program
  .command("instruction")
  .description("指令窗口（智能模式计数 / 排队 / 三分钟期限；只读优先，不冒充成果完成）");
instructionCommand
  .command("accept <text>")
  .description("接收一条用户指令进入指令窗口（上限默认 3，超出即排队，不丢弃）")
  .option("--idempotency-key <key>", "必需：幂等键（同键同参幂等复用，同键异参拒绝）")
  .option("--revision <revision>", "指令 revision（修订绑定原指令，缺省 1）")
  .option("--now <iso>", "显式接收时间（ISO 8601；缺省当前时间）")
  .option("--json", "JSON 输出")
  .action(
    async (
      text: string,
      options: {
        idempotencyKey?: string;
        revision?: string;
        now?: string;
        json?: boolean;
      },
    ) => {
      if (options.idempotencyKey === undefined || options.idempotencyKey.trim() === "") {
        process.stderr.write("astarray: 缺少 --idempotency-key（拒绝接收，不伪造指令）\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await executeInstructionAcceptCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        instructionText: text,
        idempotencyKey: options.idempotencyKey,
        ...(options.revision === undefined
          ? {}
          : { instructionRevision: Number(options.revision) }),
        ...(options.now === undefined ? {} : { nowIso: options.now }),
      });
    },
  );
instructionCommand
  .command("list")
  .description("列出指令窗口（窗口内 / 排队 / 终态）")
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeInstructionListCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
instructionCommand
  .command("deadline")
  .description("评估一条指令的三分钟处理期限（超期如实报告，不伪报已派发）")
  .option("--idempotency-key <key>", "必需：指令幂等键")
  .option("--now <iso>", "显式当前时间（ISO 8601；缺省当前时间）")
  .option("--awaiting-clarification", "该指令正在等待用户澄清（不得视为完成）")
  .option("--awaiting-permission", "该指令正在等待权限裁决（门禁优先，不被补位绕过）")
  .option("--resting", "计划休息中（门禁优先）")
  .option("--user-stopped", "用户显式停止（门禁优先）")
  .option("--long-subordinate-task", "存在长下级任务在途（不得阻塞接收新指令）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      idempotencyKey?: string;
      now?: string;
      awaitingClarification?: boolean;
      awaitingPermission?: boolean;
      resting?: boolean;
      userStopped?: boolean;
      longSubordinateTask?: boolean;
      json?: boolean;
    }) => {
      if (options.idempotencyKey === undefined || options.idempotencyKey.trim() === "") {
        process.stderr.write("astarray: 缺少 --idempotency-key（拒绝评估，不伪造指令）\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await executeInstructionDeadlineCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        idempotencyKey: options.idempotencyKey,
        ...(options.now === undefined ? {} : { nowIso: options.now }),
        ...(options.awaitingClarification === undefined
          ? {}
          : { isAwaitingClarification: options.awaitingClarification }),
        ...(options.awaitingPermission === undefined
          ? {}
          : { isAwaitingPermissionDecision: options.awaitingPermission }),
        ...(options.resting === undefined ? {} : { isResting: options.resting }),
        ...(options.userStopped === undefined
          ? {}
          : { isExplicitUserStop: options.userStopped }),
        ...(options.longSubordinateTask === undefined
          ? {}
          : { hasLongRunningSubordinateTask: options.longSubordinateTask }),
      });
    },
  );

/**
 * TOOLKIT-01-04：工具包版本管理入口（CLI 最小管理面）。
 *
 * 卡内检查点 04/06 要求"升级差异、停用/回滚、CLI 最小管理入口"。
 * 每次调用都是**独立进程**，因此状态经 `ToolPackageVersionStateStore` 原子落盘，
 * 判定逻辑全部复用 `ToolPackageVersionController`（不复制规则）。
 */
const toolPackageCommand = program
  .command("tool-package")
  .description("工具包版本管理（锁定/启用/停用/升级/回滚；不自动升级）");
toolPackageCommand
  .command("list")
  .description("列出已登记版本与项目锁定（只读）")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(async (options: { stateDir?: string; json?: boolean }) => {
    process.exitCode = await executeToolPackageListCommand({
      stateDirectory: options.stateDir ?? defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
toolPackageCommand
  .command("describe <tool-package-id>")
  .description("展示两版本之间的行为/依赖/权限差异与是否需要重新授权")
  .option("--from <version>", "源版本")
  .option("--to <version>", "目标版本")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(
    async (
      toolPackageId: string,
      options: { from?: string; to?: string; stateDir?: string; json?: boolean },
    ) => {
      process.exitCode = await executeToolPackageDescribeCommand({
        toolPackageId,
        fromVersion: options.from === undefined ? undefined : Number(options.from),
        toVersion: options.to === undefined ? undefined : Number(options.to),
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
      });
    },
  );
toolPackageCommand
  .command("status <tool-package-id>")
  .description("显示项目锁定版本、启用状态与 revision（只读）")
  .option("--project <project-id>", "项目标识")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(
    async (
      toolPackageId: string,
      options: { project?: string; stateDir?: string; json?: boolean },
    ) => {
      process.exitCode = await executeToolPackageStatusCommand({
        toolPackageId,
        projectIdentifier: options.project ?? "",
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
      });
    },
  );

/** enable/disable/upgrade/rollback 共用同一变更入口（差别只在 changeKind 与是否需版本）。 */
for (const changeKind of ["enable", "disable", "upgrade", "rollback"] as const) {
  const isVersionRequired = changeKind !== "disable";
  let registration = toolPackageCommand
    .command(`${changeKind} <tool-package-id>`)
    .description(
      changeKind === "disable"
        ? "停用（阻止新运行；在途调用仍按安全点收敛，不删除）"
        : changeKind === "rollback"
          ? "回滚到指定版本（只切换后续使用版本，不撤销历史副作用）"
          : changeKind === "upgrade"
            ? "升级到指定版本（含新增副作用时须 --reauthorization-record）"
            : "在项目内启用指定版本",
    )
    .option("--project <project-id>", "项目标识")
    .option("--state-dir <dir>", "状态目录")
    .option("--json", "JSON 输出");
  if (isVersionRequired) {
    // 注意：**不能**用 `--version` —— commander 会把它当作程序版本标志（打印 0.1.0 后退出），
    // 子命令根本不会执行。这也正是本片反例先红的原因（2026-10-10 实测）。
    registration = registration.option("--tool-version <version>", "目标版本");
  }
  if (changeKind === "upgrade") {
    registration = registration.option(
      "--reauthorization-record <record-id>",
      "该版本新增副作用的重新授权记录标识（本地签发，须先取得）",
    );
  }
  registration.action(
    async (
      toolPackageId: string,
      options: {
        project?: string;
        toolVersion?: string;
        reauthorizationRecord?: string;
        stateDir?: string;
        json?: boolean;
      },
    ) => {
      process.exitCode = await executeToolPackageChangeCommand({
        changeKind,
        toolPackageId,
        projectIdentifier: options.project ?? "",
        version: options.toolVersion === undefined ? undefined : Number(options.toolVersion),
        ...(options.reauthorizationRecord === undefined
          ? {}
          : { reauthorizationRecordIdentifier: options.reauthorizationRecord }),
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
      });
    },
  );
}

/**
 * TOOLKIT-01-04：取消 / 崩溃恢复 与独立反馈（管理入口）。
 *
 * `cancel` **不删除在途调用**（卡内 §8："不能删掉运行中的文件造成结果未知"）；
 * `recover` 把半提交切换收敛到可信版本；`feedback` 只读列出操作记录。
 */
toolPackageCommand
  .command("cancel <tool-package-id>")
  .description("取消后续运行（保留在途调用，待按安全点收敛）")
  .option("--project <project-id>", "项目标识")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(
    async (
      toolPackageId: string,
      options: { project?: string; stateDir?: string; json?: boolean },
    ) => {
      process.exitCode = await executeToolPackageCancelCommand({
        toolPackageId,
        projectIdentifier: options.project ?? "",
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
        requestingAgentInstanceId: "authenticated-user",
      });
    },
  );
toolPackageCommand
  .command("recover <tool-package-id>")
  .description("崩溃恢复：把半提交的版本切换收敛到可信版本")
  .option("--project <project-id>", "项目标识")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(
    async (
      toolPackageId: string,
      options: { project?: string; stateDir?: string; json?: boolean },
    ) => {
      process.exitCode = await executeToolPackageRecoverCommand({
        toolPackageId,
        projectIdentifier: options.project ?? "",
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
        requestingAgentInstanceId: "authenticated-user",
      });
    },
  );
toolPackageCommand
  .command("authorize-upgrade <tool-package-id>")
  .description(
    "为含新增副作用的升级签发重新授权记录（先展示差异；签发与执行分离）",
  )
  .option("--project <project-id>", "项目标识")
  .option("--tool-version <version>", "目标版本")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(
    async (
      toolPackageId: string,
      options: {
        project?: string;
        toolVersion?: string;
        stateDir?: string;
        json?: boolean;
      },
    ) => {
      process.exitCode = await executeToolPackageAuthorizeUpgradeCommand({
        toolPackageId,
        projectIdentifier: options.project ?? "",
        toVersion:
          options.toolVersion === undefined ? undefined : Number(options.toolVersion),
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
        issuedBy: "authenticated-user",
      });
    },
  );
toolPackageCommand
  .command("feedback")
  .description("列出工具包管理操作的独立反馈（来源/动作/revision/结果）")
  .option("--state-dir <dir>", "状态目录")
  .option("--json", "JSON 输出")
  .action(async (options: { stateDir?: string; json?: boolean }) => {
    process.exitCode = await executeToolPackageFeedbackCommand({
      stateDirectory: options.stateDir ?? defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });

/**
 * MERGE-01 §1.3 第 4 项：参数授权**设置入口**（CLI 侧）。
 *
 * 卡内："**关闭细分若会从 deny/ask 回退 allow，必须明确提示放宽范围，
 * 不以'关闭功能'静默扩大权限**"；"扩大权限需既有认证用户确认"。
 * 本命令不自行判定，一律走 SDK 的同一实现（保证 CLI/SDK 结论一致）。
 */
const settingsCommand = program
  .command("settings")
  .description("设置入口（参数授权总开关与每工具细分）");

settingsCommand
  .command("parameter-authorization")
  .description("读取或写入参数授权设置（放宽权限需 --confirm）")
  .option("--state-dir <dir>", "状态目录")
  .option("--disable-granularity", "关闭每工具参数细分（可能放宽权限）")
  .option("--disable-parameter-authorization", "关闭参数授权总开关（可能放宽权限）")
  .option(
    "--tool <spec>",
    "工具授权形态：工具名:统一效果[:规则ID=效果,...]（可重复）",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .option("--confirm", "已获认证用户确认（放宽权限时必需）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      stateDir?: string;
      disableGranularity?: boolean;
      disableParameterAuthorization?: boolean;
      tool?: string[];
      confirm?: boolean;
      json?: boolean;
    }) => {
      process.exitCode = await executeParameterAuthorizationSettingsCommand({
        stateDirectory: options.stateDir ?? defaultStateDirectory(),
        isJsonOutput: options.json === true,
        shouldDisableGranularity: options.disableGranularity === true,
        shouldDisableParameterAuthorization:
          options.disableParameterAuthorization === true,
        toolAuthorizationShapeSpecifications: options.tool ?? [],
        isConfirmedByAuthenticatedUser: options.confirm === true,
      });
    },
  );

/**
 * PROJECT-01-04：跨项目授权与副本的公开只读入口。
 */
/**
 * `project status`：冷启动重定位状态（RELOCATE-01-04）。
 *
 * 产品文案（命令名与字段）经用户 2026-10-18 确认。**只读**：不写登记、不执行任务、不启动模型。
 */
const projectCommand = program
  .command("project")
  .description("项目（只读；冷启动与重定位状态）");
projectCommand
  .command("status")
  .description("查询项目的冷启动状态：能否加载旧历史、能否执行任务、需要用户做什么")
  .requiredOption("--project <project-id>", "项目标识")
  .requiredOption("--root <path>", "当前选择的项目根路径")
  .option("--observed-identifier <id>", "当前根观测到的项目标识（不提供则按无法验证处理）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      project: string;
      root: string;
      observedIdentifier?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeProjectStatusCommand({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: options.project,
        currentRootPath: options.root,
        observedProjectIdentifier: options.observedIdentifier ?? null,
        isJsonOutput: options.json === true,
      });
    },
  );

/**
 * `history`：本地运行历史的**只读**视图（HISTORY-01-03，2026-10-18）。
 *
 * 只读：不恢复 mission、不调模型、不注入上下文、**不重放工具**。
 * 显示开关只影响视图 —— 隐藏后事件仍保存在本地（`storedEventCount` 会如实报告）。
 */
projectCommand
  .command("reconcile")
  .description("重定位对账：判断换路径后能否自动恢复（只读；含写需人工确认，不重放已完成操作）")
  .requiredOption("--input <path>", "对账输入 JSON 文件（显式的项目状态/映射/引用/未决操作）")
  .option("--json", "JSON 输出")
  .action(async (options: { input: string; json?: boolean }) => {
    process.exitCode = await executeProjectReconcileCommand({
      inputFilePath: options.input,
      isJsonOutput: options.json === true,
    });
  });

const obsCommand = program
  .command("obs")
  .description("观测（只读；性能样本与诊断摘要，本地数据，不上传）");
obsCommand
  .command("perf")
  .description("查询性能样本（摘要或明细分页；无样本不等于用量为零）")
  .option("--since <iso>", "时间窗下界（含）")
  .option("--until <iso>", "时间窗上界（含）")
  .option("--detail", "返回明细分页（默认摘要）")
  .option("--page-size <number>", "每页条数")
  .option("--cursor <cursor>", "分页游标")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      since?: string;
      until?: string;
      detail?: boolean;
      pageSize?: string;
      cursor?: string;
      json?: boolean;
    }) => {
      const pageSize = options.pageSize === undefined ? undefined : Number(options.pageSize);
      if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
        process.stderr.write("astarray: --page-size 必须是正整数\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      process.exitCode = await executeObsPerfCommand({
        stateDirectory: defaultStateDirectory(),
        ...(options.since === undefined ? {} : { windowStartIso: options.since }),
        ...(options.until === undefined ? {} : { windowEndIso: options.until }),
        detailLevel: options.detail === true ? "detail" : "summary",
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        isJsonOutput: options.json === true,
      });
    },
  );
obsCommand
  .command("process")
  .description("查询进程样本（RSS/事件循环延迟/队列深度；无样本不等于没有消耗）")
  .option("--since <iso>", "时间窗下界（含）")
  .option("--until <iso>", "时间窗上界（含）")
  .option("--limit <number>", "最多返回条数（缺省 50）")
  .option("--json", "JSON 输出")
  .action(
    async (options: { since?: string; until?: string; limit?: string; json?: boolean }) => {
      const limit = options.limit === undefined ? undefined : Number(options.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        process.stderr.write("astarray: --limit 必须是正整数\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      process.exitCode = await executeObsProcessCommand({
        stateDirectory: defaultStateDirectory(),
        ...(options.since === undefined ? {} : { windowStartIso: options.since }),
        ...(options.until === undefined ? {} : { windowEndIso: options.until }),
        ...(limit === undefined ? {} : { limit }),
        isJsonOutput: options.json === true,
      });
    },
  );
obsCommand
  .command("diag")
  .description("查询诊断摘要（按指纹聚合；事实与推断分列）")
  .option("--mission <id>", "限定 mission")
  .option("--agent <agent-instance-id>", "限定具体个体（不得读取同级记录）")
  .option("--since <iso>", "时间窗下界（含）")
  .option("--until <iso>", "时间窗上界（含）")
  .option("--page-size <number>", "每页分组数")
  .option("--cursor <cursor>", "分页游标")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      mission?: string;
      agent?: string;
      since?: string;
      until?: string;
      pageSize?: string;
      cursor?: string;
      json?: boolean;
    }) => {
      const pageSize = options.pageSize === undefined ? undefined : Number(options.pageSize);
      if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize <= 0)) {
        process.stderr.write("astarray: --page-size 必须是正整数\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      process.exitCode = await executeObsDiagCommand({
        stateDirectory: defaultStateDirectory(),
        ...(options.mission === undefined ? {} : { missionIdentifier: options.mission }),
        ...(options.agent === undefined ? {} : { sourceAgentInstanceId: options.agent }),
        ...(options.since === undefined ? {} : { windowStartIso: options.since }),
        ...(options.until === undefined ? {} : { windowEndIso: options.until }),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        isJsonOutput: options.json === true,
      });
    },
  );

const historyCommand = program
  .command("history")
  .description("本地运行历史（只读；分页查看工具调用/失败/过程说明/恢复分界）");

historyCommand
  .command("list")
  .description("列出有运行历史的 mission（最近优先，分页）")
  .option("--page-size <count>", "每页条数", String(DEFAULT_HISTORY_PAGE_SIZE))
  .option("--page <index>", "页码（0 起）")
  .option("--after <mission-id>", "游标：只列出该 mission 之后的条目")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      pageSize?: string;
      page?: string;
      after?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeHistoryListCommand({
        stateDirectory: defaultStateDirectory(),
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: Number(options.pageSize) }),
        ...(options.page === undefined ? {} : { pageIndex: Number(options.page) }),
        ...(options.after === undefined ? {} : { afterMissionIdentifier: options.after }),
        isJsonOutput: options.json === true,
      });
    },
  );

historyCommand
  .command("show")
  .description("查看某个 mission 的运行历史（按游标分页；只读，不重放工具）")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .option("--page-size <count>", "每页条数", String(DEFAULT_HISTORY_PAGE_SIZE))
  .option("--cursor <sequence>", "上一页最后一条的序号")
  .option("--search <text>", "关键词检索（纯子串、大小写不敏感；不解释正则）")
  .option(
    "--kind <kind>",
    "只显示这些种类（可重复：tool-call/tool-failure/model-note/checkpoint/resume-boundary）",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .option("--hide-run-history", "关闭总显示开关（只隐藏，不删除）")
  .option("--show-process-explanations", "显示过程说明（默认为隐藏）")
  .option("--hide-tool-calls", "隐藏工具调用（只隐藏，不删除）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      mission: string;
      pageSize?: string;
      cursor?: string;
      search?: string;
      kind?: string[];
      hideRunHistory?: boolean;
      showProcessExplanations?: boolean;
      hideToolCalls?: boolean;
      json?: boolean;
    }) => {
      process.exitCode = await executeHistoryShowCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier: options.mission,
        ...(options.pageSize === undefined
          ? {}
          : { pageSize: Number(options.pageSize) }),
        ...(options.cursor === undefined ? {} : { cursor: Number(options.cursor) }),
        ...(options.search === undefined ? {} : { searchQuery: options.search }),
        ...(options.kind === undefined ? {} : { includedKinds: options.kind }),
        displaySettings: {
          ...(options.hideRunHistory === true ? { showRunHistory: false } : {}),
          ...(options.showProcessExplanations === true
            ? { showProcessExplanations: true }
            : {}),
          ...(options.hideToolCalls === true ? { showToolCalls: false } : {}),
        },
        isJsonOutput: options.json === true,
      });
    },
  );

/**
 * `folder`：对话式文件夹授权的 CLI 共用入口（FOLDER-01-03）。
 *
 * 命令名经用户 2026-10-18 **确认＝选项 A**（`request|approve|revoke|check`）。
 * `request` 只出授权卡、不落库；`approve` 才是认证用户确认；`check` 只读且 fail-closed。
 * **不提供"全部批准"**：一张卡只处理一个文件夹。
 */
const folderCommand = program
  .command("folder")
  .description("项目文件夹授权（预览卡/批准/撤销/执行前复检；一张卡一个文件夹）");

/** 组装文件夹授权候选的公共参数。 */
function readFolderScopeOptions(options: {
  project: string;
  path: string | string[];
  permission?: string;
  includeSubdirectories?: boolean;
  duration?: string;
}): {
  readonly projectIdentifier: string;
  readonly requestedPaths: ReadonlyArray<string>;
  readonly permissionKind: FolderGrantPermissionKind | null;
  readonly includesSubdirectories: boolean;
  readonly durationKind: FolderGrantDurationKind | null;
} {
  const requestedPaths = Array.isArray(options.path) ? options.path : [options.path];
  return {
    projectIdentifier: options.project,
    requestedPaths,
    // 默认值：只读 + 仅本次会话（卡内推荐初始选择）；**显式非法值**仍返回 null 由调用方报用法错误
    permissionKind:
      options.permission === undefined
        ? "read-only"
        : resolveFolderPermissionKind(options.permission),
    includesSubdirectories: options.includeSubdirectories === true,
    durationKind:
      options.duration === undefined ? "session" : resolveFolderDurationKind(options.duration),
  };
}

folderCommand
  .command("request")
  .description("生成文件夹授权卡（只预览，不落库；多个 --path 逐项出卡）")
  .requiredOption("--project <project-id>", "项目标识")
  .option("--path <path>", "要纳入的文件夹绝对路径（可重复；每项一张卡）", (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option("--permission <kind>", "read-only（默认）或 read-write")
  .option("--include-subdirectories", "是否包含子目录（默认不含）")
  .option("--duration <kind>", "session（默认，仅本次会话）或 until-revoked")
  .option("--known-project-root <project-id>=<path>", "显式声明的已知项目根（可重复；用于跨项目/父目录检查）", (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      project: string;
      path?: string | string[];
      permission?: string;
      includeSubdirectories?: boolean;
      duration?: string;
      knownProjectRoot?: string[];
      json?: boolean;
    }) => {
      if (options.path === undefined) {
        process.stderr.write("astarray: 至少需要一个 --path\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      const scope = readFolderScopeOptions({ ...options, path: options.path });
      if (scope.permissionKind === null || scope.durationKind === null) {
        process.stderr.write("astarray: --permission 只能是 read-only/read-write；--duration 只能是 session/until-revoked\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      const declared = parseKnownProjectRootSpecifications(
        options.knownProjectRoot,
        options.project,
      );
      if (declared.invalidSpecifications.length > 0) {
        process.stderr.write(
          `astarray: --known-project-root 需为 <project-id>=<path>；无法解析：${declared.invalidSpecifications.join(", ")}\n`,
        );
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      const loaded = await loadRegisteredProjectRoots({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: options.project,
      });
      process.exitCode = await executeFolderRequestCommand({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: scope.projectIdentifier,
        requestedPaths: scope.requestedPaths,
        permissionKind: scope.permissionKind,
        includesSubdirectories: scope.includesSubdirectories,
        durationKind: scope.durationKind,
        registeredRoots: mergeProjectRoots(loaded, declared.roots),
        isJsonOutput: options.json === true,
      });
    },
  );

folderCommand
  .command("approve")
  .description("认证用户批准一个文件夹（落库一条授权；一张卡一个文件夹）")
  .requiredOption("--project <project-id>", "项目标识")
  .requiredOption("--path <path>", "要纳入的文件夹绝对路径")
  .option("--permission <kind>", "read-only（默认）或 read-write")
  .option("--include-subdirectories", "是否包含子目录（默认不含）")
  .option("--duration <kind>", "session（默认）或 until-revoked")
  .requiredOption("--grant-id <id>", "本次授权的标识（同 ID 异参会被拒绝）")
  .requiredOption("--revision <number>", "项目 revision（陈旧写入会被拒绝）")
  .option("--expires-at <iso>", "过期时间（ISO）")
  .option("--known-project-root <project-id>=<path>", "显式声明的已知项目根（可重复）", (value: string, previous: string[] | undefined) => [...(previous ?? []), value])
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      project: string;
      path: string;
      permission?: string;
      includeSubdirectories?: boolean;
      duration?: string;
      grantId: string;
      revision: string;
      expiresAt?: string;
      knownProjectRoot?: string[];
      json?: boolean;
    }) => {
      const scope = readFolderScopeOptions(options);
      if (scope.permissionKind === null || scope.durationKind === null) {
        process.stderr.write("astarray: --permission/--duration 取值非法\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      const revision = Number(options.revision);
      if (!Number.isInteger(revision) || revision < 1) {
        process.stderr.write("astarray: --revision 必须是正整数\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      const declared = parseKnownProjectRootSpecifications(options.knownProjectRoot, options.project);
      const loaded = await loadRegisteredProjectRoots({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: options.project,
      });
      process.exitCode = await executeFolderApproveCommand({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: scope.projectIdentifier,
        requestedPath: scope.requestedPaths[0] ?? options.path,
        permissionKind: scope.permissionKind,
        includesSubdirectories: scope.includesSubdirectories,
        durationKind: scope.durationKind,
        grantIdentifier: options.grantId,
        projectRevision: revision,
        expiresAtIso: options.expiresAt ?? null,
        registeredRoots: mergeProjectRoots(loaded, declared.roots),
        isJsonOutput: options.json === true,
      });
    },
  );

folderCommand
  .command("revoke")
  .description("撤销一条文件夹授权（只影响之后的操作；历史记录保留）")
  .requiredOption("--project <project-id>", "项目标识")
  .requiredOption("--grant-id <id>", "授权标识")
  .requiredOption("--reason <text>", "撤销原因（如实记录）")
  .option("--json", "JSON 输出")
  .action(
    async (options: { project: string; grantId: string; reason: string; json?: boolean }) => {
      process.exitCode = await executeFolderRevokeCommand({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: options.project,
        grantIdentifier: options.grantId,
        reason: options.reason,
        isJsonOutput: options.json === true,
      });
    },
  );

folderCommand
  .command("check")
  .description("执行前复检：该路径+该权限是否被批准（只读，拒绝即非 0 退出）")
  .requiredOption("--project <project-id>", "项目标识")
  .requiredOption("--path <path>", "待检查的目标绝对路径")
  .option("--permission <kind>", "read-only（默认）或 read-write")
  .requiredOption("--revision <number>", "项目 revision（变化后旧许可失效）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      project: string;
      path: string;
      permission?: string;
      revision: string;
      json?: boolean;
    }) => {
      const permissionKind = resolveFolderPermissionKind(options.permission);
      if (permissionKind === null) {
        process.stderr.write("astarray: --permission 只能是 read-only/read-write\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      const revision = Number(options.revision);
      if (!Number.isInteger(revision) || revision < 1) {
        process.stderr.write("astarray: --revision 必须是正整数\n");
        process.exitCode = EXIT_CODES.USAGE_ERROR;
        return;
      }
      process.exitCode = await executeFolderCheckCommand({
        stateDirectory: defaultStateDirectory(),
        projectIdentifier: options.project,
        targetPath: options.path,
        requiredPermission: permissionKind,
        projectRevision: revision,
        isJsonOutput: options.json === true,
      });
    },
  );

const crossProjectCommand = program
  .command("cross-project")
  .description("跨项目授权与副本（只读；按来源/目标/个体过滤，不串数据）");
crossProjectCommand
  .command("list")
  .description("列出跨项目授权与副本回执（副本显式标注，人工可分辨）")
  .option("--source-project <project-id>", "限定来源项目")
  .option("--target-project <project-id>", "限定目标项目")
  .option("--agent <agent-instance-id>", "限定接收个体（多同级个体互不串数据）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      sourceProject?: string;
      targetProject?: string;
      agent?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeCrossProjectListCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        ...(options.sourceProject === undefined
          ? {}
          : { sourceProjectIdentifier: options.sourceProject }),
        ...(options.targetProject === undefined
          ? {}
          : { targetProjectIdentifier: options.targetProject }),
        ...(options.agent === undefined
          ? {}
          : { receivingAgentInstanceId: options.agent }),
      });
    },
  );

crossProjectCommand
  .command("read")
  .description("按授权跨项目只读（真实读取；来源零写入；未授权不触达资源）")
  .requiredOption("--authorization <id>", "授权标识")
  .requiredOption("--source-project <project-id>", "来源项目标识")
  .requiredOption("--target-project <project-id>", "目标项目标识")
  .requiredOption("--resource <relative-path>", "来源资源相对路径（用于授权范围判定）")
  .requiredOption("--absolute-resource <absolute-path>", "来源资源绝对路径（真正被读取）")
  .requiredOption("--arguments-hash <hash>", "完整规范化参数哈希（必须与授权绑定一致）")
  .option("--source-revision <revision>", "来源项目当前 revision（给出时须与授权绑定一致）")
  /**
   * PROJECT-01-03（2026-11-02）：**来源项目根**。
   *
   * 服务据此把「声明路径」锚定到真实文件，证明 `--absolute-resource`
   * 就是授权范围内的那个文件。此前 CLI **未暴露该选项**、执行器也从未收到它
   * ⇒ 一律 fail-closed 回 `resource-out-of-scope`
   * （实测：包级验收的跨项目判据 5/5 全红）。
   */
  .requiredOption(
    "--source-project-root <dir>",
    "来源项目根（用于把声明路径锚定到真实文件）",
  )
  .option("--expected-content-hash <hash>", "期望内容哈希（不符即拒绝）")
  .option("--now <iso>", "显式当前时间（ISO 8601）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      authorization: string;
      sourceProject: string;
      targetProject: string;
      resource: string;
      absoluteResource: string;
      argumentsHash: string;
      sourceProjectRoot: string;
      sourceRevision?: string;
      expectedContentHash?: string;
      now?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeCrossProjectReadCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        authorizationIdentifier: options.authorization,
        sourceProjectIdentifier: options.sourceProject,
        targetProjectIdentifier: options.targetProject,
        sourceResourcePath: options.resource,
        absoluteResourcePath: options.absoluteResource,
        argumentsHash: options.argumentsHash,
        // PROJECT-01-03：来源项目根必须传到服务，否则声明路径无法锚定 ⇒ 一律 out-of-scope。
        sourceProjectRootPath: options.sourceProjectRoot,
        ...(options.sourceRevision === undefined
          ? {}
          : { currentSourceProjectRevision: Number(options.sourceRevision) }),
        ...(options.expectedContentHash === undefined
          ? {}
          : { expectedContentHash: options.expectedContentHash }),
        ...(options.now === undefined ? {} : { nowIso: options.now }),
      });
    },
  );
crossProjectCommand
  .command("import-copy")
  .description("按授权跨项目导入副本（真实写出目标；来源零写入；拒绝陈旧覆盖人工修改）")
  .requiredOption("--authorization <id>", "授权标识")
  .requiredOption("--source-project <project-id>", "来源项目标识")
  .requiredOption("--target-project <project-id>", "目标项目标识")
  .requiredOption("--source-resource <relative-path>", "来源资源相对路径（用于授权范围判定）")
  .requiredOption("--target-resource <relative-path>", "目标资源相对路径（用于回执）")
  .requiredOption("--absolute-source <absolute-path>", "来源绝对路径（真正被读取）")
  .requiredOption("--absolute-target <absolute-path>", "目标绝对路径（真正被写出）")
  .requiredOption("--source-revision <revision>", "来源项目 revision（必须与授权绑定一致）")
  .requiredOption("--arguments-hash <hash>", "完整规范化参数哈希（必须与授权绑定一致）")
  /**
   * PROJECT-01-03（2026-11-02）：**来源/目标项目根**（与 `read` 同因）。
   * 此前未暴露 ⇒ 服务无法把声明路径锚定到真实文件 ⇒ 一律 `resource-out-of-scope`。
   */
  .requiredOption(
    "--source-project-root <dir>",
    "来源项目根（用于把来源声明路径锚定到真实文件）",
  )
  .requiredOption(
    "--target-project-root <dir>",
    "目标项目根（用于把目标声明路径锚定到真实文件）",
  )
  .option(
    "--expected-target-content-hash <hash>",
    "目标预期内容哈希（给出时可判定人工改动；未给出且目标已存在则拒绝覆盖）",
  )
  .option("--now <iso>", "显式当前时间（ISO 8601）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      authorization: string;
      sourceProject: string;
      targetProject: string;
      sourceResource: string;
      targetResource: string;
      absoluteSource: string;
      absoluteTarget: string;
      sourceRevision: string;
      argumentsHash: string;
      sourceProjectRoot: string;
      targetProjectRoot: string;
      expectedTargetContentHash?: string;
      now?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeCrossProjectImportCopyCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        authorizationIdentifier: options.authorization,
        sourceProjectIdentifier: options.sourceProject,
        targetProjectIdentifier: options.targetProject,
        sourceResourcePath: options.sourceResource,
        targetResourcePath: options.targetResource,
        absoluteSourcePath: options.absoluteSource,
        absoluteTargetPath: options.absoluteTarget,
        sourceRevision: Number(options.sourceRevision),
        argumentsHash: options.argumentsHash,
        // PROJECT-01-03：两个项目根都必须传到服务，否则声明路径无法锚定 ⇒ out-of-scope。
        sourceProjectRootPath: options.sourceProjectRoot,
        targetProjectRootPath: options.targetProjectRoot,
        ...(options.expectedTargetContentHash === undefined
          ? {}
          : { expectedTargetContentHash: options.expectedTargetContentHash }),
        ...(options.now === undefined ? {} : { nowIso: options.now }),
      });
    },
  );

/**
 * PERF-01-03：性能最小概览（只读；由已落盘样本复算；不发起任何 Provider/业务请求）。
 */
const perfCommand = program.command("perf").description("性能概览（只读；由已落盘样本复算）");
perfCommand
  .command("overview")
  .description("性能最小概览：范围/时间窗口/分页/摘要（无法测量时报不可报告，不报零）")
  .option("--mission <mission-id>", "限定可见范围（mission）")
  .option("--since <iso>", "时间窗下界（ISO 8601，含）")
  .option("--until <iso>", "时间窗上界（ISO 8601，含）")
  .option("--detail <level>", "summary | detail（缺省 summary）")
  .option("--page-size <count>", "detail 模式每页条数（缺省 20）")
  .option("--cursor <cursor>", "detail 模式分页游标（上一页 nextCursor）")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      mission?: string;
      since?: string;
      until?: string;
      detail?: string;
      pageSize?: string;
      cursor?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executePerfOverviewCommand({
        stateDirectory: defaultStateDirectory(),
        isJsonOutput: options.json === true,
        ...(options.mission === undefined ? {} : { missionIdentifier: options.mission }),
        ...(options.since === undefined ? {} : { windowStartIso: options.since }),
        ...(options.until === undefined ? {} : { windowEndIso: options.until }),
        ...(options.detail === undefined ? {} : { detailLevel: options.detail }),
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
    },
  );

const contextCommand = program.command("context").description("上下文生命周期");
contextCommand
  .command("metrics")
  .description("上下文运行时缓存与 token 指标（由真实装配事件复算）")
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeContextMetricsCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
contextCommand
  .command("recall")
  .description("结构化上下文回访（ASTARRAY_CONTEXT_RECALL_REQUEST_V1 JSON）")
  .requiredOption("--agent <agent-id>", "调用者 agentInstanceId")
  .requiredOption("--graph <graph-id>", "上下文图标识（用于节点索引）")
  .requiredOption("--request <json>", "结构化回访请求 JSON")
  .option("--json", "JSON 输出")
  .action(
    async (options: { agent: string; graph: string; request: string; json?: boolean }) => {
      process.exitCode = await executeContextRecallCommand({
        stateDirectory: defaultStateDirectory(),
        callerAgentInstanceId: options.agent,
        graphIdentifier: options.graph,
        requestJson: options.request,
        isJsonOutput: options.json === true,
      });
    },
  );
contextCommand
  .command("transaction <mission-id> <task-id>")
  .description("上下文事务只读对账；--replay 幂等补齐缺口（不重复、不覆盖旧产物）")
  .requiredOption("--agent <agent-id>", "owner agentInstanceId")
  .option("--mode <mode-key>", "模式键（assist/devolve）", "assist")
  .option("--description <text>", "任务描述（--replay 必填）")
  .option("--summary <text>", "完成摘要（--replay 必填）")
  .option("--replay", "执行幂等重放（只补齐缺口）")
  .option("--json", "JSON 输出")
  .action(
    async (
      missionIdentifier: string,
      taskIdentifier: string,
      options: {
        agent: string;
        mode: string;
        description?: string;
        summary?: string;
        replay?: boolean;
        json?: boolean;
      },
    ) => {
      process.exitCode = await executeContextTransactionCommand({
        stateDirectory: defaultStateDirectory(),
        agentInstanceId: options.agent,
        missionIdentifier,
        taskIdentifier,
        modeKey: options.mode,
        ...(options.description !== undefined
          ? { taskDescription: options.description }
          : {}),
        ...(options.summary !== undefined ? { summaryText: options.summary } : {}),
        isReplayRequested: options.replay === true,
        isJsonOutput: options.json === true,
      });
    },
  );
contextCommand
  .command("status")
  .description("查看上下文关闭分组、待追认状态与全局上下文预算上限")
  .option("--agent <agent-id>", "具体 agentInstanceId")
  .option("--graph <graph-id>", "上下文图标识")
  .option("--json", "输出机器可解析 JSON")
  .action(async (options: { agent?: string; graph?: string; json?: boolean }) => {
    if (options.agent === undefined || options.graph === undefined) {
      process.stderr.write("context status 需要 --agent 与 --graph\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeContextStatusCommand({
      stateDirectory: defaultStateDirectory(),
      agentInstanceId: options.agent,
      graphIdentifier: options.graph,
      isJsonOutput: options.json === true,
    });
  });

const recoverCommand = program
  .command("recover")
  .description("恢复中心：列出/查询/恢复/放弃 mission（只恢复安全节点）");
recoverCommand
  .command("list")
  .description("只读列出磁盘上的 mission（含损坏标记与租约）")
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeRecoverListCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
recoverCommand
  .command("show <mission-id>")
  .description("查询单个 mission 的磁盘状态与可信检查点可用性")
  .option("--json", "JSON 输出")
  .action(async (missionIdentifier: string, options: { json?: boolean }) => {
    process.exitCode = await executeRecoverShowCommand({
      stateDirectory: defaultStateDirectory(),
      missionIdentifier,
      isJsonOutput: options.json === true,
    });
  });
recoverCommand
  .command("resume <mission-id>")
  .description("只恢复安全节点；需裁决项逐项 blocked（不默认允许）")
  .option("--execute", "安全对账通过后真正续接 mission 完成未完成任务")
  .option("--json", "JSON 输出")
  .action(
    async (missionIdentifier: string, options: { execute?: boolean; json?: boolean }) => {
      process.exitCode = await executeRecoverResumeCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier,
        isJsonOutput: options.json === true,
        isExecutionRequested: options.execute === true,
      });
    },
  );
recoverCommand
  .command("abandon <mission-id>")
  .description("只关闭调度并保留可审计存档（不删除数据）")
  .option("--json", "JSON 输出")
  .action(async (missionIdentifier: string, options: { json?: boolean }) => {
    process.exitCode = await executeRecoverAbandonCommand({
      stateDirectory: defaultStateDirectory(),
      missionIdentifier,
      isJsonOutput: options.json === true,
    });
  });

program
  .command("cancel <mission-id>")
  .description("取消一个任务")
  .option("--json", "输出机器可解析 JSON")
  .action(async (missionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeCancelCommand({
      missionId,
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

const configCommand = program.command("config").description("配置管理");
configCommand
  .command("init")
  .description("初始化配置")
  .action(async () => {
    process.exitCode = await executeConfigInitCommand({
      stateDirectory: defaultStateDirectory(),
    });
  });
configCommand
  .command("context-budget")
  .description("查看或设置全局上下文预算（token；0=不自动注入全局记录）")
  .argument("[tokens]", "非负整数 token 数；缺省仅查看")
  .option("--json", "JSON 输出")
  .action(async (tokens: string | undefined, options: { json?: boolean }) => {
    let parsedTokens: number | null = null;
    if (tokens !== undefined) {
      parsedTokens = Number.parseInt(tokens, 10);
      if (
        !Number.isInteger(parsedTokens) ||
        parsedTokens < 0 ||
        String(parsedTokens) !== tokens.trim()
      ) {
        process.stderr.write("context-budget 必须为非负整数（0 表示不自动注入）\n");
        process.exitCode = 2;
        return;
      }
    }
    process.exitCode = await executeConfigContextBudgetCommand({
      stateDirectory: defaultStateDirectory(),
      tokens: parsedTokens,
      isJsonOutput: options.json === true,
    });
  });
configCommand
  .command("install-enabled")
  .description("设置 Assist 安装独立开关（true/false；开启不等于授权）")
  .argument("<enabled>", "true 或 false")
  .action(async (enabled: string) => {
    if (enabled.toLowerCase() !== "true" && enabled.toLowerCase() !== "false") {
      process.stderr.write("install-enabled 参数必须为 true 或 false\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeConfigInstallEnabledCommand({
      stateDirectory: defaultStateDirectory(),
      isEnabled: enabled.toLowerCase() === "true",
    });
  });

// T07D-06：Provider 配置装配（含受保护凭据引用的**写入面**）
const providerCommand = configCommand
  .command("provider")
  .description("Provider 配置：受保护凭据引用写入/登记与只读查询（凭据不回显）");
providerCommand
  .command("credential-set")
  .description(
    "从 STDIN 写入受保护凭据引用（JSON: {referenceId, baseUrl, apiKey}）；key 不得经命令行或环境变量传入",
  )
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeProviderCredentialSetCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
providerCommand
  .command("register")
  .description("登记 Provider（凭据只以引用 ID 入目录；引用不存在即拒绝）")
  .argument("<provider-id>", "Provider 档案 ID")
  .requiredOption("--protocol <protocol>", "协议名（如 generic-openai-compatible）")
  .requiredOption("--api-version <version>", "协议 API 版本")
  .requiredOption("--capability <name...>", "能力名（可重复；如 text tool-calling）")
  .requiredOption("--support-level <level>", "adapter-only|fake-server-conformant|live-smoke-verified|product-path-verified")
  .requiredOption("--credential-reference <reference>", "受保护凭据引用 ID")
  .option("--json", "JSON 输出")
  .option(
    "--verified-at <iso>",
    "验证时间（ISO 8601；仅在已有实测证据时给出。未给出则保持 null，不臆造）",
  )
  .action(
    async (
      providerId: string,
      options: {
        protocol: string;
        apiVersion: string;
        capability: string[];
        supportLevel: string;
        credentialReference: string;
        verifiedAt?: string;
        json?: boolean;
      },
    ) => {
      process.exitCode = await executeProviderRegisterCommand({
        stateDirectory: defaultStateDirectory(),
        providerProfileId: providerId,
        protocolName: options.protocol,
        apiVersion: options.apiVersion,
        capabilityNames: options.capability,
        supportLevel: options.supportLevel,
        protectedCredentialReferenceId: options.credentialReference,
        ...(options.verifiedAt === undefined ? {} : { verifiedAtIso: options.verifiedAt }),
        isJsonOutput: options.json === true,
      });
    },
  );
providerCommand
  .command("list")
  .description("列出已登记 Provider（公开信息；无凭据）")
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeProviderListCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
providerCommand
  .command("show")
  .description("查看已登记 Provider 的协议/能力/支持等级（无凭据、无响应正文）")
  .argument("<provider-id>", "Provider 档案 ID")
  .option("--json", "JSON 输出")
  .action(async (providerId: string, options: { json?: boolean }) => {
    try {
      process.exitCode = await executeProviderShowCommand({
        stateDirectory: defaultStateDirectory(),
        providerProfileId: providerId,
        isJsonOutput: options.json === true,
      });
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 2;
    }
  });

// B6R-04：认证用户设置控制面——权限组生命周期
const profileCommand = program.command("profile").description("权限组管理（认证设置控制面）");
profileCommand
  .command("list")
  .description("列出全部权限组（分页；无产品数量上限）")
  .option("--json", "JSON 输出")
  .option("--page <n>", "页码", "1")
  .option("--page-size <n>", "每页数量", "50")
  .action(async (options: { json?: boolean; page?: string; pageSize?: string }) => {
    process.exitCode = await executeProfileListCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
      page: Number.parseInt(options.page ?? "1", 10),
      pageSize: Number.parseInt(options.pageSize ?? "50", 10),
    });
  });
profileCommand
  .command("create")
  .description("创建自定义权限组（来源 blank/assist/devolve/ponder/custom:<id>）")
  .argument("<name>", "显示名称")
  .option("--from <source>", "创建来源", "blank")
  .action(async (name: string, options: { from?: string }) => {
    process.exitCode = await executeProfileCreateCommand({
      stateDirectory: defaultStateDirectory(),
      displayName: name,
      source: options.from ?? "blank",
    });
  });
profileCommand
  .command("rename")
  .description("重命名自定义权限组（ID 不变）")
  .argument("<profileId>", "权限组 ID")
  .argument("<newName>", "新名称")
  .action(async (profileId: string, newName: string) => {
    process.exitCode = await executeProfileRenameCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      newDisplayName: newName,
    });
  });
profileCommand
  .command("copy")
  .description("复制自定义权限组")
  .argument("<profileId>", "权限组 ID")
  .argument("<newName>", "新名称")
  .action(async (profileId: string, newName: string) => {
    process.exitCode = await executeProfileCopyCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      newDisplayName: newName,
    });
  });
profileCommand
  .command("reset")
  .description("重置为来源（blank/assist/devolve/ponder/custom:<id>）")
  .argument("<profileId>", "权限组 ID")
  .option("--to <source>", "重置来源", "blank")
  .action(async (profileId: string, options: { to?: string }) => {
    process.exitCode = await executeProfileResetCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      source: options.to ?? "blank",
    });
  });
profileCommand
  .command("set-capability")
  .description("逐项三态设置（allow/ask/deny）")
  .argument("<profileId>", "权限组 ID")
  .argument("<capabilityId>", "权限 ID")
  .argument("<decision>", "allow|ask|deny")
  .action(async (profileId: string, capabilityId: string, decision: string) => {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      process.stderr.write("decision 必须为 allow|ask|deny\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeProfileSetCapabilityCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
      capabilityId,
      decision,
    });
  });
profileCommand
  .command("export")
  .description("导出公开可配置字段（剥离内部字段；覆盖前自动备份）")
  .argument("<reference>", "builtin 或 profile ID")
  .option("--out <path>", "输出文件")
  .action(async (reference: string, options: { out?: string }) => {
    process.exitCode = await executeProfileExportCommand({
      stateDirectory: defaultStateDirectory(),
      reference,
      outputPath: options.out ?? null,
    });
  });
profileCommand
  .command("import")
  .description("导入公开配置（只接受可配置目录字段）")
  .argument("<file>", "JSON 文件")
  .action(async (file: string) => {
    process.exitCode = await executeProfileImportCommand({
      stateDirectory: defaultStateDirectory(),
      inputPath: file,
    });
  });
profileCommand
  .command("delete")
  .description("删除自定义权限组（当前使用组必须先切换）")
  .argument("<profileId>", "权限组 ID")
  .action(async (profileId: string) => {
    process.exitCode = await executeProfileDeleteCommand({
      stateDirectory: defaultStateDirectory(),
      permissionProfileId: profileId,
    });
  });
profileCommand
  .command("switch")
  .description("认证用户选择当前权限组（持久化；写入自动备份）")
  .argument("<reference>", "builtin 或 profile ID")
  .action(async (reference: string) => {
    process.exitCode = await executeProfileSwitchCommand({
      stateDirectory: defaultStateDirectory(),
      reference,
    });
  });
profileCommand
  .command("show")
  .description("显示当前/指定权限组公开详情")
  .argument("[reference]", "builtin 或 profile ID（缺省为当前选择）")
  .option("--json", "JSON 输出")
  .action(async (reference: string | undefined, options: { json?: boolean }) => {
    process.exitCode = await executeProfileShowCommand({
      stateDirectory: defaultStateDirectory(),
      reference: reference ?? null,
      isJsonOutput: options.json === true,
    });
  });

// B6R-06：会话提升控制面（认证设置控制面；不提供"提升主 Agent"）
const sessionCommand = program.command("session").description("会话提升与关闭导出（认证设置控制面）");
const workflowCommand = program
  .command("workflow")
  .description("独立工作助手纵向闭环（本地控制面；仅登记本次派出的 Agent）");
workflowCommand
  .command("run")
  .description("运行纵向闭环场景：readonly-analysis | small-coding")
  .requiredOption("--scenario <name>", "readonly-analysis | small-coding")
  .option("--mission <mission-id>", "mission 标识（readonly-analysis）")
  .option("--scope <text>", "侦察范围描述（readonly-analysis）")
  .option("--digest-file <path>", "PROJECT_CONTEXT_DIGEST_V1 JSON 文件路径")
  .option("--task <task-id>", "任务标识（small-coding）")
  .option("--task-revision <n>", "任务 revision（缺省 1）")
  .option("--appointment <appointment-id>", "任命标识")
  .option("--implementation-agent <agent-id>", "实现者 agentInstanceId")
  .option("--testing-agent <agent-id>", "测试者 agentInstanceId")
  .option("--acceptance-agent <agent-id>", "验收者 agentInstanceId")
  .option("--commit <hash>", "贡献提交哈希")
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      scenario: string;
      mission?: string;
      scope?: string;
      digestFile?: string;
      task?: string;
      taskRevision?: string;
      appointment?: string;
      implementationAgent?: string;
      testingAgent?: string;
      acceptanceAgent?: string;
      commit?: string;
      json?: boolean;
    }) => {
      process.exitCode = await executeWorkflowScenarioCommand({
        stateDirectory: defaultStateDirectory(),
        scenario: options.scenario,
        isJsonOutput: options.json === true,
        ...(options.mission !== undefined
          ? { missionIdentifier: options.mission }
          : {}),
        ...(options.scope !== undefined ? { scopeQuery: options.scope } : {}),
        ...(options.digestFile !== undefined
          ? { digestFilePath: options.digestFile }
          : {}),
        ...(options.task !== undefined ? { taskIdentifier: options.task } : {}),
        ...(options.taskRevision !== undefined
          ? { taskRevision: Number.parseInt(options.taskRevision, 10) }
          : {}),
        ...(options.appointment !== undefined
          ? { appointmentId: options.appointment }
          : {}),
        ...(options.implementationAgent !== undefined
          ? { implementationAgentInstanceId: options.implementationAgent }
          : {}),
        ...(options.testingAgent !== undefined
          ? { testingAgentInstanceId: options.testingAgent }
          : {}),
        ...(options.acceptanceAgent !== undefined
          ? { acceptanceAgentInstanceId: options.acceptanceAgent }
          : {}),
        ...(options.commit !== undefined
          ? { contributionCommitHash: options.commit }
          : {}),
      });
    },
  );

const mcpCommand = program
  .command("mcp")
  .description("MCP 外部工具桥接（BRIDGE-01：stdio，仅最小工具面）");
mcpCommand
  .command("serve")
  .description("以 stdio 运行 MCP 服务器（换行分隔 JSON-RPC；stdout 仅 MCP 消息）")
  .option("--runtime <runtime>", "运行时（mock | openai-compatible；缺省 mock）")
  .option("--provider-endpoint <url>", "openai-compatible 协议端点（必填）")
  .option("--provider-model <model>", "Provider 模型标识（必填）")
  .option("--provider-api-key-env <name>", "存放 API key 的环境变量名")
  .option("--provider-credential-reference <reference>", "受保护凭据引用（优先于环境变量）")
  .option(
    "--provider-request-timeout-seconds <seconds>",
    "Provider 单次请求超时秒数（缺省 30；长任务需放宽）",
  )
  .option(
    "--runtime-diagnostics-file <path>",
    "把本次选中的运行时写入公开诊断报告（供安装验收；不含凭据）",
  )
  .action(
    async (options: {
      runtime?: string;
      providerEndpoint?: string;
      providerModel?: string;
      providerApiKeyEnv?: string;
      providerCredentialReference?: string;
      providerRequestTimeoutSeconds?: string;
      runtimeDiagnosticsFile?: string;
    }) => {
      process.exitCode = await executeMcpServeCommand({
        stateDirectory: defaultStateDirectory(),
        ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
        ...(options.providerEndpoint !== undefined
          ? { providerEndpoint: options.providerEndpoint }
          : {}),
        ...(options.providerModel !== undefined
          ? { providerModelIdentifier: options.providerModel }
          : {}),
        ...(options.providerApiKeyEnv !== undefined
          ? { providerApiKeyEnvironmentVariable: options.providerApiKeyEnv }
          : {}),
        ...(options.providerCredentialReference !== undefined
          ? { providerCredentialReference: options.providerCredentialReference }
          : {}),
        ...(options.providerRequestTimeoutSeconds !== undefined
          ? {
              providerRequestTimeoutMilliseconds:
                Number.parseInt(options.providerRequestTimeoutSeconds, 10) * 1_000,
            }
          : {}),
        ...(options.runtimeDiagnosticsFile !== undefined
          ? { runtimeDiagnosticsFilePath: options.runtimeDiagnosticsFile }
          : {}),
      });
    },
  );

const guideCommand = program
  .command("guide")
  .description("运行中指导（GUIDE-01：提交并在安全点应用）");
guideCommand
  .command("submit")
  .description("提交运行中指导（受理不等于已应用）")
  .argument("<instruction>", "指导文本")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .requiredOption("--task <task-id>", "task 标识")
  .option(
    "--tier <tier>",
    "行为档：record-only|safe-point-guidance|gate-and-request-pause",
    "safe-point-guidance",
  )
  .option("--json", "JSON 输出")
  .action(
    async (
      instruction: string,
      options: { mission: string; task: string; tier: string; json?: boolean },
    ) => {
      const allowedTiers = [
        "record-only",
        "safe-point-guidance",
        "gate-and-request-pause",
      ];
      if (!allowedTiers.includes(options.tier)) {
        process.stderr.write("非法行为档：" + options.tier + "\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await executeGuideSubmitCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier: options.mission,
        taskIdentifier: options.task,
        instructionText: instruction,
        behaviorTier: options.tier as
          | "record-only"
          | "safe-point-guidance"
          | "gate-and-request-pause",
        isJsonOutput: options.json === true,
      });
    },
  );
guideCommand
  .command("status")
  .description("查看指导接收/应用状态与安全点应用延迟")
  .option("--guidance <guidance-id>", "只查看某条指导")
  .option("--json", "JSON 输出")
  .action(async (options: { guidance?: string; json?: boolean }) => {
    process.exitCode = await executeGuideStatusCommand({
      stateDirectory: defaultStateDirectory(),
      guidanceIdentifier: options.guidance,
      isJsonOutput: options.json === true,
    });
  });

const accuracyCommand = program
  .command("accuracy")
  .description("准确性检查档位/预算（ACCURACY：默认标准档，仅认证用户可配置）");
accuracyCommand
  .command("status")
  .description("读取当前档位、预算上界与开关状态")
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeAccuracyStatusCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
accuracyCommand
  .command("configure")
  .description("配置档位/预算/开关（Agent 不得自行降级或关闭）")
  .option("--tier <tier>", "档位：fast|standard|strict")
  .option("--enable", "启用准确性检查")
  .option("--disable", "关闭准确性检查（不新增模型审查或人工阻塞）")
  .option(
    "--max-model-calls <count>",
    "模型审查次数上界",
    (value: string) => Number.parseInt(value, 10),
  )
  .option(
    "--max-wall-clock-ms <milliseconds>",
    "墙钟时间上界（毫秒）",
    (value: string) => Number.parseInt(value, 10),
  )
  .option(
    "--expected-revision <revision>",
    "期望 revision（并发配置校验；缺省用当前 revision）",
    (value: string) => Number.parseInt(value, 10),
  )
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      tier?: string;
      enable?: boolean;
      disable?: boolean;
      maxModelCalls?: number;
      maxWallClockMs?: number;
      expectedRevision?: number;
      json?: boolean;
    }) => {
      if (options.enable === true && options.disable === true) {
        process.stderr.write("不能同时使用 --enable 与 --disable\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await executeAccuracyConfigureCommand({
        stateDirectory: defaultStateDirectory(),
        tier: options.tier,
        isEnabled:
          options.enable === true
            ? true
            : options.disable === true
              ? false
              : undefined,
        maximumModelCallCount: options.maxModelCalls,
        maximumWallClockMilliseconds: options.maxWallClockMs,
        expectedRevision: options.expectedRevision,
        isJsonOutput: options.json === true,
      });
    },
  );

const preserveCommand = program
  .command("preserve")
  .description("本地保全（GIT-PRESERVE：远端同步失败后的独立可恢复快照）");
preserveCommand
  .command("create")
  .description("按远端同步结果生成或复用本地保全点")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .requiredOption("--repo <repository-path>", "仓库路径")
  .requiredOption(
    "--sync-status <status>",
    "同步状态：succeeded|not-attempted|attempting|failed-network|failed-authentication|failed-rejected|failed-no-remote|failed-unknown",
  )
  .option("--json", "JSON 输出")
  .action(
    async (options: {
      mission: string;
      repo: string;
      syncStatus: string;
      json?: boolean;
    }) => {
      process.exitCode = await executePreserveCreateCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier: options.mission,
        repositoryPath: options.repo,
        syncStatus: options.syncStatus,
        isJsonOutput: options.json === true,
      });
    },
  );
preserveCommand
  .command("status")
  .description("列出某 mission 的保全点（无保全点诚实为 no-preservation）")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .option("--json", "JSON 输出")
  .action(async (options: { mission: string; json?: boolean }) => {
    process.exitCode = await executePreserveStatusCommand({
      stateDirectory: defaultStateDirectory(),
      missionIdentifier: options.mission,
      isJsonOutput: options.json === true,
    });
  });
preserveCommand
  .command("show")
  .description("查看保全点状态与逐项完整性报告")
  .argument("<preservation-point-id>", "保全点标识")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .option("--json", "JSON 输出")
  .action(
    async (
      preservationPointId: string,
      options: { mission: string; json?: boolean },
    ) => {
      process.exitCode = await executePreserveShowCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier: options.mission,
        preservationPointId,
        isJsonOutput: options.json === true,
      });
    },
  );
preserveCommand
  .command("restore")
  .description("恢复到新目录（拒绝非空目标，不覆盖当前工作区）")
  .argument("<preservation-point-id>", "保全点标识")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .requiredOption("--into <directory>", "恢复目标目录（必须为空或不存在）")
  .option("--json", "JSON 输出")
  .action(
    async (
      preservationPointId: string,
      options: { mission: string; into: string; json?: boolean },
    ) => {
      process.exitCode = await executePreserveRestoreCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier: options.mission,
        preservationPointId,
        restoreDirectoryPath: options.into,
        isJsonOutput: options.json === true,
      });
    },
  );

guideCommand
  .command("change")
  .description("追加/修订/新建任务（必须显式选择；不明确时请求澄清）")
  .argument("<instruction>", "指导文本")
  .requiredOption("--mission <mission-id>", "mission 标识")
  .option("--task <task-id>", "目标任务标识（new-task 可省略）")
  .option("--intent <intent>", "变更类型：append|revise|new-task")
  .option(
    "--task-revision <revision>",
    "观察到的任务 revision",
    (value: string) => Number.parseInt(value, 10),
    1,
  )
  .option("--new-task <task-id>", "new-task 的独立任务标识")
  .option(
    "--invalidate-artifact <identifiers...>",
    "修订使其失效的产物标识（可多个）",
    [],
  )
  .option(
    "--invalidate-entry <identifiers...>",
    "修订使其失效的验收条目标识（可多个）",
    [],
  )
  .option(
    "--tier <tier>",
    "行为档：record-only|safe-point-guidance|gate-and-request-pause",
    "safe-point-guidance",
  )
  .option("--json", "JSON 输出")
  .action(
    async (
      instruction: string,
      options: {
        mission: string;
        task?: string;
        intent?: string;
        taskRevision: number;
        newTask?: string;
        invalidateArtifact: string[];
        invalidateEntry: string[];
        tier: string;
        json?: boolean;
      },
    ) => {
      const allowedTiers = [
        "record-only",
        "safe-point-guidance",
        "gate-and-request-pause",
      ];
      if (!allowedTiers.includes(options.tier)) {
        process.stderr.write("非法行为档：" + options.tier + "\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await executeGuideChangeCommand({
        stateDirectory: defaultStateDirectory(),
        missionIdentifier: options.mission,
        taskIdentifier: options.task ?? null,
        instructionText: instruction,
        changeIntent: options.intent ?? null,
        requestedTaskSequenceRevision: options.taskRevision,
        newTaskIdentifier: options.newTask ?? null,
        invalidatedArtifactIdentifiers: options.invalidateArtifact,
        invalidatedAcceptanceEntryIdentifiers: options.invalidateEntry,
        behaviorTier: options.tier as
          | "record-only"
          | "safe-point-guidance"
          | "gate-and-request-pause",
        isJsonOutput: options.json === true,
      });
    },
  );
guideCommand
  .command("history")
  .description("查看任务的指导变更历史（追加/修订保留历史）")
  .requiredOption("--task <task-id>", "任务标识")
  .option("--json", "JSON 输出")
  .action(async (options: { task: string; json?: boolean }) => {
    process.exitCode = await executeGuideHistoryCommand({
      stateDirectory: defaultStateDirectory(),
      taskIdentifier: options.task,
      isJsonOutput: options.json === true,
    });
  });

const summaryCommand = program
  .command("summary")
  .description("摘要（SUM-01：清单、分页读取与章节展开）");
summaryCommand
  .command("list")
  .description("列出已发布摘要来源（无来源时状态为 no-summary）")
  .option("--json", "JSON 输出")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeSummaryListCommand({
      stateDirectory: defaultStateDirectory(),
      isJsonOutput: options.json === true,
    });
  });
summaryCommand
  .command("build")
  .description("把 mission 工作存档汇总为摘要并原子发布")
  .argument("<mission-id>", "mission 标识")
  .option("--json", "JSON 输出")
  .action(async (missionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeSummaryBuildCommand({
      stateDirectory: defaultStateDirectory(),
      missionId,
      isJsonOutput: options.json === true,
    });
  });
summaryCommand
  .command("show")
  .description("读取摘要：默认概览，可用 --chunk 展开章节")
  .argument("<source-identifier>", "摘要来源标识（通常为 mission id）")
  .option("--level <level>", "详细度：summary|outline|section|detail", "summary")
  .option(
    "--page-size <size>",
    "每页分块数",
    (value: string) => Number.parseInt(value, 10),
    10,
  )
  .option("--chunk <chunk-identifier>", "展开指定章节")
  .option(
    "--max-return-units <units>",
    "单次返回计量单位上限（只裁剪本次返回）",
    (value: string) => Number.parseInt(value, 10),
  )
  .option("--json", "JSON 输出")
  .action(
    async (
      sourceIdentifier: string,
      options: {
        level: string;
        pageSize: number;
        chunk?: string;
        maxReturnUnits?: number;
        json?: boolean;
      },
    ) => {
      const allowedDetailLevels = ["summary", "outline", "section", "detail"];
      if (!allowedDetailLevels.includes(options.level)) {
        process.stderr.write("非法详细度等级：" + options.level + "\n");
        process.exitCode = 2;
        return;
      }
      process.exitCode = await executeSummaryShowCommand({
        stateDirectory: defaultStateDirectory(),
        sourceIdentifier,
        detailLevel: options.level as
          | "summary"
          | "outline"
          | "section"
          | "detail",
        pageSize: options.pageSize,
        chunkIdentifier: options.chunk,
        maximumReturnUnitCount: options.maxReturnUnits,
        isJsonOutput: options.json === true,
      });
    },
  );

program
  .command("gui")
  .description("本地 GUI 工作台（loopback HTTP + SSE；默认自动打开浏览器）")
  .option(
    "--port <port>",
    "监听端口（0 为自动分配）",
    (value: string) => Number.parseInt(value, 10),
  )
  .option("--no-open", "不自动打开浏览器")
  .option("--runtime <runtime>", "运行时（mock | openai-compatible；缺省 mock）")
  .option("--provider-endpoint <url>", "openai-compatible 协议端点（必填）")
  .option("--provider-model <model>", "Provider 模型标识（必填）")
  .option("--provider-api-key-env <name>", "存放 API key 的环境变量名")
  .option("--provider-credential-reference <reference>", "受保护凭据引用（优先于环境变量）")
  .option(
    "--provider-request-timeout-seconds <seconds>",
    "Provider 单次请求超时秒数（缺省 30；长任务需放宽）",
  )
  .option(
    "--runtime-diagnostics-file <path>",
    "把本次选中的运行时写入公开诊断报告（供安装验收；不含凭据）",
  )
  .action(
    async (options: {
      port?: number;
      open?: boolean;
      runtime?: string;
      providerEndpoint?: string;
      providerModel?: string;
      providerApiKeyEnv?: string;
      providerCredentialReference?: string;
      providerRequestTimeoutSeconds?: string;
      runtimeDiagnosticsFile?: string;
    }) => {
      process.exitCode = await executeGuiServeCommand({
        stateDirectory: defaultStateDirectory(),
        ...(options.port !== undefined ? { port: options.port } : {}),
        isBrowserOpenEnabled: options.open !== false,
        ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
        ...(options.providerEndpoint !== undefined
          ? { providerEndpoint: options.providerEndpoint }
          : {}),
        ...(options.providerModel !== undefined
          ? { providerModelIdentifier: options.providerModel }
          : {}),
        ...(options.providerApiKeyEnv !== undefined
          ? { providerApiKeyEnvironmentVariable: options.providerApiKeyEnv }
          : {}),
        ...(options.providerCredentialReference !== undefined
          ? { providerCredentialReference: options.providerCredentialReference }
          : {}),
        ...(options.providerRequestTimeoutSeconds !== undefined
          ? {
              providerRequestTimeoutMilliseconds:
                Number.parseInt(options.providerRequestTimeoutSeconds, 10) * 1_000,
            }
          : {}),
        ...(options.runtimeDiagnosticsFile !== undefined
          ? { runtimeDiagnosticsFilePath: options.runtimeDiagnosticsFile }
          : {}),
      });
    },
  );

sessionCommand
  .command("elevation-list")
  .description("查看会话级/个体级临时提升")
  .argument("<sessionId>", "会话 ID")
  .option("--json", "JSON 输出")
  .action(async (sessionId: string, options: { json?: boolean }) => {
    process.exitCode = await executeSessionElevationListCommand({
      stateDirectory: defaultStateDirectory(),
      sessionId,
      isJsonOutput: options.json === true,
    });
  });
sessionCommand
  .command("elevate")
  .description("认证用户创建会话/个体提升（不提供提升主 Agent）")
  .argument("<sessionId>", "会话 ID")
  .argument("<capabilityId>", "权限 ID")
  .argument("<decision>", "allow|ask（提升方向必须更宽）")
  .option("--agent <agentInstanceId>", "具体次级 Agent（缺省=会话级）")
  .option("--ttl-seconds <n>", "到期秒数（缺省=不过期）")
  .action(
    async (
      sessionId: string,
      capabilityId: string,
      decision: string,
      options: { agent?: string; ttlSeconds?: string },
    ) => {
      if (decision !== "allow" && decision !== "ask") {
        process.stderr.write("decision 必须为 allow|ask\n");
        process.exitCode = 2;
        return;
      }
      const ttlSeconds = options.ttlSeconds;
      const expiresAtIso =
        ttlSeconds === undefined
          ? null
          : new Date(Date.now() + Number.parseInt(ttlSeconds, 10) * 1000).toISOString();
      process.exitCode = await executeSessionElevateCommand({
        stateDirectory: defaultStateDirectory(),
        sessionId,
        capabilityId,
        elevatedDecision: decision,
        agentInstanceId: options.agent ?? null,
        expiresAtIso,
      });
    },
  );
sessionCommand
  .command("revoke-elevation")
  .description("撤销指定临时提升")
  .argument("<sessionId>", "会话 ID")
  .argument("<elevationId>", "提升 ID")
  .action(async (sessionId: string, elevationId: string) => {
    process.exitCode = await executeSessionRevokeElevationCommand({
      stateDirectory: defaultStateDirectory(),
      sessionId,
      elevationId,
    });
  });
sessionCommand
  .command("shutdown")
  .description("关闭会话：收敛 → 可选导出（受控备份）→ 无条件撤销全部提升")
  .argument("<sessionId>", "会话 ID")
  .option("--export <path>", "导出公开有效配置路径")
  .option("--json", "JSON 输出")
  .action(
    async (sessionId: string, options: { export?: string; json?: boolean }) => {
      process.exitCode = await executeSessionShutdownCommand({
        stateDirectory: defaultStateDirectory(),
        sessionId,
        exportPath: options.export ?? null,
        isJsonOutput: options.json === true,
      });
    },
  );

/**
 * G10（2026-11-08 第 184 轮）：`preset list` 与 `concurrent status` 此前**只有实现、从未分发**
 * （全仓无调用点）⇒ 用户无法从 CLI 调用。此处按既有 `.command(...).action(...)` 风格接入。
 *
 * ⚠️ 这两个命令只做**只读状态视图**（不执行进程、不联网、不写文件），
 * 输出语义已按 G9 改为如实：`modulesLoadable` + `componentsReadySemantics`。
 */
program
  .command("preset")
  .description("预设（模型/Provider 预设列表）")
  .command("list")
  .description("列出全部预设（内置 + 自定义）")
  .option("--json", "输出机器可解析 JSON")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executePresetListCommand({
      isJsonOutput: options.json === true,
    });
  });

program
  .command("concurrent")
  .description("并发变更（人工/Agent 并发冲突视图）")
  .command("status")
  .description("冲突状态视图（人工变更/意图/冲突种类/来源）")
  .option("--json", "输出机器可解析 JSON")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await executeConcurrentStatusCommand({
      isJsonOutput: options.json === true,
    });
  });

program
  .command("doctor")
  .description("诊断环境")
  .option("--json", "输出机器可解析 JSON")
  .option("--provider <provider-id>", "只报告该 Provider 的配置/凭据引用/支持等级（不探测网络）")
  .option("--errors", "只读诊断：错误汇总（事实与推断分列；不执行进程、不联网、不写文件）")
  .option("--bundle", "只读诊断：输出脱敏诊断包预览（纯构造，不落盘）")
  .option("--mission <mission-id>", "诊断：限定可见范围（mission）")
  .option("--agent <agent-instance-id>", "诊断：限定可见范围（具体 agentInstanceId）")
  .option("--since <iso>", "诊断：时间窗下界（ISO 8601）")
  .option("--until <iso>", "诊断：时间窗上界（ISO 8601）")
  .option("--page-size <count>", "诊断：分页条数")
    .action(async (options: {
      json?: boolean;
      provider?: string;
      errors?: boolean;
      bundle?: boolean;
      mission?: string;
      agent?: string;
      since?: string;
      until?: string;
      pageSize?: string;
      cursor?: string;
    }) => {
      if (options.errors === true || options.bundle === true) {
        process.exitCode = await executeDoctorErrorsCommand({
          stateDirectory: defaultStateDirectory(),
          isJsonOutput: options.json === true,
          shouldOutputBundle: options.bundle === true,
          ...(options.mission === undefined ? {} : { missionIdentifier: options.mission }),
          ...(options.agent === undefined ? {} : { sourceAgentInstanceId: options.agent }),
          ...(options.since === undefined ? {} : { windowStartIso: options.since }),
          ...(options.until === undefined ? {} : { windowEndIso: options.until }),
          ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        });
        return;
      }
    if (options.provider !== undefined && options.provider.trim() !== "") {
      try {
        process.exitCode = await executeDoctorProviderCommand({
          stateDirectory: defaultStateDirectory(),
          providerProfileId: options.provider,
          isJsonOutput: options.json === true,
        });
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exitCode = 2;
      }
      return;
    }
    process.exitCode = await executeDoctorCommand({
      isJsonOutput: options.json === true,
      stateDirectory: defaultStateDirectory(),
    });
  });

await program.parseAsync(process.argv);

/**
 * 收敛退出（2026-10-10，修 CLI 滞留缺陷）。
 *
 * 问题：一次性命令产出结果后，本进程仍可能被**残留句柄**（反馈子进程等）拉住而不退出
 * ——实测 provider + 权限询问路径 >60s，只能外部 kill
 * （见 `tests/tui/integration/cli-exit-linger.test.ts` 的 ②，此前以 `it.skip` 保留为待通过反例；
 * 同一现象也让验收 harness 拿不到干净退出码）。
 *
 * 为什么放在**引导层**而不是 `executeRunCommand`：后者会被单测**在进程内**直接调用，
 * 在其中 `process.exit()` 会杀死 vitest worker（实测连带 10 个既有用例失败，已回退）。
 * 本文件只在真实 CLI 进程里执行，故这里是安全收敛点。
 *
 * 为什么不会误杀常驻服务：`gui serve` / `mcp serve` 的动作 promise 在服务运行期间不会 resolve，
 * 因此 `parseAsync` 在服务期间不会返回，本段不可达。
 *
 * 退出前等 stdout 排空，避免管道输出被截断；并留一个不阻止事件循环的兜底定时器。
 */
const convergenceExitCode = process.exitCode ?? 0;
process.exitCode = convergenceExitCode;
process.stdout.write("", () => {
  process.exit(convergenceExitCode);
});
setTimeout(() => {
  process.exit(convergenceExitCode);
}, 1_000).unref();

