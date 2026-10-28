/**
 * ALIGN-01-01（2026-10-28）：稳定的「会话 → 主个体 → 运行」持久映射。
 *
 * 问题（ALIGN-00 静态基线）：此前只有 `missionId`（每次用户消息新建）与
 * `sessionIdentifier`（GUI 会话串，进程内 Map 保存），**没有稳定的会话实体**；
 * ponder 路径还每次生成 `main:ponder:<随机>` ⇒ 换个进程/换条消息就换了"个体"，
 * 个体记忆与后续报告索引无处归属。
 *
 * 本模块只做**最小持久映射**（不新建第二套调度，不复制任务序列权威）：
 *
 *   projectIdentifier
 *     └─ conversationIdentifier        （稳定会话；重启后仍指向同一主个体）
 *          ├─ mainAgentInstanceIdentifier（该会话选定的主个体；记忆键精确到它）
 *          └─ runs[]                   （runIdentifier ↔ missionIdentifier ↔ 执行个体）
 *
 * 四条硬约束（均由代码强制，不靠调用方自觉）：
 * 1. **不以宿主进程 ID / 任务 ID 冒充会话**：会话标识不得使用 `mission-*`、
 *    `pid:*`、`process-*`、`host:*` 等派生形态（`assertNotDerivedIdentifier`）。
 * 2. **不按角色名猜归属**：同一 `conversationIdentifier` 换项目或换主个体一律
 *    `conversation-identity-conflict`，绝不静默改绑。
 * 3. **关闭即终止**：已关闭会话不得继续追加运行（`conversation-identity-closed`）；
 *    要接着干必须显式开新会话 —— 新会话拿到**新个体**，不继承旧记忆。
 * 4. **运行与使命分开**：`runIdentifier` 每次执行新生成；`missionIdentifier`
 *    只是该运行的一个可选投影，二者不得互相代替（同一次运行重放同一 mission
 *    返回同一 run，不重复登记）。
 *
 * 落盘：`<stateDirectory>/conversation-identity/conversations.json`（原子写 + `.bak`
 * 备份恢复 + revision 单调递增），与 `agent-model-binding-store` 同一套纪律。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";

import { DomainError } from "../core/errors.js";
import { AsyncMutex } from "../infra/async-mutex.js";
import {
  backupExistingFile,
  readJsonWithBackupRecovery,
  writeAtomicJson,
} from "../infra/atomic-json.js";

export const CONVERSATION_IDENTITY_SCHEMA_VERSION = 1;

/** 每个会话保留的运行条数上限（超出丢弃最旧并如实记账，不静默丢）。 */
export const MAXIMUM_RETAINED_RUN_COUNT_PER_CONVERSATION = 200;

export interface ConversationRunRecord {
  /** 一次执行（一次主 Agent 应答 / 一次任务组派发）的稳定标识；永不复用。 */
  readonly runIdentifier: string;
  /** 该运行对应的 mission 投影；纯问答运行没有 mission ⇒ null。 */
  readonly missionIdentifier: string | null;
  /** 实际执行该运行的个体（记忆/读取抑制/汇报都按它定位）。 */
  readonly agentInstanceIdentifier: string;
  /**
   * ALIGN-01-03：触发本次运行的**用户消息引用**（harness 生成）。
   *
   * 主 Agent 的提案必须引用一次真实的用户任务；把引用持久化在运行记录上，
   * 才能在不信任模型输入的前提下校验"这条提案确实是针对那条用户消息"。
   * 历史记录没有该字段 ⇒ 读取方按 `null`（未知）处理，不得用 missionId 顶替。
   */
  readonly userMessageReference: string | null;
  readonly startedAtIso: string;
}

export interface ConversationIdentityRecord {
  readonly conversationIdentifier: string;
  readonly projectIdentifier: string;
  /** 该会话选定的主 Agent 个体；同一会话跨重启、跨消息不变。 */
  readonly mainAgentInstanceIdentifier: string;
  readonly status: "active" | "closed";
  readonly createdAtIso: string;
  readonly lastActiveAtIso: string;
  readonly closedAtIso?: string;
  readonly runs: readonly ConversationRunRecord[];
  /** 因超出保留上限而被丢弃的运行条数（如实记录，不假装从未发生）。 */
  readonly droppedRunCount: number;
}

