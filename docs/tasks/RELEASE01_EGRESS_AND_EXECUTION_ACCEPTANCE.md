# RELEASE-01　MCP、Provider 与受控执行的生产入口返修

状态：**01 第一片、02 已实施；01 端到端/03 待实施；04 已有基线**（2026-11-23）。基线：c3264ceb。B1–B4 指 11 月 23 日的[阻塞汇总](../reports/BLOCKERS_2026-11-23.md)。本卡将建议细化为施工口径，实施、验证和发布分别记录。各子卡可独立推进。

## 01　B1：MCP 会话授权到每次结果释放

- **起点**：CLI 的 executeMcpServeCommand 装配 runMcpStdioSession；mcp-tool-bridge 读取项目内容，mcp-stdio-server 的 writeResult 现已默认执行内容扫描。现有环境变量主体和客户端 initialize 信息只能用于标识。检查 ADR-0070 与 tools/outbound-content-gate.ts，复用已有内容哈希、内容 revision、目标与规则版本校验。
- **输入**：由可信宿主绑定连接、认证主体、目的端、源项目、允许的资源集合、有效期和授权 revision。默认主体或空授权只开放协议协商和已核定的公开元数据。连接授权允许范围内调用，执行时继续遵守原工具权限。记录真实来源与最终资源；搜索、证据查询等聚合结果须覆盖所有来源。
- **执行**：调用前解析授权范围；释放数据前重读有效授权，校验撤销、目的端及资源范围，分别检查授权 revision、内容 revision 和扫描规则版本。将实际序列化的业务结果及导出元数据交给既有门禁。授权绑定来自可信记录，禁止用待发内容给自己签发批准。脱敏改变内容时重新绑定。错误出口仅返回稳定原因及关联 ID，不能反射正文。旧客户端仍可协商协议，缺绑定的项目读取返回明确拒绝。
- **验收**：扩展 mcp-outbound-content-scan.test.ts，并从构建产物启动真实 stdio 子进程。以两个客户端、两个项目和临时资源测试已授权正常读、同一连接范围内重复读、错目的端、越界、过期、撤销、调用中 revision 变化及扫描失败。合法请求得到预期结果；拒绝请求在 stdout、stderr 和审计中均无夹具正文，项目元数据同样受保护。列明所有释放点及幂等重连行为。

## 02　B2：Provider 最终请求默认阻断

- **起点**：openai-compatible-runtime.ts 和 anthropic-messages-runtime.ts 各自缺省 record；共用 runtime/provider-egress-scan.ts。检查 ADR-0080、正常构造、显式配置、重试和流式入口，集中解析有效策略。
- **目标**：生产缺省 block。扫描最终请求体，包括历史、工具结果与附加上下文；每次实际发送前检查，本地扫描异常或非 clean 结束该次发送。记录可排查的来源类别与原因，剔除敏感正文和认证头。旧配置缺字段走新默认；显式 record/off 仅用于明确隔离的测试诊断，旧生产配置使用这些值时报告配置冲突并提示迁移。补记替代 ADR-0080 旧默认的范围。
- **验收**：分别用两个协议的本地假服务计数，从产品正常入口覆盖普通、流式、重试路径。clean 正常返回；敏感工具结果、扫描异常及仅在重组后出现的敏感内容均为零网络请求。确认错误不会触发其他供应商重发。以脱敏业务样本记录误阻断数和分母，诊断模式另测。无需外部账户或付费请求。

## 03　B3：首版受控执行范围与能力声明

- **起点**：沿 execution-contract、process-execution-controller、sandbox-capability-probe、sandbox-helper-backend 到安装自检。复用 EXEC-01 的状态、预算、取消、输出扫描和重启对账。
- **范围**：先验收 Windows 项目构建和测试配置。只允许已登记的程序、参数约束、规范工作目录、环境和预算。项目脚本及其子进程也须受真实后端隔离。默认关闭网络，需联网的构建作为独立配置单独授权。无可用后端或探测无法证明所需限制时拒绝启动。保留已有查询与取消的 action 权限。
- **验收**：从安装包运行夹具项目的构建、失败测试、修正后复跑，核对退出码、扫描输出与任务验收相互独立。实测工作区外写入、未授权网络、子进程退出、超时、资源限额及取消后的残留进程。清洁设备记录 OS、架构、后端、安装包版本和每项结果。缺对应设备列为待验证；平台支持只按实际通过的组合发布。工具链安装、提权及签名另按具体操作授权。

## 04　B4：公开包验收

保留公开 CLI/SDK 产品边界。复用 verify:entry-runtime-selection 与 verify:tarball-install，在隔离目录安装 tarball，断言声明支持的入口可用，未提供的入口返回稳定错误；核对实际打包的文件清单。已有两条脚本通过的记录可作基线，有打包变更时重跑。

## 交付与状态回写

