# ADR-0071 凭据隔离与最小读取（SEC-02-07）

- 状态：部分采纳（子进程环境已允许列表化 + 凭据中介契约；OS 级隔离未做）
- 日期：2026-10-28
- 来源：[SEC-02](../tasks/SEC02_LOCAL_SCAN_COVERAGE.md) 检查点 07
- 相关：ADR-0068（检测器目录）、ADR-0069（入口 fail-closed）、ADR-0070（外发门禁）

## 1. 背景（实测）

**所有会创建子进程的地方都整体继承宿主环境**（`...process.env`）：

| 位置 | 子进程 | 风险 |
|---|---|---|
| `feedback-process/process-supervisor.ts` | `fork` 反馈进程 | 宿主上任何 `*_API_KEY`/`*_TOKEN` 进入子进程 |
| `orchestration/git-process.ts` | `spawn` git | 同上；git 钩子/凭据助手可读 |
| `orchestration/git-integration-coordinator.ts` | `spawnSync(shell:true)` 集成测试命令 | **项目自定义命令**（可能由模型生成）拿到全部宿主凭据 |
| `orchestration/mission-orchestrator.ts` | `spawnSync(shell:true)` 证据命令 | 同上 |
| `toolkit/tool-package-zip-installer.ts` | `spawnSync` powershell/unzip | 解压器拿到全部宿主凭据 |

另外：没有"凭据引用"契约（工作 Agent 可见的只有 provider 凭据存储的间接使用），
MCP 结果只做**掩码**而非阻断（ADR-0069/矩阵已记），也没有"交给模型前再检查一次"的兜底。

## 2. 契约（冻结）

1. **子进程环境 = 允许列表**（`infra/subprocess-environment-allowlist.ts`）：
   - 只复制显式允许的变量名（PATH/临时目录/用户主目录/语言/终端/git 三项非秘密配置）；
   - 即使名字在允许列表里，**命中凭据命名模式也排除**（`*_API_KEY`/`*_TOKEN`/`*_SECRET`/
     `*PASSWORD`/`AWS_`/`GITHUB`/`SSH_AUTH_SOCK`/`VAULT_` …）；
   - 只记录**被排除的变量名**，**绝不读取或记录其值**；
   - `assertSubprocessEnvironmentIsRestricted` 供装配自检（防止日后写回 `...process.env`）。
2. **凭据引用不含秘密**（`tools/credential-broker.ts`）：
   - `CredentialReference` 只有 `credentialIdentifier` / `serviceIdentifier` / `allowedOperations`；
   - `assertCredentialReferenceUsable` 校验**服务一致**与**操作在范围内**（不得跨目标透传认证）；
   - 只有 `CredentialBroker.resolveForRequest` 能经**可信解析端口**换取秘密，且空秘密直接拒绝；
   - `describeReference` 输出可安全出现在提示词/日志里的描述。
3. **模型/日志兜底**：`assertModelVisiblePayloadHasNoCredential` 用同一份检测器目录做四态扫描；
   非 `clean` 即抛 `sensitive-content-read-denied`，**错误里只带规则/原因，不回显命中值**。
4. **继承全模式禁读**：放权、会话提权、上级批准、"测试用途"都不能绕过本层（本层不读这些开关）。

## 3. 已修复的调用点

- `process-supervisor` fork：受限环境 + `ASTARRAY_FEEDBACK_CHILD=1`（非秘密标记）；
- `git-process` spawn：受限环境 + 原有三项 git 非秘密配置；
- `git-integration-coordinator` 集成测试命令：受限环境；
- `mission-orchestrator` 证据命令：受限环境；
- `tool-package-zip-installer` 解压（powershell/unzip）：受限环境。

## 4. 未完成（如实）

- **凭据解析端口没有生产实现**：`CredentialBroker` 只有契约；provider 凭据仍走既有存储
  （未改成"引用 + 中介"），因此"工作 Agent 只拿引用"尚未在 provider 路径上成立。
- **OS 级隔离未做**：没有文件/进程沙箱；"平台无法隔离时拒绝通用执行路径"这条**未实现**
  （当前也没有通用 shell 工具，见 SEC-02-06 通道 6）。
- **扫描暂存域对工作 Agent 不可读**：未实现（没有独立暂存域）。
- **异常/进程转储/请求头**：只在 MCP 结果与日志路径上有掩码；**原始异常与进程转储未逐一收口**。
- **MCP 结果仍是"掩码不阻断"**（沿 SEC-02-06 结论）。
- **未验证**：没有跑过"宿主有 `*_API_KEY` 时子进程看不到""跨服务用同一引用被拒"
  "模型可见载荷含 key 被拒"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
