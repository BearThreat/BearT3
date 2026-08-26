import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import { relaySupportIssues } from "../persistence/schema.ts";
import * as SupportIssues from "./SupportIssues.ts";

const storedIssue = {
  receiptId: "receipt-1",
  subject: "The send button is stuck",
  description: "Tapping Send does not submit the prompt.",
  diagnosticsConsent: false,
  diagnostics: null,
  status: "received" as const,
  operatorReply: null,
  repliedAt: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  SupportIssues.layer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)));

function selectRows(rows: ReadonlyArray<Record<string, unknown>>) {
  return {
    from: (table: unknown) => {
      expect(table).toBe(relaySupportIssues);
      return {
        where: (condition: unknown) => {
          expect(condition).toBeDefined();
          return {
            limit: () => Effect.succeed(rows),
            orderBy: () => Effect.succeed(rows),
          };
        },
      };
    },
  };
}

describe("SupportIssues", () => {
  it.effect("creates a durable user-bound receipt and returns the stored record", () => {
    const inserted: Array<Record<string, unknown>> = [];
    const conflictTargets: Array<unknown> = [];
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relaySupportIssues);
        return {
          values: (values: Record<string, unknown>) => {
            inserted.push(values);
            return {
              onConflictDoNothing: (config: { readonly target: unknown }) => {
                conflictTargets.push(config.target);
                return Effect.void;
              },
            };
          },
        };
      },
      select: () => selectRows([storedIssue]),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const issues = yield* SupportIssues.SupportIssues;
      const input = {
        userId: "user-1",
        request: {
          receiptId: "receipt-1",
          subject: storedIssue.subject,
          description: storedIssue.description,
          diagnosticsConsent: false,
        },
      } as const;
      const result = yield* issues.create(input);
      const retried = yield* issues.create(input);

      expect(result).toEqual(storedIssue);
      expect(retried).toEqual(storedIssue);
      expect(inserted).toHaveLength(2);
      expect(inserted[0]).toMatchObject({
        userId: "user-1",
        receiptId: "receipt-1",
        diagnosticsConsent: false,
        diagnosticsJson: null,
        status: "received",
      });
      expect(conflictTargets).toEqual([
        [relaySupportIssues.userId, relaySupportIssues.receiptId],
        [relaySupportIssues.userId, relaySupportIssues.receiptId],
      ]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("rejects diagnostics without consent before writing", () => {
    let inserts = 0;
    const fakeDb = {
      insert: () => {
        inserts += 1;
        return Effect.die("must not insert");
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const issues = yield* SupportIssues.SupportIssues;
      const error = yield* Effect.flip(
        issues.create({
          userId: "user-1",
          request: {
            receiptId: "receipt-1",
            subject: storedIssue.subject,
            description: storedIssue.description,
            diagnosticsConsent: false,
            diagnostics: { appVersion: "1.0.0", traceId: "trace-1" },
          },
        }),
      );
      expect(error).toMatchObject({
        _tag: "SupportIssueDiagnosticsConsentRequired",
        receiptId: "receipt-1",
      });
      expect(inserts).toBe(0);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("lists only through a user-bound query", () => {
    const whereClauses: Array<unknown> = [];
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relaySupportIssues);
          return {
            where: (condition: unknown) => {
              whereClauses.push(condition);
              return { orderBy: () => Effect.succeed([storedIssue]) };
            },
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const issues = yield* SupportIssues.SupportIssues;
      expect(yield* issues.listForUser({ userId: "user-1" })).toEqual([storedIssue]);
      expect(whereClauses).toHaveLength(1);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("stores operator status and reply", () => {
    const updated: Array<Record<string, unknown>> = [];
    const resolved = {
      ...storedIssue,
      status: "resolved" as const,
      operatorReply: "Fixed. Please reopen Salvo.",
      repliedAt: "2026-08-24T01:00:00.000Z",
    };
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relaySupportIssues);
        return {
          set: (values: Record<string, unknown>) => {
            updated.push(values);
            return { where: () => Effect.void };
          },
        };
      },
      select: () => selectRows([resolved]),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const issues = yield* SupportIssues.SupportIssues;
      const result = yield* issues.updateByOperator({
        userId: "user-1",
        receiptId: "receipt-1",
        status: "resolved",
        reply: "Fixed. Please reopen Salvo.",
      });
      expect(result).toEqual(resolved);
      expect(updated[0]).toMatchObject({
        status: "resolved",
        operatorReply: "Fixed. Please reopen Salvo.",
      });
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });

  it.effect("lists all issues with their user ownership for the operator inbox", () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          orderBy: () => Effect.succeed([{ userId: "user-1", ...storedIssue }]),
        }),
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const issues = yield* SupportIssues.SupportIssues;
      expect(yield* issues.listForOperator()).toEqual([{ userId: "user-1", issue: storedIssue }]);
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
