import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  mapAcpResumeError,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  for (const provider of ["cursor", "grok"] as const) {
    it(`maps ${provider} ACP missing-session resume failures`, () => {
      const error = mapAcpResumeError(
        ProviderDriverKind.make(provider),
        "thread-1" as never,
        new EffectAcpErrors.AcpRequestError({
          code: -32000,
          errorMessage: "Session not found",
          method: "session/load",
        }),
      );

      expect(error._tag).toBe("ProviderAdapterResumeError");
      if (error._tag === "ProviderAdapterResumeError") {
        expect(error.reason).toBe("session_missing");
        expect(error.method).toBe("session/load");
      }
    });
  }

  it("maps ACP method-not-found as unsupported resume", () => {
    const error = mapAcpResumeError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      new EffectAcpErrors.AcpRequestError({
        code: -32601,
        errorMessage: "Method not found",
        method: "session/load",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterResumeError");
    if (error._tag === "ProviderAdapterResumeError") {
      expect(error.reason).toBe("unsupported_resume");
    }
  });

  it("does not classify an ambiguous ACP load failure as lost context", () => {
    const error = mapAcpResumeError(
      ProviderDriverKind.make("grok"),
      "thread-1" as never,
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        method: "session/load",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
  });
});
