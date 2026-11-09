/**
 * EXEC-01-01（2026-11-09）：运行环境与执行契约的**反例优先**验证。
 *
 * 说明（不夸大）：本文件的 `FakeSandboxBackend` 只是**契约测试替身**，
 * 不代表已有隔离能力。真实隔离的验收在 EXEC-01-02 / 06，且必须用干净设备。
 * 这里断言的是"越界一律拒绝"与"没有后端时精确 unsupported"，不是"沙箱可用"。
 */
import { describe, expect, it } from "vitest";

import { DomainError } from "../../../packages/core/src/core/errors.js";
import {
  computeExecutionEnvironmentFingerprint,
  ExecutionEnvironmentRegistry,
  normalizeExecutionEnvironment,
  parseProcessExecutionQueryRequest,
  parseProcessExecutionStartRequest,
  PROCESS_EXECUTION_DEFAULT_TIMEOUT_MILLISECONDS,
  PROCESS_EXECUTION_MAXIMUM_TIMEOUT_MILLISECONDS,
  type ExecutionEnvironmentPolicy,
  type ProcessExecutionOwnership,
} from "../../../packages/core/src/execution/execution-contract.js";
import {
  InMemoryProcessExecutionStore,
  ProcessExecutionController,
  type SandboxExecutionBackend,
  type SandboxOutputStreamChunk,
} from "../../../packages/core/src/execution/process-execution-controller.js";

const validEnvironment: ExecutionEnvironmentPolicy = {
  environmentIdentifier: "node-offline-22",
  toolchainVersion: "node-22.11.0+stdlib",
  executableIdentifiers: { "run-script": "/sandbox/bin/node", "run-test": "/sandbox/bin/node" },
  allowedInputProjectRelativePrefixes: ["src", "test"],
  allowedOutputProjectRelativePrefixes: ["tmp"],
  resourcePolicy: {
    maximumCpuMilliseconds: 60_000,
    maximumMemoryBytes: 512 * 1024 * 1024,
    maximumProcessCount: 8,
    maximumDiskBytes: 256 * 1024 * 1024,
  },
  isNetworkAllowed: false,
};

const ownership: ProcessExecutionOwnership = {
  projectIdentifier: "project-a",
  agentInstanceIdentifier: "tertiary-agent-1",
  missionIdentifier: "mission-1",
  taskIdentifier: "task-1",
  attemptNumber: 1,
  authorizationRevision: 3,
};

/** 契约测试替身：**不是**隔离后端，只按脚本返回固定结果。 */
class FakeSandboxBackend implements SandboxExecutionBackend {
  public readonly startedRequests: Array<{
    readonly executableEntryPoint: string;
    readonly arguments: readonly string[];
    readonly timeoutMilliseconds: number;
  }> = [];
  public readonly cancelledHandles: string[] = [];

  constructor(private readonly isAvailable = true) {}

  async probeCapability() {
    return {
      isAvailable: this.isAvailable,
      backendIdentifier: "fake-contract-test-double",
      isolationPrimitiveDescription: "契约测试替身（非真实隔离）",
      reasonUnavailable: this.isAvailable ? null : "测试替身被声明为不可用",
    };
  }

  async start(input: {
    readonly identity: { readonly executionId: string };
    readonly executableEntryPoint: string;
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    readonly timeoutMilliseconds: number;
    readonly streamStorageLimitBytes: number;
  }) {
    this.startedRequests.push({
      executableEntryPoint: input.executableEntryPoint,
      arguments: input.arguments,
      timeoutMilliseconds: input.timeoutMilliseconds,
    });
    return {
      backendExecutionHandle: `handle-${input.identity.executionId}`,
      status: "running" as const,
    };
  }

  async readStatus() {
    return { status: "succeeded" as const, exitCode: 0, failureReason: null };
  }