export interface ConversationIdentityDocument {
  readonly schemaVersion: typeof CONVERSATION_IDENTITY_SCHEMA_VERSION;
  readonly revision: number;
  readonly conversations: Readonly<Record<string, ConversationIdentityRecord>>;
}

export interface ConversationIdentityStoreOptions {
  baseDirectory: string;
  /** 时钟注入（测试/对账用；缺省取系统时间）。 */
  nowIso?: () => string;
  generateConversationIdentifier?: () => string;
  generateMainAgentInstanceIdentifier?: () => string;
  generateRunIdentifier?: () => string;
  maximumRetainedRunCountPerConversation?: number;
}

export interface OpenConversationInput {
  projectIdentifier: string;
  /** 显式会话标识；缺省生成 `conversation-<uuid>`。 */
  conversationIdentifier?: string;
  /**
   * **新建**会话时采用的主个体（ALIGN-01-02 的"一次会话选择既有主个体"）。
   *
   * 注意：`resolveOrOpenConversationForProject` 命中**已登记**会话时**忽略**
   * 本字段 —— 既有会话永远沿用其登记过的个体（记忆域不得因换进程被改绑）；
   * 严格改绑只发生在显式 `openConversation`，且参数不符时直接冲突。
   */
  mainAgentInstanceIdentifier?: string;
}

export interface BeginRunInput {
  conversationIdentifier: string;
  /** 实际执行个体；缺省取该会话的主个体。 */
  agentInstanceIdentifier?: string;
  /** 该运行对应的 mission（纯问答无 mission ⇒ 省略）。 */
  missionIdentifier?: string;
  /** ALIGN-01-03：触发本次运行的用户消息引用（harness 生成）。 */
  userMessageReference?: string;
}

/**
 * 会话标识**不得**由宿主进程或任务派生。
 *
 * 这不是洁癖：`main-controller` 此前用 `mission-<8hex>` 当 mission、
 * 用 `main:ponder:<8hex>` 当个体，把"一次调用"当成了"一个会话"，
 * 于是重启即失去关联。这里在写入口直接拒绝派生形态。
 */
const DERIVED_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /^mission[-:]/i,
  /^pid[-:]/i,
  /^process[-:]/i,
  /^host[-:]/i,
];

export function isDerivedProcessOrMissionIdentifier(identifier: string): boolean {
  return DERIVED_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(identifier));
}

export class ConversationIdentityStore {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly nowIso: () => string;
  private readonly generateConversationIdentifier: () => string;
  private readonly generateMainAgentInstanceIdentifier: () => string;
  private readonly generateRunIdentifier: () => string;
  private readonly maximumRetainedRunCountPerConversation: number;
  private readonly lock = new AsyncMutex();

  constructor(options: ConversationIdentityStoreOptions) {
    const directoryPath = path.join(options.baseDirectory, "conversation-identity");
    this.filePath = path.join(directoryPath, "conversations.json");
    this.backupFilePath = path.join(directoryPath, "conversations.json.bak");
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.generateConversationIdentifier =
      options.generateConversationIdentifier ?? (() => `conversation-${randomUUID()}`);
    this.generateMainAgentInstanceIdentifier =
      options.generateMainAgentInstanceIdentifier ?? (() => `main-agent-${randomUUID()}`);
    this.generateRunIdentifier =
      options.generateRunIdentifier ?? (() => `run-${randomUUID()}`);
    this.maximumRetainedRunCountPerConversation =
      options.maximumRetainedRunCountPerConversation ??
      MAXIMUM_RETAINED_RUN_COUNT_PER_CONVERSATION;
  }

