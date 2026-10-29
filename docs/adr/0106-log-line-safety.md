# ADR-0106 日志行安全化：换行注入加固（SEC-02 通道 14 / R18）

- 状态：已采纳（工具 + 一处真实日志边界；覆盖有限）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R18、
  [SEC02_CHANNEL_MATRIX](../tasks/SEC02_CHANNEL_MATRIX.md) 通道 14
- 相关：`infra/redaction.ts`（脱敏，不是本模块职责）

## 1. 背景

日志里拼入的变量（子进程 stderr、异常消息、工具输出）可能含换行：
一行日志会被拆成多行，从而**伪造**额外日志行或结构化字段（log injection）。
通道 14 之前只做到"掩码"，没有处理换行。

## 2. 变更（冻结）

1. 新增 `infra/log-line-safety.ts`：
   - `sanitizeLogLine(text, maximumCharacters?)`：把 `\r\n`/`\r`/`\n`/U+2028/U+2029
     替换为可见转义；有界截断（缺省 2000 字符）并标注截断；返回**转义计数**；
   - `formatDiagnosticLogLine({prefix, message})`：生成**不含换行**的单行日志。
2. 应用到真实边界：`process-supervisor.handleChildProcessFailure` 的
   `error.message` 写入（此前直接拼入模板字符串）。
3. **不是脱敏**：本模块不负责隐藏秘密（那是 `Redactor`/扫描层）；也不改写 IPC/JSON 载荷。
4. 调用方自行追加行尾 `\n`；本模块保证正文内部不再引入换行。

## 3. 生产调用链（源码位置）

```
FeedbackProcessSupervisor.handleChildProcessFailure      packages/core/src/feedback-process/process-supervisor.ts
└─ formatDiagnosticLogLine({prefix, message: error.message})
   └─ sanitizeLogLine → 转义换行 + 有界截断
   └─ process.stderr.write(`${line}\n`)
```

## 4. 未完成（如实）

- **覆盖点只有一处**：其他 `process.stderr.write`（入口心跳、子进程 stdout 转发）**未应用**；
  子进程 stdout 转发是**有意**保留原文（它是子进程自己的输出，转义会破坏其格式）。
- **没有全局日志封装**：没有统一 logger，无法保证"所有日志都经过"。
- **转义不是防伪造的充分条件**：终端控制字符（ANSI 转义）未处理。
- **未运行验证**：没跑过"含换行 ⇒ 转义为单行""超长 ⇒ 截断并标注""计数正确"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
