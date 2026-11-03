# ADR-0204 作用域配置覆盖前保全旧版本（GUI-04-02 第一步，2026-11-03）

- 状态：**已实现该检查点的"旧版本保全"部分**；其余（跨进程锁、恢复继承、`.bak` 语义）
  未做
- 来源：GUI-04 卡 §3（覆盖前备份）
- 相关：ADR-0134（归档口径）、GUI-03 作用域配置

## 1. 问题

`ScopedSettingsStore` 原顺序是「先原子写主文件，再把主文件复制为 `.bak`」——
`.bak` 是**覆盖后的**副本，无法追溯覆盖前版本；一旦新值写坏，旧配置不可恢复。

## 2. 本次改动

- 新增 `captureRecoveryPoint(current, reason)`：写入前把**当前文档**追加到
  `<state>/scoped-settings/recovery/history.jsonl`（含时间、原因、完整 previous 文档）；
- **首次创建**（无任何覆盖且 revision ≤ 1）不制造空备份；
- 备份失败 ⇒ 抛 `scoped-settings-backup-failed` 并**拒绝覆盖主文件**（revision 与内容不变）；
- 原有 `.bak` 仍保留为"最新健康副本"，两者语义分开。

## 3. 验证

```
tests/core/orchestration/scoped-settings-store.test.ts → 6/6
  新增：第二次写入前历史有 1 条（previous.revision=2）；
        备份失败（recovery 被同名文件占位）⇒ 拒绝覆盖，revision 与旧值不变
tests/core --maxWorkers=2 → 3674 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成（如实）

- **跨进程写锁**未实现：当前仍是单对象 `AsyncMutex`，多宿主共享状态目录不保证 CAS；
- "恢复继承"（删除覆盖字段而非写 0）未做；
- 权限覆盖的**放宽预览/确认闭环**（GUI-04-01）未做；
- 真实"备份后可恢复到旧值"的读取/回滚入口未做（只有历史文件）。
