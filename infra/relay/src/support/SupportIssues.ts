import type {
  RelayCreateSupportIssueRequest,
  RelaySupportIssueRecord,
  RelaySupportIssueStatus,
} from "@t3tools/contracts/relay";
import { and, desc, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relaySupportIssues } from "../persistence/schema.ts";

export class SupportIssuePersistenceError extends Schema.TaggedErrorClass<SupportIssuePersistenceError>()(
  "SupportIssuePersistenceError",
  {
    operation: Schema.Literals(["create", "load-created", "list", "operator-update"]),
    userId: Schema.String,
    receiptId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Support issue persistence '${this.operation}' failed for user '${this.userId}'`;
  }
}

export class SupportIssueDiagnosticsConsentRequired extends Schema.TaggedErrorClass<SupportIssueDiagnosticsConsentRequired>()(
  "SupportIssueDiagnosticsConsentRequired",
  { receiptId: Schema.String },
) {}

export class SupportIssueNotFound extends Schema.TaggedErrorClass<SupportIssueNotFound>()(
  "SupportIssueNotFound",
  { userId: Schema.String, receiptId: Schema.String },
) {}

export class SupportIssues extends Context.Service<
  SupportIssues,
  {
    readonly create: (input: {
      readonly userId: string;
      readonly request: RelayCreateSupportIssueRequest;
    }) => Effect.Effect<
      RelaySupportIssueRecord,
      SupportIssuePersistenceError | SupportIssueDiagnosticsConsentRequired | SupportIssueNotFound
    >;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<ReadonlyArray<RelaySupportIssueRecord>, SupportIssuePersistenceError>;
    readonly listForOperator: () => Effect.Effect<
      ReadonlyArray<{ readonly userId: string; readonly issue: RelaySupportIssueRecord }>,
      SupportIssuePersistenceError
    >;
    readonly updateByOperator: (input: {
      readonly userId: string;
      readonly receiptId: string;
      readonly status: RelaySupportIssueStatus;
      readonly reply?: string | null;
    }) => Effect.Effect<
      RelaySupportIssueRecord,
      SupportIssuePersistenceError | SupportIssueNotFound
    >;
  }
>()("t3code-relay/support/SupportIssues") {}

const selection = {
  receiptId: relaySupportIssues.receiptId,
  subject: relaySupportIssues.subject,
  description: relaySupportIssues.description,
  diagnosticsConsent: relaySupportIssues.diagnosticsConsent,
  diagnostics: relaySupportIssues.diagnosticsJson,
  status: relaySupportIssues.status,
  operatorReply: relaySupportIssues.operatorReply,
  repliedAt: relaySupportIssues.repliedAt,
  createdAt: relaySupportIssues.createdAt,
  updatedAt: relaySupportIssues.updatedAt,
};

const operatorSelection = { userId: relaySupportIssues.userId, ...selection };

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const load = Effect.fn("salvo.support_issues.load")(function* (input: {
    readonly userId: string;
    readonly receiptId: string;
    readonly operation: "load-created" | "operator-update";
  }) {
    const rows = yield* db
      .select(selection)
      .from(relaySupportIssues)
      .where(
        and(
          eq(relaySupportIssues.userId, input.userId),
          eq(relaySupportIssues.receiptId, input.receiptId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new SupportIssuePersistenceError({
              operation: input.operation,
              userId: input.userId,
              receiptId: input.receiptId,
              cause,
            }),
        ),
      );
    return rows[0] ?? (yield* new SupportIssueNotFound(input));
  });

  return SupportIssues.of({
    create: Effect.fn("salvo.support_issues.create")(function* ({ userId, request }) {
      if (request.diagnostics !== undefined && !request.diagnosticsConsent) {
        return yield* new SupportIssueDiagnosticsConsentRequired({ receiptId: request.receiptId });
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      const values: typeof relaySupportIssues.$inferInsert = {
        userId,
        receiptId: request.receiptId,
        subject: request.subject,
        description: request.description,
        diagnosticsConsent: request.diagnosticsConsent,
        diagnosticsJson: request.diagnosticsConsent ? (request.diagnostics ?? null) : null,
        status: "received",
        operatorReply: null,
        repliedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* db
        .insert(relaySupportIssues)
        .values(values)
        .onConflictDoNothing({
          target: [relaySupportIssues.userId, relaySupportIssues.receiptId],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new SupportIssuePersistenceError({
                operation: "create",
                userId,
                receiptId: request.receiptId,
                cause,
              }),
          ),
        );
      return yield* load({ userId, receiptId: request.receiptId, operation: "load-created" });
    }),

    listForUser: Effect.fn("salvo.support_issues.list_for_user")(function* ({ userId }) {
      return yield* db
        .select(selection)
        .from(relaySupportIssues)
        .where(eq(relaySupportIssues.userId, userId))
        .orderBy(desc(relaySupportIssues.updatedAt))
        .pipe(
          Effect.mapError(
            (cause) => new SupportIssuePersistenceError({ operation: "list", userId, cause }),
          ),
        );
    }),

    listForOperator: Effect.fn("salvo.support_issues.list_for_operator")(function* () {
      const rows = yield* db
        .select(operatorSelection)
        .from(relaySupportIssues)
        .orderBy(desc(relaySupportIssues.updatedAt))
        .pipe(
          Effect.mapError(
            (cause) =>
              new SupportIssuePersistenceError({ operation: "list", userId: "operator", cause }),
          ),
        );
      return rows.map(({ userId, ...issue }) => ({ userId, issue }));
    }),

    updateByOperator: Effect.fn("salvo.support_issues.update_by_operator")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* db
        .update(relaySupportIssues)
        .set({
          status: input.status,
          operatorReply: input.reply ?? null,
          repliedAt: input.reply === undefined || input.reply === null ? null : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(relaySupportIssues.userId, input.userId),
            eq(relaySupportIssues.receiptId, input.receiptId),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new SupportIssuePersistenceError({
                operation: "operator-update",
                userId: input.userId,
                receiptId: input.receiptId,
                cause,
              }),
          ),
        );
      return yield* load({ ...input, operation: "operator-update" });
    }),
  });
});

export const layer = Layer.effect(SupportIssues, make);