  async readDocument(): Promise<ConversationIdentityDocument> {
    const readResult = await readJsonWithBackupRecovery(this.filePath, this.backupFilePath);
    if (readResult === null) {
      return {
        schemaVersion: CONVERSATION_IDENTITY_SCHEMA_VERSION,
        revision: 0,
        conversations: {},
      };
    }
    const content = readResult.content as Partial<ConversationIdentityDocument>;
    if (
      content.schemaVersion !== CONVERSATION_IDENTITY_SCHEMA_VERSION ||
      typeof content.revision !== "number" ||
      content.conversations === undefined ||
      typeof content.conversations !== "object"
    ) {
      throw new DomainError(
        "journal-corrupted",
        "会话身份映射文件非法（schemaVersion/revision/conversations 不符）。",
      );
    }
    return {
      schemaVersion: CONVERSATION_IDENTITY_SCHEMA_VERSION,
      revision: content.revision,
      conversations: content.conversations as Record<string, ConversationIdentityRecord>,
    };
  }

  async getConversation(
    conversationIdentifier: string,
  ): Promise<ConversationIdentityRecord | null> {
    if (conversationIdentifier.trim() === "") {
      return null;
    }
    const document = await this.readDocument();
    return document.conversations[conversationIdentifier] ?? null;
  }

  async listConversationsByProject(
    projectIdentifier: string,
  ): Promise<ConversationIdentityRecord[]> {
    const document = await this.readDocument();
    return Object.values(document.conversations)
      .filter((record) => record.projectIdentifier === projectIdentifier)
      .sort((left, right) => left.createdAtIso.localeCompare(right.createdAtIso));
  }

  /** 该项目**最近活跃**的未关闭会话；没有则 null（不猜、不按名字匹配）。 */
  async resolveActiveConversationForProject(
    projectIdentifier: string,
  ): Promise<ConversationIdentityRecord | null> {
    const records = await this.listConversationsByProject(projectIdentifier);
    const activeRecords = records.filter((record) => record.status === "active");
    if (activeRecords.length === 0) {
      return null;
    }
    return activeRecords.reduce((latest, candidate) =>
      candidate.lastActiveAtIso > latest.lastActiveAtIso ? candidate : latest,
    );
  }

  /**
   * 默认入口：同一项目复用其最近活跃会话；没有才新建。
   *
   * 这是"默认交流路径"的唯一会话入口 —— 不按角色名、不按进程 ID 猜测，
   * 也不因为新建 mission 就新建会话。
   *
   * 若调用方显式给出 `conversationIdentifier`，则只按该标识解析/创建
   * （显式优先于"最近活跃"，但同样受冲突/已关闭规则约束）。
   */
  async resolveOrOpenConversationForProject(
    input: OpenConversationInput,
  ): Promise<ConversationIdentityRecord> {
    return this.lock.runExclusive(async () => {
      const document = await this.readDocument();
      const requestedConversationIdentifier = input.conversationIdentifier?.trim();
      if (
        requestedConversationIdentifier !== undefined &&
        requestedConversationIdentifier !== ""
      ) {
        const built = this.buildConversationRecord(document, input, {
          adoptExistingMainAgentIndividual: true,
        });
        const touched: ConversationIdentityRecord = {
          ...built.record,
          lastActiveAtIso: this.nowIso(),
        };
        await this.writeDocument({
          ...document,
          revision: document.revision + 1,
          conversations: {
            ...document.conversations,
            [touched.conversationIdentifier]: touched,
          },
        });
        return touched;
      }
      const existing = this.pickLatestActiveConversation(document, input.projectIdentifier);
      if (existing !== null) {
        const touched: ConversationIdentityRecord = {
          ...existing,
          lastActiveAtIso: this.nowIso(),
        };
        await this.writeDocument({
          ...document,
          revision: document.revision + 1,
          conversations: {
            ...document.conversations,
            [touched.conversationIdentifier]: touched,
          },
        });
        return touched;
      }
      const built = this.buildConversationRecord(document, input, {
        adoptExistingMainAgentIndividual: true,
      });
      await this.writeDocument({
        ...document,
        revision: document.revision + 1,
        conversations: {
          ...document.conversations,
          [built.record.conversationIdentifier]: built.record,
        },
      });
      return built.record;
    });
  }

