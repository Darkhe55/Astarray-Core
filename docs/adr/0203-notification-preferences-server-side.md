# ADR-0203 通知偏好的服务端持久化（B1/B2，2026-11-03）

- 状态：**已实现（公开侧 B1+B2）**；GUI 接线（B3）待做
- 来源：GUI-03 **F01**（通知偏好），用户选择路线 **B（服务端持久化）**
- 相关：`accuracy-policy-store.ts`（存储范式）、GUI 既有 localStorage 偏好

## 1. 设计

- `NotificationPreferenceStore`（`<state>/settings/notification-preferences.json`）：
  - 键 = **认证用户 + 项目**；值 = 四个布尔（`complete/failure/pending/system`，与 GUI 面板一致）；
  - 默认值：`true/true/true/false`；缺失或损坏 ⇒ 返回默认值（不抛错、不伪造）；
  - **未知字段 / 非布尔值 ⇒ 拒绝**（不静默丢弃）；
  - 可选 `expectedRevision`：提供时做乐观并发校验，陈旧即 `stale-revision`；
  - 原子写 + 备份恢复。
- 门面方法（认证用户约束）：
  - `getNotificationPreferences({ projectIdentifier? })`
  - `updateNotificationPreferences({ projectIdentifier?, preferences, expectedRevision? })`
  - 未认证会话 ⇒ `task-sequence-permission-denied`。

## 2. 验证

```
tests/core/notification-preference-store.test.ts → 6/6
  默认值/写入读回/revision 冲突/未知字段/损坏文件/跨用户与项目隔离
tests/core/notification-preference-sdk.test.ts → 2/2
  未认证拒绝；默认值→更新→再读；陈旧 revision 被拒
tests/core --maxWorkers=2 → 3672 tests 全通过
typecheck / lint / build → 全绿
```

## 3. 未完成

- **B3（外部仓库 GUI）**：路由 `GET/POST /commands/notification-preferences`、CSRF/主体校验、
  面板改走服务端（localStorage 降级为缓存）——尚未做；
- 没有"偏好影响哪些通知事件"的完整映射（当前只存开关，通知产生侧是否消费待 B3 对齐）；
- 无导出/迁移工具；旧 localStorage 偏好**不自动迁移**（避免猜测归属）。
