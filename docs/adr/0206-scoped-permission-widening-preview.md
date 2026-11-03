# ADR-0206 权限放宽的服务端预览与单独确认（GUI-04-01，2026-11-03）

- 状态：**已实现**（核心服务 + 门面强制 + GUI 差异卡）
- 来源：GUI-04 §2「作用域配置写入与权限确认」
- 相关：GUI-03-02（作用域覆盖）、权限组目录

## 1. 规则

- **收紧**（目标 profile 逐项决定不比当前更宽）可直接保存；
- **放宽**（任一能力 `deny/ask → allow` 方向更宽）必须先由服务端生成预览：
  目标、逐项差异、`expectedRevision`、主体、有效期、指纹；
- 用户确认只对**这一份预览**有效；参数/主体/指纹/revision 变化或过期 ⇒ 必须重新预览；
- 同一预览重复确认 ⇒ **幂等**返回原结果，不重复写；
- 主体来自服务端认证上下文（`getAuthenticatedUserId`），删除固定 `authenticated-user`。

## 2. 实现

| 层 | 内容 |
|---|---|
| 核心 | `scoped-permission-change-service.ts`：`evaluatePermissionWidening`（逐项比较 + fallback）、`preview`、`confirm`、`isWideningChange` |
| 运行时 | 解析"当前生效 profile"：优先作用域覆盖，其次当前选择；预览/确认/判断均走同一解析 |
| 门面 | `previewScopedPermissionChange` / `confirmScopedPermissionChange`；`updateScopedPermission` 对放宽直接拒绝（`permission-widening-confirmation-required`），未认证拒绝 |
| GUI | 保存被拒（放宽）⇒ 自动请求预览并渲染差异卡 + 「确认放宽（仅此一次）」；确认后回读 |

## 3. 验证

```
tests/core/scoped-permission-change.test.ts → 4/4（放宽/收紧、指纹/主体/到期/未知预览、幂等）
tests/core/scoped-permission-widening-sdk.test.ts → 2/2（直接放宽被拒、预览+确认生效、再收紧、未认证）
私有库 gui04-01-permission-widening.test.ts → 1/1（预览/确认透传、400、501、页面差异确认入口）
公开全量（串行）：3683 tests，1 个既有 drill 用例失败，单跑 3/3 通过（负载相关，已在报告中如实记录）
私有库 npm run check：96 files / 672 tests 通过
```

## 4. 未完成

- **跨进程**预览共享未做（预览存于进程内；多实例下需重新预览）；
- 项目/会话归属、可管理性校验仍依赖上层既有校验，未在本服务内重复实现；
- 不可配置安全规则/上级范围/主 Agent 只读/跨项目只读的**逐条反例**未覆盖；
- readiness：GUI 端到端（真实点击 → 差异卡 → 确认生效）未做。