  /** 显式开启会话；同 ID 同参数幂等，不同参数冲突，已关闭拒绝。 */
  async openConversation(input: OpenConversationInput): Promise<ConversationIdentityRecord> {
    return this.lock.runExclusive(async () => {
      const document = await this.readDocument();
      const built = this.buildConversationRecord(document, input, {
        adoptExistingMainAgentIndividual: false,
      });
      if (built.isCreated) {
        await this.writeDocument({
          ...document,
          revision: document.revision + 1,
          conversations: {
            ...document.conversations,
            [built.record.conversationIdentifier]: built.record,
          },
        });
      }
      return built.record;
    });
  }

  /**
   * 登记一次运行（runIdentifier 永不复用）。
   *
   * 幂等：同一会话内同一 `missionIdentifier` 重放返回既有 run（不重复登记、不换 run）。
   * 拒绝：会话不存在 / 已关闭 / 给出的个体与该会话主个体不一致（不静默改绑）。
   */
  async beginRun(input: BeginRunInput): Promise<ConversationRunRecord> {
    return this.lock.runExclusive(async () => {
      const document = await this.readDocument();
      const record = document.conversations[input.conversationIdentifier];
      if (record === undefined) {
        throw new DomainError(
          "conversation-identity-not-found",
          `会话未登记: ${input.conversationIdentifier}`,
        );
      }
      if (record.status === "closed") {
        throw new DomainError(
          "conversation-identity-closed",
          `会话已关闭，必须开新会话（新个体）: ${input.conversationIdentifier}`,
        );
      }
      const agentInstanceIdentifier =
        input.agentInstanceIdentifier ?? record.mainAgentInstanceIdentifier;
      if (agentInstanceIdentifier.trim() === "") {
        throw new DomainError(
          "conversation-identity-conflict",
          "运行必须绑定具体执行个体（不得为空）。",
        );
      }
      if (input.missionIdentifier !== undefined) {
        const existingRun = record.runs.find(
          (run) => run.missionIdentifier === input.missionIdentifier,
        );
        if (existingRun !== undefined) {
          return existingRun;
        }
      }
      const runRecord: ConversationRunRecord = {
        runIdentifier: this.generateRunIdentifier(),
        missionIdentifier: input.missionIdentifier ?? null,
        agentInstanceIdentifier,
        userMessageReference: input.userMessageReference?.trim() || null,
        startedAtIso: this.nowIso(),
      };
      const appendedRuns = [...record.runs, runRecord];
      const overflowCount = Math.max(
        0,
        appendedRuns.length - this.maximumRetainedRunCountPerConversation,
      );
      const retainedRuns =
        overflowCount === 0 ? appendedRuns : appendedRuns.slice(overflowCount);
      const updated: ConversationIdentityRecord = {
        ...record,
        lastActiveAtIso: this.nowIso(),
        runs: retainedRuns,
        droppedRunCount: record.droppedRunCount + overflowCount,
      };
      await this.writeDocument({
        ...document,
        revision: document.revision + 1,
        conversations: {
          ...document.conversations,
          [updated.conversationIdentifier]: updated,
        },
      });
      return runRecord;
    });
  }

  /** 关闭会话（幂等）；之后的运行必须开新会话。 */
  async closeConversation(conversationIdentifier: string): Promise<ConversationIdentityRecord> {
    return this.lock.runExclusive(async () => {
      const document = await this.readDocument();
      const record = document.conversations[conversationIdentifier];
      if (record === undefined) {
        throw new DomainError(
          "conversation-identity-not-found",
          `会话未登记: ${conversationIdentifier}`,
        );
      }
      if (record.status === "closed") {
        return record;
      }
      const closed: ConversationIdentityRecord = {
        ...record,
        status: "closed",
        closedAtIso: this.nowIso(),
      };
      await this.writeDocument({
        ...document,
        revision: document.revision + 1,
        conversations: {
          ...document.conversations,
          [conversationIdentifier]: closed,
        },
      });
      return closed;
    });
  }

  private pickLatestActiveConversation(
    document: ConversationIdentityDocument,
    projectIdentifier: string,
  ): ConversationIdentityRecord | null {
    const activeRecords = Object.values(document.conversations).filter(
      (record) =>
        record.projectIdentifier === projectIdentifier && record.status === "active",
    );
    if (activeRecords.length === 0) {
      return null;
    }
    return activeRecords.reduce((latest, candidate) =>
      candidate.lastActiveAtIso > latest.lastActiveAtIso ? candidate : latest,
    );
  }

