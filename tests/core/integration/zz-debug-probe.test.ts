import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
import { createPlatformSandboxExecutionBackend } from "../../../packages/core/src/execution/platform-sandbox-backend.js";

describe("debug probe", () => {
  it("logs capability", async () => {
    const backend = createPlatformSandboxExecutionBackend({ applicationRootPath: process.cwd() });
    console.log("backend", backend === null ? "null" : backend.constructor.name);
    if (backend) {
      const capability = await backend.probeCapability();
      console.log("capability", JSON.stringify(capability));
    }
    expect(true).toBe(true);
  });
});