每个子卡提交记录变更入口、旧配置处理、执行命令、版本、正反例及未覆盖环境。先复现本卡对应缺口，再跑定向测试、npm run check 与受影响的包级脚本。更新外发出口清单、对应 SEC-02/EXEC-01 卡和阻塞汇总。B5–B8 按设备与人工证据签收；B9–B10 延用原覆盖率阈值；F1–F3 保持原工程跟踪。任何一项局部通过只改变对应子卡状态。

## 实施记录

### 02 Provider 最终请求默认阻断（2026-11-23）

- `provider-egress-scan.ts` 新增 `DEFAULT_PROVIDER_EGRESS_SCAN_MODE = "block"`；
  `anthropic-messages-runtime` 与 `openai-compatible-runtime` 的缺省改为引用该常量
  （显式 `record`/`off` 仍可配置，供隔离诊断）。
- 反例：`provider-egress-scan.test.ts` 新增"缺省档位必须是 block"；
  既有三档行为用例（off/record/block、incomplete 阻断、环形缓冲有界）保持通过。
- 门禁：909 files / 5797 tests（全绿）；`lint` 0。
- **已补（2026-11-23）**：`resolveProviderEgressScanMode` 统一解析配置——缺省/空值 ⇒ block；
  `record`/`off` 仅在 `isIsolatedDiagnostic=true` 时生效，否则报冲突并回落 block；未知值 fail-closed。
  反例 6 条（缺省/显式 block/旧 record/旧 off/隔离诊断/未知值）。\n- **仍未做（如实）**：ADR-0080 旧默认的替代记录；两协议下的"零网络请求"计数验收（需假服务计数夹具）。
### 01 MCP 授权到每次结果释放（第一片，2026-11-23）

- 新增 `bridge/mcp-egress-authorization.ts`：`McpConnectionAuthorizationBinding` + `evaluateMcpRelease`
  + `evaluateMcpReleaseAgainstStore`（**每次释放前重读**绑定与撤销状态，读失败视为撤销）。
- 校验项：无绑定、主体/连接/目的端不一致、过期、撤销、内容 revision、规则版本、资源越界；
  拒绝只给稳定原因码，越界信息**不返回资源名**。
- `runMcpStdioSession` 新增 `authorizeRelease` 钩子：宿主拒绝时回 JSON-RPC 错误（只含原因码），
  stdout 不出现结果正文；未注入时保持既有"仅内容扫描"行为（生产装配必须注入）。
- 反例：模块 8 条 + 会话钩子 4 条。
- 门禁：912 files / 5815 tests（全绿）。
- **已补（2026-11-23）**：`McpEgressAuthorizationStore`（权威文件仓库：写入/撤销/跨实例读取/损坏按撤销）+
  `createMcpReleaseAuthorizer`；`mcp serve` 缺省注入该钩子（缺绑定即拒绝），新增
  `--egress-authorization-file` 选项。反例 7 条（缺绑定/有效/撤销/过期/异主体/损坏/撤销幂等）。
- **已补（2026-11-23）**：`extractMcpResultResourceIdentifiers` 按结果中的 `task/mission/project` 标识生成资源清单；
  `createMcpReleaseAuthorizer` 支持**独立目的端来源**（`targetAccountIdentifier`）；`mcp serve` 新增 `--egress-target-account`。
  反例 3 条（默认提取越界拒绝 / 允许前缀放行 / 独立目的端不一致拒绝）。
- **已补（2026-11-23）**：**真实 stdio 子进程端到端**（临时状态目录 + 绑定文件 + 稳定连接 ID）：
  `initialize` → `submit_task` 正常返回；**运行中改写绑定为撤销后** `query_task` 被拒
  （仅原因码 `authorization-revoked`，stdout 无任务标识/正文）。夹具在生产构建 `dist/cli.js` 上运行。
- **释放点清单**：① `tools/call` 结果写 stdout（内容扫描 + 释放判定）；② 通知不产生响应；
  ③ stderr 仅诊断、不含正文；④ 诊断报告不含凭据/正文。**幂等重连**：连接 ID 用 `ASTARRAY_MCP_CONNECTION_ID`
  稳定化，每次释放前重读绑定；同 ID 重连沿用同一授权状态。
- **仍未做（如实）**：双客户端/两项目夹具、目标账户的宿主侧独立注入在真实部署中的验证。
### 03 B3 Windows 受控执行：当前阻塞与已取证（2026-11-23）

- Windows 后端实现存在（`native/sandbox-helper/src/main.rs`，Job Object + AppContainer），但：
  1. **本机无 Rust 工具链**（`cargo`/`rustc` 均未安装）⇒ 无法构建 `sandbox-helper.exe`；
  2. README 明确 **`CreateAppContainerProfile` 需要提权**（安装期预建档案）。
- 因此 `createPlatformSandboxExecutionBackend` 在本机返回 `null`，控制器按纪律拒绝执行
  （`execution-backend-unsupported`，不降级到宿主进程）。
- **B3 验收在获得 Rust/MSVC 工具链与必要授权前无法开始**；本节作为阻塞证据，不宣称通过。
- 已就绪的前置：`buildSandboxSelfCheckReport`（SDK 导出）可在有后端时记录组件状态。