  async readOutputStream(input: {
    readonly stream: "stdout" | "stderr";
    readonly fromCursorBytes: number;
    readonly maximumBytes: number;
  }): Promise<SandboxOutputStreamChunk> {
    const text = "ok\n".slice(0, input.maximumBytes);
    return {
      text,
      nextCursorBytes: input.fromCursorBytes + text.length,
      isTruncated: false,
    };
  }

  async cancel(handle: string) {
    this.cancelledHandles.push(handle);
    return { status: "cancelled" as const, exitCode: null, failureReason: "cancelled" };
  }
}

function createRegistry(): ExecutionEnvironmentRegistry {
  const registry = new ExecutionEnvironmentRegistry();
  registry.register(validEnvironment);
  return registry;
}

describe("EXEC-01-01 环境登记：不合格登记当场拒绝", () => {
  it("空可执行映射不得登记为可用环境", () => {
    expect(() =>
      normalizeExecutionEnvironment({
        ...validEnvironment,
        executableIdentifiers: {},
      }),
    ).toThrow(/至少登记一个可执行标识/u);
  });

  it("缺输入范围不得登记（无输入范围等于全盘可读）", () => {
    expect(() =>
      normalizeExecutionEnvironment({
        ...validEnvironment,
        allowedInputProjectRelativePrefixes: [],
      }),
    ).toThrow(/必须声明输入范围/u);
  });

  it("声明允许网络的环境被拒绝（首版禁止网络执行，不静默降级）", () => {
    expect(() =>
      normalizeExecutionEnvironment({
        ...validEnvironment,
        isNetworkAllowed: true,
      }),
    ).toThrow(/首版禁止网络执行/u);
  });

  it("绝对路径或含 .. 的范围前缀被拒绝", () => {
    expect(() =>
      normalizeExecutionEnvironment({
        ...validEnvironment,
        allowedInputProjectRelativePrefixes: ["C:/project"],
      }),
    ).toThrow(/项目相对路径/u);
    expect(() =>
      normalizeExecutionEnvironment({
        ...validEnvironment,
        allowedInputProjectRelativePrefixes: ["../outside"],
      }),
    ).toThrow(/不得包含/u);
  });

  it("缺资源额度不得登记", () => {
    expect(() =>
      normalizeExecutionEnvironment({
        ...validEnvironment,
        resourcePolicy: {
          ...validEnvironment.resourcePolicy,
          maximumMemoryBytes: 0,
        },
      }),
    ).toThrow(/正整数/u);
  });

  it("同一环境标识不得静默覆盖", () => {
    const registry = createRegistry();
    expect(() => registry.register(validEnvironment)).toThrow(/不得静默覆盖/u);
  });

  it("环境指纹随登记内容变化", () => {
    const base = computeExecutionEnvironmentFingerprint(
      normalizeExecutionEnvironment(validEnvironment),
    );
    const changed = computeExecutionEnvironmentFingerprint(
      normalizeExecutionEnvironment({
        ...validEnvironment,
        toolchainVersion: "node-22.12.0+stdlib",
      }),
    );
    expect(base).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(changed).not.toBe(base);
  });
});

