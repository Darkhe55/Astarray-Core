import { describe, expect, it } from "vitest";

import {
  describeProviderHttpFailure,
  isProviderContextOverflowError,
} from "../../../packages/core/src/runtime/provider-failure.js";

describe("P5 provider context overflow classification", () => {
  it("classifies HTTP 413 as context overflow", async () => {
    const error = await describeProviderHttpFailure(
      new Response(JSON.stringify({ error: { message: "payload too large" } }), {
        status: 413,
      }),
    );
    expect(error.errorCode).toBe("provider-context-overflow");
    expect(isProviderContextOverflowError(error)).toBe(true);
  });

  it("classifies HTTP 400 with an explicit context-length detail", async () => {
    const error = await describeProviderHttpFailure(
      new Response(
        JSON.stringify({ error: { message: "maximum context length exceeded" } }),
        { status: 400 },
      ),
    );
    expect(error.errorCode).toBe("provider-context-overflow");
  });

  it("does not misclassify a generic HTTP 400", async () => {
    const error = await describeProviderHttpFailure(
      new Response(JSON.stringify({ error: { message: "invalid model" } }), {
        status: 400,
      }),
    );
    expect(error.errorCode).toBe("provider-http-error");
    expect(isProviderContextOverflowError(error)).toBe(false);
  });
});
