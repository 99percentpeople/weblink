import { describe, expect, it } from "vitest";
import {
  AutomationError,
  failure,
  failureDetails,
  withRecovery,
} from "@weblink/automation";

describe("automation error recovery contract", () => {
  it("does not treat a lost mutation response or cancellation as safe to retry", () => {
    for (const code of [
      "TIMEOUT",
      "CANCELLED",
      "GRANT_EXPIRED",
      "TARGET_DISCONNECTED",
      "INPUT_TIMEOUT",
    ]) {
      const result = failure(new AutomationError(code));
      expect(result).toMatchObject({
        ok: false,
        error: {
          code,
          outcome: "unknown",
          retryable: false,
        },
      });
      if (!result.ok)
        expect(result.error.nextAction).not.toBe("retry");
    }
  });

  it("allows transient read retries, with bounded delay, but respects cancellation", () => {
    expect(
      failureDetails("BUSY", "BUSY", { readOnly: true }),
    ).toMatchObject({
      outcome: "not_applied",
      retryable: true,
      nextAction: "retry",
      retryAfterMs: 250,
    });
    expect(
      failureDetails("CANCELLED", "CANCELLED", {
        readOnly: true,
      }),
    ).toMatchObject({
      retryable: false,
      nextAction: "stop",
    });
  });

  it("distinguishes rejected validation from execution and preserves custom explanations", () => {
    expect(
      failure(
        new AutomationError(
          "INVALID_ARGUMENTS",
          undefined,
          { dispatched: false },
        ),
      ),
    ).toMatchObject({
      error: {
        outcome: "not_applied",
        nextAction: "fix_arguments",
      },
    });
    expect(
      failureDetails("BUSY", "input queue is full", {
        readOnly: true,
      }).message,
    ).toBe("input queue is full");
  });

  it("enriches legacy peer results without changing success or confirmed effects", () => {
    expect(
      withRecovery(
        {
          ok: false,
          error: { code: "BUSY", message: "BUSY" },
        },
        { readOnly: true },
      ),
    ).toMatchObject({
      error: { outcome: "not_applied", retryable: true },
    });
    const success = {
      ok: true as const,
      data: { applied: true },
    };
    expect(withRecovery(success)).toBe(success);
    expect(
      withRecovery({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: "TIMEOUT",
          outcome: "applied",
        },
      }),
    ).toMatchObject({
      error: { outcome: "applied", retryable: false },
    });
  });

  it("preserves destination outcomes through a forwarded exception", () => {
    expect(
      failure(
        new AutomationError(
          "GRANT_EXPIRED",
          "Remote action completed",
          {
            outcome: "applied",
            retryable: false,
          },
        ),
      ),
    ).toMatchObject({
      error: { outcome: "applied", retryable: false },
    });
    expect(
      failure(
        new AutomationError("BUSY", "BUSY", {
          outcome: "not_applied",
          retryable: false,
        }),
      ),
    ).toMatchObject({
      error: {
        outcome: "not_applied",
        retryable: false,
        nextAction: "observe",
      },
    });
  });

  it("preserves explicit no-retry decisions without contradictory guidance", () => {
    const result = withRecovery({
      ok: false,
      error: {
        code: "BUSY",
        message: "BUSY",
        outcome: "not_applied",
        retryable: false,
        retryAfterMs: 250,
      },
    });
    expect(result).toMatchObject({
      error: {
        outcome: "not_applied",
        retryable: false,
        nextAction: "observe",
      },
    });
    if (!result.ok)
      expect(result.error.retryAfterMs).toBeUndefined();
  });

  it("recomputes stale retry delays and normalizes malformed remote outcomes", () => {
    const legacy = withRecovery({
      ok: false,
      error: {
        code: "TARGET_DISCONNECTED",
        message: "TARGET_DISCONNECTED",
        outcome: "not_applied",
        retryAfterMs: 9999,
      },
    });
    expect(legacy).toMatchObject({
      error: { retryable: true, nextAction: "reconnect" },
    });
    if (!legacy.ok)
      expect(legacy.error.retryAfterMs).toBeUndefined();
    expect(
      failureDetails("TIMEOUT", "TIMEOUT", {
        outcome: "invalid" as "unknown",
      }),
    ).toMatchObject({
      outcome: "unknown",
      retryable: false,
    });
  });

  it("treats inherited object names as unknown error codes", () => {
    for (const code of [
      "toString",
      "constructor",
      "__proto__",
    ]) {
      for (const message of [code, "provider details"]) {
        expect(failureDetails(code, message)).toEqual({
          code,
          message,
          outcome: "unknown",
          retryable: false,
          nextAction: "observe",
        });
      }
    }
  });

  it("rejects malformed peer envelopes without throwing or allowing a mutation retry", () => {
    for (const result of [
      null,
      {},
      { ok: false },
      { ok: false, error: {} },
      { ok: false, error: { code: 3, message: "bad" } },
      { ok: true, data: null },
      { ok: true, data: [] },
    ]) {
      expect(withRecovery(result as never)).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_RESULT",
          outcome: "unknown",
          retryable: false,
          nextAction: "observe",
        },
      });
    }
  });

  it("keeps unknown provider errors conservative", () => {
    expect(
      failureDetails(
        "PROVIDER_CUSTOM_FAILURE",
        "provider details",
      ),
    ).toMatchObject({
      code: "PROVIDER_CUSTOM_FAILURE",
      message: "provider details",
      outcome: "unknown",
      retryable: false,
      nextAction: "observe",
    });
  });
});