describe("EXEC-01-01 start 参数：模型不能给宿主命令或越界路径", () => {
  it("合法参数被接受，超时缺省 60s", () => {
    const request = parseProcessExecutionStartRequest({
      action: "start",
      environmentIdentifier: "node-offline-22",
      executableIdentifier: "run-test",
      arguments: ["--test", "test/a.test.mjs"],
      workingDirectory: "src",
    });
    expect(request.timeoutMilliseconds).toBe(PROCESS_EXECUTION_DEFAULT_TIMEOUT_MILLISECONDS);
    expect(request.arguments).toEqual(["--test", "test/a.test.mjs"]);
  });

  it("不接受宿主命令字符串字段（command / shell / env / mounts 一律拒绝）", () => {
    for (const forbidden of [
      { command: "node --test" },
      { shell: "powershell -c calc" },
      { environmentVariables: { PATH: "/host/bin" } },
      { mounts: ["C:/"] },
      { isAuthorized: true },
    ]) {
      expect(() =>
        parseProcessExecutionStartRequest({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
          ...forbidden,
        }),
      ).toThrow(/不接受参数/u);
    }
  });

  it("arguments 必须是字符串数组（不接受单个命令字符串）", () => {
    expect(() =>
      parseProcessExecutionStartRequest({
        action: "start",
        environmentIdentifier: "node-offline-22",
        executableIdentifier: "run-test",
        arguments: "node --test",
        workingDirectory: "src",
      }),
    ).toThrow(/必须是字符串数组/u);
  });

  it("workingDirectory 拒绝绝对路径与 ..", () => {
    for (const workingDirectory of ["/etc", "C:\\Windows", "../outside", "src/../../x"]) {
      expect(() =>
        parseProcessExecutionStartRequest({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory,
        }),
      ).toThrow(/项目相对目录/u);
    }
  });

  it("超时越界被拒绝（0 / 负 / 超过 180s）", () => {
    for (const timeoutMilliseconds of [0, -1, PROCESS_EXECUTION_MAXIMUM_TIMEOUT_MILLISECONDS + 1]) {
      expect(() =>
        parseProcessExecutionStartRequest({
          action: "start",
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
          timeoutMilliseconds,
        }),
      ).toThrow(/timeoutMilliseconds/u);
    }
  });

  it("query 类 action 只接受自己的参数", () => {
    expect(() =>
      parseProcessExecutionQueryRequest("status", {
        action: "status",
        executionId: "exec-1",
        timeoutMilliseconds: 1000,
      }),
    ).toThrow(/不接受参数/u);
    expect(
      parseProcessExecutionQueryRequest("cancel", { action: "cancel", executionId: "exec-1" }),
    ).toEqual({ executionId: "exec-1" });
  });
});

describe("EXEC-01-01 控制器：没有后端就精确 unsupported", () => {
  it("未装配后端 ⇒ execution-backend-unsupported（不降级到宿主执行）", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: null,
    });
    const capability = await controller.probeBackendCapability();
    expect(capability.isAvailable).toBe(false);
    expect(capability.reasonUnavailable).toContain("未装配沙箱执行后端");

    await expect(
      controller.start({
        ownership,
        request: {
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
          timeoutMilliseconds: 1000,
        },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorCode: "execution-backend-unsupported" }),
    );
  });

  it("后端自报不可用 ⇒ 同样 unsupported，且原因透出", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(false),
    });
    await expect(
      controller.start({
        ownership,
        request: {
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
        },
      }),
    ).rejects.toThrow(/测试替身被声明为不可用/u);
  });
});