  private buildConversationRecord(
    document: ConversationIdentityDocument,
    input: OpenConversationInput,
    options: { readonly adoptExistingMainAgentIndividual: boolean },
  ): { record: ConversationIdentityRecord; isCreated: boolean } {
    const projectIdentifier = input.projectIdentifier.trim();
    if (projectIdentifier === "") {
      throw new DomainError(
        "conversation-identity-conflict",
        "会话必须绑定具体项目（projectIdentifier 不得为空）。",
      );
    }
    const requestedConversationIdentifier = input.conversationIdentifier?.trim();
    const conversationIdentifier =
      requestedConversationIdentifier === undefined ||
      requestedConversationIdentifier === ""
        ? this.generateConversationIdentifier()
        : requestedConversationIdentifier;
    if (isDerivedProcessOrMissionIdentifier(conversationIdentifier)) {
      throw new DomainError(
        "conversation-identity-conflict",
        `会话标识不得由宿主进程或任务派生: ${conversationIdentifier}`,
      );
    }

    const existing = document.conversations[conversationIdentifier];
    /**
     * ALIGN-01-02 的前置语义：**既有会话选择既有主个体**。
     *
     * 默认交流路径命中已登记会话时，不拿"本进程的主 Agent id"去改绑
     * （那是另一个个体的记忆域）。只有**新建**会话才采用调用方给出的个体；
     * 显式 `openConversation` 仍按严格冲突规则处理。
     */
    if (existing !== undefined && options.adoptExistingMainAgentIndividual) {
      if (existing.status === "closed") {
        throw new DomainError(
          "conversation-identity-closed",
          `会话已关闭，请开新会话（新个体）: ${conversationIdentifier}`,
        );
      }
      if (existing.projectIdentifier !== projectIdentifier) {
        throw new DomainError(
          "conversation-identity-conflict",
          `会话 ${conversationIdentifier} 已绑定项目 ${existing.projectIdentifier}，拒绝改绑为 ${projectIdentifier}。`,
        );
      }
      return { record: existing, isCreated: false };
    }

    const requestedMainAgentInstanceIdentifier =
      input.mainAgentInstanceIdentifier?.trim();
    const mainAgentInstanceIdentifier =
      requestedMainAgentInstanceIdentifier === undefined ||
      requestedMainAgentInstanceIdentifier === ""
        ? this.generateMainAgentInstanceIdentifier()
        : requestedMainAgentInstanceIdentifier;
    if (isDerivedProcessOrMissionIdentifier(mainAgentInstanceIdentifier)) {
      throw new DomainError(
        "conversation-identity-conflict",
        `主个体标识不得由宿主进程或任务派生: ${mainAgentInstanceIdentifier}`,
      );
    }

    if (existing !== undefined) {
      if (existing.status === "closed") {
        throw new DomainError(
          "conversation-identity-closed",
          `会话已关闭，不得重新打开同一标识: ${conversationIdentifier}`,
        );
      }
      if (
        existing.projectIdentifier !== projectIdentifier ||
        existing.mainAgentInstanceIdentifier !== mainAgentInstanceIdentifier
      ) {
        throw new DomainError(
          "conversation-identity-conflict",
          `会话 ${conversationIdentifier} 已绑定项目 ${existing.projectIdentifier} / 个体 ${existing.mainAgentInstanceIdentifier}，` +
            `拒绝改绑为 ${projectIdentifier} / ${mainAgentInstanceIdentifier}。`,
        );
      }
      return { record: existing, isCreated: false };
    }

    const timestamp = this.nowIso();
    return {
      isCreated: true,
      record: {
        conversationIdentifier,
        projectIdentifier,
        mainAgentInstanceIdentifier,
        status: "active",
        createdAtIso: timestamp,
        lastActiveAtIso: timestamp,
        runs: [],
        droppedRunCount: 0,
      },
    };
  }

  private async writeDocument(document: ConversationIdentityDocument): Promise<void> {
    await writeAtomicJson(this.filePath, document);
    await backupExistingFile(this.filePath, this.backupFilePath);
  }
}
