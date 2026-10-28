/**
 * SEC-02-07（2026-10-28）：**子进程环境允许列表**。
 *
 * 卡内要求：子进程环境采用**允许列表**，不默认继承宿主凭据环境变量；
 * shell、插件、转换器与模型生成脚本**不持有凭据库访问权**。
 *
 * 背景（实测）：反馈子进程 `fork(..., { env: { ...process.env } })`、Git 子进程
 * `spawn(..., { env: { ...process.env } })` 都**整体继承**宿主环境 —— 宿主机上任何一个
 * `*_API_KEY`/`*_TOKEN` 都会被带进子进程，并可能经诊断输出/异常回显泄漏。
 *
 * 本模块只做一件事：**按名字构造受限环境**。
 * - 只有显式允许的变量名会被复制；
 * - 即使名字在允许列表里，只要命中凭据命名模式也**排除**（纵深防御，防止把
 *   `PATH` 之外的东西误加进白名单）；
 * - **只记录被排除的变量名，绝不读取/记录其值**。
 */
import { DomainError } from "../core/errors.js";

/**
 * 默认允许的变量名（运行必需，非凭据）。
 *
 * 覆盖 Windows 与 POSIX 的最小集合：可执行查找、临时目录、用户主目录、语言/终端。
 * 注意大小写：Windows 环境变量名不区分大小写，这里两种拼写都列上。
 */
export const DEFAULT_ALLOWED_ENVIRONMENT_VARIABLE_NAMES: readonly string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "GIT_TERMINAL_PROMPT",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
];

/**
 * 凭据命名模式：命中即**不得**进入子进程（即使在允许列表里）。
 *
 * 保守匹配：宁可多排除一个普通变量，也不把密钥带进子进程。
 */
const CREDENTIAL_ENVIRONMENT_VARIABLE_PATTERN =
  /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|_AUTH\b|AUTH[_-]?TOKEN|OPENAI|ANTHROPIC|DEEPSEEK|MOONSHOT|ZHIPU|AWS_|AZURE_|GOOGLE_|GCP_|GITHUB|GITLAB|NPM_|DOCKER_|SSH_AUTH_SOCK|VAULT_)/i;

export interface RestrictedSubprocessEnvironmentInput {
  /** 宿主环境（通常是 `process.env`）；只按名字读取。 */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  /** 额外允许的变量名（显式加入；仍受凭据命名模式约束）。 */
  readonly additionalAllowedVariableNames?: readonly string[];
}

export interface RestrictedSubprocessEnvironment {
  /** 实际传给子进程的环境（只含允许项）。 */
  readonly environment: Record<string, string>;
  /** 实际允许的变量名（已排除凭据类）。 */
  readonly allowedVariableNames: readonly string[];
  /** 被凭据命名模式挡下的变量名（**只有名字，没有值**）。 */
  readonly excludedCredentialVariableNames: readonly string[];
}

export function buildRestrictedSubprocessEnvironment(
  input: RestrictedSubprocessEnvironmentInput,
): RestrictedSubprocessEnvironment {
  const allowedNameSet = new Set<string>([
    ...DEFAULT_ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
    ...(input.additionalAllowedVariableNames ?? []),
  ]);
  const environment: Record<string, string> = {};
  const allowedVariableNames: string[] = [];
  const excludedCredentialVariableNames: string[] = [];
  for (const [variableName, variableValue] of Object.entries(input.hostEnvironment)) {
    if (variableValue === undefined) {
      continue;
    }
    if (!allowedNameSet.has(variableName)) {
      continue;
    }
    if (CREDENTIAL_ENVIRONMENT_VARIABLE_PATTERN.test(variableName)) {
      /**
       * 名字在白名单里但看着像凭据 ⇒ 排除并记名。
       * 例如有人把 `GIT_SSH_COMMAND` 写成含 token 的命令：仍会进入，但值不会被记录；
       * 真正含密钥的变量名（`*_API_KEY` 等）一律不进子进程。
       */
      excludedCredentialVariableNames.push(variableName);
      continue;
    }
    environment[variableName] = variableValue;
    allowedVariableNames.push(variableName);
  }
  return { environment, allowedVariableNames, excludedCredentialVariableNames };
}

/**
 * 受控 fork/spawn 前的一致性校验：确保调用方**真的**用了受限环境。
 *
 * 只比较名字集合，不读取值；用于装配层自检（防止日后有人又写回 `...process.env`）。
 */
export function assertSubprocessEnvironmentIsRestricted(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly additionalAllowedVariableNames?: readonly string[];
}): void {
  const allowedNameSet = new Set<string>([
    ...DEFAULT_ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
    ...(input.additionalAllowedVariableNames ?? []),
  ]);
  const unexpectedNames = Object.keys(input.environment).filter(
    (variableName) =>
      input.environment[variableName] !== undefined && !allowedNameSet.has(variableName),
  );
  if (unexpectedNames.length > 0) {
    throw new DomainError(
      "task-sequence-permission-denied",
      `子进程环境包含未允许的变量：${unexpectedNames.join(", ")}（只记录名字，不含值）`,
    );
  }
}