describe("EXEC-01-01 控制器：环境、范围、幂等、归属", () => {
  it("未登记环境 ⇒ execution-environment-not-found（不临时创建）", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(),
    });
    await expect(
      controller.start({
        ownership,
        request: {
          environmentIdentifier: "node-temp-adhoc",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "src",
        },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorCode: "execution-environment-not-found" }),
    );
  });

  it("未登记的可执行标识 ⇒ execution-request-invalid", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(),
    });
    await expect(
      controller.start({
        ownership,
        request: {
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-anything",
          arguments: [],
          workingDirectory: "src",
        },
      }),
    ).rejects.toThrow(/未登记可执行标识/u);
  });

  it("workingDirectory 不在输入范围 ⇒ 拒绝（不靠 cwd 冒充隔离）", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(),
    });
    await expect(
      controller.start({
        ownership,
        request: {
          environmentIdentifier: "node-offline-22",
          executableIdentifier: "run-test",
          arguments: [],
          workingDirectory: "docs",
        },
      }),
    ).rejects.toThrow(/不在该环境的输入范围内/u);
  });

  it("幂等键同参返回原执行（不重启进程），异参拒绝", async () => {
    const backend = new FakeSandboxBackend();
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: backend,
    });
    const request = {
      environmentIdentifier: "node-offline-22",
      executableIdentifier: "run-test",
      arguments: ["--test"],
      workingDirectory: "src",
      idempotencyKey: "key-1",
    };
    const first = await controller.start({ ownership, request });
    expect(first.isReusedByIdempotencyKey).toBe(false);
    expect(backend.startedRequests).toHaveLength(1);

    const second = await controller.start({ ownership, request });
    expect(second.executionId).toBe(first.executionId);
    expect(second.isReusedByIdempotencyKey).toBe(true);
    /** 关键：同键同参**不得**再启动一次进程。 */
    expect(backend.startedRequests).toHaveLength(1);

    await expect(
      controller.start({
        ownership,
        request: { ...request, arguments: ["--test", "other.test.mjs"] },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorCode: "execution-idempotency-conflict" }),
    );
    expect(backend.startedRequests).toHaveLength(1);
  });

  it("别的执行主体不能查询本主体的执行", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(),
    });
    const started = await controller.start({
      ownership,
      request: {
        environmentIdentifier: "node-offline-22",
        executableIdentifier: "run-test",
        arguments: [],
        workingDirectory: "src",
      },
    });
    await expect(
      controller.readStatus({
        requestingAgentInstanceIdentifier: "tertiary-agent-2",
        executionId: started.executionId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorCode: "execution-not-authorized" }),
    );
    /** 本主体可以查。 */
    const status = await controller.readStatus({
      requestingAgentInstanceIdentifier: "tertiary-agent-1",
      executionId: started.executionId,
    });
    expect(status.executionId).toBe(started.executionId);
  });

  it("明确授权的上级可管理下级执行", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(),
      isSuperiorAgentAuthorizedToManage: ({ requestingAgentInstanceIdentifier }) =>
        requestingAgentInstanceIdentifier === "secondary-agent-1",
    });
    const started = await controller.start({
      ownership,
      request: {
        environmentIdentifier: "node-offline-22",
        executableIdentifier: "run-test",
        arguments: [],
        workingDirectory: "src",
      },
    });
    const status = await controller.readStatus({
      requestingAgentInstanceIdentifier: "secondary-agent-1",
      executionId: started.executionId,
    });
    expect(status.status).toBe("succeeded");
  });

  it("任务剩余预算更严时取更严值", async () => {
    const backend = new FakeSandboxBackend();
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: backend,
    });
    await controller.start({
      ownership,
      request: {
        environmentIdentifier: "node-offline-22",
        executableIdentifier: "run-test",
        arguments: [],
        workingDirectory: "src",
        timeoutMilliseconds: 120_000,
      },
      remainingTaskBudgetMilliseconds: 5_000,
    });
    expect(backend.startedRequests[0]?.timeoutMilliseconds).toBe(5_000);
  });

  it("不存在的执行 ⇒ execution-not-found", async () => {
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: new FakeSandboxBackend(),
      store: new InMemoryProcessExecutionStore(),
    });
    await expect(
      controller.readStatus({
        requestingAgentInstanceIdentifier: "tertiary-agent-1",
        executionId: "exec-missing",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorCode: "execution-not-found" }),
    );
  });

  it("取消会作用到后端并落终态", async () => {
    const backend = new FakeSandboxBackend();
    const controller = new ProcessExecutionController({
      environmentRegistry: createRegistry(),
      sandboxBackend: backend,
    });
    const started = await controller.start({
      ownership,
      request: {
        environmentIdentifier: "node-offline-22",
        executableIdentifier: "run-test",
        arguments: [],
        workingDirectory: "src",
      },
    });
    const cancelled = await controller.cancel({
      requestingAgentInstanceIdentifier: "tertiary-agent-1",
      executionId: started.executionId,
      reason: "用户取消",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(backend.cancelledHandles).toEqual([`handle-${started.executionId}`]);
  });
});

describe("EXEC-01-01 DomainError 语义", () => {
  it("执行类错误码都是不可恢复（除显式标注）", () => {
    const error = new DomainError("execution-backend-unsupported", "unsupported");
    expect(error.isRecoverable).toBe(false);
    expect(error.errorCode).toBe("execution-backend-unsupported");
  });
});
