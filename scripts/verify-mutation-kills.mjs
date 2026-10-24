#!/usr/bin/env node
/**
 * 变异验证（mutation verification）：确认**关键安全断言真的在拦事**（2026-10-13）。
 *
 * 由来（真实教训）：本轮为跨项目授权补了 3 条"受保护存储不得访问"的反例，
 * 其中一条（删除审计文件）在**临时禁用产品判定器**后**仍然通过** ——
 * 因为它先命中了 `resource-not-found`，**根本没走到受保护存储判定**。
 * ⇒ "测试通过"不等于"测试有效"；空洞反例会让防线看起来存在而实际不存在。
 *
 * 本脚本把那次手工实验固化为**可复用检查**：对每条关键安全断言，
 * 用精确字符串替换在产品代码里**注入一处反事实**，跑指定用例，
 * 要求**点名的那几条用例必须变红**；最后**必定还原**（sha256 校验）。
 *
 * 判定：任一变异"存活"（期望红却没红）⇒ 该变异**没被测住** ⇒ 退出码 1。
 *
 * **2026-11-08（第 92 轮）扩容：28 → 30 个变异体**（全量复跑 **30/30 被拦下**）。新增两个：
 *  - `guide01-watchdog-resumes-superseded-instruction`：把「被新指导取代的旧指令不得续跑」改成照样续跑
 *    （第 91 轮发现该分支**全仓零覆盖**，当时只靠一次性探针发现 ⇒ 固化防回归）；
 *  - `diag01-execution-refusal-recorded-as-failure`：去掉「执行前拒绝」过滤
 *    （拒绝/取消不得记成故障，卡内 DIAG-01 硬约束）。
 *
 * 扩张原则：**只固化"已经有真实反例、且反例真能变红"的守卫** ——
 * 不为了凑数加会产生误报的变异体（与仓库"不为凑数加守卫"同一纪律）。
 * **2026-11-08（第 94 轮）再扩容：31 → 33**（全量复跑 **33/33 被拦下**）。新增两个：
 *  - `ponder01-write-tool-added-to-readonly-allowlist`：把**写类工具**塞进思索模式只读白名单
 *    （思索模式必须由本地 harness **直接禁用**写入，不能仅靠提示词约束）；
 *  - `ar07-destructive-tool-without-auto-backup-accepted`：放宽 schema，使破坏性工具
 *    **不声明**工具内自动备份也能注册（违反"变更前必须自动备份"）。
 *
 * **⚠️ 本轮一条方法学教训（我自己的失误）**：验证 `ar07-destructive-tool-without-auto-backup-accepted` 时，
 * 我按"文件内容含 `mutationKind|backupPolicy`"筛出 17 个文件，却**只把其中 10 个敲进命令行**，
 * 恰好漏掉了真正守着这条规则的 `tests/core/unit/schemas.test.ts` ⇒ 得到**假结论"变异存活"**。
 * 跑全 17 个后立刻被拦下。**教训：变异探针的文件集必须由检索结果直接喂给命令，不能手敲。**
 *
 * **2026-11-08（第 96 轮）再扩容：33 → 34**（全量复跑 **34/34 被拦下**）。新增
 * `project01-narrowed-derivation-widening-accepted`（整段 `isNarrower` 恒真 ⇒ 派生可扩大范围）。
 *
 * **⚠️ 第 96 轮的第二条方法学教训 —— 变异必须够"强"**：验证这条时，我第一次只改
 * `isNarrower` 表达式里的**一项**条件（去掉 `pathPrefixes.length > 0`），其余条件仍在
 * ⇒ **变异太弱、根本没改变被测行为** ⇒ 又得到一次**假结论"存活"**（这次连全量套件都跑过、照样全绿）。
 * 换成**整段表达式恒真**后，用例立刻变红。
 * ⇒ **纪律：注入后必须先自问"这真的改变了被测行为吗？"** ——
 * 弱变异会把"守卫有效"**误报成**"守卫缺口"，而假缺口比漏检更浪费（会让人去补一个本来就有守卫的地方）。
 *
 * **2026-11-08（第 98 轮）再扩容：34 → 36**（全量复跑 **36/36 被拦下**）。新增两个，**都刻意用"整段条件"的强变异**（吸取第 96 轮"弱变异造成假缺口"的教训）：
 *  - `ar07-repeat-read-suppression-removed`：把"资源确实变了"判定改成恒真
 *    ⇒ **反自指/活锁保护**失效（同一来源可反复读未变化的资源）；
 *  - `ar07-recovery-checkpoint-chain-break-accepted`：跳过检查点哈希链校验
 *    ⇒ 被篡改/错序的检查点会被当成可信状态接受（**审计完整性**失守）。
 *
 * 两者本轮实测**均被拦下**（本就承重）：前者 4 个文件共 6 条用例变红，后者 1 条变红。
 * **2026-11-08（第 101 轮）扩容：36 → 37**（全量复跑 **37/37 被拦下**）。新增
 * `workspace-boundary-escape-accepted`（`isPathWithin` 恒真 ⇒ 包含性判定与**符号链接逃逸**判定同时失效）。
 * **本条是"验证型"结果**：实测该守卫覆盖**非常充分** —— 一次变异使多个文件大量用例变红
 * （`..` 逃逸、符号链接逃逸、工作区外绝对路径、TOCTOU 换链拦截…）⇒ **未发现缺口**，固化以防回归。
 * **2026-11-08（第 101 轮）两条新增：37 → 39**（全量复跑 **39/39 被拦下**）。标的：
 * `quaternary-permission-intersection-bypassed` 与 `quaternary-permission-excess-delegation-accepted`
 * —— **四级委派权限不得宽于三级**（AGENTS.md／ADR-0025 §5）。
 * 「**求交**（四级决定 = 三级 ⊓ 请求）」与「**超出即拒绝分发**」是**两种不同行为**，故各锁一条。
 * 本轮实测两条**均被拦下**（`quaternary-lifecycle.test.ts` 对应用例变红）⇒ **无缺口**。
 * **2026-11-08（第 102 轮）扩容：39 → 40**（全量复跑 **40/40 被拦下**）。
 * **本轮探针先"存活"、补完反例后才被拦下** —— 这是本文件的价值所在：
 * 把 `parameter-authorization.ts` 的 `doesRuleMatch` 里「无 `match` 一律匹配」与
 * 「参数不可解析返回 false」**两块顺序对调**后，**12 个相关文件 / 102 条用例全部照旧通过**
 * ⇒ 「**仅按 action 的规则 + 参数不可解析**」此前**没有任何断言**（且文件里两处表述互相矛盾）。
 * 已补反例 ⑨（钉住"仅按 action 的规则**不依赖参数文本**" + 依赖参数的规则**不可解析即回退基线**），
 * 并把该变异固化 ⇒ 现在 40/40 全被拦下。
 * **2026-11-08（第 103 轮）扩容：40 → 41**（全量复跑 **41/41 被拦下**）。新增
 * `permission-ask-expired-approval-reused`：跳过「批准已过期」判定 ⇒ 失效批准被无限期复用。
 * 实测在 **47 个相关文件 / 427 条用例**中，仅点名那条（`gui02-01-r1-approval-fingerprint-reuse`
 * 「⑧ **超出有效期**的批准不得复用」）变红 ⇒ **无缺口**，固化防回归。
 *
 * **本轮另记一条"不做的结论"**：备份库审计链（`backup-vault.ts` 的 `recordHash`／`previousRecordHash`）
 * 只有**写入方**、**全仓没有链校验方** —— 但仓库规则只要求「写高查阅优先级审计日志」，
 * **不要求产品内校验**（链是给外部审计的）⇒ 这是**设计取舍、不是缺口**，故**不为它加守卫**
 * （与"不为凑数加会产生误报的守卫"同一纪律）。
 * **2026-11-08（第 104 轮）扩容：41 → 42**（全量复跑 **42/42 被拦下**）。新增
 * `permission-ask-succeeded-target-replay-allowed`：让「已成功写入过同一目标 ⇒ 一律不得复用」整条失效
 * ⇒ 同一次批准被反复套用、**同一个写操作被再次执行**（重放）。
 * 实测被 **3 个独立文件**同时拦下（`gui02-01-r1-approval-fingerprint-reuse` ⑤、
 * `permission-ask-reuse` ⑤、`gui02-01-permission-ask-fingerprint-gap` ④）⇒ **覆盖扎实**，固化防回归。
 * **2026-11-08（第 116 轮）扩容：42 → 44**（全量复跑 **44/44 被拦下**）。新增两条**提权方向**的变异：
 * `permission-profile-assist-default-allowed`（协同模式默认矩阵绕过 `assistDefault` 一律 `allow`）与
 * `permission-profile-fallback-allow`（兜底判定 `deny` → `allow`，fail-open）。两条均被拦下。
 *
 * **⚠️ 同轮修正本脚本一处「假保证」**：原判据 `missingExpectations.length === 0` 在
 * `expectedFailingTestNames` 为**空数组**时**必然成立** ⇒ 会把"根本没让任何用例变红"的变异
 * **误判为「被拦下」**（本轮我自己写出过两条空列表，差点当证据用）。现**禁止空期望列表**：
 * 空列表一律记为脚本错误，要求写明被测用例名。
 *
 * **⚠️ 并记一次「假存活」教训**：该轮第一次探测协同默认矩阵时，我**手敲了 5 个测试文件**，
 * 结果变异"存活"；改用**由检索结果直接喂入的 13 个文件**后 ⇒ **17 条用例变红**（其实覆盖充分）。
 * 这正是本文件开头第 (a) 条纪律（文件集必须来自检索，不得手敲）的现实案例。
 * **2026-11-08（第 117 轮）扩容：44 → 46**（全量复跑 **46/46 被拦下**）。新增：
 * `backup-audit-review-priority-downgraded`（删除备份审计的**高查阅优先级**被降为 normal ——
 * 实测被 **3 条用例**拦下，含「删除备份审计记录使用高查阅优先级」「放权模式…写 HIGH 审计记录」；
 * **该探针另有诊断价值**：若测试只是拿常量自比，改常量就抓不到 ⇒ 说明那些断言**不是同义反复**）；
 * `cross-project-deny-precedence-bypassed`（跨项目裁决的「**显式拒绝优先**」永不触发 ——
 * 实测被「① 显式拒绝优先：即使其它侧允许也不放行」「② deny 优先：任一侧显式拒绝即整体拒绝」拦下）。
 *
 * **⚠️ 第 117 轮又踩一次文件集坑（本会话第 4 次）**：我给第二条变异**手敲**了 9 个文件名，
 * 里面凭印象写了两个不相关的文件、却**漏掉了真正守住该行为的**
 * `tests/core/unit/cross-project-permission-matrix.test.ts` ⇒ 该变异被误判为**「存活」**。
 * 现该条目的 `testFiles` 已改为**由检索结果直接写入**（并在条目注释里写明这次错误）。
 * ⇒ **纪律再强调：`testFiles` 只能来自检索输出，不得凭印象书写。**
 * **2026-11-08（第 118 轮）扩容：46 → 47，并且这是本窗口第 1 个"探针存活 ⇒ 补守卫"的真缺口**。
 * 新增 `feedback-agent-source-identity-emptied`：把反馈消息 agent 来源的 `agentInstanceId`
 * 由 `z.string().min(1)` 放宽为 `z.string()`（**允许空串**）。
 *
 * **原状：无人守** —— 该变异在**由检索直接喂入的 12 个文件 / 150 条用例**里**全部通过**，
 * 而 `AGENTS.md` 明写「Agent 来源必须**具体到不可复用的 `agentInstanceId`**，转发时保留原始来源」
 * ⇒ 该要求此前**没有任何断言**。
 *
 * **处置**：补反例（`tests/core/unit/schemas.test.ts`
 * 「Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝」，**并含一条合法消息必须被接受**，
 * 以免用例变成恒假）⇒ 该变异**当场被拦下**，随即固化为永久变异体。
 * **2026-11-08（第 119 轮）扩容：47 → 48**（全量复跑 **48/48 被拦下**）。新增
 * `relay-records-relayer-as-original-source`：把转达请求里的 `originalSourceAgentInstanceId`
 * 记成**转达者（直属上级）** ⇒ 原始来源被顶替、转达**冒充原创**
 * （`core/types.ts` 明写「转发消息必须保留原始来源，**不能把路由或转发 Agent 记录为原始来源**」）。
 * 实测被 `tests/core/unit/comm01-collaboration-relay.test.ts` 的
 * 「② 转达**保留原始来源、转达者与任务关联**，且**显式标注为转达**（不冒充原创）」拦下 ⇒ 覆盖确证。
 * 该条目只有 **1 个**测试文件 —— 已另行核实**不是漏覆盖**：该模块的导出函数
 * `routeCollaborationViaUniqueParent` 恰好只被这 **1 个**测试文件引用（其余两个导出是类型）。
 * **2026-11-08（第 120 轮）扩容：48 → 49**（全量复跑 **49/49 被拦下**）。新增
 * `memory-observation-source-replaced-by-owner`：把个体记忆观察的 `sourceAgentInstanceId`
 * 记成**接收方自己** ⇒ 等于「**去除来源、冒充自身记忆**」（该文件注释明令禁止）。
 * 实测被 `tests/core/unit/agent-lifecycle-and-memory.test.ts` 的
 * 「两个同级 Agent 相同任务文本下记忆完全隔离」拦下，且该用例是**直接断言**：
 * `expect(memoryB?.observations[0]?.sourceAgentInstanceId).toBe("tertiary-a")`
 * （注释原文「B 的观察保留原始来源与附件哈希」）⇒ 覆盖**直接且正确**。
 * 另注：该条目的 `testFiles` **由检索结果直接写入**（不手敲）。
 * **2026-11-08（第 121 轮）扩容：49 → 51**（全量复跑 **51/51 被拦下**）。新增两条都在
 * `scope-resolution.ts`（范围解析）：
 *  - `scope-dedicated-flow-relaxed`：专用流程（远端发布／备份删除）由 `ask-user` 放宽为 `allow`
 *    ⇒ 本模块替专用授权门放行（文件头明写「专用流程**不被本模块放宽**」）。
 *    实测被 `auth-scope-resolution.test.ts` 拦下 —— 该文件里是**直接断言**
 *    （放权 + 配置 allow 下 `S7-special-flow` 必须得到 `{ask-user, dedicated-flow}`）。
 *  - `scope-installation-switch-bypassed`：S5 安装类的「开关关闭 ⇒ 拒绝」永不触发。
 *    实测被 3 条用例拦下，含**直接点名**的「安装类：开关关闭一律拒绝（协同/放权相同）」。
 *
 * **⚠️ 本轮又被本脚本自己拦下一次（这次是"设计生效"）**：第二条的锚点
 * `if (!input.isInstallationEnabled) {` 在文件里**命中 2 次**（S5 与 S1+安装两条分支同形），
 * 脚本按"**恰好 1 次**"的规则**拒绝执行并报脚本错误**，而不是静默跳过 ⇒ 我随后把锚点
 * 扩成带 S5 分支头的**唯一片段**。**教训：锚点必须唯一，且脚本必须对重复命中报错。**
 * **2026-11-08（第 122 轮）扩容：51 → 52**（全量复跑 **52/52 被拦下**）。新增
 * `tertiary-delegated-expiry-never-narrowed`：把三级期限求交的三元真分支改成**请求值**
 * ⇒ 求交永不收紧，三级可拿到比次级**更长的有效期**（AGENTS.md：次级分发给三级的权限
 * 必须是其**当前有效权限的等于或更窄子集**）。实测被 **3 条用例**拦下，含
 * 「期限求交结果不晚于任一输入且取自输入之一」「三级权限逐项求交：三态/资源范围/期限均不得宽于次级」
 * ⇒ 覆盖直接，固化防回归。
 *
 * **⚠️ 同轮补强了我的探针工具（一次性工具，不入库）**：本轮我先写出过一次**仅空白差异**的替换
 *（原行与新行打印出来一模一样），语义上是**空操作**，却被当成"存活"（**假结果**）。
 * 已加守卫：**trim 后相同 ⇒ 拒绝运行**。
 * ⇒ **纪律再补一条：变异必须"真的改变语义"，只差空白不算变异。**
 * **2026-11-08（第 123 轮）扩容：52 → 53**（全量复跑 **53/53 被拦下**）。新增
 * `elevation-expiry-invalidation-disabled`：把会话提升的到期判定改成 `false &&`
 * ⇒ **到期永不生效**，已过期的提升继续放权（`AGENTS.md`：提升绑定**有效期**、可随时撤销）。
 * 实测被 `tests/core/unit/session-permission-elevation.test.ts` 的
 * 「到期/profile revision/目录版本变化/Agent 回收使覆盖失效」拦下 ⇒ 覆盖直接。
 *
 * **⚠️ 本轮探针工具又拦住我一次**：我先传错了行号（传的是原行本身）⇒ 新加的
 * 「**trim 后相同即拒绝运行**」守卫**当场拒绝**，我改对行号后才拿到真结论。
 * （也就是说：第 122 轮补的那条守卫，本轮立刻派上用场。）
 * **2026-11-08（第 124 轮）扩容：53 → 54**（全量复跑 **54/54 被拦下**）。新增
 * `elevation-individual-scope-always-applies`：把限定到**具体个体**的提升范围判定改成 `return true;`
 * ⇒ 该提升**泄漏到同级所有次级 Agent**（`AGENTS.md`：临时提升"默认作用于会话全部次级，
 * **也可显式限定具体次级**" ⇒ 个体覆盖不得外溢）。
 * 实测被 2 条**直接点名**的用例拦下：「个体提升不传播到其他次级 Agent（隔离）」、
 * 「会话级覆盖应用于全部现有及后续次级 Agent；个体覆盖隔离」⇒ 覆盖直接，固化防回归。
 * **2026-11-08（第 126 轮）扩容：54 → 55**（全量复跑 **55/55 被拦下**）。新增
 * `argument-fingerprint-ignores-values`：让参数规范化**只保留键名、丢掉值**
 * ⇒ 「同一路径、**内容不同**」也复用批准 —— **这正是 R1 修掉的历史缺陷本身**。
 * 实测被 **7 条用例**拦下，**两个方向都有直接断言**（内容变化 ⇒ 指纹不同；**键序变化 ⇒ 指纹相同**）。
 *
 * **⚠️ 本轮踩到一个新坑（写进纪律）**：该变异代码里含 `${…}`，我生成条目时用了**模板字符串**
 * ⇒ `${JSON.stringify(key)}` 在**加载时被当插值求值**（`key` 未定义）⇒ harness **崩溃**、`--only` 输出为空。
 * **改用单引号字符串**（不插值）后正常。
 * ⇒ **纪律：变异条目里若含 `${…}`，`find`/`replace` 必须用非插值写法（单引号串）。**
 * **2026-11-08（第 127 轮）扩容：55 → 56**（全量复跑 **56/56 被拦下**）。新增
 * `feedback-delivery-dedup-disabled`：去掉 `feedback-process/transport.ts` 里
 * 「该 `idempotencyKey` 已投递过 ⇒ 只回 ack、不再触发 handler」的判定
 * ⇒ 重复投递会**重复触发处理**（重复副作用）。
 * 实测被 `tests/core/unit/feedback-client.test.ts` 的
 * 「同 idempotencyKey 重复投递只调用 handler 一次并自动 ack」**直接点名**拦下。
 * 该条目 `testFiles` 用**较宽检索**（FeedbackClient 家族 + idempotencyKey，共 33 个文件），仍来自检索输出。
 * **2026-11-08（第 128 轮）扩容：56 → 57**（全量复跑 **57/57 被拦下**）。新增
 * `instruction-idempotency-conflict-overwrites`：去掉 `instruction-window-store.ts` 里
 * 「同键异参（同 `idempotencyKey`、内容哈希不同）→ **拒绝**、不覆盖」的判定
 * ⇒ 同键异参被当作新指令接纳，**既有用户指导可能被静默覆盖**。
 * 实测被 `tests/core/integration/instruction-window-persistence-branches.test.ts` 的
 * 「② 同键异参：必须拒绝，不得覆盖既有指令」**直接点名**拦下。
 *
 * **⚠️ 本轮改了一个"证据实践"顺序，并验证有效**：此前连续 3 轮出现
 * 「**紧接全量变异之后的那次门禁**失败」（安静机器复跑必过）。本轮改为
 * **先跑门禁、再跑全量变异** ⇒ 门禁 **exit 0（443 文件 / 3303 用例）**、变异 **57/57**。
 * ⇒ **建议固定顺序：先 `npm run check`，再 `npm run verify:mutation-kills`。**
 * **2026-11-08（第 133 轮）修复一条**永不匹配**的 find，并记下 Windows 教训**。
 * `comm01-orchestrator-skips-publisher-stamp` 原来是**跨文件多行** find；
 * 而 `mission-orchestrator.ts`（源）与 harness 的**行尾不同**（源 CRLF、harness LF）
 * ⇒ 多行 find **永不匹配**（全量跑报「锚点命中 0 次」，被 59/59 → 58/59 抓到）。
 * 我一度误判为"转义反引号写坏"，改成双引号 `\n` 拼接 —— **同样因行尾不匹配失败**。
 * ⇒ **纪律：跨文件多行锚点在 Windows 上必须避开（行尾不可控）；优先用唯一单行做 find/replace。**
 * 用法：
 *   node scripts/verify-mutation-kills.mjs            # 全部变异
 *   node scripts/verify-mutation-kills.mjs --json     # 机器可读
 *   node scripts/verify-mutation-kills.mjs --only <mutationIdentifier>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * 每个变异：
 *  - targetFile：被注入反事实的产品源文件（仓库相对路径）
 *  - find / replace：**精确**字符串替换（必须唯一命中，否则脚本报错而不是猜）
 *  - testFiles：要跑的用例文件
 *  - expectedFailingTestNames：**必须**出现在失败列表里的用例名片段
 *  - rationale：这条断言在拦什么（失败信息里会打印，便于人读懂）
 */
