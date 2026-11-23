/**
 * RELEASE-01-01（2026-11-23）：MCP 连接授权的**权威文件仓库**与释放判定装配。
 *
 * - 宿主（`mcp serve`）从状态目录读取绑定；写入/撤销由宿主/管理员完成；
 * - 读取失败或损坏 ⇒ 调用方按"撤销"处理（fail-closed）；
 * - 判定本身在 `mcp-egress-authorization.ts`（纯函数），本文件只做持久化与装配。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  evaluateMcpReleaseAgainstStore,
  type McpAuthorizationStorePort,
  type McpConnectionAuthorizationBinding,
  type McpEgressDecision,
} from "./mcp-egress-authorization.js";
import { SENSITIVE_SCAN_RULE_SET_VERSION } from "../tools/sensitive-content-scan-contract.js";

export const MCP_EGRESS_AUTHORIZATION_SCHEMA_VERSION = 1;

export interface McpEgressAuthorizationFile {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly updatedAtIso: string;
  readonly connections: Record<string, McpConnectionAuthorizationBinding>;
  readonly revokedConnectionIdentifiers: readonly string[];
}

const EMPTY_FILE: McpEgressAuthorizationFile = {
  schemaVersion: MCP_EGRESS_AUTHORIZATION_SCHEMA_VERSION,
  revision: 0,
  updatedAtIso: "1970-01-01T00:00:00.000Z",
  connections: {},
  revokedConnectionIdentifiers: [],
};

export class McpEgressAuthorizationStore implements McpAuthorizationStorePort {
  constructor(private readonly options: { readonly filePath: string }) {}

  private async readFile(): Promise<McpEgressAuthorizationFile> {
    try {
      const content = await fs.readFile(this.options.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<McpEgressAuthorizationFile>;
      return {
        schemaVersion: parsed.schemaVersion ?? MCP_EGRESS_AUTHORIZATION_SCHEMA_VERSION,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        updatedAtIso: parsed.updatedAtIso ?? EMPTY_FILE.updatedAtIso,
        connections: parsed.connections ?? {},
        revokedConnectionIdentifiers: parsed.revokedConnectionIdentifiers ?? [],
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return EMPTY_FILE;
      }
      /** 损坏/不可读：不得当作"无授权"之外的任何东西 ⇒ 抛给调用方（其按撤销处理）。 */
      throw error;
    }
  }

  private async writeFile(next: McpEgressAuthorizationFile): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    await fs.writeFile(
      this.options.filePath,
      `${JSON.stringify(next, null, 2)}\n`,
      "utf8",
    );
  }

  async readBinding(connectionIdentifier: string): Promise<McpConnectionAuthorizationBinding | null> {
    const file = await this.readFile();
    return file.connections[connectionIdentifier] ?? null;
  }

  async isRevoked(connectionIdentifier: string): Promise<boolean> {
    const file = await this.readFile();
    return file.revokedConnectionIdentifiers.includes(connectionIdentifier);
  }

  /** 宿主写入/更新绑定（授权 revision 由调用方递增；本方法不猜）。 */
  async writeBinding(binding: McpConnectionAuthorizationBinding): Promise<void> {
    const file = await this.readFile();
    await this.writeFile({
      ...file,
      revision: file.revision + 1,
      updatedAtIso: new Date().toISOString(),
      connections: { ...file.connections, [binding.connectionIdentifier]: binding },
    });
  }

  /** 撤销连接（幂等；再次写入不改变）。 */
  async revoke(connectionIdentifier: string): Promise<void> {
    const file = await this.readFile();
    if (file.revokedConnectionIdentifiers.includes(connectionIdentifier)) {
      return;
    }
    await this.writeFile({
      ...file,
      revision: file.revision + 1,
      updatedAtIso: new Date().toISOString(),
      revokedConnectionIdentifiers: [
        ...file.revokedConnectionIdentifiers,
        connectionIdentifier,
      ],
    });
  }
}

/**
 * 绑定宿主会话与权威仓库，返回 `runMcpStdioSession.authorizeRelease` 钩子。
 *
 * 注意（如实）：当前 MCP 桥接工具不携带"目标账户/资源列表"的独立来源，
 * 因此 target 取绑定的目标（对无绑定场景仍会被 `authorization-missing` 拦下），
 * 资源范围检查目前为空集；按工具提取资源清单是后续分项。
 */
/** 从工具结果提取本结果依赖的资源标识（供范围校验）。 */
export function extractMcpResultResourceIdentifiers(input: {
  readonly toolName: string;
  readonly structuredContent: Record<string, unknown>;
}): string[] {
  const identifiers: string[] = [];
  const taskIdentifier = input.structuredContent["taskIdentifier"];
  if (typeof taskIdentifier === "string" && taskIdentifier !== "") {
    identifiers.push(`task:${taskIdentifier}`);
  }
  const missionIdentifier = input.structuredContent["missionIdentifier"];
  if (typeof missionIdentifier === "string" && missionIdentifier !== "") {
    identifiers.push(`mission:${missionIdentifier}`);
  }
  const projectIdentifier = input.structuredContent["projectIdentifier"];
  if (typeof projectIdentifier === "string" && projectIdentifier !== "") {
    identifiers.push(`project:${projectIdentifier}`);
  }
  return identifiers;
}

export function createMcpReleaseAuthorizer(input: {
  readonly store: McpAuthorizationStorePort;
  readonly connectionIdentifier: string;
  readonly authenticatedPrincipalIdentifier: string;
  /**
   * 目的端的**独立来源**（宿主配置/环境变量）。缺省取绑定自身的目标，
   * 此时目的端校验对桥接工具是弱校验（如实记录，装配应传独立值）。
   */
  readonly targetAccountIdentifier?: string;
  /** 资源清单提取（缺省按结果中的 task/mission/project 标识）。 */
  readonly extractResourceIdentifiers?: (payload: {
    readonly toolName: string;
    readonly outcome: {
      readonly isError: boolean;
      readonly errorCode: string | null;
      readonly textContent: string;
      readonly structuredContent: Record<string, unknown>;
    };
  }) => string[];
  readonly nowIso?: () => string;
}): (payload: {
  readonly toolName: string;
  readonly outcome: {
    readonly isError: boolean;
    readonly errorCode: string | null;
    readonly textContent: string;
    readonly structuredContent: Record<string, unknown>;
  };
}) => Promise<McpEgressDecision> {
  return async (payload) => {
    const binding = await input.store
      .readBinding(input.connectionIdentifier)
      .catch(() => null);
    const resourceIdentifiers = (
      input.extractResourceIdentifiers ??
      ((value) =>
        extractMcpResultResourceIdentifiers({
          toolName: value.toolName,
          structuredContent: value.outcome.structuredContent,
        }))
    )(payload);
    return evaluateMcpReleaseAgainstStore({
      store: input.store,
      request: {
        connectionIdentifier: input.connectionIdentifier,
        authenticatedPrincipalIdentifier: input.authenticatedPrincipalIdentifier,
        targetAccountIdentifier:
          input.targetAccountIdentifier ?? binding?.targetAccountIdentifier ?? "",
        contentRevision: binding?.contentRevision ?? 0,
        ruleSetVersion: SENSITIVE_SCAN_RULE_SET_VERSION,
        resourceIdentifiers,
        nowIso: (input.nowIso ?? (() => new Date().toISOString()))(),
      },
    });
  };
}