export const MUTATIONS = [
  {
    mutationIdentifier: "run-history-view-ignores-display-settings",
    targetFile: "packages/core/src/orchestration/run-history-view.ts",
    find: `  if (kind === "model-note") return settings.showProcessExplanations;
  if (kind === "tool-call" || kind === "tool-failure") return settings.showToolCalls;
  return true;`,
    replace: `  void kind;
  void settings;
  return true;`,
    testFiles: ["tests/core/unit/history01-run-history-view.test.ts"],
    expectedFailingTestNames: ["③ 关闭工具显示", "④ 过程说明"],
    rationale:
      "显示开关（showToolCalls / showProcessExplanations）若不再隐藏任何事件，就成了「开关摆设」" +
      "⇒ 卡内 §4「关闭只隐藏、不影响采集」的两条反例必须变红",
  },
  {
    mutationIdentifier: "run-history-view-ignores-cursor",
    targetFile: "packages/core/src/orchestration/run-history-view.ts",
    find: "const afterCursor = matched.filter((item) => item.sequenceNumber > cursor);",
    replace: "const afterCursor = matched.filter((item) => item.sequenceNumber > 0);",
    testFiles: ["tests/core/unit/history01-run-history-view.test.ts"],
    expectedFailingTestNames: ["② 游标分页"],
    rationale:
      "游标被忽略 ⇒ 第二页重复第一页（卡内 §5「不因新事件重复或漏页」失守）⇒ 游标分页反例必须变红",
  },
  {
    mutationIdentifier: "run-history-view-skips-display-sanitization",
    targetFile: "packages/core/src/orchestration/run-history-view.ts",
    find: "  const sanitized = sanitizeRunHistoryDisplayText(rawText);",
    replace: "  const sanitized = rawText;",
    testFiles: ["tests/core/unit/history01-run-history-view.test.ts"],
    expectedFailingTestNames: ["⑦ 长详情截断"],
    rationale:
      "不脱敏就把 ANSI/控制序列交给终端（卡内 §4「按不可信输入安全渲染」）" +
      "⇒ 非法 JSON payload 的脱敏反例必须变红",
  },
  {
    mutationIdentifier: "relocate-reconciler-malformed-observation-passes",
    targetFile: "packages/core/src/orchestration/project-relocation-reconciler.ts",
    find: "  if (malformedPendingOperations.length > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/relocate01-reconciler.test.ts"],
    expectedFailingTestNames: ["⑨ 未决操作观测残缺"],
    rationale:
      "观测残缺的未决操作直接放行 ⇒ 既可能抛错中断批量对账、也可能在未知状态下继续执行（卡内：未知状态不放行）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-overview-accepts-invalid-budget",
    targetFile: "packages/tui/src/cli/commands.ts",
    find: "    (!/^\\d+$/.test(String(options.inputTokenBudget ?? \"\").trim()) || parsedBudget < 0)",
    replace: "  if (false) {",
    testFiles: ["tests/architecture/cli-numeric-option-guards.test.ts"],
    expectedFailingTestNames: ["⑤ commands.ts"],
    rationale:
      "放行 NaN/负预算 ⇒ 预算语义失效（可能把全部调用判为超预算）⇒ 该守卫必须变红",
  },
  {
    mutationIdentifier: "mission-history-trusts-recorded-running",
    targetFile: "packages/core/src/gui/mission-history-reader.ts",
    find: "    runtimeState = isActivelyRunning ? \"running\" : \"interrupted-needs-reconciliation\";",
    replace: "    runtimeState = \"running\";",
    testFiles: ["tests/core/unit/gui-mission-history-reader.test.ts"],
    expectedFailingTestNames: ["③ 历史状态 vs 运行状态"],
    rationale:
      "只要磁盘写 running 就报运行中 ⇒ 重启后的僵尸任务被当成在跑（用户会等一个不存在的任务）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "strict-integer-helper-truncates",
    targetFile: "packages/tui/src/cli/strict-integer-option.ts",
    find: "  if (!/^\\d+$/.test(trimmedValue)) {",
    replace: "  if (Number.isNaN(Number.parseInt(trimmedValue, 10))) {",
    testFiles: ["tests/tui/unit/strict-integer-option.test.ts"],
    expectedFailingTestNames: ["③ parseInt 会截断的垃圾输入必须拒绝"],
    rationale:
      "退回 parseInt 宽容截断 ⇒ \"5abc\" 变 5（预算/页码/超时都被静默改小）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-cost-benefit-accepts-thin-samples",
    targetFile: "packages/core/src/orchestration/workflow-fold-cost-benefit.ts",
    find: "  if (baselineKnownRuns.length < 3 || foldedKnownRuns.length < 3) {",
    replace: "  if (baselineKnownRuns.length < 1 || foldedKnownRuns.length < 1) {",
    testFiles: ["tests/core/unit/fold01-cost-benefit.test.ts"],
    expectedFailingTestNames: ["① 任一侧有效样本"],
    rationale:
      "一次运行就能宣称收益 ⇒ 用单次样本当结论（卡内要求实测范围与局限）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-cost-benefit-ignores-failures",
    targetFile: "packages/core/src/orchestration/workflow-fold-cost-benefit.ts",
    find: "  if (foldedFailureCount > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/fold01-cost-benefit.test.ts"],
    expectedFailingTestNames: ["② 折叠侧存在失败"],
    rationale:
      "有失败运行仍宣称收益 ⇒ 把带回归的方案当成净收益（会误导推广）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "rotate-trigger-ignores-user-task",
    targetFile: "packages/core/src/orchestration/observability-rotate-trigger.ts",
    find: "  if (input.isUserTaskActive) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-rotate-trigger.test.ts"],
    expectedFailingTestNames: ["② 用户任务进行中"],
    rationale:
      "用户任务进行中也自动整理 ⇒ 正常任务被观测整理抢占（卡内\"正常用户任务优先\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "rotate-trigger-guesses-unknown-storage",
    targetFile: "packages/core/src/orchestration/observability-rotate-trigger.ts",
    find: "  if (input.storageBytesUsed === null) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-rotate-trigger.test.ts"],
    expectedFailingTestNames: ["③ 存储占用未知"],
    rationale:
      "占用未知也判预算 ⇒ 拿未知当零（或当超预算）触发整理，与\"不猜余额\"相悖 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm-topology-delivers-orphans",
    targetFile: "packages/core/src/orchestration/collaboration-topology-view.ts",
    find: "      isDeliverable: !isOrphaned && !isInCycle && isParentUsable && agent.isActive,",
    replace: "      isDeliverable: true,",
    testFiles: ["tests/core/unit/comm01-topology-view.test.ts"],
    expectedFailingTestNames: ["② 无上级"],
    rationale:
      "无上级/环内/停用者也被标为可投递 ⇒ 消息会投到不存在的收件人（或互相当上级）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm-topology-hides-lost-trace",
    targetFile: "packages/core/src/orchestration/collaboration-topology-view.ts",
    find: "      isTraceLost: delivery.isRelayedRequest && delivery.originalSourceAgentInstanceIdentifier === null,",
    replace: "      isTraceLost: false,",
    testFiles: ["tests/core/unit/comm01-topology-view.test.ts"],
    expectedFailingTestNames: ["⑥ 转达请求缺原来源"],
    rationale:
      "转达丢失原来源却不标记 ⇒ 追溯链断了却看起来正常（无法回答\"这条指令从哪来\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-review-port-never-called",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: "    if (this.options.lessonReviewPort !== undefined) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/integration/lesson01-receive-review-wiring.test.ts"],
    expectedFailingTestNames: ["② 审查端口携带真实结局"],
    rationale:
      "审查节点从不被调用 ⇒ 推广永远不发生（接线形同虚设）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-review-miscounts-outcome",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: '          outcome: outcome.outcome === "success" ? "success" : outcome.outcome === "ambiguous" ? "ambiguous" : "failure",',
    replace: '          outcome: "success",',
    testFiles: ["tests/core/integration/lesson01-receive-review-wiring.test.ts"],
    expectedFailingTestNames: ["③ 审查端口看到 failure"],
    rationale:
      "失败结局被报成 success ⇒ 审查把失败教训当成功推广（污染记忆）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-dispatch-port-never-called",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: "    if (this.options.lessonDispatchPort !== undefined) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/integration/lesson01-dispatch-wiring.test.ts"],
    expectedFailingTestNames: ["① 端口被调用"],
    rationale:
      "分派节点从不调用投递端口 ⇒ 教训永远到不了任务（接线形同虚设）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-dispatch-failure-blocks-dispatch",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: "      } catch {\n        // 建议性投递失败：不影响派发（也不静默改变行为）\n      }",
    replace: "      } catch (error) {\n        throw error;\n      }",
    testFiles: ["tests/core/integration/lesson01-dispatch-wiring.test.ts"],
    expectedFailingTestNames: ["③ 端口抛错"],
    rationale:
      "投递失败阻塞派发 ⇒ 教训存储问题导致任务跑不起来（建议性数据变成单点故障）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-binding-load-race",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: "    await this.loadPromise;",
    replace: "    void this.loadPromise;",
    testFiles: ["tests/core/unit/comm02-concurrent-binding.test.ts"],
    expectedFailingTestNames: ["① 并发登记 10 个个体"],
    rationale:
      "加载未完成就放行读者 ⇒ 并发读回空登记表（实测 9/10 为 null）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-binding-recycle-noop",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: "    record.recycledAtIso = this.nowIso();",
    replace: "    record.recycledAtIso = null;",
    testFiles: ["tests/core/unit/comm02-concurrent-binding.test.ts"],
    expectedFailingTestNames: ["④ 回收后重启"],
    rationale:
      "回收标记不落盘 ⇒ 已回收个体重启后又变成可投递地址（复活）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "onboarding-ignores-never-show-again",
    targetFile: "packages/core/src/orchestration/onboarding-hint-contract.ts",
    find: "  if (input.state.isNeverShowAgain) {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/onboarding-status-command.test.ts"],
    expectedFailingTestNames: ["③「不再提示」持久化生效"],
    rationale:
      "「不再提示」被忽略 ⇒ 用户已拒绝仍反复弹（卡内硬要求持久化生效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "onboarding-ignores-typing",
    targetFile: "packages/core/src/orchestration/onboarding-hint-contract.ts",
    find: "  if (input.context.isUserTyping) {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/onboarding-status-command.test.ts"],
    expectedFailingTestNames: ["② 用户输入中"],
    rationale:
      "用户输入中也提示 ⇒ 抢焦点、打断输入 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-status-accepts-invalid-habit",
    targetFile: "packages/tui/src/cli/secretary-command.ts",
    find: "  if (!(SECRETARY_HABITS as ReadonlyArray<string>).includes(habit)) {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/secretary-status-command.test.ts"],
    expectedFailingTestNames: ["③ 非法 habit"],
    rationale:
      "非法 habit 被接受 ⇒ 命令按错误习惯静默执行（fail-open）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-status-accepts-out-of-range-minute",
    targetFile: "packages/tui/src/cli/secretary-command.ts",
    find: "  if (!Number.isFinite(options.minuteOfDay) || options.minuteOfDay < 0 || options.minuteOfDay > 1440) {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/secretary-status-command.test.ts"],
    expectedFailingTestNames: ["⑤ 非法 minute-of-day"],
    rationale:
      "越界分钟数被接受 ⇒ 时段判定输入错误却静默执行（fail-open）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-transport-writes-before-check",
    targetFile: "packages/core/src/orchestration/cross-project-transport.ts",
    find: "  if (decision.kind === \"rejected\") {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/comm02-transport.test.ts"],
    expectedFailingTestNames: ["② 无授权"],
    rationale:
      "判定被拒也照样落盘 ⇒ 未授权/写动作消息进入目标 mailbox（越权 + 脏数据）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-transport-no-dedupe",
    targetFile: "packages/core/src/orchestration/cross-project-transport.ts",
    find: "  if (existing !== undefined) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/comm02-transport.test.ts"],
    expectedFailingTestNames: ["④ 同 idempotencyKey"],
    rationale:
      "同幂等键重复入池 ⇒ 目标重复收到同一请求（重复投递）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "smart01-menu-hides-timeout",
    targetFile: "packages/core/src/orchestration/instruction-window-menu.ts",
    find: "  if (input.state.timedOutInstructionCount > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/smart01-instruction-menu.test.ts"],
    expectedFailingTestNames: ["④ 有超时"],
    rationale:
      "悄悄隐藏超时条数 ⇒ 用户以为全部达标（卡内要求逐条超时状态如实揭示）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "smart01-batch-submit-ignores-backlog",
    targetFile: "packages/core/src/orchestration/instruction-window-menu.ts",
    find: "      isEnabled: input.state.pendingInstructionCount > 0 && !input.state.isQueueBacklogged,",
    replace: "      isEnabled: input.state.pendingInstructionCount > 0,",
    testFiles: ["tests/core/unit/smart01-instruction-menu.test.ts"],
    expectedFailingTestNames: ["⑤ 积压"],
    rationale:
      "窗口已满还允许批量提交 ⇒ 越窗提交、背压失效（卡内：满且不能合法释放时不越窗）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-relay-hop-unbounded",
    targetFile: "packages/core/src/orchestration/collaboration-relay-chain.ts",
    find: "    hopCount: input.relayChain?.hopCount ?? 0,",
    replace: "    hopCount: 0,",
    testFiles: ["tests/core/unit/comm02-relay-chain.test.ts"],
    expectedFailingTestNames: ["② 已达上限"],
    rationale:
      "忽略已用跳数 ⇒ 转达可以无限继续（卡内要求有限跳数）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-relay-cycle-ignored",
    targetFile: "packages/core/src/orchestration/collaboration-relay-chain.ts",
    find: "  if (visited.includes(input.targetAgentInstanceId)) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/comm02-relay-chain.test.ts"],
    expectedFailingTestNames: ["③ 环"],
    rationale:
      "不做环检测 ⇒ A→B→A 无限互转（卡内点名关联链循环检测）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-self-approval-allowed",
    targetFile: "packages/core/src/orchestration/cross-project-collaboration.ts",
    find: "    input.grantor.agentInstanceId === input.requestingAgentInstanceId",
    replace: "    false",
    testFiles: ["tests/core/unit/comm02-cross-project.test.ts"],
    expectedFailingTestNames: ["② **请求方不能自批**"],
    rationale:
      "允许请求方自批目标项目授权 ⇒ 越权（跨项目连接必须由目标项目或用户批准）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-write-action-allowed",
    targetFile: "packages/core/src/orchestration/cross-project-collaboration.ts",
    find: "  if (envelope.intendedAction !== \"read\") {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/comm02-cross-project.test.ts"],
    expectedFailingTestNames: ["⑯ 跨项目写动作"],
    rationale:
      "跨项目允许写动作 ⇒ 外来 Agent 可直接改目标项目（卡内明令只读）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-stale-revision-allowed",
    targetFile: "packages/core/src/orchestration/cross-project-collaboration.ts",
    find: "  if (envelope.authorizationRevision !== authorization.revision) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/comm02-cross-project.test.ts"],
    expectedFailingTestNames: ["⑪ 旧/新 revision 不匹配"],
    rationale:
      "旧 revision 消息照常投递 ⇒ 撤销/变更后的在途消息落进新任务 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm-journal-no-serialization",
    targetFile: "packages/core/src/feedback-process/mailbox-journal.ts",
    find: "    const result = this.operationQueue.then(operation, operation);",
    replace: "    const result = operation();",
    testFiles: ["tests/core/unit/comm03-journal-concurrency.test.ts"],
    expectedFailingTestNames: ["① 并发入池 3 条"],
    rationale:
      "读改写不串行化 ⇒ 并发入池只落盘 1 条（丢消息；COMM-01-03 多实例验收实测复现）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm-journal-ack-keeps-message",
    targetFile: "packages/core/src/feedback-process/mailbox-journal.ts",
    find: "    document.messages = remainingMessages;",
    replace: "    document.messages = document.messages;",
    testFiles: ["tests/core/unit/comm03-journal-concurrency.test.ts"],
    expectedFailingTestNames: ["③ ack 与投递标记并发"],
    rationale:
      "ack 不真正移除消息 ⇒ 已确认消息会被重放（重复投递）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "guide02-superseded-still-applies",
    targetFile: "packages/core/src/runtime-guidance/guidance-control-queue.ts",
    find: "        this.pending.delete(supersededKey);",
    replace: "        void supersededKey;",
    testFiles: ["tests/core/unit/guide02-safe-point.test.ts"],
    expectedFailingTestNames: ["⑥ 更高 revision 取代旧条"],
    rationale:
      "被取代的旧修订仍留在待应用队列 ⇒ 安全点同时套用 r1 与 r2（互相矛盾的指导）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "guide02-report-wakes-main-agent",
    targetFile: "packages/core/src/runtime-guidance/guidance-control-queue.ts",
    find: "      shouldWakeMainAgent: false,",
    replace: "      shouldWakeMainAgent: true as unknown as false,",
    testFiles: ["tests/core/unit/guide02-safe-point.test.ts"],
    expectedFailingTestNames: ["④ 普通报告"],
    rationale:
      "普通报告唤醒主 Agent ⇒ 打断主对话（卡内：普通报告不唤醒主 Agent）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "diag02-page-ignores-pagesize",
    targetFile: "packages/core/src/orchestration/diagnostic-event-store.ts",
    find: "  const pageSize = Math.max(1, Math.floor(query.pageSize ?? 20));",
    replace: "  const pageSize = 1_000;",
    testFiles: ["tests/core/unit/diag02-summary-paging.test.ts"],
    expectedFailingTestNames: ["① pageSize 生效"],
    rationale:
      "分页忽略 pageSize ⇒ 一次返回全部分组（大库直接把响应撑爆，卡内点名分页）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "diag02-matched-ignores-agent-scope",
    targetFile: "packages/core/src/orchestration/diagnostic-event-store.ts",
    find: "    event.sourceAgentInstanceId !== query.sourceAgentInstanceId",
    replace: "    false",
    testFiles: ["tests/core/unit/diag02-summary-paging.test.ts"],
    expectedFailingTestNames: ["④ 个体过滤"],
    rationale:
      "忽略个体可见范围 ⇒ 子 Agent 能借诊断读到同级原始记录（卡内明令不得）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-entry-confirmed-is-blocking",
    targetFile: "packages/core/src/orchestration/project-relocation-entry-prompt.ts",
    find: "  if (outcome.classification === \"identity-confirmed\") {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/relocate01-entry-prompt.test.ts"],
    expectedFailingTestNames: ["① 身份一致"],
    rationale:
      "身份一致也按阻断处理 ⇒ 正常项目每次进入都被拦（提示失真）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-status-failed-as-delivered",
    targetFile: "packages/core/src/orchestration/collaboration-status.ts",
    find: "    case \"failed\":",
    replace: "    case \"failed\": return \"delivered\";",
    testFiles: ["tests/tui/unit/collaboration-status-command.test.ts"],
    expectedFailingTestNames: ["① 输出 Agent 归属"],
    rationale:
      "失败消息显示成已投递 ⇒ 用户以为送达（卡内要求 dropped 如实计数）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-status-empty-claims-present",
    targetFile: "packages/core/src/orchestration/collaboration-status.ts",
    find: "        ? \"没有登记 Agent、也没有收件箱文件（空 ≠ 不存在，可能是尚未运行）。\"",
    replace: "        ? \"没有数据。\"",
    testFiles: ["tests/tui/unit/collaboration-status-command.test.ts"],
    expectedFailingTestNames: ["② 空状态"],
    rationale:
      "空状态写成“没有数据” ⇒ 掩盖“空 ≠ 不存在”（用户口径）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-delivery-skips-persist",
    targetFile: "packages/core/src/orchestration/collaboration-inbox-delivery.ts",
    find: "      await this.store.save(input.recipientAgentInstanceId, {",
    replace: "      if (false) await this.store.save(input.recipientAgentInstanceId, {",
    testFiles: ["tests/core/integration/comm02-inbox-feedback-process.test.ts"],
    expectedFailingTestNames: ["① 真实进程可用"],
    rationale:
      "投递后不落盘 ⇒ 重启后状态回退成 received，消息被重复发送 ⇒ 该集成反例必须变红",
  },
  {
    mutationIdentifier: "comm02-mapping-drops-recipient-prefix",
    targetFile: "packages/core/src/orchestration/collaboration-feedback-mapping.ts",
    find: "  return COLLABORATION_RECIPIENT_PREFIX + agentInstanceId;",
    replace: "  return agentInstanceId;",
    testFiles: ["tests/core/unit/comm02-inbox-outbox-mapping.test.ts"],
    expectedFailingTestNames: ["② 收件人前缀"],
    rationale:
      "去掉 agent: 前缀 ⇒ 与其它信箱命名冲突（用户决定 b）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-feedback-transport-marks-failure-delivered",
    targetFile: "packages/core/src/orchestration/collaboration-feedback-transport.ts",
    find: "        isDelivered: false,",
    replace: "        isDelivered: true,",
    testFiles: ["tests/core/unit/comm02-inbox-outbox-mapping.test.ts"],
    expectedFailingTestNames: ["③ 反馈进程可用"],
    rationale:
      "反馈进程不可用也标投递 ⇒ 消息丢失且不重试 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-deliver-cli-no-inbox-exit-zero",
    targetFile: "packages/tui/src/cli/inbox-command.ts",
    find: "    report.outcome === \"no-inbox\" ||",
    replace: "    false ||",
    testFiles: ["tests/core/unit/comm02-inbox-outbox-mapping.test.ts"],
    expectedFailingTestNames: ["⑤ 收件箱不存在"],
    rationale:
      "收件箱不存在也返回 0 ⇒ 调用方误以为已投递（空 ≠ 无消息）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-delivery-ignores-transport-result",
    targetFile: "packages/core/src/orchestration/collaboration-inbox-delivery.ts",
    find: "      if (result.isDelivered) {",
    replace: "      if (true) {",
    testFiles: ["tests/core/unit/comm02-inbox-delivery.test.ts"],
    expectedFailingTestNames: ["② 失败"],
    rationale:
      "传输失败也当成功 ⇒ 消息丢失且不重试（卡内要求有限重试）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-delivery-sends-stale-epoch",
    targetFile: "packages/core/src/orchestration/collaboration-inbox-delivery.ts",
    find: "        input.currentAuthorizationEpoch !== undefined &&",
    replace: "        false &&",
    testFiles: ["tests/core/unit/comm02-inbox-delivery.test.ts"],
    expectedFailingTestNames: ["④ 授权代已变"],
    rationale:
      "授权变更后仍投递 ⇒ 旧消息落入新任务（卡内明确禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-delivery-swallows-conflict",
    targetFile: "packages/core/src/orchestration/collaboration-inbox-delivery.ts",
    find: "      if (error instanceof CollaborationInboxRevisionConflictError) {",
    replace: "      if (false) {",
    testFiles: ["tests/core/unit/comm02-inbox-delivery.test.ts"],
    expectedFailingTestNames: ["⑤ 落盘 revision 冲突"],
    rationale:
      "冲突被当普通错误抛出 ⇒ 上层看不清是并发写冲突（可能误重试）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-store-ignores-revision",
    targetFile: "packages/core/src/orchestration/collaboration-inbox-store.ts",
    find: "    if (input.expectedRevision !== currentRevision) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/comm02-inbox-store.test.ts"],
    expectedFailingTestNames: ["② 陈旧 revision"],
    rationale:
      "忽略 revision ⇒ 并发写入互相覆盖（丢消息）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-store-absent-fabricates-valid",
    targetFile: "packages/core/src/orchestration/collaboration-inbox-store.ts",
    find: "    if (recovery === null) return { kind: \"absent\" };",
    replace: "    if (recovery === null) return { kind: \"valid\", snapshot: { schemaVersion: 1, recipientAgentInstanceId, revision: 1, updatedAtIso: \"\", messages: [] }, recoveredFromBackup: false };",
    testFiles: ["tests/core/unit/comm02-inbox-store.test.ts"],
    expectedFailingTestNames: ["③ 未保存过的收件人"],
    rationale:
      "未保存过却伪造合法快照 ⇒ 「空 ≠ 无消息」被破坏，用户以为收件箱为空 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-cli-absent-fabricates-presence",
    targetFile: "packages/tui/src/cli/inbox-command.ts",
    find: "        isPresent: false,",
    replace: "        isPresent: true,",
    testFiles: ["tests/tui/unit/inbox-list-command.test.ts"],
    expectedFailingTestNames: ["② 未保存过"],
    rationale:
      "未保存过却报告存在 ⇒ 用户误以为收件箱为空（空 ≠ 无消息）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-cli-corrupt-as-empty",
    targetFile: "packages/tui/src/cli/inbox-command.ts",
    find: "    return 2;",
    replace: "    return 0;",
    testFiles: ["tests/tui/unit/inbox-list-command.test.ts"],
    expectedFailingTestNames: ["③ 损坏文件"],
    rationale:
      "损坏当空 ⇒ 用户以为没有消息（掩盖损坏）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-duplicate-reinserts",
    targetFile: "packages/core/src/orchestration/collaboration-inbox.ts",
    find: "    if (existing !== undefined) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/comm02-inbox.test.ts"],
    expectedFailingTestNames: ["② 重复投递复用回执"],
    rationale:
      "重复投递再插一条 ⇒ 同一任务被重复执行（卡内明确禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-backpressure-drops",
    targetFile: "packages/core/src/orchestration/collaboration-inbox.ts",
    find: "    if (pendingCount >= this.maximumPendingPerRecipient) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/comm02-inbox.test.ts"],
    expectedFailingTestNames: ["③ 每收件人背压"],
    rationale:
      "背压失效 ⇒ 忙碌收件人被无限堆积（卡内要求每收件人背压）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "comm02-inbox-stale-epoch-delivers",
    targetFile: "packages/core/src/orchestration/collaboration-inbox.ts",
    find: "    if (\n      options.currentAuthorizationEpoch !== undefined &&\n      options.currentAuthorizationEpoch !== message.authorizationEpoch\n    ) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/comm02-inbox.test.ts"],
    expectedFailingTestNames: ["⑥ 授权撤销后"],
    rationale:
      "授权撤销后仍在途投递 ⇒ 旧消息落入新任务（卡内明确禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-journal-ignores-revision",
    targetFile: "packages/core/src/orchestration/event-incident-journal.ts",
    find: "    if (input.expectedRevision !== currentRevision) {",
    replace: "    if (false) {",
    testFiles: ["tests/tui/unit/event-status-command.test.ts"],
    expectedFailingTestNames: ["② 陈旧 revision 被拒"],
    rationale:
      "忽略 revision ⇒ 并发写覆盖事故状态（崩溃重放失真）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-status-absent-claims-present",
    targetFile: "packages/tui/src/cli/event-command.ts",
    find: "isPresent: false",
    replace: "isPresent: true",
    testFiles: ["tests/tui/unit/event-status-command.test.ts"],
    expectedFailingTestNames: ["④ 无记录"],
    rationale:
      "无记录却报存在 ⇒ 「空 ≠ 无事件」被破坏（用户会被误导）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-control-low-severity-blocks",
    targetFile: "packages/core/src/orchestration/event-control-channel.ts",
    find: "          (incident.severity === \"high\" || incident.severity === \"critical\"),",
    replace: "          true,",
    testFiles: ["tests/core/integration/event01-control-loop-gate.test.ts"],
    expectedFailingTestNames: ["③ 低严重度事故只记录"],
    rationale:
      "低严重度也阻断 ⇒ 普通工具错误把整轮停死（过度拦截）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-control-model-gate-ignores-incident",
    targetFile: "packages/core/src/orchestration/event-control-channel.ts",
    find: "    if (blocking.length === 0) {",
    replace: "    if (true) {",
    testFiles: ["tests/core/unit/event01-control-channel.test.ts"],
    expectedFailingTestNames: ["② 收到事件 ≠ 已停止"],
    rationale:
      "有事故仍放行模型调用 ⇒ 控制通道形同虚设（收到事件必须立即隔离）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-control-cancel-claims-stopped",
    targetFile: "packages/core/src/orchestration/event-control-channel.ts",
    find: "      reason: \"已发出取消请求；**取消请求 ≠ 已停止**，须确认在途副作用。\",",
    replace: "      reason: \"已停止。\",",
    testFiles: ["tests/core/unit/event01-control-channel.test.ts"],
    expectedFailingTestNames: ["④ 取消结果按能力如实回报"],
    rationale:
      "把取消请求说成已停止 ⇒ 用户误以为副作用已收敛（卡内明确禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-control-confirm-skips-user",
    targetFile: "packages/core/src/orchestration/event-control-channel.ts",
    find: "    if (!input.userConfirmed) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/event01-control-channel.test.ts"],
    expectedFailingTestNames: ["⑤ 在途副作用必须用户确认"],
    rationale:
      "跳过用户确认 ⇒ 在途副作用被自动继续（不代替专用授权）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-control-replay-drops-incidents",
    targetFile: "packages/core/src/orchestration/event-control-channel.ts",
    find: "    channel.arbitrator.restoreIncidents(input.snapshot.incidents);",
    replace: "    void input.snapshot.incidents;",
    testFiles: ["tests/core/unit/event01-control-channel.test.ts"],
    expectedFailingTestNames: ["⑥ 崩溃重放"],
    rationale:
      "崩溃后不恢复事故 ⇒ 重启即放行（暂停被当成解除）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-single-owner-allows-second",
    targetFile: "packages/core/src/orchestration/event-incident-arbitration.ts",
    find: "    if (incident.ownerAgentInstanceId !== null) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/event01-incident-arbitration.test.ts"],
    expectedFailingTestNames: ["① single-owner"],
    rationale:
      "允许第二个所有者 ⇒ 同一资源被并行处理（卡内要求单一所有者）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-stale-epoch-accepted",
    targetFile: "packages/core/src/orchestration/event-incident-arbitration.ts",
    find: "    if (!Number.isSafeInteger(epoch) || epoch < incident.epoch) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/event01-incident-arbitration.test.ts"],
    expectedFailingTestNames: ["② old-epoch-rejected"],
    rationale:
      "旧 epoch 也被接受 ⇒ 过期执行者仍能提交（fencing 失效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-storm-always-preempts",
    targetFile: "packages/core/src/orchestration/event-incident-arbitration.ts",
    find: "      if (rank(severity) > rank(existing.severity)) {",
    replace: "      if (true) {",
    testFiles: ["tests/core/unit/event01-incident-arbitration.test.ts"],
    expectedFailingTestNames: ["③ storm-no-ping-pong"],
    rationale:
      "同级重复也抢占 ⇒ 风暴期间来回切换所有者（乒乓）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-criteria-accepts-empty-sources",
    targetFile: "packages/core/src/orchestration/event-acceptance-criteria.ts",
    find: "  if (eventSources === null || eventSources.filter((source) => source.trim() !== \"\").length === 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/event01-acceptance-criteria.test.ts"],
    expectedFailingTestNames: ["③ 空事件源清单"],
    rationale:
      "空事件源也算完整 ⇒ 没有事件源也能“验收通过”（口径形同虚设）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "event01-criteria-accepts-bad-deadline",
    targetFile: "packages/core/src/orchestration/event-acceptance-criteria.ts",
    find: "  } else if (!Number.isFinite(deadline) || deadline <= 0) {",
    replace: "  } else if (false) {",
    testFiles: ["tests/core/unit/event01-acceptance-criteria.test.ts"],
    expectedFailingTestNames: ["④ 响应期限非正数"],
    rationale:
      "0/负数期限也算完整 ⇒ 响应期限失去意义（永远“未超时”）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum02-annotation-accepts-model",
    targetFile: "packages/core/src/summarization/summary-annotation-evaluation.ts",
    find: "    if (sample.annotatorKind !== \"human\") {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/sum02-annotation-evaluation.test.ts"],
    expectedFailingTestNames: ["② 出现模型标注"],
    rationale:
      "把模型自评当人工标注计入 ⇒ 摘要质量可被自评“通过”（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum02-annotation-recall-counts-misattributed",
    targetFile: "packages/core/src/summarization/summary-annotation-evaluation.ts",
    find: "  const recallNumerator = labelCounts.supported + labelCounts[\"partially-supported\"];",
    replace: "  const recallNumerator =\n    labelCounts.supported + labelCounts[\"partially-supported\"] + labelCounts.misattributed;",
    testFiles: ["tests/core/unit/sum02-annotation-evaluation.test.ts"],
    expectedFailingTestNames: ["⑧ 误归因不计入 recall"],
    rationale:
      "错误归因也算“部分支持” ⇒ 质量被虚报（引用存在≠语义正确）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum02-estimate-claims-precision",
    targetFile: "packages/core/src/summarization/summary-token-budget.ts",
    find: "    isConservativeUpperBound: true,",
    replace: "    isConservativeUpperBound: false as unknown as true,",
    testFiles: ["tests/core/unit/sum02-token-budget.test.ts"],
    expectedFailingTestNames: ["② 无 tokenizer"],
    rationale:
      "把估算说成非保守/精确 ⇒ 用户按它算预算（虚报精度，卡内明令「无统一 token 准确性声明」）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum02-selection-trims-records",
    targetFile: "packages/core/src/summarization/summary-token-budget.ts",
    find: "    if (used + entry.measurement.tokenCount > availableInput) break;",
    replace: "    if (used + entry.measurement.tokenCount > availableInput) {\n      selectedRecords.push({ ...entry.record, text: entry.record.text.slice(0, Math.max(1, availableInput * 2)) });\n      continue;\n    }",
    testFiles: ["tests/core/unit/sum02-token-budget.test.ts"],
    expectedFailingTestNames: ["⑦ 放不下"],
    rationale:
      "把放不下的记录截断后塞进去 ⇒ 存档摘要被裁剪（卡内：只分页/调整选入，不裁剪存档）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum02-switch-rewrites-history",
    targetFile: "packages/core/src/summarization/summary-token-budget.ts",
    find: "    previous.source.modelIdentifier !== next.source.modelIdentifier ||\n    previous.tokenCount !== next.tokenCount;",
    replace: "    true;",
    testFiles: ["tests/core/unit/sum02-token-budget.test.ts"],
    expectedFailingTestNames: ["⑭ 同一模型重复计量"],
    rationale:
      "同一模型也报「已重新计量」⇒ 每次都重写历史/重算（卡内：换模型不重写历史，只重算本轮）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-startup-blocks-project-chat",
    targetFile: "packages/core/src/orchestration/secretary-policy.ts",
    find: "  if (!input.isProjectConversationBusy) {",
    replace: "  if (true) {",
    testFiles: ["tests/core/unit/secretary01-policy.test.ts"],
    expectedFailingTestNames: ["① 项目对话忙碌"],
    rationale:
      "忙碌时也启动整理 ⇒ 秘书阻塞项目对话（卡内点名\"秘书启动不阻塞项目对话\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-report-without-evidence",
    targetFile: "packages/core/src/orchestration/secretary-policy.ts",
    find: '  if (evidence.length === 0) {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/secretary01-policy.test.ts"],
    expectedFailingTestNames: ["⑦ 报告条目必须有证据引用"],
    rationale:
      "无证据也出具条目 ⇒ 秘书结论不可追溯（自述替代证据）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "onboarding-entry-implies-authorization",
    targetFile: "packages/core/src/orchestration/secretary-policy.ts",
    find: '  return { kind: "show", surface: input.surface, doesStealFocus: false, impliesAuthorization: false };',
    replace: '  return { kind: "show", surface: input.surface, doesStealFocus: true as unknown as false, impliesAuthorization: false };',
    testFiles: ["tests/core/unit/secretary01-policy.test.ts"],
    expectedFailingTestNames: ["⑪ 两个界面都能展示入口"],
    rationale:
      "入口抢焦点 ⇒ 打断用户当前输入/授权裁决（卡内点名\"不抢焦点\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "accuracy-forged-hash-crashes",
    targetFile: "packages/core/src/orchestration/task-accuracy-verifier.ts",
    find: "        (typeof evidence.contentHash !== \"string\" || evidence.contentHash.trim() === \"\")",
    replace: "        (evidence.contentHash === null || evidence.contentHash.trim() === \"\")",
    testFiles: ["tests/core/unit/accuracy01-verifier-hardening.test.ts"],
    expectedFailingTestNames: ["② 漏传 contentHash"],
    rationale:
      "漏传 contentHash 直接 TypeError 崩溃 ⇒ 畸形声明把验收器打断（而不是如实拒绝）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "accuracy-idempotent-replay-disabled",
    targetFile: "packages/core/src/orchestration/task-accuracy-verifier.ts",
    find: "    const processed =\n      (await this.ports.findProcessedAttempt?.(declaration.completionAttemptId)) ??\n      null;",
    replace: "    const processed = null;",
    testFiles: ["tests/core/unit/accuracy01-verifier-hardening.test.ts"],
    expectedFailingTestNames: ["⑤ 幂等签收"],
    rationale:
      "关掉幂等复用 ⇒ 同一完成声明重复派发（重复副作用，卡内点名重复派发）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-budget-ignores-inflight-reservations",
    targetFile: "packages/core/src/orchestration/usage-budget-reservation.ts",
    find: "  if (view.settledInputTokenCount + view.reservedInputTokenCount + input.estimatedInputTokenCount > input.policy.inputTokenLimit) {",
    replace: "  if (view.settledInputTokenCount + input.estimatedInputTokenCount > input.policy.inputTokenLimit) {",
    testFiles: ["tests/core/unit/usage02-budget-reservation.test.ts"],
    expectedFailingTestNames: ["⑤ 并发预算"],
    rationale:
      "并发预留不累计 ⇒ 多个在途调用一起超预算（卡内点名并发预算）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-budget-releases-unknown-usage",
    targetFile: "packages/core/src/orchestration/usage-budget-reservation.ts",
    find: "  if (!input.isUsageKnown) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/usage02-budget-reservation.test.ts"],
    expectedFailingTestNames: ["⑧ 取消且缺 usage"],
    rationale:
      "未知用量当 0 释放 ⇒ 取消后预算虚增剩余（虚报未超预算）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-budget-switch-clears-old-model",
    targetFile: "packages/core/src/orchestration/usage-budget-reservation.ts",
    find: '      : input.state.reservations.filter(\n          (reservation) => reservation.modelIdentifier === input.modelIdentifier,\n        );',
    replace: "      : input.state.reservations;",
    testFiles: ["tests/core/unit/usage02-budget-reservation.test.ts"],
    expectedFailingTestNames: ["⑩ 跨模型切换"],
    rationale:
      "按模型过滤失效 ⇒ 切换后旧模型预留被算进新模型（跨模型混账）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-model-gate-ignored",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: '      if (modelGateDecision.kind === "deny") {',
    replace: "      if (false) {",
    testFiles: ["tests/core/integration/workwindow01-model-gate.test.ts"],
    expectedFailingTestNames: ["① 门禁拒绝"],
    rationale:
      "模型门禁拒绝仍请求模型 ⇒ 休息期间照烧 token（卡内点名）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-model-gate-not-asked",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: "    if (options.workWindowGate !== undefined) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/integration/workwindow01-model-gate.test.ts"],
    expectedFailingTestNames: ["⑤ 门禁入参"],
    rationale:
      "模型门禁从不被询问 ⇒ 三处门禁只剩两处（配置了也不生效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-tool-gate-ignored",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: '      : workWindowGateDenial !== null',
    replace: "      : false && workWindowGateDenial !== null",
    testFiles: ["tests/core/integration/workwindow01-tool-gate.test.ts"],
    expectedFailingTestNames: ["① 门禁拒绝"],
    rationale:
      "门禁拒绝仍执行工具 ⇒ 休息/暂停期间工具照跑并产生副作用（卡内点名）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-tool-gate-not-asked",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: "    if (options.workWindowGate !== undefined && !isGated) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/integration/workwindow01-tool-gate.test.ts"],
    expectedFailingTestNames: ["⑤ 门禁入参正确"],
    rationale:
      "工具门禁从不被调用 ⇒ 配置了也不生效（接线形同虚设）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-port-skips-readback",
    targetFile: "packages/core/src/public-sdk.ts",
    find: "        await this.switchPermissionProfile(reference);",
    replace: "        // 变异：不真正切换，只回报 applied",
    testFiles: ["tests/core/integration/configchat01-port-wiring.test.ts"],
    expectedFailingTestNames: ["① 切换 permission-profile-default"],
    rationale:
      "不真正切换却回报 applied ⇒ 读回的有效权限组没变（谎报已生效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-port-accepts-unsupported-key",
    targetFile: "packages/core/src/public-sdk.ts",
    find: "        if (applyInput.settingKey !== \"permission-profile-default\") {",
    replace: '        if (applyInput.settingKey !== "permission-profile-default") {\n          return { appliedValueJson: applyInput.proposedValueJson, appliedRevision: revision + 1 };\n        }\n        if (false) {',
    testFiles: ["tests/core/integration/configchat01-port-wiring.test.ts"],
    expectedFailingTestNames: ["④ 无 setter 的键"],
    rationale:
      "无 setter 的键也当成功 ⇒ 界面显示已保存但实际没生效（静默失败）⇒ 该反例必须变红",
  },  {
    mutationIdentifier: "workwindow-dispatch-ignores-deny",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: '      if (gateDecision.kind === "deny") {',
    replace: "      if (false) {",
    testFiles: ["tests/core/integration/workwindow01-dispatch-gate.test.ts"],
    expectedFailingTestNames: ["① 门禁拒绝"],
    rationale:
      "门禁拒绝仍派发 ⇒ 休息/暂停期间照跑模型与工具（越权执行）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-dispatch-never-asks-gate",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: "    if (workWindowGate !== undefined) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/integration/workwindow01-dispatch-gate.test.ts"],
    expectedFailingTestNames: ["④ 门禁入参正确"],
    rationale:
      "门禁从不被调用 ⇒ 接线形同虚设（配置了也没用）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-aggregation-silently-drops-overflow",
    targetFile: "packages/core/src/orchestration/perf-aggregation.ts",
    find: "    input.samples.length - policy.maximumQueuedSamples,",
    replace: "    0,",
    testFiles: ["tests/core/unit/perf01-aggregation.test.ts"],
    expectedFailingTestNames: ["② 队列溢出"],
    rationale:
      "队列溢出被静默吞掉（丢弃数报 0）⇒ 用户以为样本完整（卡内点名队列溢出反例）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-aggregation-reorders-clock-anomaly",
    targetFile: "packages/core/src/orchestration/perf-aggregation.ts",
    find: "    if (milliseconds <= previousMilliseconds) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/perf01-aggregation.test.ts"],
    expectedFailingTestNames: ["③ 时钟倒退"],
    rationale:
      "时钟倒退的样本被正常接受 ⇒ 聚合窗口错乱却看不出来（卡内点名时钟变化反例）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-aggregation-reports-zero-on-monitor-failure",
    targetFile: "packages/core/src/orchestration/perf-aggregation.ts",
    find: "    isMeasurementIncomplete: monitorFailureCount > 0 || queueOverflowDroppedSampleCount > 0,",
    replace: "    isMeasurementIncomplete: false,",
    testFiles: ["tests/core/unit/perf01-aggregation.test.ts"],
    expectedFailingTestNames: ["⑤ 监测器失败"],
    rationale:
      "监测器失败仍报「测量完整」⇒ 上层把没测到当成 0（卡内点名「无法测量不报零」）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-delivery-duplicates-on-retry",
    targetFile: "packages/core/src/orchestration/lesson-delivery.ts",
    find: '  if (existing.outcome === input.outcome) {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/lesson03-delivery.test.ts"],
    expectedFailingTestNames: ["⑤ 崩溃重试"],
    rationale:
      "崩溃重试重复投递 ⇒ 同一教训被投两次/重复推广（卡内点名\"崩溃重试无重复推广\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-delivery-ignores-switch",
    targetFile: "packages/core/src/orchestration/lesson-delivery.ts",
    find: "    (entry) => entry.modelFingerprint === currentFingerprint,",
    replace: "    (entry) => true,",
    testFiles: ["tests/core/unit/lesson03-delivery.test.ts"],
    expectedFailingTestNames: ["⑧ 模型切换"],
    rationale:
      "模型切换后仍把旧模型下的教训投给新模型 ⇒ 串用（卡内点名\"模型切换不串用\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-delivery-auto-summarizes-when-disabled",
    targetFile: "packages/core/src/orchestration/lesson-delivery.ts",
    find: "  if (!input.isAutoSummaryEnabled) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/lesson03-delivery.test.ts"],
    expectedFailingTestNames: ["② 关闭自动总结"],
    rationale:
      "关闭自动总结仍投递 ⇒ 后台偷偷总结（卡内点名\"关闭无自动总结/检索\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-cross-task-keeps-details",
    targetFile: "packages/core/src/orchestration/lesson-selection.ts",
    find: '    const isCrossTask =\n      candidate.scopeKind !== "task" && candidate.sourceTaskIdentifier !== request.taskIdentifier;',
    replace: "    const isCrossTask = false;",
    testFiles: ["tests/core/unit/lesson01-selection.test.ts"],
    expectedFailingTestNames: ["① 跨任务命中"],
    rationale:
      "跨任务复用仍带旧任务细节/证据引用 ⇒ 把旧任务上下文污染进新任务（卡内点名）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-model-mismatch-applies",
    targetFile: "packages/core/src/orchestration/lesson-selection.ts",
    find: "      if (!isSameModel) {",
    replace: "      if (false) {",
    testFiles: ["tests/core/unit/lesson01-selection.test.ts"],
    expectedFailingTestNames: ["③ 不同模型"],
    rationale:
      "不同模型/参数也套用 role-model-config 教训 ⇒ 建议在错误模型上生效（卡内点名）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-allows-cross-agent-raw-text",
    targetFile: "packages/core/src/orchestration/lesson-selection.ts",
    find: "  if (input.requestingAgentInstanceId !== input.ownerAgentInstanceId) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/lesson01-selection.test.ts"],
    expectedFailingTestNames: ["⑩ 原文不可跨个体读"],
    rationale:
      "跨个体可读原文 ⇒ 个体隔离的教训原文泄漏（卡内\"原文不可越域读\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-resume-repeats-after-wake",
    targetFile: "packages/core/src/orchestration/work-window-resume.ts",
    find: "  if (request.hasResumedSinceWake) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/workwindow03-resume.test.ts"],
    expectedFailingTestNames: ["② 同一唤醒内第二次调用"],
    rationale:
      "唤醒后重复恢复 ⇒ 同一任务被跑两遍（重复副作用，卡内点名\"只恢复一次\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-resume-revives-manual-cancel",
    targetFile: "packages/core/src/orchestration/work-window-resume.ts",
    find: "  if (request.isManuallyCancelled) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/workwindow03-resume.test.ts"],
    expectedFailingTestNames: ["③ 手动取消"],
    rationale:
      "手动取消后被唤醒复活 ⇒ 用户失去停止能力（卡内\"手动取消不复活\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-stop-claims-stopped-on-timeout",
    targetFile: "packages/core/src/orchestration/work-window-resume.ts",
    find: "  if (input.elapsedMilliseconds >= input.timeoutMilliseconds) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/workwindow03-resume.test.ts"],
    expectedFailingTestNames: ["⑨ 停止超时未确认"],
    rationale:
      "停止超时后被当作\"进行中\"的普通分支 ⇒ 界面仍可能显示已停止（最危险的谎报）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-gate-ignores-pause-reasons",
    targetFile: "packages/core/src/orchestration/work-window-gate.ts",
    find: "  if (activePauseReasonKinds.length > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/workwindow01-gate.test.ts"],
    expectedFailingTestNames: ["⑤ 暂停原因存在"],
    rationale:
      "暂停原因被忽略 ⇒ 用户暂停/权限到期后仍继续调用模型与工具（越权执行）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-gate-only-one-gate-point",
    targetFile: "packages/core/src/orchestration/work-window-gate.ts",
    find: '  if (request.isLongRunningContinuation === true && activePauseReasonKinds.length === 0) {',
    replace: '  if (request.isLongRunningContinuation === true) {',
    testFiles: ["tests/core/unit/workwindow01-gate.test.ts"],
    expectedFailingTestNames: ["⑨ 长工具收尾"],
    rationale:
      "长工具收尾绕过暂停原因 ⇒ 权限到期/用户暂停期间工具继续跑（门禁被\"收尾\"理由绕过）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-gate-collapses-reasons",
    targetFile: "packages/core/src/orchestration/work-window-gate.ts",
    find: "  return Object.entries(state.pausedReasons)\n    .filter(([, isPaused]) => isPaused === true)\n    .map(([kind]) => kind);",
    replace: "  return Object.entries(state.pausedReasons)\n    .filter(([, isPaused]) => isPaused === true)\n    .map(([kind]) => kind)\n    .slice(0, 1);",
    testFiles: ["tests/core/unit/workwindow01-gate.test.ts"],
    expectedFailingTestNames: ["⑦ 合并暂停原因"],
    rationale:
      "多个暂停原因被折叠成一个 ⇒ 用户看不到全部原因（互为覆盖，卡内点名）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-switch-breaks-communication",
    targetFile: "packages/core/src/orchestration/communication-model-switch.ts",
    find: '  if (usableModels.length === 0) {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/configchat03-model-switch.test.ts"],
    expectedFailingTestNames: ["② 禁用最后一个可用模型"],
    rationale:
      "禁用最后一个可用模型也照做 ⇒ 通信直接中断且用户无模型可用（卡内点名的\"最后模型禁用\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-safe-point-claims-switched",
    targetFile: "packages/core/src/orchestration/communication-model-switch.ts",
    find: '      isEffective: false,',
    replace: "      isEffective: true as unknown as false,",
    testFiles: ["tests/core/unit/configchat03-model-switch.test.ts"],
    expectedFailingTestNames: ["⑦ 在途任务"],
    rationale:
      "在途任务时宣称已生效 ⇒ 用户以为模型已切换而实际仍跑旧模型 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-restart-lies-about-switch",
    targetFile: "packages/core/src/orchestration/communication-model-switch.ts",
    find: '  if (input.runtimeEffectiveModelIdentifier === input.persistedTargetModelIdentifier) {',
    replace: "  if (true) {",
    testFiles: ["tests/core/unit/configchat03-model-switch.test.ts"],
    expectedFailingTestNames: ["⑩ 重启对账"],
    rationale:
      "持久化写了就算已切换 ⇒ 重启后运行时其实还是旧模型（最容易被谎报的一步）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-replays-as-fresh-apply",
    targetFile: "packages/core/src/orchestration/config-chat-control-plane.ts",
    find: '  if (identity.kind === "idempotent-replay") {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/configchat01-control-plane.test.ts"],
    expectedFailingTestNames: ["② 重复提交"],
    rationale:
      "重复提交被当成新变更重新落地 ⇒ 设置被重复应用/审计账目重复（卡内点名反例）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-ignores-stale-revision",
    targetFile: "packages/core/src/orchestration/config-chat-contract.ts",
    find: "      reasonCode: \"stale-revision\",",
    replace: "      reasonCode: \"not-in-public-allowlist\",",
    testFiles: ["tests/core/unit/configchat01-control-plane.test.ts"],
    expectedFailingTestNames: ["④ 并发编辑"],
    rationale:
      "并发编辑被报成\"不在白名单\" ⇒ 用户被误导去改无关设置（真正问题是 revision 落后）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-safe-point-claims-effective",
    targetFile: "packages/core/src/orchestration/config-chat-control-plane.ts",
    find: "        isEffective: false,",
    replace: "        isEffective: true as unknown as false,",
    testFiles: ["tests/core/unit/configchat01-control-plane.test.ts"],
    expectedFailingTestNames: ["⑧ 影响在途任务"],
    rationale:
      "安全点未到却宣称已生效 ⇒ 用户以为权限/模型已切换（在途任务行为不一致）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum01-publish-accepts-mismatched-payload",
    targetFile: "packages/tui/src/cli/commands.ts",
    find: "        reason: \"payload-kind-mismatch：来源种类 \" + sourceKind + \" 需要 \" + fieldName + \"，但载荷里是 \" + knownField,",
    replace: "        reason: \"ok\",",
    testFiles: ["tests/tui/integration/sum01-summary-publish-cli.test.ts"],
    expectedFailingTestNames: ["② 载荷与来源种类不匹配"],
    rationale:
      "载荷与来源种类不匹配也照收 ⇒ 按错适配器解释（数据被错误归类）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum01-publish-drops-invalid-items",
    targetFile: "packages/tui/src/cli/commands.ts",
    find: "  const invalidIndex = arrayOutcome.items.findIndex((item) => !isValidItem(item));",
    replace: "  const invalidIndex = -1;",
    testFiles: ["tests/tui/integration/sum01-summary-publish-cli.test.ts"],
    expectedFailingTestNames: ["③ 非法条目"],
    rationale:
      "非法条目被静默丢弃 ⇒ 用户以为全部发布成功（少数据不报）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "sum01-show-ignores-source-kind",
    targetFile: "packages/tui/src/cli/commands.ts",
    find: "      ...(options.sourceKind === undefined ? {} : { sourceKind: options.sourceKind }),\n      ...(options.maximumReturnUnitCount",
    replace: "      ...(options.maximumReturnUnitCount",
    testFiles: ["tests/tui/integration/sum01-summary-publish-cli.test.ts"],
    expectedFailingTestNames: ["⑥ 延后文件来源"],
    rationale:
      "show 忽略来源种类 ⇒ 已发布的非工作存档摘要\"看得见却打不开\"（即本轮修复的缺口）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-measurement-fakes-complete",
    targetFile: "packages/core/src/orchestration/document-view-measurement.ts",
    find: "      isComplete: expectedCount === 0 ? true : preservedCount >= expectedCount,",
    replace: "      isComplete: true,",
    testFiles: ["tests/core/unit/docview01-measurement.test.ts"],
    expectedFailingTestNames: ["⑥ 覆盖不完整"],
    rationale:
      "覆盖永远报「完整」⇒ 语义丢失被计量掩盖（比丢内容更危险）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-measurement-token-basis-wrong",
    targetFile: "packages/core/src/orchestration/document-view-measurement.ts",
    find: "    tokenEstimate: Math.ceil(input.content.length / 4),",
    replace: "    tokenEstimate: Buffer.byteLength(input.content, \"utf8\"),",
    testFiles: ["tests/core/unit/docview01-measurement.test.ts"],
    expectedFailingTestNames: ["② token 一律标注为"],
    rationale:
      "把字符估算换成字节数 ⇒ 口径错了却仍标成\"估算\"（数字虚高，用户按它算钱）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-measurement-hides-truncation",
    targetFile: "packages/core/src/orchestration/document-view-measurement.ts",
    find: "    isTruncated: extraction.isTruncated,",
    replace: "    isTruncated: false,",
    testFiles: ["tests/core/unit/docview01-measurement.test.ts"],
    expectedFailingTestNames: ["⑬ 截断必须如实暴露"],
    rationale:
      "截断被隐藏 ⇒ 用户以为读全了（漏读不自知）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-adapter-drops-tables",
    targetFile: "packages/core/src/orchestration/document-view-adapter.ts",
    find: "        kind: \"table\",\n        lineStart: startLine,\n        lineEnd: index,",
    replace: "        kind: \"paragraph\",\n        lineStart: startLine,\n        lineEnd: index,",
    testFiles: ["tests/core/unit/docview01-adapter.test.ts"],
    expectedFailingTestNames: ["⑤ 表格"],
    rationale:
      "表格被当成普通段落 ⇒ 表头/单元格关系静默丢失（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-adapter-guesses-corrupted",
    targetFile: "packages/core/src/orchestration/document-view-adapter.ts",
    find: "  if (content.includes(\"\\u0000\")) {\n    return \"内容包含 NUL 字节",
    replace: "  if (false) {\n    return \"内容包含 NUL 字节",
    testFiles: ["tests/core/unit/docview01-adapter.test.ts"],
    expectedFailingTestNames: ["③ 损坏文件"],
    rationale:
      "二进制内容被当作文本继续解析 ⇒ 给出半真半假的正文（比报错更危险）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-adapter-drops-anchors",
    targetFile: "packages/core/src/orchestration/document-view-adapter.ts",
    find: "    sourceAnchor: `${format}:line:${String(block.lineStart)}`,",
    replace: "    sourceAnchor: `${format}:block:${String(index + 1)}`,",
    testFiles: ["tests/core/unit/docview01-adapter.test.ts"],
    expectedFailingTestNames: ["⑫ 每块都有"],
    rationale:
      "锚点从\"行号定位\"退化为\"序号\" ⇒ 无法回指原文位置（补读与证据链失效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-internal-widens-scope",
    targetFile: "packages/core/src/orchestration/workflow-fold-internal-authorization.ts",
    find: "      if (!input.declaredCapabilityScope.has(capability)) {",
    replace: "      if (false) {",
    testFiles: ["tests/core/unit/fold01-internal-authorization.test.ts"],
    expectedFailingTestNames: ["① 能力不在登记范围"],
    rationale:
      "折叠包内部可越出登记范围 ⇒ 用一次外层宽批准换掉原有逐步确认（权限扩张）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-internal-skips-irreversible-prompt",
    targetFile: "packages/core/src/orchestration/workflow-fold-internal-authorization.ts",
    find: "      if (isIrreversibleCapability) {",
    replace: "      if (false) {",
    testFiles: ["tests/core/unit/fold01-internal-authorization.test.ts"],
    expectedFailingTestNames: ["⑤ 不可逆能力"],
    rationale:
      "不可逆动作不再逐步确认 ⇒ 删文件/执行命令被一次宽授权放行 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-view-shows-unsourced",
    targetFile: "packages/core/src/orchestration/curation-view-contract.ts",
    find: "    if (!hasSource) {\n      unsourcedItemCount += 1;\n      continue;\n    }",
    replace: "    if (!hasSource) {\n      unsourcedItemCount += 1;\n    }",
    testFiles: ["tests/core/unit/curate01-view-contract.test.ts"],
    expectedFailingTestNames: ["② 无来源条目"],
    rationale:
      "无来源条目也展示 ⇒ 结论无法追溯到原消息/工具回执（卡内硬要求）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-view-merges-other-agents",
    targetFile: "packages/core/src/orchestration/curation-view-contract.ts",
    find: "    if (!input.viewerAuthorizedAgentInstanceIdentifiers.has(item.ownerAgentInstanceIdentifier)) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/curate01-view-contract.test.ts"],
    expectedFailingTestNames: ["③ 跨个体不合并"],
    rationale:
      "把无权查看的其它个体条目合并进视图 ⇒ 跨个体记忆泄漏（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-verification-accepts-single-success",
    targetFile: "packages/core/src/orchestration/explore-verification-contract.ts",
    find: "  if (evidencedSuccesses.length < 3) missingEvidence.push(\"successful-runs\");",
    replace: "  if (evidencedSuccesses.length < 1) missingEvidence.push(\"successful-runs\");",
    testFiles: ["tests/core/unit/explore01-verification-contract.test.ts"],
    expectedFailingTestNames: ["① 一次成功"],
    rationale:
      "一次成功就算够 ⇒ 把\\\"一次成功\\\"称为稳定方案（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-verification-auto-merges",
    targetFile: "packages/core/src/orchestration/explore-verification-contract.ts",
    find: "    isAutoMerged: false,\n    requiredNextStep:",
    replace: "    isAutoMerged: true as unknown as false,\n    requiredNextStep:",
    testFiles: ["tests/core/unit/explore01-verification-contract.test.ts"],
    expectedFailingTestNames: ["④ 证据齐备"],
    rationale:
      "候选可自动合并 ⇒ 绕过普通验收与受控合并（用户最终判断被跳过）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "backup-apply-continues-after-failure",
    targetFile: "packages/core/src/orchestration/process-sample-backup-retention-apply.ts",
    find: "      return {\n        kind: \"aborted\",",
    replace: "      continue;\n      return {\n        kind: \"aborted\",",
    testFiles: ["tests/core/unit/obs01-backup-retention-apply.test.ts"],
    expectedFailingTestNames: ["③ 删除失败"],
    rationale:
      "删除失败仍继续删剩下的 ⇒ 半删状态被当成成功（用户以为清理完成，实际只清了一半）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "backup-apply-deletes-unplanned",
    targetFile: "packages/core/src/orchestration/process-sample-backup-retention-apply.ts",
    find: "  for (const fileName of plan.deleteFileNames) {",
    replace: "  for (const fileName of backupFileNames) {",
    testFiles: ["tests/core/unit/obs01-backup-retention-apply.test.ts"],
    expectedFailingTestNames: ["② 只有计划内的备份被删"],
    rationale:
      "删除全部备份而不是计划内的 ⇒ 把用户手工备份与最新安全网一起删掉 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-rotate-prunes-without-flag",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "  if (input.isPruneBackups === true) {",
    replace: "  if (true) {",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-prune.test.ts"],
    expectedFailingTestNames: ["① 默认不清理"],
    rationale:
      "不加开关也清理备份 ⇒ 默认行为变成\"顺手删东西\"（用户没要求）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-rotate-prune-deletes-everything",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "      removeBackupFile: deleteFileIfExists,",
    replace: "      removeBackupFile: async (absoluteFilePath: string) => {\n        const { promises: fsPromises } = await import(\"node:fs\");\n        const entries = await fsPromises.readdir(pathNode.dirname(absoluteFilePath));\n        for (const entry of entries.filter((name) => name.startsWith(\"process-samples.backup-\"))) {\n          await deleteFileIfExists(pathNode.join(pathNode.dirname(absoluteFilePath), entry));\n        }\n      },",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-prune.test.ts"],
    expectedFailingTestNames: ["② --prune-backups"],
    rationale:
      "清理时把\"所有备份\"都删（含手工备份与最新安全网）⇒ 用户手工备份被抹掉 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "backup-retention-deletes-newest",
    targetFile: "packages/core/src/orchestration/process-sample-backup-retention.ts",
    find: "    const isNewest = index === 0;",
    replace: "    const isNewest = false;",
    testFiles: ["tests/core/unit/obs01-backup-retention.test.ts"],
    expectedFailingTestNames: ["⑥ 最新一份即使超出条数"],
    rationale:
      "最新一份也可能被删 ⇒ 出事时无备份可用（把安全网删掉）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "backup-retention-deletes-unparsable",
    targetFile: "packages/core/src/orchestration/process-sample-backup-retention.ts",
    find: "    if (recordedAtIso === null) {\n      unknown.push(fileName);\n      continue;\n    }",
    replace: "    if (recordedAtIso === null) {\n      continue;\n    }",
    testFiles: ["tests/core/unit/obs01-backup-retention.test.ts"],
    expectedFailingTestNames: ["④ 不认识的文件名"],
    rationale:
      "不认识的文件名被静默丢弃/删除 ⇒ 用户手工备份被抹掉且无计数 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "gitignore-drops-local-state",
    targetFile: ".gitignore",
    find: ".astarray/",
    replace: "# .astarray/ (removed)",
    testFiles: ["tests/architecture/repository-hygiene.test.ts"],
    expectedFailingTestNames: ["① 本地状态库"],
    rationale:
      "删掉 .astarray/ 忽略规则 ⇒ 本机运行痕迹（任务/记忆/凭据痕迹）可能被提交进公开仓库 ⇒ 该守卫必须变红",
  },
  {
    mutationIdentifier: "rotate-preview-hides-retained-window",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "      plan.retainedOldestAtIso === null || plan.retainedNewestAtIso === null",
    replace: "      true",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-command.test.ts"],
    expectedFailingTestNames: ["⑦ 预览必须给出"],
    rationale:
      "始终隐藏保留窗口 ⇒ 用户无法判断留下的数据够不够用（只能盲信\"已裁剪\"）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-rotate-truncates-garbage-budget",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "      if (!/^\\d+$/.test(trimmedValue) || Number.parseInt(trimmedValue, 10) < 1) {",
    replace: "      if (Number.parseInt(trimmedValue, 10) < 1) {",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-command.test.ts"],
    expectedFailingTestNames: ["④ 严格整数"],
    rationale:
      "只做 parseInt 截断校验 ⇒ \"5abc\" 被当成 5 字节预算，几乎裁光历史 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-rotate-accepts-nan-budget",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "    if (!Number.isFinite(numericValue) || numericValue <= 0) {",
    replace: "    if (false) {",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-command.test.ts"],
    expectedFailingTestNames: ["③ 非法预算"],
    rationale:
      "放行 NaN/负值 ⇒ 计划把全部样本判为超预算（敲错参数就丢历史）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-rotate-dry-run-writes",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "  if (!isApply) {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-command.test.ts"],
    expectedFailingTestNames: ["① 默认 dry-run"],
    rationale:
      "预览也改盘 ⇒ 用户只想看一眼却丢了历史（且产生备份）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "perf-rotate-apply-skips-preview-path",
    targetFile: "packages/tui/src/cli/obs-perf-rotate-command.ts",
    find: "  const isApply = input.isApply === true;",
    replace: "  const isApply = true;",
    testFiles: ["tests/tui/unit/obs01-perf-rotate-command.test.ts"],
    expectedFailingTestNames: ["① 默认 dry-run"],
    rationale:
      "默认当成 apply ⇒ 一条命令就把历史裁掉（不应默认破坏）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-aggregate-mixes-estimate-into-billable",
    targetFile: "packages/core/src/orchestration/usage-ledger-aggregate.ts",
    find: "      if (entry.sourceKind === \"provider\" && entry.isBillable) {",
    replace: "      if (entry.isBillable) {",
    testFiles: ["tests/core/unit/obs01-usage-ledger-aggregate.test.ts"],
    expectedFailingTestNames: ["③ 估算即使被标成可结算"],
    rationale:
      "把估算并进可结算合计 ⇒ 报表把估算当账单（用户会按错的数对账）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-aggregate-counts-missing-as-zero",
    targetFile: "packages/core/src/orchestration/usage-ledger-aggregate.ts",
    find: "    if (entry.sourceKind === \"missing\" || entry.totalTokens === null) {",
    replace: "    if (entry.totalTokens === null && false) {",
    testFiles: ["tests/core/unit/obs01-usage-ledger-aggregate.test.ts"],
    expectedFailingTestNames: ["② 缺失条目"],
    rationale:
      "缺失条目当 0 计入合计 ⇒ 把 unknown 记成零（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-estimate-claimed-billable",
    targetFile: "packages/core/src/orchestration/usage-ledger-contract.ts",
    find: "  if (input.sourceKind === \"local-estimate\" && isBillable) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-usage-ledger-contract.test.ts"],
    expectedFailingTestNames: ["⑤ 本地估算不得声明可结算"],
    rationale:
      "估算可声明可结算 ⇒ 把估算当账单（卡内：估算与账单边界必须清楚）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "usage-missing-zeroed",
    targetFile: "packages/core/src/orchestration/usage-ledger-contract.ts",
    find: "    if (\n      inputTokens !== null ||\n      outputTokens !== null ||\n      totalTokens !== null\n    ) {",
    replace: "    if (false) {",
    testFiles: ["tests/core/unit/obs01-usage-ledger-contract.test.ts"],
    expectedFailingTestNames: ["② 来源缺失"],
    rationale:
      "缺失来源可以写 0 ⇒ 把 unknown 记成零（用户会以为真的用了 0 token）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "evidence-pack-body-ignores-sections",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "      ...(requestedSections.has(\"findings-summary\")",
    replace: "      ...(true",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑪ obs diag export"],
    rationale:
      "无视章节声明仍写 findings ⇒ 声明与内容不一致（用户以为没导出的东西被带走）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "evidence-pack-body-drops-degraded-status",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "      ...(requestedSections.has(\"degraded-status\")",
    replace: "      ...(false",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑪ obs diag export"],
    rationale:
      "要求降级状态却不写 ⇒ 读者无法判断证据是否完整（伪「一切正常」）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "evidence-pack-body-leaks-message-text",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "    isInference: finding.isInference,",
    replace: "    isInference: finding.isInference,\n    messageText: finding.redactedSampleText,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑩ obs diag export"],
    rationale:
      "把错误文本写进证据包 ⇒ 导出文件可能携带敏感内容（卡内：写入前最小化，不是事后遮盖）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "evidence-pack-body-ignores-window",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "        windowStartIso: input.windowStartIso,\n        windowEndIso: input.windowEndIso,",
    replace: "        windowStartIso: null,\n        windowEndIso: null,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑩ obs diag export"],
    rationale:
      "正文忽略时间窗 ⇒ 证据包覆盖范围与声明不一致（用户以为只看最近一段）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "diag-export-writes-when-rejected",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "  if (decision.kind === \"rejected\") {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑨ obs diag export"],
    rationale:
      "被拒绝仍继续写文件 ⇒ 违反\"拒绝即不落盘\"（敏感证据包可能落地）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "diag-export-drops-manifest-safety-flags",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "    isAutoUploaded: false,",
    replace: "    isAutoUploaded: true,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑨ obs diag export"],
    rationale:
      "报告已自动上传 ⇒ 与\"不联网上传\"矛盾（用户会以为文件已外发）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "evidence-pack-allows-auto-upload",
    targetFile: "packages/core/src/orchestration/diagnostic-evidence-pack-contract.ts",
    find: "  if (input.isNetworkUploadRequested) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-diagnostic-evidence-pack.test.ts"],
    expectedFailingTestNames: ["② 非用户主动"],
    rationale:
      "允许自动联网上传证据包 ⇒ 违反\"不自动联网发送\"（诊断数据外泄面）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "evidence-pack-allows-sensitive-content",
    targetFile: "packages/core/src/orchestration/diagnostic-evidence-pack-contract.ts",
    find: "  if (input.containsRawArguments || input.containsSecrets) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-diagnostic-evidence-pack.test.ts"],
    expectedFailingTestNames: ["④ 含原始参数或凭据"],
    rationale:
      "允许含原始参数/凭据的证据包 ⇒ 把敏感内容导出带走（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-process-summary-ignores-window",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "        samples: matchedSamples,\n        discardedLineCount: report.discardedLineCount,",
    replace: "        samples: report.samples,\n        discardedLineCount: report.discardedLineCount,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑧ obs process --summary"],
    rationale:
      "摘要忽略时间窗 ⇒ 报告的统计与用户查询的范围不一致（覆盖范围失真）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-process-summary-keeps-raw-samples",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "    samples: isSummaryRequested ? [] : returnedSamples,",
    replace: "    samples: returnedSamples,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑧ obs process --summary"],
    rationale:
      "摘要模式仍返回逐条样本 ⇒ 与\"摘要只给聚合\"的约定不符（也浪费输出）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "aggregate-missing-field-counted-as-zero",
    targetFile: "packages/core/src/orchestration/process-sample-aggregate.ts",
    find: "      if (value === undefined) continue;",
    replace: "      if (value === undefined) { fieldValues[fieldName].push(0); continue; }",
    testFiles: ["tests/core/unit/obs01-process-sample-aggregate.test.ts"],
    expectedFailingTestNames: ["① 缺字段的样本不计入该字段分母"],
    rationale:
      "缺字段被补 0 计入分母 ⇒ 把\"没采到\"算成\"零延迟/零队列\"（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "aggregate-median-uses-upper-middle",
    targetFile: "packages/core/src/orchestration/process-sample-aggregate.ts",
    find: "      : ((sortedValues[middleIndex - 1] ?? 0) + (sortedValues[middleIndex] ?? 0)) / 2;",
    replace: "      : (sortedValues[middleIndex] ?? 0);",
    testFiles: ["tests/core/unit/obs01-process-sample-aggregate.test.ts"],
    expectedFailingTestNames: ["② min/max/mean/median"],
    rationale:
      "偶数个时中位数只取上中位 ⇒ 分位数失真（性能报告的关键指标）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "run-perf-flag-not-passed-through",
    targetFile: "packages/tui/src/cli.tsx",
    find: "        isPerfCollectionEnabled: options.perfCollect === true,",
    replace: "        isPerfCollectionEnabled: false,",
    testFiles: ["tests/architecture/obs-run-collector-wiring.test.ts"],
    expectedFailingTestNames: ["① CLI"],
    rationale:
      "开关不透传 ⇒ \"--perf-collect\" 变成空开关（用户以为在采集，实际没采）⇒ 该守卫必须变红",
  },
  {
    mutationIdentifier: "run-perf-never-stops",
    targetFile: "packages/tui/src/cli/run-command.ts",
    find: "        await runPerfCollector.stop();",
    replace: "        void runPerfCollector;",
    testFiles: ["tests/architecture/obs-run-collector-wiring.test.ts"],
    expectedFailingTestNames: ["③ 命令侧"],
    rationale:
      "只 start 不 stop ⇒ 定时器泄漏，且保留整理永不执行（文件无界增长）⇒ 该守卫必须变红",
  },
  {
    mutationIdentifier: "run-perf-created-while-disabled",
    targetFile: "packages/core/src/orchestration/run-perf-collection.ts",
    find: "  if (input.isPerfCollectionEnabled !== true) return null;",
    replace: "  if (false) return null;",
    testFiles: ["tests/core/unit/obs01-run-perf-collection.test.ts"],
    expectedFailingTestNames: ["① 默认未开启"],
    rationale:
      "未开启也创建采集器 ⇒ 默认 off 失效、产生目录与定时器（用户没同意就有开销）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "collector-samples-while-disabled",
    targetFile: "packages/core/src/orchestration/session-perf-collector.ts",
    find: "    if (!input.isCollectionEnabled) {\n      return { kind: \"skipped\", reason: \"采集未开启：不采样、不写盘。\" };\n    }",
    replace: "    if (false) {\n      return { kind: \"skipped\", reason: \"x\" };\n    }",
    testFiles: ["tests/core/unit/obs01-session-perf-collector.test.ts"],
    expectedFailingTestNames: ["① 默认关闭"],
    rationale:
      "关闭时仍采样落盘 ⇒ 用户没同意就产生文件与开销（默认 off 失效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "collector-stop-skips-retention",
    targetFile: "packages/core/src/orchestration/session-perf-collector.ts",
    find: "        const retentionReport = await applyProcessSampleRetention({",
    replace: "        const retentionReport = { kind: \"no-action\" as const, reason: \"skipped\" }; void applyProcessSampleRetention; if (false) await applyProcessSampleRetention({",
    testFiles: ["tests/core/unit/obs01-session-perf-collector.test.ts"],
    expectedFailingTestNames: ["⑥ stop 时按保留策略"],
    rationale:
      "关闭时不整理 ⇒ 预算/保留策略永不生效（文件无界增长）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "scheduler-ignores-collection-switch",
    targetFile: "packages/core/src/orchestration/observability-sampling-scheduler.ts",
    find: "      if (!input.isCollectionEnabled) {",
    replace: "      if (false) {",
    testFiles: ["tests/core/unit/obs01-sampling-scheduler.test.ts"],
    expectedFailingTestNames: ["① 默认关闭"],
    rationale:
      "无视采集开关 ⇒ 默认 off 也在排定时器（用户没同意就有常驻开销）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "scheduler-duplicates-timer-on-restart",
    targetFile: "packages/core/src/orchestration/observability-sampling-scheduler.ts",
    find: "      if (timerHandle !== null) {\n        return { kind: \"not-started\", reason: \"已在运行：重复 start 不会创建第二个定时器。\" };\n      }",
    replace: "      if (false) {\n        return { kind: \"not-started\", reason: \"x\" };\n      }",
    testFiles: ["tests/core/unit/obs01-sampling-scheduler.test.ts"],
    expectedFailingTestNames: ["② 开启后 start"],
    rationale:
      "重复 start 各排一个定时器 ⇒ 采样频率翻倍、资源泄漏（且 stop 只清一个）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "retention-apply-skips-backup",
    targetFile: "packages/core/src/orchestration/process-sample-retention-apply.ts",
    find: "    await copyFileWithBackup(filePath, backupFilePath);",
    replace: "    void copyFileWithBackup;",
    testFiles: ["tests/core/unit/obs01-process-sample-retention-apply.test.ts"],
    expectedFailingTestNames: ["② 过期样本被裁剪"],
    rationale:
      "裁剪前不备份 ⇒ 违反「清理遵循自动备份」（删历史无法回滚）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "retention-apply-keeps-oldest",
    targetFile: "packages/core/src/orchestration/process-sample-retention-apply.ts",
    find: "  for (let index = input.candidates.length - 1; index >= 0; index -= 1) {",
    replace: "  for (let index = 0; index < input.candidates.length; index += 1) {",
    testFiles: ["tests/core/unit/obs01-process-sample-retention-apply.test.ts"],
    expectedFailingTestNames: ["③ 超预算"],
    rationale:
      "重写时保留最旧而非最新 ⇒ 与判定层的「新样本优先」不一致（数据自相矛盾）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "retention-drops-newest-first",
    targetFile: "packages/core/src/orchestration/process-sample-retention.ts",
    find: "  for (let index = withinRetentionWindow.length - 1; index >= 0; index -= 1) {",
    replace: "  for (let index = 0; index < withinRetentionWindow.length; index += 1) {",
    testFiles: ["tests/core/unit/obs01-process-sample-retention.test.ts"],
    expectedFailingTestNames: ["④ 超预算"],
    rationale:
      "超预算时先删**最新**样本 ⇒ 保留最旧数据、丢掉刚采的（用户要的是最新近况）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "retention-silently-zeroes-dropped-counts",
    targetFile: "packages/core/src/orchestration/process-sample-retention.ts",
    find: "    droppedByRetentionCount,\n    droppedByBudgetCount,",
    replace: "    droppedByRetentionCount: 0,\n    droppedByBudgetCount: 0,",
    testFiles: ["tests/core/unit/obs01-process-sample-retention.test.ts"],
    expectedFailingTestNames: ["③ 超过 24h"],
    rationale:
      "裁剪条数被清零 ⇒ 静默删除历史（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-process-empty-reported-as-samples",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "    hasSamples: matchedSamples.length > 0,",
    replace: "    hasSamples: true,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑥ obs process"],
    rationale:
      "无进程样本却报 hasSamples=true ⇒ 调用方把\"没采到\"当成\"有数据\"（unknown 不记作零）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-process-hides-discarded-lines",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "      returnedSampleCount: returnedSamples.length,\n      discardedLineCount: report.discardedLineCount,",
    replace: "      returnedSampleCount: returnedSamples.length,\n      discardedLineCount: 0,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑦ obs process"],
    rationale:
      "坏行数恒为 0 ⇒ 观测降级不可见（卡内：不能静默丢弃）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "process-sample-accepts-unknown-field",
    targetFile: "packages/core/src/orchestration/process-sample-store.ts",
    find: "    if (!ALLOWED_FIELD_NAMES.has(fieldName)) return false;",
    replace: "    if (false) return false;",
    testFiles: ["tests/core/unit/obs01-process-sample-store.test.ts"],
    expectedFailingTestNames: ["③ 非法样本拒绝写入"],
    rationale:
      "接受白名单外指标 ⇒ OS 级/未知指标被写进进程样本（跨平台语义不一致）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "process-sample-silently-drops-bad-lines",
    targetFile: "packages/core/src/orchestration/process-sample-store.ts",
    find: "      if (!isProcessSampleEvent(parsed)) {\n        discardedLineCount += 1;\n        continue;\n      }",
    replace: "      if (false) {\n        continue;\n      }",
    testFiles: ["tests/core/unit/obs01-process-sample-store.test.ts"],
    expectedFailingTestNames: ["④ 坏行如实计数"],
    rationale:
      "坏行被静默跳过且不计数 ⇒ 观测降级不可见（卡内：不能静默丢弃）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-sampler-append-failure-throws",
    targetFile: "packages/core/src/orchestration/observability-sampler.ts",
    find: "  } catch (error) {\n    return {\n      kind: \"degraded\",\n      reason: `样本落盘失败（已降级，不阻塞业务）：${error instanceof Error ? error.message : String(error)}`,",
    replace: "  } catch (error) {\n    throw error;\n    return {\n      kind: \"degraded\",\n      reason: `样本落盘失败（已降级，不阻塞业务）：${error instanceof Error ? error.message : String(error)}`,",
    testFiles: ["tests/core/unit/obs01-sampler.test.ts"],
    expectedFailingTestNames: ["⑦ 落盘失败"],
    rationale:
      "样本落盘失败直接抛给业务 ⇒ 观测故障阻塞业务（R37 契约明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-sampler-fills-unknown-with-zero",
    targetFile: "packages/core/src/orchestration/observability-sampler.ts",
    find: "    fields = { ...input.ports.readProcessMetrics(), ...(input.taskFacts ?? {}) };",
    replace: "    fields = { eventLoopDelayMs: 0, ...input.ports.readProcessMetrics(), ...(input.taskFacts ?? {}) };",
    testFiles: ["tests/core/unit/obs01-sampler.test.ts"],
    expectedFailingTestNames: ["⑤ 拿不到某项指标"],
    rationale:
      "拿不到指标就填 0 ⇒ 把 unknown 记成\"零延迟\"（卡内：unknown 不记作零）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-sampler-ignores-collection-switch",
    targetFile: "packages/core/src/orchestration/observability-sampler.ts",
    find: "    isCollectionEnabled: input.isCollectionEnabled,",
    replace: "    isCollectionEnabled: true,",
    testFiles: ["tests/core/unit/obs01-sampler.test.ts"],
    expectedFailingTestNames: ["① 默认关闭"],
    rationale:
      "采样器无视开关 ⇒ 即使默认 off 也在采样（用户没同意就有开销）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-perf-empty-reported-as-zero",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "    hasSamples: result.coverage.matchedSampleCount > 0,",
    replace: "    hasSamples: true,",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["① 无样本"],
    rationale:
      "无样本却报 hasSamples=true ⇒ 调用方会把\"没采到\"当成\"有用量\"（卡内：unknown 不记作零）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-command-crashes-on-read-failure",
    targetFile: "packages/tui/src/cli/observability-command.ts",
    find: "  } catch (error) {\n    /**\n     * **观测故障不得阻塞业务**",
    replace: "  } catch (error) {\n    throw error;\n    /**\n     * **观测故障不得阻塞业务**",
    testFiles: ["tests/tui/unit/obs01-observability-command.test.ts"],
    expectedFailingTestNames: ["⑤ 真实读取失败"],
    rationale:
      "查询失败直接把错误抛给调用方 ⇒ 观测故障阻塞业务（R37 契约明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-perf-collection-default-on",
    targetFile: "packages/core/src/orchestration/observability-collection-contract.ts",
    find: "  if (!input.isCollectionEnabled) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-collection-contract.test.ts"],
    expectedFailingTestNames: ["① 默认关闭"],
    rationale:
      "采集无视开关（等于默认开启）⇒ 用户没同意也在采样、产生默认开销 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-perf-accepts-os-level-metrics",
    targetFile: "packages/core/src/orchestration/observability-collection-contract.ts",
    find: "  if (invalidFieldNames.length > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-collection-contract.test.ts"],
    expectedFailingTestNames: ["④ 采样字段白名单"],
    rationale:
      "接受 OS 级/未知指标 ⇒ 跨平台语义不一致且开销不可控（用户决策：只采进程内）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "obs-diag-accepts-raw-arguments",
    targetFile: "packages/core/src/orchestration/observability-collection-contract.ts",
    find: "  if (input.sanitization.containsRawArguments) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/obs01-collection-contract.test.ts"],
    expectedFailingTestNames: ["⑥ DIAG"],
    rationale:
      "允许保存原始命令参数 ⇒ 诊断日志变成凭据/敏感数据泄漏面（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-status-relocation-section-always",
    targetFile: "packages/tui/src/cli/project-relocation-command.ts",
    find: '  const relocationSection =\n    description.registrationReadKind === "legacy"',
    replace: '  const relocationSection =\n    true',
    testFiles: ["tests/tui/unit/relocate01-project-status-relocation-section.test.ts"],
    expectedFailingTestNames: ["② 有效登记且身份一致"],
    rationale:
      "无条件输出 relocation 段 ⇒ 正常项目也带重定位段（误导用户以为要重定位、破坏向后兼容）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-status-legacy-hides-reconcile-hint",
    targetFile: "packages/tui/src/cli/project-relocation-command.ts",
    find: '          reconcileCommandHint: "astarray project reconcile --input <reconcile-input.json> --json",',
    replace: '          reconcileCommandHint: "",',
    testFiles: ["tests/tui/unit/relocate01-project-status-relocation-section.test.ts"],
    expectedFailingTestNames: ["① 存在旧格式登记"],
    rationale:
      "旧格式登记却不给出对账入口 ⇒ 用户不知道下一步该做什么（卡内：人工确认短且易懂）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-cli-write-exit-zero",
    targetFile: "packages/tui/src/cli/project-relocation-command.ts",
    find: "  return reconciliation.isExecutionAllowed ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;",
    replace: "  return EXIT_CODES.SUCCESS;",
    testFiles: ["tests/tui/unit/relocate01-project-reconcile-command.test.ts"],
    expectedFailingTestNames: ["② 含写/外部副作用"],
    rationale:
      "含写/需人工确认也返回 0 ⇒ 脚本会误判为「已恢复」并继续（用户决策：含写必须人工确认）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-cli-blocks-become-success",
    targetFile: "packages/tui/src/cli/project-relocation-command.ts",
    find: "      (reference) => reference.wasRewritten,",
    replace: "      (reference) => false,",
    testFiles: ["tests/tui/unit/relocate01-project-reconcile-command.test.ts"],
    expectedFailingTestNames: ["① 只读且解析成功"],
    rationale:
      "改写计数恒为 0 ⇒ 报告与实际解析结果不一致（人工据此判断会看错）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-reconciler-completed-replayed",
    targetFile: "packages/core/src/orchestration/project-relocation-reconciler.ts",
    find: '  if (input.projectStatus === "completed") {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/relocate01-reconciler.test.ts"],
    expectedFailingTestNames: ["② 已完成项目"],
    rationale:
      "已完成项目被重新对账并恢复 ⇒ 重放已完成操作（卡内：已完成绝不重放）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-reconciler-write-auto-resumed",
    targetFile: "packages/core/src/orchestration/project-relocation-reconciler.ts",
    find: "  if (input.hasWriteOrExternalSideEffects) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/relocate01-reconciler.test.ts"],
    expectedFailingTestNames: ["④ 含写/外部副作用"],
    rationale:
      "含写/外部副作用也自动恢复 ⇒ 未经人工确认就重放写操作（用户决策：必须人工确认）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-reconciler-blocked-ignored",
    targetFile: "packages/core/src/orchestration/project-relocation-reconciler.ts",
    find: "  if (isBlockedByOperation) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/relocate01-reconciler.test.ts"],
    expectedFailingTestNames: ["⑤ 旧一次性许可", "⑥ 新位置权限复检"],
    rationale:
      "被门禁阻塞的未决操作被忽略 ⇒ 旧一次性许可/未知副作用下自动恢复 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "cross-project-copy-receipts-ignore-agent-filter",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `      if (
        filter.receivingAgentInstanceId !== undefined &&
        entry.receivingAgentInstanceId !== filter.receivingAgentInstanceId
      ) {
        return false;
      }`,
    replace: `      if (false) {
        return false;
      }`,
    testFiles: ["tests/core/integration/cross-project-copy-receipt-filter.test.ts"],
    expectedFailingTestNames: ["① list --agent"],
    rationale:
      "副本回执不再按个体过滤 ⇒ 甲个体能看到乙个体的副本（串数据）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "onboarding-never-show-again-ignored",
    targetFile: "packages/core/src/orchestration/onboarding-hint-contract.ts",
    find: "  if (input.state.isNeverShowAgain) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-onboarding-hint.test.ts"],
    expectedFailingTestNames: ["② 「不再提示」持久化生效"],
    rationale:
      "「不再提示」被忽略 ⇒ 用户拒绝后仍反复弹提示（卡内：换文案也不能绕过拒绝）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "onboarding-hint-during-authorization",
    targetFile: "packages/core/src/orchestration/onboarding-hint-contract.ts",
    find: "  if (input.context.isAuthorizationPending) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-onboarding-hint.test.ts"],
    expectedFailingTestNames: ["④ 忙碌类上下文"],
    rationale:
      "授权裁决中弹提示 ⇒ 与重要授权卡混排、诱导误点（卡内禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "onboarding-recommendation-implies-authorization",
    targetFile: "packages/core/src/orchestration/onboarding-hint-contract.ts",
    find: "    impliesAuthorization: false,",
    replace: "    impliesAuthorization: true,",
    testFiles: ["tests/core/unit/client01-onboarding-hint.test.ts"],
    expectedFailingTestNames: ["⑦ 推荐不构成授权"],
    rationale:
      "推荐话术被当成授权 ⇒ 用户只是「了解方案」就被执行/安装 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-run-rest-period-ignored",
    targetFile: "packages/core/src/orchestration/curation-execution-contract.ts",
    find: "  if (input.isRestPeriod) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-curation-execution.test.ts"],
    expectedFailingTestNames: ["④ 启动门禁"],
    rationale:
      "休息时段仍触发模型整理 ⇒ 违反卡内\"休息时不触发模型整理\"（且会消耗额度）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-missed-periods-replayed",
    targetFile: "packages/core/src/orchestration/curation-execution-contract.ts",
    find: "    coalescedRunCount: 1,",
    replace: "    coalescedRunCount: missedPeriodCount,",
    testFiles: ["tests/core/unit/exp01-curation-execution.test.ts"],
    expectedFailingTestNames: ["② 错过多个周期"],
    rationale:
      "错过多少周期就补跑多少次 ⇒ 重复整理与重复消耗（卡内：合并为一次）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-failure-claims-full-coverage",
    targetFile: "packages/core/src/orchestration/curation-execution-contract.ts",
    find: "    claimsFullCoverage: false,\n    failureReason: input.failureReason ?? \"摘要失败（未提供原因）。\",",
    replace: "    claimsFullCoverage: true,\n    failureReason: input.failureReason ?? \"摘要失败（未提供原因）。\",",
    testFiles: ["tests/core/unit/exp01-curation-execution.test.ts"],
    expectedFailingTestNames: ["⑤ 摘要失败"],
    rationale:
      "摘要失败却声称覆盖完整 ⇒ 用户以为历史已整理（卡内：不假装覆盖完整）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-trial-real-user-data-allowed",
    targetFile: "packages/core/src/orchestration/explore-trial-contract.ts",
    find: "  if (input.touchesRealUserData) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-explore-trial.test.ts"],
    expectedFailingTestNames: ["① 真实用户数据"],
    rationale:
      "允许在真实用户数据上跑试验 ⇒ 随机破坏性操作打到用户数据（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-trial-duplicate-rerun-allowed",
    targetFile: "packages/core/src/orchestration/explore-trial-contract.ts",
    find: "  if (existingTrial !== undefined) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-explore-trial.test.ts"],
    expectedFailingTestNames: ["④ 相同参数"],
    rationale:
      "相同参数/种子/版本重复重跑 ⇒ 重复消耗预算且结论不可增量（卡内禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-budget-refreshed-on-restart",
    targetFile: "packages/core/src/orchestration/explore-trial-contract.ts",
    find: "  if (input.persistedBudget === null) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-explore-trial.test.ts"],
    expectedFailingTestNames: ["⑦ 重启后预算不刷新"],
    rationale:
      "重启后无快照却返回 restored（用 null 预算）⇒ 等于重启刷新预算 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-lifecycle-rollback-with-unknown-side-effects",
    targetFile: "packages/core/src/orchestration/workflow-fold-lifecycle.ts",
    find: "  if (input.hasUnknownSideEffects) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-fold-lifecycle.test.ts"],
    expectedFailingTestNames: ["⑤ 回退阻塞"],
    rationale:
      "有未知副作用仍允许回退 ⇒ 可能以'实验失败'重放非幂等副作用（卡内明令）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-lifecycle-auto-rerun-old-workflow",
    targetFile: "packages/core/src/orchestration/workflow-fold-lifecycle.ts",
    find: "    shouldAutoRerunOldWorkflow: false,",
    replace: "    shouldAutoRerunOldWorkflow: true,",
    testFiles: ["tests/core/unit/exp01-fold-lifecycle.test.ts"],
    expectedFailingTestNames: ["⑥ 发现回归"],
    rationale:
      "回归后自动重跑旧工作流 ⇒ 卡内明确禁止（可能重复副作用）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-lifecycle-reuse-retired-version",
    targetFile: "packages/core/src/orchestration/workflow-fold-lifecycle.ts",
    find: "  if (isRetired) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-fold-lifecycle.test.ts"],
    expectedFailingTestNames: ["② 停用版本"],
    rationale:
      "已停用的版本仍可复用 ⇒ 回归版本继续产生错误输出（卡内：停用新版本）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-package-author-self-verification-accepted",
    targetFile: "packages/core/src/orchestration/workflow-fold-package.ts",
    find: "  if (input.verification.verifierAgentInstanceId === input.authorAgentInstanceId) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-fold-package.test.ts"],
    expectedFailingTestNames: ["② 作者自己验收"],
    rationale:
      "作者可验收自己的产出 ⇒ 自我确认（卡内：实现者不得验收自己的产出）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-package-permission-widening-accepted",
    targetFile: "packages/core/src/orchestration/workflow-fold-package.ts",
    find: "  if (hasUnapprovedPermission) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-fold-package.test.ts"],
    expectedFailingTestNames: ["⑥ 展开后的步骤权限"],
    rationale:
      "折叠包可带未批准的步骤权限 ⇒ 借折叠扩权（卡内：每步按实际权限检查）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "fold-package-single-input-accepted",
    targetFile: "packages/core/src/orchestration/workflow-fold-package.ts",
    find: "  if (distinctInputFingerprints.size < 2) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-fold-package.test.ts"],
    expectedFailingTestNames: ["③ 少于两种不同输入"],
    rationale:
      "单例成功即可登记 ⇒ 等价性没有证据（卡内：至少两种不同输入）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-accepts-non-user-source",
    targetFile: "packages/core/src/orchestration/config-chat-contract.ts",
    find: '  if (proposal.sourceKind !== "authenticated-user") {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/configchat01-contract.test.ts"],
    expectedFailingTestNames: ["② 工具输出"],
    rationale:
      "工具输出/文档/经验文字可冒充用户设置指令 ⇒ 提示注入改配置（卡内硬禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-ignores-stale-revision",
    targetFile: "packages/core/src/orchestration/config-chat-contract.ts",
    find: "  if (proposal.expectedRevision !== proposal.currentRevision) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/configchat01-contract.test.ts"],
    expectedFailingTestNames: ["④ 旧 revision"],
    rationale:
      "旧 revision 仍可写入 ⇒ 覆盖用户随后作出的新修改（卡内：期望 revision 原子提交）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-skips-risk-confirmation",
    targetFile: "packages/core/src/orchestration/config-chat-contract.ts",
    find: "  if (riskyKinds.length > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/configchat01-contract.test.ts"],
    expectedFailingTestNames: ["⑤ 风险类别"],
    rationale:
      "扩大权限/断连类修改不再显式确认 ⇒ 用户被一次含糊指令改掉权限边界 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "configchat-allows-secret-into-chat",
    targetFile: "packages/core/src/orchestration/config-chat-contract.ts",
    find: "  if (CHAT_SETTING_SECRET_KEYS.includes(proposal.settingKey)) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/configchat01-contract.test.ts"],
    expectedFailingTestNames: ["① 秘密类设置"],
    rationale:
      "秘密类设置进入对话 ⇒ 凭据会写入对话/历史（卡内：必须走受保护入口）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-filtered-view-writeback-allowed",
    targetFile: "packages/core/src/orchestration/document-view-contract.ts",
    find: "      isFullFileWriteBackAllowed: false,",
    replace: "      isFullFileWriteBackAllowed: true,",
    testFiles: ["tests/core/unit/docview01-contract.test.ts"],
    expectedFailingTestNames: ["⑥ 过滤视图"],
    rationale:
      "允许用过滤视图覆盖写回原文件 ⇒ 丢失的样式/内容被永久写入（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-scanned-pdf-reported-supported",
    targetFile: "packages/core/src/orchestration/document-view-contract.ts",
    find: '  if (input.format === "pdf" && input.isPdfReliablyExtractable === false) {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/docview01-contract.test.ts"],
    expectedFailingTestNames: ["② 能力矩阵"],
    rationale:
      "扫描件 PDF 伪报支持 ⇒ 用户以为已完整读取（卡内：不伪报）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "docview-unknown-mode-defaults-content",
    targetFile: "packages/core/src/orchestration/document-view-contract.ts",
    find: '  if (rawMode === "content" || rawMode === "structure" || rawMode === "layout") return rawMode;\n  return null;',
    replace: "  return (rawMode ?? \"content\") as DocumentPresentationMode;",
    testFiles: ["tests/core/unit/docview01-contract.test.ts"],
    expectedFailingTestNames: ["① 模式枚举"],
    rationale:
      "未知模式被当成有效值 ⇒ 冲突的布尔式参数回来了（卡内要求枚举、未知不猜）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-cli-check-always-succeeds",
    targetFile: "packages/tui/src/cli/folder-command.ts",
    find: '  return decision.outcome === "allowed" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;',
    replace: "  return EXIT_CODES.SUCCESS;",
    testFiles: ["tests/tui/unit/folder01-command.test.ts"],
    expectedFailingTestNames: ["⑥ check"],
    rationale:
      "复检拒绝也返回成功 ⇒ 用户以为已授权（fail-open）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-cli-approve-skips-human-confirmation",
    targetFile: "packages/tui/src/cli/folder-command.ts",
    find: "    isHumanConfirmed: true,",
    replace: "    isHumanConfirmed: false,",
    testFiles: ["tests/tui/unit/folder01-command.test.ts"],
    expectedFailingTestNames: ["④ approve"],
    rationale:
      "approve 不再代表认证用户确认 ⇒ 授权无法落库（或可被非人类路径绕过）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-cli-accepts-unknown-permission",
    targetFile: "packages/tui/src/cli/folder-command.ts",
    find: `  if (rawPermission === "read-only" || rawPermission === "read-write") return rawPermission;
  return null;`,
    replace: `  if (rawPermission !== undefined) return rawPermission as FolderGrantPermissionKind;
  return null;`,
    testFiles: ["tests/tui/unit/folder01-command.test.ts"],
    expectedFailingTestNames: ["⑩ 取值校验"],
    rationale:
      "未知权限值被接受 ⇒ 含糊措辞变成权限（卡内：权限含糊先澄清）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-cli-request-ignores-unacceptable",
    targetFile: "packages/tui/src/cli/folder-command.ts",
    find: "  if (hasUnacceptable) {",
    replace: "  if (false) {",
    testFiles: ["tests/tui/unit/folder01-command.test.ts"],
    expectedFailingTestNames: ["③ request"],
    rationale:
      "不可登记的候选仍返回成功 ⇒ 用户以为可以批准（且未落库却报成功）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-rest-priority-inverted",
    targetFile: "packages/core/src/orchestration/work-window-contract.ts",
    find: `  // 作用域交集：任何作用域命中休息 ⇒ 休息（项目规则不能无声覆盖全局休息）
  if (hasRestingMatch) {`,
    replace: `  // 作用域交集：任何作用域命中休息 ⇒ 休息（项目规则不能无声覆盖全局休息）
  if (false) {`,
    testFiles: ["tests/core/unit/workwindow01-contract.test.ts"],
    expectedFailingTestNames: ["② 休息黑名单跨午夜", "⑤ 同优先级冲突"],
    rationale:
      "休息不再优先 ⇒ 白名单/项目规则可覆盖全局休息（卡内：冲突时休息优先、项目不能无声覆盖）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-oneoff-not-prioritized",
    targetFile: "packages/core/src/orchestration/work-window-contract.ts",
    find: "  if (oneOffRules.length > 0) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/workwindow01-contract.test.ts"],
    expectedFailingTestNames: ["④ 一次性例外"],
    rationale:
      "一次性例外不再优先 ⇒ 用户显式放行在周期休息区间内被忽略 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-pause-reasons-overwritten",
    targetFile: "packages/core/src/orchestration/work-window-contract.ts",
    find: "    pausedReasons: { ...input.current.pausedReasons, [input.reason]: input.isPaused },",
    replace: "    pausedReasons: { [input.reason]: input.isPaused } as typeof input.current.pausedReasons,",
    testFiles: ["tests/core/unit/workwindow01-contract.test.ts"],
    expectedFailingTestNames: ["⑧ 暂停原因分别记录"],
    rationale:
      "设置一个暂停原因会清掉其它原因 ⇒ 解除时段暂停把用户暂停也一并清掉（卡内禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workwindow-resume-ignores-unknown-side-effects",
    targetFile: "packages/core/src/orchestration/work-window-contract.ts",
    find: '  if (input.hasUnknownSideEffects) blockedReasonCodes.push("unknown-side-effects");',
    replace: "  if (false) void 0;",
    testFiles: ["tests/core/unit/workwindow01-contract.test.ts"],
    expectedFailingTestNames: ["⑨ 恢复门禁"],
    rationale:
      "未知副作用不再阻塞恢复 ⇒ 到点后可能重放无法确认的非幂等操作（卡内禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-main-agent-write-allowed",
    targetFile: "packages/core/src/orchestration/lesson-record-contract.ts",
    find: "  if (input.isMainAgentModel) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/lesson01-record-contract.test.ts"],
    expectedFailingTestNames: ["⑨ 写入"],
    rationale:
      "主 Agent 模型获得写入工具 ⇒ 违反只读角色（卡内硬约束）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-reconstructed-snapshot-accepted",
    targetFile: "packages/core/src/orchestration/lesson-record-contract.ts",
    find: '  if (record.snapshotSource !== "runtime") {',
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/lesson01-record-contract.test.ts"],
    expectedFailingTestNames: ["③ 配置快照必须取自运行时"],
    rationale:
      "允许写总结时重建的配置快照 ⇒ 记录的不是事件发生时的真实配置（结论不可追）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-facts-hypotheses-merge-allowed",
    targetFile: "packages/core/src/orchestration/lesson-record-contract.ts",
    find: "  if (hypothesisAsFact !== undefined) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/lesson01-record-contract.test.ts"],
    expectedFailingTestNames: ["⑤ 事实/假设混写"],
    rationale:
      "事实与假设可混写 ⇒ 猜测被当作确定事实（卡内：不得混为确定事实）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "lesson-unknown-version-exact-match",
    targetFile: "packages/core/src/orchestration/lesson-record-contract.ts",
    find: '  if (hasUnknownVersion) differences.push("model-version-unknown");',
    replace: "  if (hasUnknownVersion) void 0;",
    testFiles: ["tests/core/unit/lesson01-record-contract.test.ts"],
    expectedFailingTestNames: ["④ unknown 必须显式"],
    rationale:
      "模型版本未知时仍按精确匹配 ⇒ 未知被当成已知（卡内：未知不得当成精确匹配）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-ignores-scope-expansion",
    targetFile: "packages/core/src/orchestration/curation-plan-contract.ts",
    find: '    changes.push("scope-expanded");',
    replace: "    void 0;",
    testFiles: ["tests/core/unit/exp01-curation-plan.test.ts"],
    expectedFailingTestNames: ["② 范围扩大"],
    rationale:
      "扩大项目/会话/个体/数据类别不再算重大 ⇒ 未经再次授权就扩大整理范围 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-unknown-change-treated-minor",
    targetFile: "packages/core/src/orchestration/curation-plan-contract.ts",
    find: '    changes.push("unknown-change");',
    replace: "    void 0;",
    testFiles: ["tests/core/unit/exp01-curation-plan.test.ts"],
    expectedFailingTestNames: ["⑤ 字段有差异但无法归类"],
    rationale:
      "无法归类的差异被当作非重大 ⇒ 模型可用'小改'绕过本地比较（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-authorization-skips-fingerprint",
    targetFile: "packages/core/src/orchestration/curation-plan-contract.ts",
    find: "  if (input.authorization.planFingerprint !== computeCurationPlanFingerprint(input.plan)) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-curation-plan.test.ts"],
    expectedFailingTestNames: ["① 未授权"],
    rationale:
      "授权不再绑定参数指纹 ⇒ 批准后偷改参数仍然有效（卡内：新授权绑定精确 revision）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "curation-transition-pauses-old-plan",
    targetFile: "packages/core/src/orchestration/curation-plan-contract.ts",
    find: `    decision: "keep-old-waiting",
    isNewPlanPaused: true,
    isOldPlanStillAllowed: true,`,
    replace: `    decision: "keep-old-waiting",
    isNewPlanPaused: true,
    isOldPlanStillAllowed: false,`,
    testFiles: ["tests/core/unit/exp01-curation-plan.test.ts"],
    expectedFailingTestNames: ["⑦ 重大变更未获新授权"],
    rationale:
      "等待新授权时把旧方案也停掉 ⇒ 未经授权就改变了既有行为（卡内：只暂停新方案）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-start-ignores-unknown-resource-state",
    targetFile: "packages/core/src/orchestration/explore-plan-contract.ts",
    find: "  if (input.isResourceStateUnknown && !input.hasUserApprovedLocalBudget) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-explore-plan.test.ts"],
    expectedFailingTestNames: ["⑤ 启动"],
    rationale:
      "资源未知且无用户批准预算仍启动 ⇒ 等于猜余额/擅自消耗额度（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-budget-overdraft-allowed",
    targetFile: "packages/core/src/orchestration/explore-plan-contract.ts",
    find: "    consumed.trials > budget.maximumTrials;",
    replace: "    consumed.trials > budget.maximumTrials + 1000;",
    testFiles: ["tests/core/unit/exp01-explore-plan.test.ts"],
    expectedFailingTestNames: ["⑧ 预算扣减"],
    rationale:
      "允许透支试验数 ⇒ 预算不再是硬上限（可被绕过）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-stop-ignores-no-progress",
    targetFile: "packages/core/src/orchestration/explore-plan-contract.ts",
    find: "  if (\n    Number.isFinite(input.maximumNoProgressRounds) &&\n    input.consecutiveNoProgressRounds >= input.maximumNoProgressRounds\n  ) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-explore-plan.test.ts"],
    expectedFailingTestNames: ["⑨ 停止条件"],
    rationale:
      "无进展不再停止 ⇒ 探索可无限续跑（卡内禁止无限续跑）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "explore-duplicate-combination-allowed",
    targetFile: "packages/core/src/orchestration/explore-plan-contract.ts",
    find: "  if (input.exploredCombinationFingerprints.includes(input.targetCombinationFingerprint)) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-explore-plan.test.ts"],
    expectedFailingTestNames: ["⑥ 启动"],
    rationale:
      "相同参数与版本组合重复探索 ⇒ 重复消耗预算且结论不可增量（卡内明确禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workflow-fold-accepts-non-foldable",
    targetFile: "packages/core/src/orchestration/workflow-fold-contract.ts",
    find: "  if (offendingItem !== undefined) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/exp01-fold-contract.test.ts"],
    expectedFailingTestNames: ["④ 不可折叠项"],
    rationale:
      "不可折叠项（授权/结果/回执/裁决/nonce/批准指纹）被折进模板 ⇒ 复用上次许可或伪装上次结果 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workflow-fold-skips-side-effect-parameter-schema",
    targetFile: "packages/core/src/orchestration/workflow-fold-contract.ts",
    find: `      (parameter.effectKind === "content" || parameter.effectKind === "target") &&
      (!isNonBlank(parameter.parameterName) || !isNonBlank(parameter.schemaJson)),`,
    replace: `      (parameter.effectKind === "content" || parameter.effectKind === "target") &&
      (false),`,
    testFiles: ["tests/core/unit/exp01-fold-contract.test.ts"],
    expectedFailingTestNames: ["⑤ 影响副作用的参数"],
    rationale:
      "副作用参数不校验名称/schema ⇒ 不同写入内容可能映射成同一授权/幂等身份 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workflow-per-step-authorization-disabled",
    targetFile: "packages/core/src/orchestration/workflow-fold-contract.ts",
    find: "      requiresPerStepAuthorization: true,",
    replace: "      requiresPerStepAuthorization: false,",
    testFiles: ["tests/core/unit/exp01-fold-contract.test.ts"],
    expectedFailingTestNames: ["⑦ 登记"],
    rationale:
      "外层一次批准即可覆盖展开后的内部步骤 ⇒ 内部安装/外部写入/备份删除被掩盖 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "workflow-reuses-previous-authorization",
    targetFile: "packages/core/src/orchestration/workflow-fold-contract.ts",
    find: "      reusesPreviousAuthorization: false,",
    replace: "      reusesPreviousAuthorization: true,",
    testFiles: ["tests/core/unit/exp01-fold-contract.test.ts"],
    expectedFailingTestNames: ["⑦ 登记"],
    rationale:
      "复用上次操作许可 ⇒ 折叠等于把旧授权带到新调用（卡内：只复用方法，不复用上次许可）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-first-start-ignores-offline-threshold",
    targetFile: "packages/core/src/orchestration/secretary-first-start.ts",
    find: "  if (offlineDurationMinutes < input.minimumClientClosedDurationMinutes) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-secretary-first-start.test.ts"],
    expectedFailingTestNames: ["② 单纯跨午夜"],
    rationale:
      "离线阈值被忽略 ⇒ 单纯跨午夜的短重启也会触发整理（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-first-start-reprocesses-day",
    targetFile: "packages/core/src/orchestration/secretary-first-start.ts",
    find: "  if (input.lastProcessedLocalDates.includes(nowLocalDate)) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-secretary-first-start.test.ts"],
    expectedFailingTestNames: ["④ 该本地日已处理"],
    rationale:
      "已处理日期仍再次触发 ⇒ 同一天重复整理（重复模型调用/重复产物）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-daily-claim-allows-double",
    targetFile: "packages/core/src/orchestration/secretary-first-start.ts",
    find: "  if (existing !== undefined) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-secretary-first-start.test.ts"],
    expectedFailingTestNames: ["⑧ 同日领取"],
    rationale:
      "同日领取不再排他 ⇒ 多窗口同时整理同一天（卡内要求原子领取）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-collapse-deletes-old",
    targetFile: "packages/core/src/orchestration/secretary-first-start.ts",
    find: `    collapsedOlderCount,
    areOlderDeleted: false,`,
    replace: `    collapsedOlderCount,
    areOlderDeleted: true,`,
    testFiles: ["tests/core/unit/client01-secretary-first-start.test.ts"],
    expectedFailingTestNames: ["⑨ 收拢视图"],
    rationale:
      "把收拢当成删除 ⇒ 旧历史被标记删除（卡内：收拢而非删除）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-task-key-ignores-project",
    targetFile: "packages/core/src/orchestration/secretary-relay-contract.ts",
    find: `    "secretary-task-line",
    input.projectIdentifier,`,
    replace: `    "secretary-task-line",
    "",`,
    testFiles: ["tests/core/unit/client01-secretary-relay.test.ts"],
    expectedFailingTestNames: ["① 多项目同名任务不串线"],
    rationale:
      "任务行键丢掉项目标识 ⇒ 两个项目的同名任务在汇总里被合并成一条（串线）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-relay-dedup-disabled",
    targetFile: "packages/core/src/orchestration/secretary-relay-contract.ts",
    find: "  if (sameReceipt !== undefined) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-secretary-relay.test.ts"],
    expectedFailingTestNames: ["⑥ 重放同"],
    rationale:
      "相同幂等键+目标重复派发 ⇒ 同一任务被下发两次（重复副作用）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-receipt-regression-allowed",
    targetFile: "packages/core/src/orchestration/secretary-relay-contract.ts",
    find: "  if (nextOrder <= currentOrder) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-secretary-relay.test.ts"],
    expectedFailingTestNames: ["⑦ 回执状态只能前进"],
    rationale:
      "回执状态可倒退 ⇒ 已完成的转交被回写成已派发（状态不可信）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-mode-switch-copies-history",
    targetFile: "packages/core/src/orchestration/secretary-relay-contract.ts",
    find: "  copiesHistory: false,",
    replace: "  copiesHistory: true,",
    testFiles: ["tests/core/unit/client01-secretary-relay.test.ts"],
    expectedFailingTestNames: ["② 模式切换的隔离"],
    rationale:
      "模式切换复制历史 ⇒ 汇总模式复制项目对话（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-default-enabled",
    targetFile: "packages/core/src/orchestration/secretary-agent-contract.ts",
    find: "  if (input.isExperimentEnabled !== true) {",
    replace: "  if (false) {",
    testFiles: ["tests/core/unit/client01-secretary-contract.test.ts"],
    expectedFailingTestNames: ["① 默认关闭"],
    rationale:
      "实验秘书默认开启 ⇒ 未经用户显式开启就创建实例（卡内：默认关闭、默认不创建实例）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-source-read-allowed",
    targetFile: "packages/core/src/orchestration/secretary-agent-contract.ts",
    find: `  "read-only-report-query",
  "status-query",
];`,
    replace: `  "read-only-report-query",
  "status-query",
  "project-source-read",
];`,
    testFiles: ["tests/core/unit/client01-secretary-contract.test.ts"],
    expectedFailingTestNames: ["⑤ 能力矩阵", "⑨ 同级关系"],
    rationale:
      "把项目源文件读取并入允许能力 ⇒ 秘书可读项目源码（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "secretary-relay-broadcasts-all",
    targetFile: "packages/core/src/orchestration/secretary-agent-contract.ts",
    find: `      kind: "needs-clarification",`,
    replace: `      kind: "proposal-created",`,
    testFiles: ["tests/core/unit/client01-secretary-contract.test.ts"],
    expectedFailingTestNames: ["⑧ 任务转交"],
    rationale:
      "目标不明时不再要求澄清 ⇒ 一条指令被当成可派发（等同广播风险）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-grant-store-revocation-ignored",
    targetFile: "packages/core/src/orchestration/folder-grant-store.ts",
    find: "      (grant) => !grant.isRevoked && isPathInsideOrEqual(normalizedTarget.comparisonPath, grant.normalizedRootPath),",
    replace:
      "      (grant) => isPathInsideOrEqual(normalizedTarget.comparisonPath, grant.normalizedRootPath),",
    testFiles: ["tests/core/unit/folder01-grant-store.test.ts"],
    expectedFailingTestNames: ["⑩ 撤销"],
    rationale:
      "撤销被忽略 ⇒ 已撤销的目录仍可读（撤销形同虚设）⇒ 撤销反例必须变红",
  },
  {
    mutationIdentifier: "folder-grant-store-write-via-readonly-allowed",
    targetFile: "packages/core/src/orchestration/folder-grant-store.ts",
    find: `  if (granted === "read-write") return true;
  return required === "read-only";`,
    replace: `  void granted;
  void required;
  return true;`,
    testFiles: ["tests/core/unit/folder01-grant-store.test.ts"],
    expectedFailingTestNames: ["⑧ 已授权"],
    rationale: "只读授权放行写操作 ⇒ 目录许可变成写权限（越权）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-grant-store-stale-revision-accepted",
    targetFile: "packages/core/src/orchestration/folder-grant-store.ts",
    find: `    const revisionMatched = usable.filter(
      (grant) => grant.projectRevision === input.projectRevision,
    );`,
    replace: `    const revisionMatched = usable;`,
    testFiles: ["tests/core/unit/folder01-grant-store.test.ts"],
    expectedFailingTestNames: ["⑪ 过期"],
    rationale:
      "项目 revision 前进后旧许可仍有效 ⇒ 变更后的项目沿用旧授权（卡内要求变更即失效）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-grant-model-signature-accepted",
    targetFile: "packages/core/src/orchestration/folder-grant-request.ts",
    find: "  const requiresAuthenticatedUserConfirmation = true;",
    replace: "  const requiresAuthenticatedUserConfirmation = false;",
    testFiles: ["tests/core/unit/folder01-grant-request.test.ts"],
    expectedFailingTestNames: ["⑨ 可接受候选"],
    rationale:
      "模型提出的候选不需要认证用户确认 ⇒ 模型可自行赋权（卡内：模型只能提候选、不能签字）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-grant-ancestor-widening-accepted",
    targetFile: "packages/core/src/orchestration/folder-grant-request.ts",
    find: `  const isAncestorOfAnyRoot = [...ownRootsNormalized, ...otherRootsNormalized].some((root) =>
    isPathInsideOrEqual(root.comparisonPath, normalized.comparisonPath),
  );`,
    replace: `  const isAncestorOfAnyRoot = false;`,
    testFiles: ["tests/core/unit/folder01-grant-request.test.ts"],
    expectedFailingTestNames: ["⑧ 父目录"],
    rationale:
      "父目录候选被放行 ⇒ 纳入一个目录就等于覆盖其下所有项目/未授权区域（范围扩大）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "folder-grant-prefix-containment",
    targetFile: "packages/core/src/orchestration/folder-grant-request.ts",
    find: `  const rootWithSeparator = rootComparisonPath.endsWith("/")
    ? rootComparisonPath
    : \`\${rootComparisonPath}/\`;
  return comparisonPath.startsWith(rootWithSeparator);`,
    replace: `  return comparisonPath.startsWith(rootComparisonPath);`,
    testFiles: ["tests/core/unit/folder01-grant-request.test.ts"],
    expectedFailingTestNames: ["⑦ **逐段**判定"],
    rationale:
      "退回字符串前缀判定 ⇒ `old-project-extra` 会被当成 `old-project` 的子目录（卡内明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "run-history-view-ignores-search-query",
    targetFile: "packages/core/src/orchestration/run-history-view.ts",
    find: `  const matched = normalizedSearchQuery === null
    ? eligible
    : eligible.filter((item) =>
        doesPayloadMatchSearchQuery(item.event.payloadJson, normalizedSearchQuery),
      );`,
    replace: `  const matched = eligible;`,
    testFiles: ["tests/core/unit/history01-run-history-view.test.ts"],
    expectedFailingTestNames: ["⑭ 关键词检索"],
    rationale:
      "检索词被忽略 ⇒ 用户以为筛过、实际看到全量（且 searchMatchCount 谎报）⇒ 检索反例必须变红",
  },
  {
    mutationIdentifier: "cross-project-forbidden-access-target-disabled",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (
      isForbiddenAccessTarget !== undefined &&
      (await isForbiddenAccessTarget(binding.resolvedAbsolutePath))
    ) {`,
    replace: `    const isForbiddenAccessTarget = this.options.isForbiddenAccessTarget;
    if (false && isForbiddenAccessTarget !== undefined) {`,
    testFiles: [
      "tests/core/integration/cross-project-resource-io.test.ts",
      "tests/core/integration/cross-project-sdk-entry.test.ts",
    ],
    expectedFailingTestNames: [
      "受保护存储（backup-vault / 删除审计）不得经跨项目通道访问",
      "副本导入：**来源**是受保护存储时不得被拷出去",
      "受保护存储之删除审计文件同样不得经跨项目通道读取",
      "SDK 入口：受保护存储（backup-vault）不得经跨项目通道读取",
    ],
    rationale: "受保护存储判定被禁用时，保管库/审计文件必须仍被拒绝（fail-closed 防线）",
  },
  {
    mutationIdentifier: "cross-project-target-filename-binding-relaxed",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `      if (canonicalizedActualPath !== expectedCanonicalTargetPath) {`,
    replace: `      if (path.dirname(canonicalizedActualPath) !== path.dirname(expectedCanonicalTargetPath)) {`,
    testFiles: ["tests/core/integration/cross-project-resource-io.test.ts"],
    expectedFailingTestNames: [
      "副本导入：目标绝对路径与「目标项目根 + 声明路径」不一致时必须拒绝",
    ],
    rationale:
      "把'完整规范路径比对'放宽成'只比父目录'后，'同目录换个文件名'必须仍被拒绝（否则目标可被调包）",
  },
  {
    mutationIdentifier: "tool-package-reauthorization-gate-removed",
    targetFile: "packages/core/src/toolkit/tool-package-version-state-store.ts",
    find: `    if (differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;`,
    replace: `    if (false && differences.requiresReauthorization) {
      const recordIdentifier = input.reauthorizationRecordIdentifier;`,
    testFiles: ["tests/core/integration/toolkit01-reauthorization-gate.test.ts"],
    expectedFailingTestNames: [
      "无重新授权记录 ⇒ 必须拒绝",
      "给了不存在的记录标识 ⇒ 必须拒绝",
      "记录与本次操作绑定不匹配 ⇒ 必须拒绝",
      "记录已被消费 ⇒ 必须拒绝",
    ],
    rationale:
      "把'以本地签发的重新授权记录为依据'的门禁整段短路后，无记录/记录不存在/绑定不匹配/已消费四种情形必须全部变红" +
      "（否则等于门禁形同虚设，调用方又能凭自述放行）",
  },
  {
    mutationIdentifier: "tool-package-reauthorization-single-use-removed",
    targetFile: "packages/core/src/toolkit/tool-package-reauthorization-record-store.ts",
    find: `    if (record.consumedAtIso !== null) {`,
    replace: `    if (false && record.consumedAtIso !== null) {`,
    testFiles: [
      "tests/core/unit/toolkit01-reauthorization-record-store.test.ts",
      "tests/core/integration/toolkit01-reauthorization-gate.test.ts",
    ],
    expectedFailingTestNames: [
      "一次性：同一条记录不得二次放行",
      "记录已被消费 ⇒ 必须拒绝",
    ],
    rationale:
      "去掉'一次性消费'后，同一条批准不得能反复升级（否则一次批准可被无限复用）",
  },
  {
    /**
     * 2026-10-22 订正：原两条变异（`comm01-single-parent-uniqueness-removed`、
     * `comm01-direct-parent-check-relaxed`）针对的是**错误模型**
     * （"唯一上级 = 通信授权"），已随实现一并删除。
     * 依 `docs/AGENT_COMMUNICATION_OVERVIEW.md` §35–54 与用户澄清，
     * 正确语义是"创建来源登记 + 地址完整性"（无绑定记录 ⇒ 直接拒绝）。
     */
    mutationIdentifier: "comm01-unknown-recipient-accepted",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: `    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (record === null) {
      return false;
    }
    return record.recycledAtIso === null;`,
    replace: `    const record = await this.registry.getRecord(recipientAgentInstanceId);
    if (false && record === null) {
      return false;
    }
    return record === null || record.recycledAtIso === null;`,
    testFiles: ["tests/core/integration/comm01-agent-creation-registry.test.ts"],
    expectedFailingTestNames: ["**无绑定记录**的收件人 ⇒ 直接拒绝"],
    rationale:
      "放宽'无绑定记录即拒收'后，未知地址会被当作可投递主体" +
      "（用户澄清的硬规则：投递到无绑定记录的对象**直接拒绝**）",
  },
  {
    mutationIdentifier: "comm01-creation-provenance-not-persisted",
    targetFile: "packages/core/src/orchestration/agent-parent-binding-store.ts",
    find: `      if (parsed.schemaVersion !== 1) {
        return;
      }`,
    replace: `      if (false && parsed.schemaVersion !== 1) {
        return;
      }`,
    testFiles: ["tests/core/integration/comm01-agent-creation-registry.test.ts"],
    expectedFailingTestNames: ["`schemaVersion` 不符 ⇒ 按空继续"],
    rationale:
      "不再按 schemaVersion 拒收后，异版本文档里的记录会被当作**存在的主体**" +
      "⇒ 未知地址变成可投递（伪造存在性）",
  },
  {
    mutationIdentifier: "comm01-delivery-address-check-skipped",
    targetFile: "packages/core/src/feedback-process/delivery-worker.ts",
    find: `    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {`,
    replace: `    const isRecipientAddressKnown = this.dependencies.isRecipientAddressKnown;
    if (false && isRecipientAddressKnown !== undefined) {
      const isKnown = await isRecipientAddressKnown(nextMessage);
      if (!isKnown) {`,
    testFiles: ["tests/core/integration/comm01-delivery-address-integrity.test.ts"],
    expectedFailingTestNames: [
      "收件人**无绑定记录** ⇒ 不投递、不标记已投递",
      "真实 AgentCreationRegistry 端到端",
    ],
    rationale:
      "把投递步骤的地址完整性整段短路后，'无绑定记录 / 已回收的收件人不得投递'必须变红" +
      "（否则该检查只写在模块里、在真实投递路径上并不生效）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-authority-check-skipped",
    targetFile: "packages/core/src/toolkit/tool-package-operation-control.ts",
    find: `  if (input.authorizationController !== undefined) {
    const authority = await input.authorizationController.resolveIssuingAuthority({`,
    replace: `  if (false && input.authorizationController !== undefined) {
    const authority = await input.authorizationController.resolveIssuingAuthority({`,
    testFiles: ["tests/core/integration/toolkit01-reauthorization-gate.test.ts"],
    expectedFailingTestNames: ["**无资格的 Agent** 不得签发"],
    rationale:
      "短路'签发资格'判定后，未获授予的 Agent 又能在**真实签发入口**上凭空签发" +
      "（用户澄清：默认只有用户持有该权限，Agent 须经显式授予）",
  },
  {
    mutationIdentifier: "toolkit01-delegation-amplification-allowed",
    targetFile: "packages/core/src/toolkit/tool-upgrade-authorization-grant.ts",
    find: `      if (ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {`,
    replace: `      if (false && ownValidGrant.expiresAtIso !== null) {
        if (requestedExpiry === null) {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-authorization.test.ts"],
    expectedFailingTestNames: [
      "**逐层分发不得放大**：自身有期限时不得授出无期限能力",
      "**逐层分发不得放大**：授出期限不得晚于自身期限",
    ],
    rationale:
      "放开'不得放大'后，下级可授出无期限/更长期限的能力 ⇒ 逐层分发变成权限膨胀" +
      "（用户要求'向下级逐层分发'但**不得放大**）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-declaration-modes-not-required",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `  if (missingModes.length > 0) {`,
    replace: `  if (false && missingModes.length > 0) {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["**缺少任一模式** ⇒ 拒绝"],
    rationale:
      "不再要求三模式齐全后，升级包可以只声明一部分模式就落地" +
      "（用户明确要求'必须显式声明三种模式的默认权限规则和理由'）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-declaration-reason-not-required",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `      if (rule.reason.trim() === "") {`,
    replace: `      if (false && rule.reason.trim() === "") {`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["但**规则没有理由** ⇒ 拒绝"],
    rationale:
      "不再要求理由后，升级包可加开关却不说为什么" +
      "（用户明确要求'显式声明三种模式的默认权限规则**和理由**'）",
  },
  {
    mutationIdentifier: "toolkit01-upgrade-removed-feature-rules-kept",
    targetFile: "packages/core/src/toolkit/tool-upgrade-permission-declaration.ts",
    find: `  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return !removedFeatureIdentifiers.has(key);
  });`,
    replace: `  const retainedRules = input.existingRules.filter((rule) => {
    const key = rule.ruleIdentifier ?? rule.action;
    return true || !removedFeatureIdentifiers.has(key);
  });`,
    testFiles: ["tests/core/unit/toolkit01-upgrade-permission-declaration.test.ts"],
    expectedFailingTestNames: ["**消失的功能** ⇒ 移除其旧规则"],
    rationale:
      "不再移除消失功能的旧规则后，'消失的功能也要对应移除旧的权限管理开关'这条就不成立" +
      "（会留下指向已不存在功能的僵尸开关）",
  },
  {
    mutationIdentifier: "comm01-feedback-ignores-task-publisher",
    targetFile: "packages/core/src/orchestration/worker-agent.ts",
    find: `      recipientId: route.recipientId,`,
    replace: `      recipientId: \`scheduler:\${this.options.missionId}\`,`,
    testFiles: [
      "tests/core/unit/worker-agent.test.ts",
      "tests/core/unit/comm01-task-publisher-feedback-route.test.ts",
    ],
    expectedFailingTestNames: [
      "任务记录了发布者 ⇒ 反馈**投给发布者**而非默认 scheduler",
    ],
    rationale:
      "把反馈去向改回硬编码 scheduler 后，'反馈走任务发布者反向通道'必须变红" +
      "（用户澄清：反馈**不是**根据上下级关系，而是默认走任务发布者的反向通道）",
  },
  {
    mutationIdentifier: "comm01-publisher-stamp-overwrites-existing",
    targetFile: "packages/core/src/orchestration/task-publisher-feedback-route.ts",
    find: `  const existing = input.task.publishedByRecipientId;
  if (typeof existing === "string" && existing.trim() !== "") {
    return existing;
  }`,
    replace: `  const existing = input.task.publishedByRecipientId;
  if (false && typeof existing === "string" && existing.trim() !== "") {
    return existing;
  }`,
    testFiles: ["tests/core/unit/comm01-task-publisher-feedback-route.test.ts"],
    expectedFailingTestNames: ["任务**已带**发布者 ⇒ 尊重原值"],
    rationale:
      "强行覆盖既有发布者 ⇒ 会把反馈从真正的发布者改投到本编排器（另一种'错投'）" +
      "（'尊重原值'这条必须变红）",
  },
  {
    mutationIdentifier: "comm01-orchestrator-skips-publisher-stamp",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    /**
     * ⚠️ **2026-11-08（第 133 轮）修正（两次踩坑，记录）**：
     *
     * 1. 原 `find` 是**多行**模板串，而 `mission-orchestrator.ts` 与 harness 的**行尾不同**
     *    （工作区源文件 CRLF、harness LF）⇒ 多行 find **永不匹配**（全量跑报「锚点命中 0 次」）；
     * 2. 我一度以为是"转义反引号"写坏，改成双引号 `\n` 拼接 —— 同样因行尾不匹配而失败。
     *
     * **结论：跨文件多行锚点在 Windows 上必须避开**（行尾不可控）。现改为**单行**变异，
     * 语义不变：把发布者信箱登记改成 `undefined` 即"编排器不再登记发布者"。
     */
    find: "          publisherRecipientId: `scheduler:${options.missionId}`,",
    replace: "          publisherRecipientId: undefined as never,",
    testFiles: ["tests/core/unit/comm01-task-publisher-feedback-route.test.ts"],
    expectedFailingTestNames: ["编排器产出的 Worker 配置里，任务带着"],
    rationale:
      "编排器不再登记发布者 ⇒ '编排器产出的 Worker 配置里带着编排器自己的信箱'必须变红" +
      "（否则这次'启用'等于没启用，反向通道又变回死代码）",
  },
  {
    mutationIdentifier: "comm01-relay-recipient-bypassed",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `    request: {
      relayRecipientAgentInstanceId: directParentAgentInstanceId,`,
    replace: `    request: {
      relayRecipientAgentInstanceId: input.targetAgentInstanceId,`,
    testFiles: ["tests/core/unit/comm01-collaboration-relay.test.ts"],
    expectedFailingTestNames: [
      "收件人**由本地按归属算出** = 目标的唯一直属上级",
      "**不允许第二上级直接下令**",
    ],
    rationale:
      "把收件人改成目标自己（绕过其唯一直属上级）后，'经唯一上级转达'必须变红" +
      "（卡内 §2.2：涉及三级/四级目标的跨上级句柄须向**其直属上级的协作收件箱**递交）",
  },
  {
    mutationIdentifier: "comm01-relay-marks-original-instruction",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `      isRelayedRequest: true,`,
    replace: `      isRelayedRequest: false as never,`,
    testFiles: ["tests/core/unit/comm01-collaboration-relay.test.ts"],
    expectedFailingTestNames: ["**显式标注为转达**（不冒充原创）"],
    rationale:
      "不再标注为转达 ⇒ 接收方会把转达请求当成直属上级的**原创指令**" +
      "（卡内 §2.2 明确：转达保留来源、转达者与任务关联，**不冒充直属上级原创**）",
  },
  {
    mutationIdentifier: "comm01-relay-parent-unavailable-not-paused",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `    return {
      isRoutable: false,
      isPausedForRecovery: true,
      reason:
        "协作目标的直属上级 \`" + directParentAgentInstanceId +`,
    replace: `    return {
      isRoutable: false,
      isPausedForRecovery: false as never,
      reason:
        "协作目标的直属上级 \`" + directParentAgentInstanceId +`,
    testFiles: ["tests/core/unit/comm01-collaboration-relay.test.ts"],
    expectedFailingTestNames: ["**原上级已不可用** ⇒ **暂停并存档**"],
    rationale:
      "原上级不可用却不再要求暂停存档 ⇒ 执行者可能被诱导自行另找上级" +
      "（卡内 §2.2：原上级不可用时暂停并存档，不让执行者自行找新上级）",
  },
  {
    mutationIdentifier: "project01-controlled-port-skips-protected-storage",
    targetFile: "packages/core/src/tools/controlled-cross-project-resource-io.ts",
    find: `    await this.protectedStoragePolicy.assertGenericToolAccessAllowed({
      canonicalTargetPath: resolvedWithinWorkspace,
      operation,
    });`,
    replace: `    if (false) {
      await this.protectedStoragePolicy.assertGenericToolAccessAllowed({
        canonicalTargetPath: resolvedWithinWorkspace,
        operation,
      });
    }`,
    testFiles: [
      "tests/core/integration/project01-controlled-resource-io-port.test.ts",
    ],
    expectedFailingTestNames: [
      "读取**保管库**内文件 ⇒ 拒绝",
      "写入**保管库** ⇒ 拒绝",
      "删除审计文件同样不得经该端口读取",
      "`fileExists` 对受保护路径也必须先判定",
    ],
    rationale:
      "受控端口不再过受保护存储判定 ⇒ '保管库/审计文件必须被拒'四条必须变红" +
      "（否则该端口就退化成 CLI 那种'拿到绝对路径就能读写'，正是卡内禁止的）",
  },
  {
    mutationIdentifier: "project01-controlled-port-skips-workspace-boundary",
    targetFile: "packages/core/src/tools/controlled-cross-project-resource-io.ts",
    find: `    const resolvedWithinWorkspace =
      await this.workspaceBoundary.resolveWithinWorkspace(absolutePath);`,
    replace: `    const resolvedWithinWorkspace = absolutePath;`,
    testFiles: [
      "tests/core/integration/project01-controlled-resource-io-port.test.ts",
    ],
    expectedFailingTestNames: [
      "读取**工作区外**的绝对路径 ⇒ 拒绝",
      "**写入**工作区外 ⇒ 拒绝",
      "`ensureDirectory` 越界 ⇒ 拒绝",
    ],
    rationale:
      "跳过工作区边界 ⇒ 工作区外路径可被读写（'拿到绝对路径就能读写'）⇒ 三条越界反例必须变红",
  },
  {
    mutationIdentifier: "project01-human-edit-guard-fails-open",
    targetFile: "packages/core/src/tools/cross-project-human-edit-guard.ts",
    find: `        return {
          hasHumanChange: true,
          reason: "目标已存在但不是普通文件（可能是目录/链接）⇒ 拒绝覆盖（fail-closed）",
        };`,
    replace: `        return {
          hasHumanChange: false,
          reason: "目标已存在但不是普通文件（可能是目录/链接）⇒ 拒绝覆盖（fail-closed）",
        };`,
    testFiles: ["tests/core/integration/project01-human-edit-guard.test.ts"],
    expectedFailingTestNames: ["目标是**目录**而非普通文件 ⇒ 判为有人工改动"],
    rationale:
      "把'非普通文件'判为无人工改动（fail-open）⇒ 可能对目录/链接路径放行覆盖 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "project01-import-guard-missing-without-baseline",
    targetFile: "packages/core/src/public-sdk.ts",
    /**
     * 注意：`public-sdk.ts` 是 **CRLF** 文件（实测 4527 个 CRLF、0 个裸 LF），
     * 多行 `find` 锚点会因换行符不同而**命中 0 次**（验证器会当场报错，不会静默跳过）。
     * 故这里用**单行锚点**。
     */
    find: `        const baselineContentHash = input.expectedTargetContentHash;`,
    replace: `        const baselineContentHash = input.expectedTargetContentHash;
        // 变异：不再回退默认守卫（用于验证"端到端可见"）
        if (true) { return undefined; }`,
    testFiles: [
      "tests/core/integration/project01-default-resource-io-assembly.test.ts",
    ],
    expectedFailingTestNames: ["目标已存在且内容**与预期一致** ⇒ 允许"],
    rationale:
      "未给基线时又不回退默认守卫 ⇒ 目标已存在恒 target-stale-rejected（'能读不能导'）" +
      "⇒ 该端到端用例必须变红",
  },
  /**
   * 2026-11-08（第 92 轮）新增：把上一轮**手工**做的两个探针固化为**永久**变异体。
   *
   * 由来：第 91 轮发现 `it("watchdog 不误续跑旧指令/未收敛取消")` 的**名字**承诺了
   * "旧指令"，但其断言只覆盖取消类三条分支；生产代码里真正对应"旧指令"的
   * `instruction-superseded` 分支**全仓零覆盖** ⇒ 该验收**有实现、无守卫**。
   * 当时靠**一次性**变异探针发现，这类探针不会自动复跑 ⇒ 一并固化，防回归。
   */
  {
    mutationIdentifier: "guide01-watchdog-resumes-superseded-instruction",
    targetFile: "packages/core/src/runtime-guidance/long-tool-checkpoint.ts",
    find: `      return { shouldResume: false, reason: "instruction-superseded" };`,
    replace: `      return { shouldResume: true, reason: "instruction-superseded" };`,
    testFiles: ["tests/core/integration/long-tool-checkpoint.test.ts"],
    expectedFailingTestNames: ["watchdog 不误续跑**旧指令**"],
    rationale:
      "把'被新指导取代的旧指令不得续跑'改成'照样续跑' ⇒ watchdog 会按**已失效的** " +
      "instructionRevision 续跑旧指令（卡内 GUIDE-01-03 明令禁止）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "diag01-execution-refusal-recorded-as-failure",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: `        !isExecutionRefusalErrorCode(toolResult.errorCode)`,
    replace: `        true`,
    testFiles: ["tests/core/integration/obs01-diag-production-collection.test.ts"],
    expectedFailingTestNames: ["执行前拒绝（工具不存在）不得记成故障"],
    rationale:
      "去掉'执行前拒绝'过滤 ⇒ 权限拒绝/工具不存在/敏感内容禁读等**确定无副作用**的拒绝" +
      "会被记成程序故障（卡内 DIAG-01 明令：拒绝与取消不得记成失败）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 93 轮）新增。由来：`AGENTS.md` 明令「底层强制约束**不进入可配置权限目录**，
   * 也不得由 TUI/CLI、帮助、导出配置、普通错误详情或模型提示**向用户披露**」，
   * 目录自己的 docstring 也写着同一句 —— 但**此前只有文档、没有守卫**：
   * 注入下面这条"内部强制层能力"后，**18 个相关测试文件 / 147 条用例全部照旧通过**。
   */
  {
    mutationIdentifier: "ar07-internal-constraint-published-in-catalog",
    targetFile: "packages/core/src/tools/permission-capability-catalog.ts",
    find: `  { capabilityId: "project.read", displayName: "项目读取",`,
    replace:
      `  { capabilityId: "internal.sensitive-content-read-denied", displayName: "敏感内容禁读（内部强制）", ` +
      `description: "内部强制执行层：不属于可配置权限", devolveDefault: "deny", assistDefault: "deny", ` +
      `applicableResources: [], riskSummary: "内部" },\n` +
      `  { capabilityId: "project.read", displayName: "项目读取",`,
    testFiles: ["tests/core/unit/ar07-internal-enforcement-non-disclosure.test.ts"],
    expectedFailingTestNames: [
      "目录文案里不得出现内部强制层的措辞",
      "每条能力的命名空间必须属于**冻结的公开清单**",
    ],
    rationale:
      "把内部强制执行层（敏感内容禁读）当成一条**可配置权限**写进目录 ⇒ 它就会出现在设置界面、" +
      "帮助与导出配置里，用户得以知晓并试图调整本应不可配置的底层约束" +
      "（AGENTS.md 强制规范与 ADR-0020 均禁止）⇒ 这两条反例必须变红",
  },
  /**
   * 2026-11-08（第 94 轮）新增两个：**思索模式白名单**与**破坏性工具自动备份**。
   * 两者本轮都被拦下（本就承重）⇒ 固化防回归。
   */
  {
    mutationIdentifier: "ponder01-write-tool-added-to-readonly-allowlist",
    targetFile: "packages/core/src/tools/local-tool-policy-engine.ts",
    find: `  "readFile",
  "listDirectory",`,
    replace: `  "readFile",
  "writeFileTemporary",
  "listDirectory",`,
    testFiles: [
      "tests/core/unit/local-tool-policy.test.ts",
      "tests/core/integration/ponder-readonly-tools-production-wiring.test.ts",
    ],
    expectedFailingTestNames: [
      "非白名单工具一律 fail-closed 并产生拒绝事件",
      "思索模式暴露只读白名单工具，隐藏写/执行类工具",
    ],
    rationale:
      "把**写类工具**塞进思索模式只读白名单 ⇒ 思索模式（AGENTS.md：编辑、进程执行、网络访问" +
      "必须由本地 harness **直接禁用**，不能仅靠提示词约束）就会向模型暴露并允许写操作" +
      "⇒ 这两条反例必须变红",
  },
  {
    mutationIdentifier: "ar07-destructive-tool-without-auto-backup-accepted",
    targetFile: "packages/core/src/core/schemas.ts",
    find: `      destructiveToolMutationKinds.has(descriptor.mutationKind) &&
      descriptor.backupPolicy !== "automatic-preimage"`,
    replace: `      false &&
      descriptor.backupPolicy !== "automatic-preimage"`,
    testFiles: ["tests/core/unit/schemas.test.ts"],
    expectedFailingTestNames: ["拒绝未提供工具内自动备份的破坏性工具"],
    rationale:
      "放宽 schema 校验 ⇒ 破坏性工具（删除/覆盖/截断…）可以**不声明**工具内自动备份即注册，" +
      "直接违反 AGENTS.md「任何删除、文本删减、替换、截断或覆盖必须由执行工具在变更前自动备份」" +
      "⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 96 轮）新增。**注意这条的 `find` 是整段表达式**：
   * 我第一次只改其中一项条件（去掉 `pathPrefixes.length > 0`），
   * 其余条件仍生效 ⇒ **变异太弱、根本没改变行为**，于是得到假结论"存活"。
   * 换成整段恒真后，该用例立刻变红。
   * ⇒ **教训：注入后必须先自问"这真的改变了被测行为吗"**（见文件头部的第 3 条纪律）。
   */
  {
    mutationIdentifier: "project01-narrowed-derivation-widening-accepted",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `    const isNarrower =
      input.resourceScope.pathPrefixes.length > 0 &&
      input.resourceScope.pathPrefixes.every((candidatePrefix) =>
        parent.resourceScope.pathPrefixes.some(
          (parentPrefix) =>
            candidatePrefix === parentPrefix || candidatePrefix.startsWith(parentPrefix),
        ),
      ) &&
      input.resourceScope.realPaths.every((candidatePath) =>
        parent.resourceScope.realPaths.includes(candidatePath),
      ) &&
      (!input.resourceScope.isDynamicSharedDirectory ||
        parent.resourceScope.isDynamicSharedDirectory);`,
    replace: `    const isNarrower = true;`,
    testFiles: ["tests/core/integration/cross-project-authorization.test.ts"],
    expectedFailingTestNames: ["任务内缩权派生：派生授权范围必须**不宽于**来源授权"],
    rationale:
      "让'派生范围必须不宽于父授权'恒真 ⇒ 任何任务都能凭父授权**扩大**自己的资源范围" +
      "（跨项目只读授权可被放大成写/越界范围，属提权）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 98 轮）新增两个（**均用"整段条件"的强变异**，吸取"弱变异"教训）：
   * 反自指/活锁保护，以及恢复检查点哈希链。
   */
  {
    mutationIdentifier: "ar07-repeat-read-suppression-removed",
    targetFile: "packages/core/src/tools/read-suppression-ledger.ts",
    find: `      currentFingerprint === null ||
      currentFingerprint.deviceInode !== entry.resourceIdentity.deviceInode ||
      (entry.contentFingerprint !== null &&
        currentFingerprint.contentFingerprint !== entry.contentFingerprint)
    ) {`,
    replace: `      true
    ) {`,
    testFiles: [
      "tests/core/integration/cross-mission-isolation-regression.test.ts",
      "tests/core/integration/read-file-view.test.ts",
      "tests/core/unit/ar07-fault-and-counterexample-gaps.test.ts",
    ],
    expectedFailingTestNames: [
      "同一 agentInstanceId 重复读取才是真正的自指读取（必须抑制）",
      "同一视图窗口内重复读取被抑制（resource-already-read）",
      "路径别名与相对段不能绕过抑制键",
    ],
    rationale:
      "把'资源确实变了'判定改成**恒真** ⇒ 同一来源短时间内重复读取**未变化**的资源不再被抑制，" +
      "模型可被诱导反复读同一文件（AGENTS.md 明令必须有本地**反自指/活锁**保护）⇒ 上述反例必须变红",
  },
  {
    mutationIdentifier: "ar07-recovery-checkpoint-chain-break-accepted",
    targetFile: "packages/core/src/orchestration/recovery-checkpoint-store.ts",
    find: `      if (
        previousTrusted !== null &&
        checkpoint.previousCheckpointHash !== previousTrusted.checkpointHash
      ) {`,
    replace: `      if (false) {`,
    testFiles: ["tests/core/unit/recovery-checkpoint-store.test.ts"],
    expectedFailingTestNames: ["哈希链断裂：前一检查点哈希不匹配 → 拒绝写入"],
    rationale:
      "跳过'前一检查点哈希必须匹配'校验 ⇒ 被篡改/错序的检查点会被当成可信状态接受，" +
      "恢复时会按**伪造的信任链**继续（审计完整性失守）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 101 轮）新增：**工作区边界**（`isPathWithin` 恒真 ⇒ 包含性判定与
   * 符号链接逃逸判定**同时**失效）。本轮实测该守卫覆盖**非常充分**（多个文件大量用例变红），
   * 固化以防回归 —— 它失守意味着可读写工作区**之外**的文件。
   */
  {
    mutationIdentifier: "workspace-boundary-escape-accepted",
    targetFile: "packages/core/src/tools/workspace-boundary.ts",
    find: `  const relativePath = path.relative(workspaceRootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );`,
    replace: `  return true;`,
    testFiles: [
      "tests/core/unit/tool-registry.test.ts",
      "tests/core/unit/protected-storage-policy.test.ts",
      "tests/core/integration/project01-controlled-resource-io-port.test.ts",
    ],
    expectedFailingTestNames: [
      "工作区内文件读取成功、逃逸被拒（WorkspaceBoundary）",
      "符号链接逃逸被拒（WorkspaceBoundary）",
      "读取**工作区外**的绝对路径 ⇒ 拒绝，且**没有读到内容**",
    ],
    rationale:
      "让'路径是否在工作区内'恒真 ⇒ `..` 逃逸与**符号链接逃逸**同时不再被拦，工具可读写工作区之外的任意路径" +
      "（AGENTS.md：真实路径/工作区/OS 边界必须由**本地确定性**策略执行）⇒ 上述反例必须变红",
  },
  /**
   * 2026-11-08（第 101 轮）新增两条：**四级委派权限不得宽于三级**（`quaternary-boundary-guards.ts`）。
   * 「求交」与「超出即拒绝分发」是**两种不同行为**，故各锁一条。本轮实测两条均被拦下 ⇒ 无缺口。
   */
  {
    mutationIdentifier: "quaternary-permission-intersection-bypassed",
    targetFile: "packages/core/src/orchestration/quaternary-boundary-guards.ts",
    find: `    return this.tertiaryGuard.computeDelegatedDecision({
      secondaryEffectiveDecision: this.options.tertiaryEffectiveDecision,
      requestedDelegatedDecision: requestedDecision,
    });`,
    replace: `    return requestedDecision;`,
    testFiles: ["tests/core/unit/quaternary-lifecycle.test.ts"],
    expectedFailingTestNames: ["四级决定 = 三级 ⊓ 请求（不宽于三级）"],
    rationale:
      "让四级权限**直接等于请求值**（不做与三级有效权限的求交）⇒ 三级可把**自己都没有的**权限授予四级，" +
      "越权沿层级向下放大（AGENTS.md：四级权限/工具/范围/期限不得宽于三级）⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "quaternary-permission-excess-delegation-accepted",
    targetFile: "packages/core/src/orchestration/quaternary-boundary-guards.ts",
    find: `    this.tertiaryGuard.assertDelegationAllowed({
      secondaryEffectiveDecision: this.options.tertiaryEffectiveDecision,
      requestedDelegatedDecision: requestedDecision,
    });`,
    replace: `    return;`,
    testFiles: ["tests/core/unit/quaternary-lifecycle.test.ts"],
    expectedFailingTestNames: ["请求宽于三级 → 拒绝分发"],
    rationale:
      "把'超出三级上限即拒绝分发'变成**空操作** ⇒ 越权请求不再被拒（只是被静默夹紧或放行），" +
      "调用方无从得知自己越界 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 102 轮）新增。由来：**本轮探针一次存活** ——
   * 把 `doesRuleMatch` 里「无 `match` 一律匹配」与「参数不可解析返回 false」两块**顺序对调**后，
   * **12 个相关文件 / 102 条用例全部照旧通过** ⇒ 该情形**此前无任何断言**；
   * 而文件自身两处表述在此情形下互相矛盾（L86-88「一律匹配」 vs L120「不套用任何规则」）。
   * 已补反例 ⑨（钉住"**仅按 action 的规则不依赖参数文本**"），并把本变异固化。
   */
  {
    mutationIdentifier: "merge01-unparseable-parameters-change-action-only-decision",
    targetFile: "packages/core/src/tools/parameter-authorization.ts",
    find: `  if (rule.match === undefined) {
    // 无 match：该 action 一律匹配（仍是显式的 action 绑定，不是通配）。
    return true;
  }
  if (parsedArguments === null) {
    return false;
  }`,
    replace: `  if (parsedArguments === null) {
    return false;
  }
  if (rule.match === undefined) {
    // 无 match：该 action 一律匹配（仍是显式的 action 绑定，不是通配）。
    return true;
  }`,
    testFiles: ["tests/core/unit/merge01-parameter-authorization.test.ts"],
    expectedFailingTestNames: ["仅按 action 的规则**不依赖参数文本**"],
    rationale:
      "对调两块后，**仅按 action 的规则**（不读参数）的判定会被'参数是否可解析'改变 ⇒ " +
      "**调用方可控的文本**（把 JSON 弄坏）就能翻转授权结果，凭空多出一个攻击面；" +
      "同时与文件自身「不可解析时不套用任何规则」的契约冲突 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 103 轮）新增：**过期的批准不得复用**（S3「过期…不得复用批准」）。
   * 本轮实测被拦下（在 **47 个相关文件 / 427 条用例**中，仅点名那条变红）⇒ 无缺口，固化防回归。
   */
  {
    mutationIdentifier: "permission-ask-expired-approval-reused",
    targetFile: "packages/core/src/orchestration/permission-ask-contract.ts",
    find: `  if (expiresAtIso !== null && Date.parse(expiresAtIso) <= Date.now()) {`,
    replace: `  if (false) {`,
    testFiles: ["tests/core/unit/gui02-01-r1-approval-fingerprint-reuse.test.ts"],
    expectedFailingTestNames: ["**超出有效期**的批准不得复用"],
    rationale:
      "跳过'批准已过期'判定 ⇒ 一份**早已失效**的批准会被无限期复用，" +
      "用户当初的逐次授权被悄悄延长（S3 明令过期不得复用）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 104 轮）新增：**重放保护**（已成功写入过同一目标 ⇒ 一律不得复用）。
   * 本轮实测被 **3 个独立文件**同时拦下 ⇒ 覆盖扎实，固化防回归。
   */
  {
    mutationIdentifier: "permission-ask-succeeded-target-replay-allowed",
    targetFile: "packages/core/src/orchestration/permission-ask-contract.ts",
    find: `  if (previousApproval.hasSucceededWithSameTarget) {
    return "already-executed";
  }`,
    replace: `  if (false) {
    return "already-executed";
  }`,
    testFiles: [
      "tests/core/unit/gui02-01-r1-approval-fingerprint-reuse.test.ts",
      "tests/tui/unit/permission-ask-reuse.test.ts",
      "tests/core/unit/gui02-01-permission-ask-fingerprint-gap.test.ts",
    ],
    expectedFailingTestNames: [
      "已成功写入过同一目标 ⇒ 一律不得复用（fail-closed 不放宽）",
      "该目标路径已成功写入过 → fail-closed（不得靠抖动绕过重放保护）",
      "已成功写入过同一目标 ⇒ 不得复用（fail-closed，现有行为已正确）",
    ],
    rationale:
      "让'已成功写入过同一目标'整条失效 ⇒ 同一次批准会被**反复套用**、" +
      "同一个写操作被**再次执行**（重放），破坏'逐次授权'语义 ⇒ 上述反例必须变红",
  },
  /**
   * 2026-11-08（第 116 轮）新增两条：**模式默认权限矩阵**（`permission-profile-store.ts`）。
   * 两条都是**提权方向**的变异；本轮实测均被拦下（覆盖充分）⇒ 固化防回归。
   */
  {
    mutationIdentifier: "permission-profile-assist-default-allowed",
    targetFile: "packages/core/src/tools/permission-profile-store.ts",
    find: `        capabilityDecisions[capability.capabilityId] = capability.assistDefault;`,
    replace: `        capabilityDecisions[capability.capabilityId] = "allow";`,
    /** 检索得到的完整文件集（13 个）—— 不手敲子集（本会话曾因此得到「假存活」）。 */
    testFiles: [
      "tests/core/unit/ar07-fault-and-counterexample-gaps.test.ts",
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/b6r10-session-shutdown-record-validity.test.ts",
      "tests/core/unit/craftsman-stage-controller.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/main-controller-facades.test.ts",
      "tests/core/unit/permission-profiles.test.ts",
      "tests/core/unit/profile-cli-contract.test.ts",
      "tests/core/unit/session-control-surface.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/shutdown-and-export-gaps.test.ts",
    ],
    expectedFailingTestNames: ["会话权限 revision 变化后旧提升仍生效（应失效）"],
    rationale:
      "让**协同模式**默认矩阵绕过目录里的 `assistDefault`、一律 `allow` ⇒ AGENTS.md 要求的" +
      "「协同模式使用**独立默认矩阵**」被抹平，危险能力在协同模式下静默放权（提权）" +
      "⇒ 本轮实测：**13 个检索命中文件**（**由检索结果直接喂入**）里 **17 条用例变红**",
  },
  {
    mutationIdentifier: "permission-profile-fallback-allow",
    targetFile: "packages/core/src/tools/permission-profile-store.ts",
    find: `      fallbackDecision: "deny",`,
    replace: `      fallbackDecision: "allow",`,
    testFiles: ["tests/core/unit/elevation-persistence.test.ts"],
    expectedFailingTestNames: ["baseProfileRevision/catalogVersion 不匹配 → 覆盖失效（305）"],
    rationale:
      "把内置 profile 的**兜底判定**由 `deny` 改成 `allow` ⇒ 目录里**未出现/未验证**的能力不再默认拒绝" +
      "（fail-open；AGENTS.md：`deny` 优先、未验证范围归人工裁决）⇒ 本轮实测 **2 条用例变红**",
  },
  /**
   * 2026-11-08（第 117 轮）新增：**删除备份审计的"高查阅优先级"不得被降级**
   * （AGENTS.md：放权模式不提示但写入**高查阅优先级**审计日志）。
   *
   * 本条探针另有**诊断价值**：若测试只是拿常量自比（`reviewPriority === BACKUP_DELETION_AUDIT_PRIORITY`），
   * 改常量就**抓不到** ⇒ 本条会"存活"。实测**被 3 条用例拦下** ⇒ 那些断言**不是同义反复**。
   */
  {
    mutationIdentifier: "backup-audit-review-priority-downgraded",
    targetFile: "packages/core/src/core/types.ts",
    find: `export const BACKUP_DELETION_AUDIT_PRIORITY = "high" as const;`,
    replace: `export const BACKUP_DELETION_AUDIT_PRIORITY = "normal" as const;`,
    /** 检索得到的完整文件集（4 个）—— 不手敲子集。 */
    testFiles: [
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/backup-vault.test.ts",
      "tests/core/unit/builtins.test.ts",
      "tests/core/unit/frozen-decisions.test.ts",
    ],
    expectedFailingTestNames: ["删除备份审计记录使用高查阅优先级"],
    rationale:
      "把删除备份审计记录的查阅优先级由 `high` 降为 `normal` ⇒ 规则要求的「**高查阅优先级**审计日志」被静默降级，" +
      "高优先级审计的意义（先被人看到）丢失 ⇒ 本反例必须变红",
  },
  /**
   * 2026-11-08（第 117 轮）新增：**跨项目授权裁决的第一条 —— `deny` 优先**。
   * `AGENTS.md`：`deny` 优先；任何"显式拒绝"都必须整体拒绝，不能被其它侧允许或模式放宽覆盖。
   */
  {
    mutationIdentifier: "cross-project-deny-precedence-bypassed",
    targetFile: "packages/core/src/orchestration/cross-project-authorization-store.ts",
    find: `  if (input.requestedResourceIsDenied === true) {`,
    replace: `  if (false && input.requestedResourceIsDenied === true) {`,
    /**
     * 检索得到的完整文件集（9 个）—— **由检索结果直接写入**。
     *
     * ⚠️ 我第一版**手敲**了这份清单（凭印象写了两个不相关的文件、漏掉了
     * `cross-project-permission-matrix.test.ts`）⇒ 该变异被误判为"存活"（第 117 轮，本会话第 4 次同类错误）。
     */
    testFiles: [
      "tests/core/integration/cross-project-authorization.test.ts",
      "tests/core/integration/cross-project-crash-after-write.test.ts",
      "tests/core/integration/cross-project-isolation-multi-project.test.ts",
      "tests/core/integration/cross-project-public-entry.test.ts",
      "tests/core/integration/cross-project-resource-io.test.ts",
      "tests/core/integration/cross-project-sdk-entry.test.ts",
      "tests/core/integration/cross-project-stale-overwrite.test.ts",
      "tests/core/unit/cross-project-permission-matrix.test.ts",
      "tests/tui/unit/cross-project-transfer-cli-entry.test.ts",
    ],
    expectedFailingTestNames: ["显式拒绝优先：即使其它侧允许也不放行"],
    rationale:
      "让跨项目裁决里「**显式拒绝优先**」这条永不触发 ⇒ 显式 deny 会被其它侧的允许或模式放宽盖过，" +
      "`deny` 优先这条底线失守 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 118 轮）新增：**反馈消息的来源必须具体到某个个体**
   * （`AGENTS.md`：每条反馈消息必须携带经过 schema 校验的信息来源；**Agent 来源必须具体到
   * 不可复用的 `agentInstanceId`**，转发时保留原始来源）。
   *
   * **本条是"探针存活 ⇒ 补守卫 ⇒ 固化"的产物**：把 agent 分支的 `agentInstanceId`
   * 由 `z.string().min(1)` 放宽为 `z.string()`（允许空串）后，原本 **12 个检索命中文件 / 150 条用例
   * 全部照旧通过** ⇒ 规则无人守。已补反例（`tests/core/unit/schemas.test.ts`
   * 「Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝」）并把本变异固化。
   *
   * ⚠️ 该条目的 `testFiles` **由检索结果直接写入**（本会话已因手敲清单出现过两次假结论）。
   */
  {
    mutationIdentifier: "feedback-agent-source-identity-emptied",
    targetFile: "packages/core/src/core/schemas.ts",
    find: `      agentInstanceId: z.string().min(1),`,
    replace: `      agentInstanceId: z.string(),`,
    testFiles: [
      "tests/core/integration/comm01-delivery-address-integrity.test.ts",
      "tests/core/integration/feedback-process.test.ts",
      "tests/core/integration/guidance-safe-point.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/delivery-worker.test.ts",
      "tests/core/unit/feedback-client.test.ts",
      "tests/core/unit/feedback-entrypoint.test.ts",
      "tests/core/unit/mailbox-journal.test.ts",
      "tests/core/unit/main-controller.test.ts",
      "tests/core/unit/mission-orchestrator-lease.test.ts",
      "tests/core/unit/orchestration.test.ts",
      "tests/core/unit/schemas.test.ts",
    ],
    expectedFailingTestNames: ["Agent 来源必须具体到某个个体：空 agentInstanceId 一律拒绝"],
    rationale:
      "让反馈消息 agent 来源的 `agentInstanceId` 接受**空串** ⇒ 来源不再\"具体到某个个体\"，" +
      "身份归属在执行层丢失（转发时也无法保留原始来源）⇒ 本反例必须变红",
  },
  /**
   * 2026-11-08（第 119 轮）新增：**转达必须保留原始来源**（不得冒充原创）。
   *
   * `AGENTS.md`：每条反馈消息必须携带经过 schema 校验的信息来源；**转发时保留原始来源**；
   * 且仓库里 `core/types.ts` 明写「转发消息必须保留原始来源，**不能把路由或转发 Agent 记录为原始来源**」。
   *
   * 本轮实测被 `tests/core/unit/comm01-collaboration-relay.test.ts` 的
   * 「② 转达**保留原始来源、转达者与任务关联**，且**显式标注为转达**（不冒充原创）」拦下 ⇒ 覆盖确证，固化防回归。
   *
   * ⚠️ 该条目的 `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "relay-records-relayer-as-original-source",
    targetFile: "packages/core/src/orchestration/collaboration-relay-via-parent.ts",
    find: `      originalSourceAgentInstanceId: input.originalSourceAgentInstanceId,`,
    replace: `      originalSourceAgentInstanceId: directParentAgentInstanceId,`,
    testFiles: [
      "tests/core/unit/comm01-collaboration-relay.test.ts",
    ],
    expectedFailingTestNames: ["转达**保留原始来源、转达者与任务关联**"],
    rationale:
      "把转达请求里的 `originalSourceAgentInstanceId` 记成**转达者（直属上级）**⇒ " +
      "原始来源被顶替、转达冒充原创（`core/types.ts` 明令禁止）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 120 轮）新增：**个体记忆追加观察必须保留原始来源**
   * （`agent-individual-memory.ts`：「接收方保留原始来源与附件哈希；**不得去除来源冒充自身记忆**」；
   * `AGENTS.md`：跨 Agent 仅可经本地控制器显式选择条目，附件只用于当前任务且**不得自动并入接收方长期记忆**）。
   *
   * 变异把观察的 `sourceAgentInstanceId` 记成**接收方自己**（等于"去除来源冒充自身记忆"）。
   * 本轮实测被 `tests/core/unit/agent-lifecycle-and-memory.test.ts` 的
   * 「两个同级 Agent 相同任务文本下记忆完全隔离」拦下 —— 且该用例是**直接断言**：
   * `expect(memoryB?.observations[0]?.sourceAgentInstanceId).toBe("tertiary-a")`
   * （注释原文「B 的观察保留原始来源与附件哈希」）⇒ 覆盖**直接且正确**，固化防回归。
   *
   * ⚠️ 该条目的 `testFiles` **由检索结果直接写入**（不手敲）。
   */
  /**
   * 2026-11-08（第 121 轮）新增：**专用流程不得被范围解析放宽**。
   *
   * `scope-resolution.ts` 文件头明写「deny 一律优先；安装类必须有独立开关；
   * **专用流程（远端发布/备份删除）不被本模块放宽**」——`S7-special-flow` 必须恒为 `ask-user`。
   *
   * 本轮实测被 `tests/core/integration/auth-scope-resolution.test.ts` 拦下，且该文件里是**直接断言**：
   * 放权模式 + `configuredDecision: "allow"` 下 `S7-special-flow` 必须得到
   * `{decision: "ask-user", adjudicator: "dedicated-flow"}`（位于「矩阵」用例内）。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  /**
   * 2026-11-08（第 121 轮）新增：**安装类操作必须受独立开关约束**（开关关闭一律拒绝）。
   *
   * `AGENTS.md`：安装/外部软件操作必须先由本地控制面判定实际作用范围；
   * 「**开关不得代替授权**，不得使用会话记忆、Agent 推断或批量许可放行」。
   *
   * 本轮实测被 3 条用例拦下，其中 `tests/core/integration/auth-scope-resolution.test.ts` 的
   * 「安装类：开关关闭一律拒绝（协同/放权相同）」是**直接点名**该行为的用例。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "scope-installation-switch-bypassed",
    targetFile: "packages/core/src/tools/scope-resolution.ts",
    /** ⚠️ 锚点必须**唯一**：`if (!input.isInstallationEnabled)` 在文件里出现**两次**
     *（S5 安装类与 S1+安装操作两条分支同形）⇒ 带上 S5 分支头一起匹配。 */
    find: `  if (input.scopeClass === "S5-installation") {\n    if (!input.isInstallationEnabled) {`,
    replace: `  if (input.scopeClass === "S5-installation") {\n    if (false && !input.isInstallationEnabled) {`,
    testFiles: [
      "tests/core/integration/auth-scope-gate.test.ts",
      "tests/core/integration/auth-scope-install-routing.test.ts",
      "tests/core/integration/auth-scope-resolution.test.ts",
      "tests/core/integration/permission-refusal-side-effect.test.ts",
      "tests/core/integration/reliability-fault-injection-reservation.test.ts",
      "tests/core/integration/scope-authorization-regrant.test.ts",
      "tests/core/integration/scope-consumption-semantics.test.ts",
      "tests/core/integration/scope-reservation-settlement.test.ts",
      "tests/core/integration/scope-tool-mapping.test.ts",
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/assist-installation-gate.test.ts",
      "tests/core/unit/gui02-02-installation-gate-guard-branches.test.ts",
      "tests/core/unit/gui02-02-installation-gate-interface-port.test.ts",
      "tests/core/unit/installation-gate-execution.test.ts",
    ],
    expectedFailingTestNames: ["安装类：开关关闭一律拒绝（协同/放权相同）"],
    rationale:
      "让 S5 安装类的「独立安装开关关闭 ⇒ 拒绝」永不触发 ⇒ 安装开关形同虚设、" +
      "**开关之外再无门禁**（`AGENTS.md` 明令开关不得被替代、不得被绕过）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 122 轮）新增：**三级期限求交必须"取更早"**（不得晚于次级有效期限）。
   *
   * `session-permission-elevation.ts` 的 `TertiaryPermissionDelegationGuard.computeDelegatedExpiry`：
   * 「三级请求期限**不得晚于**次级有效期限（取更早）」。变异把三元真分支改成请求值
   * ⇒ 求交**永不收紧**，三级可拿到比次级更长的有效期。
   *
   * 本轮实测被 3 条用例拦下（含「期限求交结果不晚于任一输入且取自输入之一」、
   * 「三级权限逐项求交：三态/资源范围/期限均不得宽于次级」）⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "tertiary-delegated-expiry-never-narrowed",
    targetFile: "packages/core/src/tools/session-permission-elevation.ts",
    find: `      ? input.secondaryExpiresAtIso`,
    replace: `      ? input.requestedExpiresAtIso`,
    testFiles: [
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-property-invariants.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/toolkit01-upgrade-authorization.test.ts",
    ],
    expectedFailingTestNames: ["期限求交结果不晚于任一输入且取自输入之一"],
    rationale:
      "把三级期限求交的真分支改成**请求值** ⇒ 求交永不收紧，三级拿到比次级**更长的有效期**" +
      "（AGENTS.md：次级分发给三级的权限必须是其**当前有效权限的等于或更窄子集**）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 123 轮）新增：**会话提升的"到期"必须使其失效**。
   *
   * `AGENTS.md`：当前会话允许认证用户临时提升次级 Agent 的公开权限；提升绑定会话、作用域、
   * 权限项、**有效期**和 revision，**可随时撤销**，关闭会话即失效。
   *
   * 变异把 `record.expiresAtIso !== null &&` 改成 `false &&` ⇒ **到期判定永不生效**，
   * 已过期的提升会继续生效（权限被无限期延长）。
   *
   * 本轮实测被 `tests/core/unit/session-permission-elevation.test.ts` 的
   * 「到期/profile revision/目录版本变化/Agent 回收使覆盖失效」拦下（该用例内直接有
   * 「// 未到期生效」与到期边界断言）⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "elevation-expiry-invalidation-disabled",
    targetFile: "packages/core/src/tools/session-permission-elevation.ts",
    find: `          record.expiresAtIso !== null &&`,
    replace: `          false &&`,
    testFiles: [
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/b6r10-session-shutdown-record-validity.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/session-control-surface.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/shutdown-and-export-gaps.test.ts",
    ],
    expectedFailingTestNames: ["到期/profile revision/目录版本变化/Agent 回收使覆盖失效"],
    rationale:
      "让提升的**到期判定永不生效** ⇒ 过期提升继续放权，用户当初的临时提升被无限期延长" +
      "（`AGENTS.md`：提升绑定**有效期**、可随时撤销）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 124 轮）新增：**个体提升必须只作用于该具体次级 Agent**。
   *
   * `AGENTS.md`：临时提升「默认作用于该会话全部现有及后续次级 Agent，**也可显式限定具体次级**」
   * ⇒ 限定到个体的覆盖**不得外溢**到同级其他个体。
   *
   * 变异把个体范围判定改成 `return true;` ⇒ 个体提升**泄漏到所有次级 Agent**（越权）。
   *
   * 本轮实测被 2 条用例拦下，且两条**直接点名**该性质：
   * 「个体提升不传播到其他次级 Agent（隔离）」「会话级覆盖应用于全部现有及后续次级 Agent；个体覆盖隔离」
   * ⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "elevation-individual-scope-always-applies",
    targetFile: "packages/core/src/tools/session-permission-elevation.ts",
    find: `          return record.scope.agentInstanceId === input.agentInstanceId;`,
    replace: `          return true;`,
    testFiles: [
      "tests/core/unit/b6r10-session-shutdown-record-validity.test.ts",
      "tests/core/unit/craftsman-disclosure.test.ts",
      "tests/core/unit/craftsman-schemas.test.ts",
      "tests/core/unit/craftsman-stage-controller.test.ts",
      "tests/core/unit/elevation-effectiveness.test.ts",
      "tests/core/unit/elevation-persistence.test.ts",
      "tests/core/unit/main-controller-facades.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
      "tests/core/unit/shutdown-and-export-gaps.test.ts",
    ],
    expectedFailingTestNames: ["个体提升不传播到其他次级 Agent（隔离）"],
    rationale:
      "让限定到**具体个体**的会话提升恒成立 ⇒ 该提升被应用到同级**所有**次级 Agent，" +
      "个体隔离失守、越权扩散（AGENTS.md：个体覆盖只作用于该具体次级）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 126 轮）新增：**参数指纹必须绑定完整规范化参数**（内容变化 ⇒ 指纹变化）。
   *
   * 这条就是 **R1 修掉的历史缺陷本身**：旧实现只比"工具名 + 目标路径"，
   * 导致「同一路径、**内容不同**」也复用批准（与 S3"绑定完整参数指纹"冲突）。
   * `permission-policy.ts` 的 `serializeCanonical` 负责**递归键序规范化**后再 sha256。
   *
   * 变异让规范化**只保留键名、丢掉值** ⇒ 内容变化不再改变指纹 ⇒ 批准可跨内容复用。
   *
   * 本轮实测被 **7 条用例**拦下，**两个方向都有直接断言**：
   * 「② 指纹绑定**完整规范化参数**：内容变化 ⇒ 指纹不同；键序变化 ⇒ 指纹相同」、
   * 「① 【消除缺陷】同一目标路径、**内容不同** ⇒ 必须重新询问」、「① 【R1 已修】…必须 ask-user」、
   * 「语义等价、键序不同 → 规范化与哈希一致；值/数组顺序变化仍敏感」等。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  /**
   * 2026-11-08（第 127 轮）新增：**投递按 idempotencyKey 去重**（同一客户端生命周期内）。
   *
   * `feedback-process/transport.ts` 的 `handleDelivery`：若该 `idempotencyKey` 已投递过，
   * **只回 ack、不再触发 handler**。变异去掉该判定 ⇒ 重复投递会**重复触发处理**
   *（重复副作用；`AGENTS.md`：反馈消息必须携带经 schema 校验的来源，且同一消息不得重复处理）。
   *
   * 本轮实测被 `tests/core/unit/feedback-client.test.ts` 的
   * 「同 idempotencyKey 重复投递只调用 handler 一次并自动 ack」**直接点名**拦下 ⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（此处用较宽检索，覆盖 FeedbackClient 家族）。
   */
  {
    mutationIdentifier: "feedback-delivery-dedup-disabled",
    targetFile: "packages/core/src/feedback-process/transport.ts",
    find: `    if (this.deliveredIdempotencyKeys.has(message.idempotencyKey)) {`,
    replace: `    if (false && this.deliveredIdempotencyKeys.has(message.idempotencyKey)) {`,
    testFiles: [
      "tests/core/integration/comm01-delivery-address-integrity.test.ts",
      "tests/core/integration/feedback-process.test.ts",
      "tests/core/integration/guidance-safe-point.test.ts",
      "tests/core/integration/instruction-continuous-reception.test.ts",
      "tests/core/integration/instruction-stop-recovery.test.ts",
      "tests/core/integration/instruction-window-persistence-branches.test.ts",
      "tests/core/integration/instruction-window-queue.test.ts",
      "tests/core/integration/mcp-stdio-session.test.ts",
      "tests/core/integration/mcp-tool-bridge.test.ts",
      "tests/core/integration/merge01-window-intention-counting.test.ts",
      "tests/core/integration/reliability-before-dispatch-crash.test.ts",
      "tests/core/integration/reliability-r4-ledger-concurrency.test.ts",
      "tests/core/integration/reliability-r4-ledger-corruption.test.ts",
      "tests/core/integration/reliability-sdk-idempotency.test.ts",
      "tests/core/integration/smart01-window-deadline-entry.test.ts",
      "tests/core/unit/application-sdk-task-events.test.ts",
      "tests/core/unit/ar07-module-gaps-6.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/craftsman-disclosure-action.test.ts",
      "tests/core/unit/craftsman-disclosure.test.ts",
      "tests/core/unit/craftsman-schemas.test.ts",
      "tests/core/unit/delivery-worker.test.ts",
      "tests/core/unit/feedback-client.test.ts",
      "tests/core/unit/feedback-entrypoint.test.ts",
      "tests/core/unit/feedback-supervisor.test.ts",
      "tests/core/unit/mailbox-journal.test.ts",
      "tests/core/unit/schemas.test.ts",
      "tests/tui/unit/cli-commands.test.ts",
      "tests/tui/unit/run-command-gaps.test.ts",
      "tests/tui/unit/smart01-instruction-cli-entry.test.ts",
      "tests/tui/unit/tui-launch.test.ts",
    ],
    expectedFailingTestNames: ["同 idempotencyKey 重复投递只调用 handler 一次并自动 ack"],
    rationale:
      "去掉投递去重判定 ⇒ 同一条消息被投递两次时会**重复触发 handler**（重复副作用），" +
      "破坏\"同一消息只处理一次\"的契约 ⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 128 轮）新增：**指令幂等：同键异参必须拒绝、不得覆盖**。
   *
   * `instruction-window-store.ts` 文件头：「② 同键异参（`idempotencyKey` 相同但内容哈希不同）
   * → **拒绝**，不覆盖」。变异去掉该判定 ⇒ 同键异参被**当作新指令接纳/覆盖**，
   * 既有用户指导可能被静默替换。
   *
   * 本轮实测被 `tests/core/integration/instruction-window-persistence-branches.test.ts` 的
   * 「② 同键异参：必须拒绝，不得覆盖既有指令」**直接点名**拦下 ⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "instruction-idempotency-conflict-overwrites",
    targetFile: "packages/core/src/orchestration/instruction-window-store.ts",
    find: `        if (existing.contentHash !== contentHash) {`,
    replace: `        if (false && existing.contentHash !== contentHash) {`,
    testFiles: [
      "tests/core/integration/instruction-continuous-reception.test.ts",
      "tests/core/integration/instruction-stop-recovery.test.ts",
      "tests/core/integration/instruction-window-persistence-branches.test.ts",
      "tests/core/integration/instruction-window-queue.test.ts",
      "tests/core/integration/merge01-window-intention-counting.test.ts",
      "tests/core/integration/usage-ledger-persistence.test.ts",
      "tests/tui/unit/smart01-instruction-cli-entry.test.ts",
    ],
    expectedFailingTestNames: ["同键异参：必须拒绝，不得覆盖既有指令"],
    rationale:
      "让「同键异参」不再被拒绝 ⇒ 内容不同的同键指令被当作新指令接纳，" +
      "**既有指令可能被静默覆盖**（同键异参必须拒绝这一契约失守）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 131 轮）新增：**无进展签名不得包含自由文本**（否则守卫形同虚设）。
   *
   * 这条正是第 130 轮**实测踩到的真 bug**：签名写成
   * `"error:" + errorCode + ":" + errorMessage` 时，`resource-already-read` 的错误文本里带
   * **倒计时字段**（`remainingWaitMilliseconds`）⇒ 签名每次都不同 ⇒ `isNewProgress` 恒真 ⇒
   * 无进展永不累计 ⇒ 守卫永不触发（请求数跑满 `maximumLoopIterations`）。
   *
   * 实测被 `tests/core/integration/g2-progress-guard.test.ts` 的
   * 「启用守卫后必须显著早于上限中止」拦下（守卫开了也照样跑满上限）⇒ 覆盖直接，固化防回归。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**（不手敲）。
   */
  {
    mutationIdentifier: "progress-guard-signature-includes-volatile-text",
    targetFile: "packages/core/src/runtime/tool-loop.ts",
    find: `            : "error:" + toolResult.errorCode;`,
    replace: `            : "error:" + toolResult.errorCode + ":" + toolResult.errorMessage;`,
    testFiles: [
      "tests/core/integration/g2-progress-guard.test.ts",
    ],
    expectedFailingTestNames: ["启用守卫后必须显著早于上限中止"],
    rationale:
      "把无进展签名退回为**含自由文本** ⇒ 带倒计时/时间戳的错误文本使签名每次都变、" +
      "`isNewProgress` 恒真、守卫永不触发（**这正是第 130 轮实测的 bug**）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 133 轮）新增：**高严谨性必须被本地规则真正标记出来**。
   *
   * 变异把判定条件从 `=== "high"` 改成 `=== "standard"`（即**永远不为真**）⇒
   * 高严谨任务不再被标记 ⇒ 不再强制 `factVerification` ⇒ 「证据包缺失也不得结案」形同虚设。
   *
   * 实测被 `tests/core/integration/g3-high-rigor-evidence.test.ts` 的
   * 「高严谨 + 开关开 + 只发完成事件（未调 factVerification）⇒ 不得 done」拦下。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**。
   */
  {
    mutationIdentifier: "high-rigor-marking-never-matches",
    targetFile: "packages/core/src/orchestration/mission-orchestrator.ts",
    find: `      new LocalRigorPolicyEngine().classifyRigor(task.description).rigorLevel === "high"`,
    replace: `      new LocalRigorPolicyEngine().classifyRigor(task.description).rigorLevel === "standard"`,
    testFiles: [
      "tests/core/integration/completion-gate-counterexamples.test.ts",
      "tests/core/integration/evidence-and-identifiers-production-wiring.test.ts",
      "tests/core/integration/g3-high-rigor-evidence.test.ts",
      "tests/core/integration/scope-tool-mapping.test.ts",
      "tests/core/unit/completion-protocol.test.ts",
      "tests/core/unit/evidence-verification.test.ts",
      "tests/core/unit/permission-profiles.test.ts",
      "tests/core/unit/session-control-surface.test.ts",
      "tests/core/unit/session-permission-elevation.test.ts",
    ],
    expectedFailingTestNames: ["高严谨 + 开关开 + 只发完成事件（未调 factVerification）⇒ 不得 done"],
    rationale:
      "让高严谨标记恒不命中 ⇒ 本地规则形同虚设、证据包永不强制" +
      "（AGENTS.md：高严谨任务必须被本地规则标记并强制形成证据包）⇒ 该反例必须变红",
  },
  /**
   * 2026-11-08（第 159 轮）新增：**接线清单必须能发现"构造点被拔掉"**。
   *
   * 变异把装配层的 `new LocalProgressAndCycleGuard()` 换成空对象 ⇒
   *  - `wiring-manifest.test.ts` 的"标为已构造的组件必须在源码里被构造"必须变红（**这是本条要守的东西**）；
   *  - 同时 `g2-progress-guard` 的"有界中止"也会红（守卫不再生效）。
   *
   * ⇒ 用来证明那张清单**真有判别力**，而不是一句注释。
   *
   * ⚠️ `testFiles` **由检索结果直接写入**。
   */
  {
    mutationIdentifier: "wiring-manifest-constructor-removed",
    targetFile: "packages/core/src/application/application-runtime.ts",
    find: `new LocalProgressAndCycleGuard({`,
    replace: `new (class extends LocalProgressAndCycleGuard { async recordCallAndDetectViolation() { return null; } })({`,
    testFiles: [
      "tests/core/integration/g2-progress-guard.test.ts",
      "tests/core/unit/ar07-module-gaps-5.test.ts",
      "tests/core/unit/ar07-module-gaps-8.test.ts",
      "tests/core/unit/read-suppression-and-guard.test.ts",
      "tests/core/unit/wiring-manifest.test.ts",
    ],
    expectedFailingTestNames: [
      "标 `constructed` 的组件必须在装配/编排源码里被构造（被拔线 ⇒ 红）",
      "启用守卫后必须显著早于上限中止",
    ],
    rationale:
      "拔掉装配层的构造点 ⇒ 接线清单与 G2 行为反例都必须变红；" +
      "若它们不变红，说明那张清单只是注释、没有判别力",
  },
  /**
   * 2026-10-17（第 2 轮）新增：**五门禁必须 fail-closed**：任何一门缺失都不得判定 merge-ready
   *
   * ⚠️ `testFiles` **由检索结果直接写入**。
   */
  {
    mutationIdentifier: "merge-readiness-always-allowed",
    targetFile: "packages/core/src/orchestration/git-merge-readiness.ts",
    find: `  return unmetGateNames.length === 0
    ? { isMergeReady: true, unmetGateNames: [] }
    : { isMergeReady: false, unmetGateNames };`,
    replace: `  return { isMergeReady: true, unmetGateNames: [] }; // MUTANT`,
    testFiles: [
      "tests/core/unit/g1-merge-readiness.test.ts",
    ],
    expectedFailingTestNames: ["缺提交哈希 ⇒ 不可合并，且点名「提交哈希」"],
    rationale: "把【缺项即不可合并】改成【永远可合并】⇒ 缺项反例必须变红",
  },
  /**
   * 2026-10-17（第 2 轮）新增：**完整用法末尾必须附固定提醒**（`AGENTS.md`：后续只注入提醒）
   *
   * ⚠️ `testFiles` **由检索结果直接写入**。
   */
  {
    mutationIdentifier: "tool-documentation-renderer-omits-reminder",
    targetFile: "packages/core/src/tools/tool-documentation-renderer.ts",
    find: `  sections.push(buildReminderText());`,
    replace: `  // MUTANT：漏掉固定提醒`,
    testFiles: [
      "tests/core/integration/g4-tool-documentation-injection.test.ts",
      "tests/core/unit/g4-tool-documentation-renderer.test.ts",
    ],
    expectedFailingTestNames: ["整组：**末尾必须附固定提醒**（模型据此请求帮助）"],
    rationale: "漏掉提醒 ⇒ 渲染器【末尾提醒】反例必须变红",
  },
  {
    mutationIdentifier: "relocate-registration-accepts-unknown-version",
    targetFile: "packages/core/src/orchestration/project-location-registration.ts",
    find: `  if (rawSchemaVersion !== 1) {`,
    replace: `  if (false) {`,
    testFiles: ["tests/core/unit/relocate01-location-registration.test.ts"],
    expectedFailingTestNames: ["④ 不认识的 schemaVersion"],
    rationale: "未知版本必须拒绝；若放行，版本反例必须变红",
  },
  {
    mutationIdentifier: "relocate-confirmation-allows-model-signoff",
    targetFile: "packages/core/src/orchestration/project-relocation-confirmation.ts",
    find: `  if (input.isHumanConfirmed !== true) {`,
    replace: `  if (false) {`,
    testFiles: ["tests/core/unit/relocate01-confirmation.test.ts"],
    expectedFailingTestNames: ["① 模型/自动流程代签"],
    rationale: "重定位必须由认证用户本人确认；放行代签 ⇒ 代签反例必须变红",
  },
  {
    mutationIdentifier: "relocate-apply-skips-backup",
    targetFile: "packages/core/src/orchestration/project-relocation-apply.ts",
    find: `    await ioPort.writeBackup(input.previousRegistration);`,
    replace: `    void 0; // MUTANT：跳过备份`,
    testFiles: ["tests/core/unit/relocate01-apply-and-copy.test.ts"],
    expectedFailingTestNames: ["③ 正常应用"],
    rationale: "必须先备份后写；跳过备份 ⇒ 顺序反例必须变红",
  },
  {
    mutationIdentifier: "relocate-path-resolution-ignores-whitelist",
    targetFile: "packages/core/src/orchestration/project-relocation-path-resolution.ts",
    find: `  if (!input.declaredStructuredResourceKinds.includes(reference.resourceKind)) {`,
    replace: `  if (false) {`,
    testFiles: ["tests/core/unit/relocate01-path-resolution.test.ts"],
    expectedFailingTestNames: ["② 未声明的种类"],
    rationale: "只有 schema 声明过的结构化资源才可改写；放行全部 ⇒ 未声明种类反例必须变红",
  },
  {
    mutationIdentifier: "relocate-recovery-replays-completed",
    targetFile: "packages/core/src/orchestration/project-relocation-recovery-gate.ts",
    find: `  if (operation.isCompleted) {`,
    replace: `  if (false) {`,
    testFiles: ["tests/core/unit/relocate01-recovery-gate.test.ts"],
    expectedFailingTestNames: ["① 已确认完成"],
    rationale: "已确认完成的操作绝不重放；放行 ⇒ 重放反例必须变红",
  },
  {
    mutationIdentifier: "relocate-controller-legacy-as-unregistered",
    targetFile: "packages/core/src/orchestration/project-relocation-controller.ts",
    find: `        isRegistrationCorrupted: readOutcome.kind === "legacy",`,
    replace: `        isRegistrationCorrupted: false,`,
    testFiles: ["tests/core/integration/relocate01-readonly-controller.test.ts"],
    expectedFailingTestNames: ["④ 旧格式登记"],
    rationale: "旧格式登记必须走旧格式流程而不是记为未登记；退化 ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "relocate-store-corrupt-as-absent",
    targetFile: "packages/core/src/orchestration/project-location-registration-store.ts",
    find: `      return { kind: "invalid", reason: "登记文件不是合法 JSON；需按待恢复处理，不伪称验证成功。" };`,
    replace: `      return { kind: "absent", reason: "MUTANT：坏 JSON 当作未登记" };`,
    testFiles: ["tests/core/unit/relocate01-registration-store.test.ts"],
    expectedFailingTestNames: ["④ 登记文件是坏 JSON"],
    rationale: "坏 JSON 必须如实报 invalid；当作 absent ⇒ 该反例必须变红",
  },
  {
    mutationIdentifier: "run-history-drops-dedupe",
    targetFile: "packages/core/src/orchestration/run-history-store.ts",
    find: `    if (isDuplicate) {`,
    replace: `    if (false) {`,
    testFiles: ["tests/core/unit/history01-run-history-store.test.ts"],
    expectedFailingTestNames: ["③ 重复事件 ⇒ **去重**"],
    rationale: "重复事件必须去重；放行 ⇒ 去重反例必须变红",
  },
];

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseJsonReport(reportPath) {
  const rawText = readFileSync(reportPath, "utf8");
  const trimmed = rawText.trim();
  // vitest --reporter=json 可能带前导日志行，取第一个 '{' 起解析。
  const startIndex = trimmed.indexOf("{");
  if (startIndex === -1) {
    throw new Error("未找到 JSON 报告内容");
  }
  return JSON.parse(trimmed.slice(startIndex));
}

function collectFailedTestNames(report) {
  const failedNames = new Set();
  for (const testResult of report.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failedNames.add(String(assertion.fullName ?? assertion.title ?? ""));
      }
    }
  }
  return failedNames;
}

function runMutation(mutation, options) {
  const targetPath = path.join(repositoryRootDirectory, mutation.targetFile);
  const originalContent = readFileSync(targetPath, "utf8");
  const originalDigest = sha256OfFile(targetPath);

  const occurrenceCount = originalContent.split(mutation.find).length - 1;
  if (occurrenceCount !== 1) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage:
        `锚点在 ${mutation.targetFile} 中命中 ${occurrenceCount} 次（要求恰好 1 次）——` +
        "说明源码已改动，请同步更新脚本里的 find 片段（不要让它静默跳过）",
      failedTestNames: [],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const mutatedContent = originalContent.replace(mutation.find, mutation.replace);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "astarray-mutation-"));
  const reportPath = path.join(temporaryDirectory, "vitest-report.json");

  let failedTestNames = new Set();
  let runError = null;
  try {
    writeFileSync(targetPath, mutatedContent, "utf8");
    try {
      execFileSync(
        process.execPath,
        [
          path.join(repositoryRootDirectory, "node_modules", "vitest", "vitest.mjs"),
          "run",
          ...mutation.testFiles,
          "--reporter=json",
          `--outputFile=${reportPath}`,
        ],
        { cwd: repositoryRootDirectory, stdio: "inherit" },
      );
      // 注入了反事实 ⇒ 期望 vitest 失败；若这里正常返回说明"用例没红"。
      runError = "vitest 在注入反事实后仍然通过（该变异存活）";
    } catch {
      // 期望路径：存在失败用例。
    }
    try {
      const report = parseJsonReport(reportPath);
      /**
       * 2026-10-17（第 5 轮）守卫：**变异体自身语法错误 ⇒ 脚本错误，不是"存活"**。
       *
       * 现象（我踩过 2 次）：`find` 只截取表达式的一部分 ⇒ 变异后语法错误 ⇒ 测试文件**无法收集**
       * （`assertionResults` 为空、但有 `message`）⇒ 命名用例根本不会运行 ⇒ 若不特判会被误算为"存活"。
       */
      const collectFailures = (report.testResults ?? []).filter(
        (testResult) =>
          (testResult.assertionResults ?? []).length === 0 &&
          typeof testResult.message === "string" &&
          testResult.message.trim() !== "",
      );
      if (collectFailures.length > 0) {
        return {
          mutationIdentifier: mutation.mutationIdentifier,
          isKilled: false,
          isScriptError: true,
          errorMessage:
            "变异使测试文件无法收集（语法/转换错误）：请把 find 改为完整表达式，或让 replace 语法合法。首条信息：" +
            String(collectFailures[0].message).slice(0, 300),
          failedTestNames: [],
          expectedFailingTestNames: mutation.expectedFailingTestNames,
        };
      }
      failedTestNames = collectFailedTestNames(report);
    } catch (error) {
      if (runError === null) {
        runError = `无法解析 vitest JSON 报告：${String(error)}`;
      }
    }
  } finally {
    writeFileSync(targetPath, originalContent, "utf8");
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const restoredDigest = sha256OfFile(targetPath);
  if (restoredDigest !== originalDigest) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage: `还原失败：${mutation.targetFile} 的 sha256 与注入前不一致`,
      failedTestNames: [...failedTestNames],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  const missingExpectations = mutation.expectedFailingTestNames.filter(
    (expectedNameFragment) =>
      ![...failedTestNames].some((failedName) => failedName.includes(expectedNameFragment)),
  );

  /**
   * **2026-11-08（第 116 轮）修正一处"假保证"**：原判据是 `missingExpectations.length === 0`，
   * 于是 **`expectedFailingTestNames` 为空数组时**（`filter` 结果必然为空）**无条件判为"被拦下"**
   * —— 哪怕这个变异**根本没有让任何用例变红**。本轮我自己就写出过两条空列表的变异，
   * 差点把它们当成"覆盖充分"的证据。
   *
   * 现要求：**必须点名至少一条用例**，且该用例确实变红。
   * （若某个变异确实只能用"整体失败"判定，请**写明被测用例名**，不要留空。）
   */
  if (mutation.expectedFailingTestNames.length === 0) {
    return {
      mutationIdentifier: mutation.mutationIdentifier,
      isKilled: false,
      isScriptError: true,
      errorMessage:
        "变异未点名任何期望失败的用例 ⇒ 无法判定被拦下（禁止空期望列表；请写明用例名）",
      failedTestNames: [...failedTestNames],
      expectedFailingTestNames: mutation.expectedFailingTestNames,
    };
  }

  return {
    mutationIdentifier: mutation.mutationIdentifier,
    isKilled: missingExpectations.length === 0,
    isScriptError: false,
    errorMessage: runError,
    failedTestNames: [...failedTestNames],
    expectedFailingTestNames: mutation.expectedFailingTestNames,
    missingExpectations,
    rationale: mutation.rationale,
  };
}

/**
 * `--check-anchors`：**只**校验每条变异的 `targetFile`/`find` 是否仍"恰好命中 1 次"。
 *
 * 为什么需要它：失效锚点会让变异体**静默不生效**（= 该守卫是空的），
 * 而只有跑全量才暴露。这个模式让它变成一条**秒级**的架构测试（`tests/architecture/mutation-anchors-live.test.ts`）。
 */
function checkAllAnchors() {
  const mismatches = [];
  for (const mutation of MUTATIONS) {
    let sourceContent;
    try {
      sourceContent = readFileSync(path.resolve(mutation.targetFile), "utf8");
    } catch {
      mismatches.push({
        mutationIdentifier: mutation.mutationIdentifier,
        targetFile: mutation.targetFile,
        occurrenceCount: -1,
        detail: "目标文件不可读",
      });
      continue;
    }
    const occurrenceCount = sourceContent.split(mutation.find).length - 1;
    if (occurrenceCount !== 1) {
      mismatches.push({
        mutationIdentifier: mutation.mutationIdentifier,
        targetFile: mutation.targetFile,
        occurrenceCount,
        detail: occurrenceCount === 0 ? "锚点已失效（源码改动后未同步）" : "锚点命中多次（不唯一）",
      });
    }
  }
  for (const mismatch of mismatches) {
    process.stdout.write(
      `❌ ${mismatch.mutationIdentifier}（${mismatch.targetFile}）：命中 ${String(mismatch.occurrenceCount)} 次 —— ${mismatch.detail}\n`,
    );
  }
  process.stdout.write(
    `锚点自检：${String(MUTATIONS.length - mismatches.length)}/${String(MUTATIONS.length)} 条有效\n`,
  );
  process.exitCode = mismatches.length === 0 ? 0 : 1;
}

function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.includes("--check-anchors")) {
    checkAllAnchors();
    return;
  }
  const isJsonOutput = argumentsList.includes("--json");
  const onlyIndex = argumentsList.indexOf("--only");
  const onlyIdentifier = onlyIndex === -1 ? null : argumentsList[onlyIndex + 1];

  const selectedMutations =
    onlyIdentifier === null
      ? MUTATIONS
      : MUTATIONS.filter((mutation) => mutation.mutationIdentifier === onlyIdentifier);

  if (selectedMutations.length === 0) {
    process.stderr.write(`未找到匹配的变异：${String(onlyIdentifier)}\n`);
    process.exitCode = 1;
    return;
  }

  const outcomes = [];
  for (const mutation of selectedMutations) {
    if (!isJsonOutput) {
      process.stdout.write(`\n── 变异 ${mutation.mutationIdentifier} ──\n`);
      process.stdout.write(`   ${mutation.rationale}\n`);
    }
    const outcome = runMutation(mutation, { isJsonOutput });
    outcomes.push(outcome);
    if (!isJsonOutput) {
      if (outcome.isScriptError) {
        process.stdout.write(`   ❌ 脚本错误：${String(outcome.errorMessage)}\n`);
      } else if (outcome.isKilled) {
        process.stdout.write(
          `   ✅ 被拦下（${outcome.expectedFailingTestNames.length} 条点名的用例均变红）\n`,
        );
      } else {
        process.stdout.write(`   ❌ **变异存活**：以下期望变红的用例没有红\n`);
        for (const missing of outcome.missingExpectations ?? []) {
          process.stdout.write(`        - ${missing}\n`);
        }
        if (outcome.errorMessage !== null) {
          process.stdout.write(`        备注：${String(outcome.errorMessage)}\n`);
        }
      }
    }
  }

  const killedCount = outcomes.filter((outcome) => outcome.isKilled).length;
  const allKilled = killedCount === outcomes.length;

  if (isJsonOutput) {
    process.stdout.write(
      JSON.stringify({ killedCount, totalCount: outcomes.length, outcomes }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(
      `\n变异验证：${killedCount}/${outcomes.length} 被拦下` +
        (allKilled ? "（全部通过）\n" : "（存在存活变异 ⇒ 有断言是空的）\n"),
    );
  }

  process.exitCode = allKilled ? 0 : 1;
}

main();
















