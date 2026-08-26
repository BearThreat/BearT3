// @effect-diagnostics nodeBuiltinImport:off - Host-side integration fixture controls a disposable local Docker container and migration files.
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayDb from "./db.ts";
import * as HostedSandboxRepository from "./hostedSandboxes/HostedSandboxRepository.ts";
import * as SandboxBootstrapTokens from "./hostedSandboxes/SandboxBootstrapTokens.ts";
import * as SponsoredInference from "./sponsoredInference/SponsoredInferenceGateway.ts";
import * as SponsoredResponses from "./sponsoredInference/SponsoredResponsesProxy.ts";
import {
  CanaryBudgetAuthority,
  CanaryBudgetDenied,
  layerDisabled as canaryBudgetDisabled,
  makeInMemory,
} from "./canary/CanaryBudgetAuthority.ts";

const containerName = `salvo-postgres-test-${randomUUID()}`;
const postgresPassword = "salvo-test-only";
let postgresPort = 0;

const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const dockerLogs = () => {
  const result = spawnSync("docker", ["logs", containerName], { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};

const applyMigrations = () => {
  const migrationsRoot = join(import.meta.dirname, "../migrations/postgres");
  for (const directory of readdirSync(migrationsRoot).sort()) {
    const migrationPath = join(migrationsRoot, directory, "migration.sql");
    const migration = readFileSync(migrationPath, "utf8").replaceAll(
      "--> statement-breakpoint",
      "\n",
    );
    const applied = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        containerName,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "salvo_test",
      ],
      { input: migration, encoding: "utf8" },
    );
    if (applied.status !== 0) {
      throw new Error(`Migration ${directory} failed: ${applied.stderr}`);
    }
  }
};

beforeAll(() => {
  docker(
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env",
    "POSTGRES_DB=salvo_test",
    "postgres:17-alpine",
  );
  postgresPort = Number(docker("port", containerName, "5432/tcp").split(":").at(-1));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const readyCount =
      dockerLogs().split("database system is ready to accept connections").length - 1;
    if (readyCount >= 2) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (attempt === 99) throw new Error("Ephemeral Postgres did not become ready");
  }
  spawnSync("docker", ["exec", containerName, "createdb", "-U", "postgres", "salvo_test"]);
  applyMigrations();
}, 30_000);

afterAll(() => {
  spawnSync("docker", ["stop", "--time", "0", containerName], { stdio: "ignore" });
});

const pgLayer = () =>
  PgClient.layer({
    host: "127.0.0.1",
    port: postgresPort,
    database: "salvo_test",
    username: "postgres",
    password: Redacted.make(postgresPassword),
    maxConnections: 8,
  });

const dbLayer = () =>
  Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(Layer.provide(pgLayer()));

const repositoryLayer = () => {
  const db = dbLayer();
  return HostedSandboxRepository.layer.pipe(Layer.provide(db));
};

const gatewayLayer = (
  provider: SponsoredInference.SponsoredInferenceProvider,
  caps = { pilotMicros: 100, userMicros: 100, turnMicros: 100 },
) => {
  const db = dbLayer();
  const transactions = RelayDb.RelayTransactions.layer.pipe(Layer.provide(db));
  const dependencies = Layer.mergeAll(
    db,
    transactions,
    NodeCryptoLayer.layer,
    canaryBudgetDisabled,
    Layer.succeed(
      SponsoredInference.SponsoredInferenceRuntimeConfig,
      SponsoredInference.SponsoredInferenceRuntimeConfig.of({
        provider,
        caps,
        allowedModels: new Set(["salvo-default"]),
        grantTtlMs: 60_000,
      }),
    ),
  );
  return SponsoredInference.layer.pipe(Layer.provide(dependencies));
};

const responsesLayer = (fetch: typeof globalThis.fetch, budgetLayer = canaryBudgetDisabled) => {
  const db = dbLayer();
  const transactions = RelayDb.RelayTransactions.layer.pipe(Layer.provide(db));
  return SponsoredResponses.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        db,
        transactions,
        budgetLayer,
        Layer.succeed(
          SponsoredResponses.SponsoredResponsesProxyConfig,
          SponsoredResponses.SponsoredResponsesProxyConfig.of({
            apiKey: "test-key",
            upstreamUrl: "https://upstream.invalid/v1/responses",
            allowedModels: new Set(["salvo-default"]),
            maxOutputTokens: 100,
            turnMicros: 200_000,
            userMicros: 1_000_000,
            pilotMicros: 2_000_000,
            inputMicrosPerMillionTokens: 100_000,
            outputMicrosPerMillionTokens: 200_000,
            timeoutMs: 1000,
            fetch,
          }),
        ),
      ),
    ),
  );
};

const withDb = <A, E>(effect: Effect.Effect<A, E, RelayDb.RelayDb>) =>
  Effect.runPromise(effect.pipe(Effect.provide(dbLayer())));

const rawRows = <T extends Record<string, unknown>>(result: unknown): ReadonlyArray<T> =>
  Array.isArray(result)
    ? (result as ReadonlyArray<T>)
    : ((result as { readonly rows?: ReadonlyArray<T> }).rows ?? []);

const resetSalvoTables = () =>
  withDb(
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* db.execute(
        sql`truncate table salvo_provisioning_stop_audits, salvo_provisioning_stops, salvo_sandbox_bootstrap_tokens, salvo_hosted_sandbox_prompts, salvo_hosted_sandboxes, salvo_sponsored_response_calls, salvo_sponsored_inference_audits, salvo_sponsored_inference_requests, salvo_sponsored_inference_grants, salvo_sponsored_inference_users restart identity cascade`,
      );
      yield* db.execute(
        sql`update salvo_sponsored_inference_control set stopped = false, reserved_micros = 0, billed_micros = 0`,
      );
    }),
  );

const promptRecord = {
  sandboxId: "sandbox-1",
  requestId: "prompt-1",
  userId: "member-1",
  prompt: "private prompt text",
  status: "pending" as const,
  leaseToken: null,
  leaseExpiresAt: null,
  sandboxExecutionReceiptId: null,
  gatewayProviderReceiptId: null,
  acceptedAt: null,
  createdAt: "2026-08-25T00:00:00.000Z",
};

describe("Salvo Postgres persistence", () => {
  it("atomically redeems a hash-only bootstrap capability once across service restarts", async () => {
    await resetSalvoTables();
    await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.execute(
          sql`insert into salvo_hosted_sandboxes (sandbox_id, user_id, request_id, status, created_at, updated_at) values ('sandbox-bootstrap', 'member-bootstrap', 'start-bootstrap', 'starting', '2026-08-25T00:00:00Z', '2026-08-25T00:00:00Z')`,
        );
      }),
    );
    const retired: string[] = [];
    const makeLayer = () =>
      SandboxBootstrapTokens.layerPostgres({
        masterKey: Buffer.alloc(32, 9),
        bootstrapOrigin: "https://relay.test",
        inferenceGatewayUrl: "https://relay.test/v1/responses",
        codexModel: "salvo-default",
        codexMaxOutputTokens: 100,
        codexReserveMicros: 100,
        ttlMs: 60_000,
        provisionTunnel: async () => ({
          token: "token".repeat(8),
          endpoint: "https://sandbox.test",
          tunnelId: "tunnel-1",
        }),
        retireTunnel: async (_sandboxId, tunnelId) => {
          retired.push(tunnelId);
          return { retired: true, attempts: 1 };
        },
      }).pipe(Layer.provide(dbLayer()));
    const issued = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SandboxBootstrapTokens.SandboxBootstrapCredentials;
        return yield* service.issue({
          sandboxId: "sandbox-bootstrap",
          userId: "member-bootstrap",
          clientToken: "salvo-sandbox-bootstrap",
        });
      }).pipe(Effect.provide(makeLayer())),
    );
    const binding = {
      token: issued.token,
      sandboxId: "sandbox-bootstrap",
      userId: "member-bootstrap",
      clientToken: "salvo-sandbox-bootstrap",
    };
    const attempts = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SandboxBootstrapTokens.SandboxBootstrapCredentials;
        const settle = service
          .redeem(binding)
          .pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          );
        return yield* Effect.all([settle, settle], { concurrency: "unbounded" });
      }).pipe(Effect.provide(makeLayer())),
    );
    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok)).toHaveLength(1);
    const stored = rawRows<{ token_hash: string; secret_ciphertext: string; consumed_at: string }>(
      await withDb(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          return yield* db.execute(
            sql`select token_hash, secret_ciphertext, consumed_at from salvo_sandbox_bootstrap_tokens where sandbox_id = 'sandbox-bootstrap'`,
          );
        }),
      ),
    )[0]!;
    const success = attempts.find((attempt) => attempt.ok)!;
    expect(stored.token_hash).not.toBe(issued.token);
    expect(stored.secret_ciphertext).not.toContain(success.value.controlSecret);
    expect(stored.consumed_at).toBeTruthy();
    const authenticated = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SandboxBootstrapTokens.SandboxBootstrapCredentials;
        return yield* Effect.all([
          service.authenticate(success.value.controlSecret),
          service.authenticate("wrong-control-secret"),
        ]);
      }).pipe(Effect.provide(makeLayer())),
    );
    expect(authenticated).toEqual([
      { sandboxId: "sandbox-bootstrap", userId: "member-bootstrap" },
      null,
    ]);
    await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.execute(
          sql`update salvo_hosted_sandboxes set status = 'ready', provider_ref = 'i-owned' where sandbox_id = 'sandbox-bootstrap'`,
        );
      }),
    );
    const expiring = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SandboxBootstrapTokens.SandboxBootstrapCredentials;
        return yield* service.listExpiring({ cutoff: "2099-01-01T00:00:00Z", limit: 10 });
      }).pipe(Effect.provide(makeLayer())),
    );
    expect(expiring).toEqual([
      { sandboxId: "sandbox-bootstrap", userId: "member-bootstrap", providerRef: "i-owned" },
    ]);
    const revoked = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SandboxBootstrapTokens.SandboxBootstrapCredentials;
        const result = yield* service.revoke({
          sandboxId: "sandbox-bootstrap",
          userId: "member-bootstrap",
          reason: "hibernate",
        });
        return {
          result,
          auth: yield* service.authenticate(success.value.controlSecret),
          resolved: yield* service.resolve("sandbox-bootstrap"),
        };
      }).pipe(Effect.provide(makeLayer())),
    );
    expect(revoked).toEqual({
      result: { revoked: 1, tunnelsRetired: 1 },
      auth: null,
      resolved: null,
    });
    expect(retired).toEqual(["tunnel-1"]);
    const history = rawRows<{ event: string }>(
      await withDb(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          return yield* db.execute(
            sql`select event from salvo_sandbox_lifecycle_history where sandbox_id = 'sandbox-bootstrap'`,
          );
        }),
      ),
    );
    expect(history.map((row) => row.event)).toContain("control-revoked");
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* SandboxBootstrapTokens.SandboxBootstrapCredentials;
          return yield* service.redeem(binding);
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow("bootstrap_token_rejected");
    await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.execute(
          sql`update salvo_hosted_sandboxes set status = 'stopped' where sandbox_id = 'sandbox-bootstrap'`,
        );
      }),
    );
    const resumed = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* HostedSandboxRepository.HostedSandboxRepository;
        return yield* repository.claimResume({
          eventId: "resume-bootstrap-1",
          sandboxId: "sandbox-bootstrap",
          userId: "member-bootstrap",
          updatedAt: "2026-08-25T02:00:00Z",
        });
      }).pipe(Effect.provide(repositoryLayer())),
    );
    expect(resumed.status).toBe("starting");
    const resumeHistory = rawRows<{ event: string }>(
      await withDb(
        Effect.gen(function* () {
          const db = yield* RelayDb.RelayDb;
          return yield* db.execute(
            sql`select event from salvo_sandbox_lifecycle_history where event_id = 'resume-bootstrap-1'`,
          );
        }),
      ),
    );
    expect(resumeHistory).toEqual([{ event: "resume-starting" }]);
    await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.execute(
          sql`update salvo_hosted_sandboxes set status = 'failed', updated_at = '2026-08-25T01:00:00Z' where sandbox_id = 'sandbox-bootstrap'`,
        );
        yield* db.execute(
          sql`insert into salvo_sandbox_lifecycle_history (event_id,sandbox_id,user_id,event,created_at) values ('stop-failed-bootstrap','sandbox-bootstrap','member-bootstrap','stop-failed','2026-08-25T01:00:00Z')`,
        );
      }),
    );
    const retry = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* HostedSandboxRepository.HostedSandboxRepository;
        return yield* repository.claimFailedStops({
          retryBefore: "2026-08-25T01:01:00Z",
          now: "2026-08-25T01:02:00Z",
          limit: 5,
        });
      }).pipe(Effect.provide(repositoryLayer())),
    );
    expect(retry).toHaveLength(1);
    expect(retry[0]?.status).toBe("draining");
  });

  it("applies the real migration chain and preserves prompt lease/receipt state across repository restarts", async () => {
    await resetSalvoTables();
    const schema = await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        return yield* db.execute(
          sql`select column_name from information_schema.columns where table_name = 'salvo_hosted_sandbox_prompts' order by column_name`,
        );
      }),
    );
    expect(rawRows(schema).map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "lease_token",
        "lease_expires_at",
        "sandbox_execution_receipt_id",
        "gateway_provider_receipt_id",
      ]),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* HostedSandboxRepository.HostedSandboxRepository;
        yield* repository.enqueuePrompt(promptRecord);
        const claims = yield* Effect.all(
          [
            repository.claimPrompt({
              ...promptRecord,
              leaseToken: "lease-a",
              now: "2026-08-25T00:00:01.000Z",
              leaseExpiresAt: "2026-08-25T00:01:00.000Z",
            }),
            repository.claimPrompt({
              ...promptRecord,
              leaseToken: "lease-b",
              now: "2026-08-25T00:00:01.000Z",
              leaseExpiresAt: "2026-08-25T00:01:00.000Z",
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(new Set(claims.map((claim) => claim.leaseToken)).size).toBe(1);
      }).pipe(Effect.provide(repositoryLayer())),
    );

    const leased = await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        return rawRows(
          yield* db.execute(
            sql`select * from salvo_hosted_sandbox_prompts where sandbox_id = 'sandbox-1' and request_id = 'prompt-1'`,
          ),
        )[0]!;
      }),
    );
    expect(leased.status).toBe("dispatching");
    expect(["lease-a", "lease-b"]).toContain(leased.lease_token);

    const reclaimed = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* HostedSandboxRepository.HostedSandboxRepository;
        return yield* repository.claimPrompt({
          ...promptRecord,
          leaseToken: "lease-after-restart",
          now: "2026-08-25T00:02:00.000Z",
          leaseExpiresAt: "2026-08-25T00:03:00.000Z",
        });
      }).pipe(Effect.provide(repositoryLayer())),
    );
    expect(reclaimed.leaseToken).toBe("lease-after-restart");

    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* HostedSandboxRepository.HostedSandboxRepository;
        const replay = yield* repository.enqueuePrompt({
          ...promptRecord,
          prompt: "must not overwrite",
        });
        expect(replay.prompt).toBe("private prompt text");
        const accepted = yield* repository.acceptPrompt({
          sandboxId: "sandbox-1",
          requestId: "prompt-1",
          leaseToken: "lease-after-restart",
          sandboxExecutionReceiptId: "sandbox-receipt-1",
          gatewayProviderReceiptId: "gateway-receipt-1",
          acceptedAt: "2026-08-25T00:02:01.000Z",
        });
        expect(accepted).toMatchObject({
          status: "accepted",
          leaseToken: null,
          sandboxExecutionReceiptId: "sandbox-receipt-1",
          gatewayProviderReceiptId: "gateway-receipt-1",
        });
      }).pipe(Effect.provide(repositoryLayer())),
    );

    const afterRestart = await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        return rawRows(
          yield* db.execute(
            sql`select status, sandbox_execution_receipt_id, gateway_provider_receipt_id from salvo_hosted_sandbox_prompts where sandbox_id = 'sandbox-1' and request_id = 'prompt-1'`,
          ),
        )[0]!;
      }),
    );
    expect(afterRestart).toMatchObject({
      status: "accepted",
      sandbox_execution_receipt_id: "sandbox-receipt-1",
      gateway_provider_receipt_id: "gateway-receipt-1",
    });
  }, 30_000);

  it("enforces atomic sponsored caps, releases failed reservations, replays completions after restart, and omits prompts from audits", async () => {
    await resetSalvoTables();
    let providerCalls = 0;
    const provider: SponsoredInference.SponsoredInferenceProvider = {
      execute: ({ idempotencyKey }) =>
        Effect.sync(() => {
          providerCalls += 1;
          return { text: `answer-${idempotencyKey}`, billedMicros: 40 };
        }),
    };

    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        const grant = yield* gateway.issueGrant({ userId: "member-1", sandboxId: "sandbox-1" });
        const response = yield* gateway.execute({
          grant,
          userId: "member-1",
          sandboxId: "sandbox-1",
          requestId: "completed-1",
          prompt: "private prompt text",
          reserveMicros: 60,
        });
        return { grant, response };
      }).pipe(Effect.provide(gatewayLayer(provider))),
    );
    expect(first.response.replayed).toBe(false);

    const replay = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.execute({
          grant: first.grant,
          userId: "member-1",
          sandboxId: "sandbox-1",
          requestId: "completed-1",
          prompt: "private prompt text",
          reserveMicros: 60,
        });
      }).pipe(Effect.provide(gatewayLayer(provider))),
    );
    expect(replay).toMatchObject({ replayed: true, text: "answer-completed-1", billedMicros: 40 });
    expect(providerCalls).toBe(1);

    const failingProvider: SponsoredInference.SponsoredInferenceProvider = {
      execute: () =>
        Effect.fail(
          new SponsoredInference.SponsoredInferenceProviderError({ cause: "provider unavailable" }),
        ),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        const grant = yield* gateway.issueGrant({ userId: "member-2", sandboxId: "sandbox-2" });
        const error = yield* Effect.flip(
          gateway.execute({
            grant,
            userId: "member-2",
            sandboxId: "sandbox-2",
            requestId: "failed-1",
            prompt: "do not audit me",
            reserveMicros: 60,
          }),
        );
        expect(error.code).toBe("provider_failed");
      }).pipe(Effect.provide(gatewayLayer(failingProvider))),
    );

    const afterFailure = await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        return rawRows(
          yield* db.execute(
            sql`select reserved_micros from salvo_sponsored_inference_users where user_id = 'member-2'`,
          ),
        );
      }),
    );
    expect(afterFailure[0]?.reserved_micros).toBe(0);

    await resetSalvoTables();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const blockingProvider: SponsoredInference.SponsoredInferenceProvider = {
      execute: ({ idempotencyKey }) =>
        Effect.promise(async () => {
          signalStarted();
          await providerReleased;
          return { text: `answer-${idempotencyKey}`, billedMicros: 40 };
        }),
    };
    const atomicGrant = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.issueGrant({ userId: "member-3", sandboxId: "sandbox-3" });
      }).pipe(Effect.provide(gatewayLayer(blockingProvider))),
    );
    const firstAtomic = Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.execute({
          grant: atomicGrant,
          userId: "member-3",
          sandboxId: "sandbox-3",
          requestId: "atomic-1",
          prompt: "first",
          reserveMicros: 60,
        });
      }).pipe(Effect.provide(gatewayLayer(blockingProvider))),
    );
    await started;
    const denied = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* Effect.flip(
          gateway.execute({
            grant: atomicGrant,
            userId: "member-3",
            sandboxId: "sandbox-3",
            requestId: "atomic-2",
            prompt: "second",
            reserveMicros: 60,
          }),
        );
      }).pipe(Effect.provide(gatewayLayer(blockingProvider))),
    );
    expect(denied.code).toBe("budget_denied");
    releaseProvider();
    await firstAtomic;

    const audit = await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        return rawRows(
          yield* db.execute(
            sql`select details_json::text as details, count(*) over ()::int as total from salvo_sponsored_inference_audits`,
          ),
        );
      }),
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(
      audit.every(
        (row) => !String(row.details).includes("first") && !String(row.details).includes("second"),
      ),
    ).toBe(true);
  }, 30_000);

  it("streams Responses SSE byte-for-byte and durably replays without another upstream call", async () => {
    await resetSalvoTables();
    const provider = { execute: () => Effect.succeed({ text: "unused", billedMicros: 1 }) };
    const grant = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.issueGrant({ userId: "responses-user", sandboxId: "responses-box" });
      }).pipe(
        Effect.provide(
          gatewayLayer(provider, { pilotMicros: 1000, userMicros: 1000, turnMicros: 100 }),
        ),
      ),
    );
    const raw =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n';
    let upstreamCalls = 0;
    const upstream: typeof globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response(raw, { headers: { "content-type": "text/event-stream" } });
    };
    const input = {
      userId: "responses-user",
      sandboxId: "responses-box",
      parentRequestId: "parent-turn-a",
      grantToken: grant.token,
      body: {
        model: "salvo-default",
        stream: true,
        max_output_tokens: 100,
        input: [{ role: "user", content: "make a file" }],
        tools: [{ type: "function", name: "shell" }],
      },
    };
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* SponsoredResponses.SponsoredResponsesProxy;
        const first = yield* proxy.execute(input);
        const firstText = yield* Effect.promise(() => first.text());
        const replay = yield* proxy.execute(input);
        const replayText = yield* Effect.promise(() => replay.text());
        return { firstText, replayText, replayed: replay.headers.get("x-salvo-replayed") };
      }).pipe(Effect.provide(responsesLayer(upstream))),
    );
    expect(observed).toEqual({ firstText: raw, replayText: raw, replayed: "true" });
    expect(upstreamCalls).toBe(1);
  }, 30_000);

  it("never calls Responses upstream when authoritative readings or operator admission deny the request", async () => {
    const now = 1_777_000_000_000;
    const cases = [
      makeInMemory({
        nowMs: () => now,
        operatorUserIds: new Set(["responses-user"]),
        readAuthoritative: () =>
          Effect.fail(new CanaryBudgetDenied({ code: "authoritative_unavailable" })),
      }),
      makeInMemory({
        nowMs: () => now,
        operatorUserIds: new Set(["responses-user"]),
        readAuthoritative: () =>
          Effect.succeed([
            {
              provider: "aws" as const,
              billedMicros: 0,
              observedAtMs: now - 300_001,
              source: "aws",
            },
            {
              provider: "openai" as const,
              billedMicros: 0,
              observedAtMs: now - 300_001,
              source: "openai",
            },
          ]),
      }),
      makeInMemory({
        nowMs: () => now,
        operatorUserIds: new Set(["somebody-else"]),
        readAuthoritative: () =>
          Effect.succeed([
            { provider: "aws" as const, billedMicros: 0, observedAtMs: now, source: "aws" },
            { provider: "openai" as const, billedMicros: 0, observedAtMs: now, source: "openai" },
          ]),
      }),
      makeInMemory({
        nowMs: () => now,
        capMicros: 1,
        operatorUserIds: new Set(["responses-user"]),
        readAuthoritative: () =>
          Effect.succeed([
            { provider: "aws" as const, billedMicros: 0, observedAtMs: now, source: "aws" },
            { provider: "openai" as const, billedMicros: 0, observedAtMs: now, source: "openai" },
          ]),
      }),
    ];
    for (const [index, budget] of cases.entries()) {
      await resetSalvoTables();
      const grant = await Effect.runPromise(
        Effect.gen(function* () {
          const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
          return yield* gateway.issueGrant({
            userId: "responses-user",
            sandboxId: "responses-box",
          });
        }).pipe(
          Effect.provide(
            gatewayLayer(
              { execute: () => Effect.succeed({ text: "unused", billedMicros: 1 }) },
              { pilotMicros: 2_000_000, userMicros: 1_000_000, turnMicros: 200_000 },
            ),
          ),
        ),
      );
      let upstreamCalls = 0;
      const upstream: typeof globalThis.fetch = async () => {
        upstreamCalls += 1;
        return new Response("unreachable");
      };
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const proxy = yield* SponsoredResponses.SponsoredResponsesProxy;
          return yield* Effect.flip(
            proxy.execute({
              userId: "responses-user",
              sandboxId: "responses-box",
              parentRequestId: `denied-${index}`,
              grantToken: grant.token,
              body: { model: "salvo-default", stream: true, input: "hello" },
            }),
          );
        }).pipe(
          Effect.provide(
            responsesLayer(upstream, Layer.succeed(CanaryBudgetAuthority, budget.service)),
          ),
        ),
      );
      expect(error.code).toBe("budget_denied");
      expect(upstreamCalls).toBe(0);
    }
  }, 30_000);

  it("releases a failed call and safely retries the same provider request", async () => {
    await resetSalvoTables();
    const grant = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.issueGrant({ userId: "retry-user", sandboxId: "retry-box" });
      }).pipe(
        Effect.provide(
          gatewayLayer(
            { execute: () => Effect.succeed({ text: "unused", billedMicros: 1 }) },
            { pilotMicros: 2_000_000, userMicros: 1_000_000, turnMicros: 200_000 },
          ),
        ),
      ),
    );
    const raw =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    let calls = 0;
    const upstream: typeof globalThis.fetch = async () =>
      ++calls === 1
        ? new Response("failed", { status: 503 })
        : new Response(raw, { headers: { "content-type": "text/event-stream" } });
    const input = {
      userId: "retry-user",
      sandboxId: "retry-box",
      parentRequestId: "retry-parent",
      grantToken: grant.token,
      body: { model: "salvo-default", stream: true, input: "retry" },
    };
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* SponsoredResponses.SponsoredResponsesProxy;
        const first = yield* proxy.execute(input).pipe(Effect.flip);
        const second = yield* proxy.execute(input);
        return { first: first.code, second: yield* Effect.promise(() => second.text()) };
      }).pipe(Effect.provide(responsesLayer(upstream))),
    );
    expect(observed).toEqual({ first: "upstream_failed", second: raw });
    expect(calls).toBe(2);
  }, 30_000);

  it("reclaims an expired running lease without allowing the stale stream to settle the retry", async () => {
    await resetSalvoTables();
    const grant = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.issueGrant({ userId: "lease-user", sandboxId: "lease-box" });
      }).pipe(
        Effect.provide(
          gatewayLayer(
            { execute: () => Effect.succeed({ text: "unused", billedMicros: 1 }) },
            { pilotMicros: 2_000_000, userMicros: 1_000_000, turnMicros: 200_000 },
          ),
        ),
      ),
    );
    const raw =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
    let calls = 0;
    const upstream: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(raw, { headers: { "content-type": "text/event-stream" } });
    };
    const input = {
      userId: "lease-user",
      sandboxId: "lease-box",
      parentRequestId: "lease-parent",
      grantToken: grant.token,
      body: { model: "salvo-default", stream: true, input: "lease" },
    };
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* SponsoredResponses.SponsoredResponsesProxy;
        return yield* proxy.execute(input);
      }).pipe(Effect.provide(responsesLayer(upstream))),
    );
    await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        yield* db.execute(
          sql`update salvo_sponsored_response_calls set lease_expires_at = '2000-01-01T00:00:00.000Z' where status = 'running'`,
        );
      }),
    );
    const retryText = await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* SponsoredResponses.SponsoredResponsesProxy;
        const retry = yield* proxy.execute(input);
        return yield* Effect.promise(() => retry.text());
      }).pipe(Effect.provide(responsesLayer(upstream))),
    );
    void first;
    const state = await withDb(
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        return rawRows<{ status: string }>(
          yield* db.execute(sql`select status from salvo_sponsored_response_calls`),
        )[0];
      }),
    );
    expect(retryText).toBe(raw);
    expect(state?.status).toBe("completed");
    expect(calls).toBe(2);
  }, 30_000);

  it("rejects oversized/deep requests and aborts oversized SSE capture", async () => {
    await resetSalvoTables();
    const grant = await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* SponsoredInference.SponsoredInferenceGateway;
        return yield* gateway.issueGrant({ userId: "bounds-user", sandboxId: "bounds-box" });
      }).pipe(
        Effect.provide(
          gatewayLayer(
            { execute: () => Effect.succeed({ text: "unused", billedMicros: 1 }) },
            { pilotMicros: 2_000_000, userMicros: 1_000_000, turnMicros: 200_000 },
          ),
        ),
      ),
    );
    const upstream: typeof globalThis.fetch = async () =>
      new Response(new Uint8Array(SponsoredResponses.MAX_RESPONSES_CAPTURE_BYTES + 1), {
        headers: { "content-type": "text/event-stream" },
      });
    const base = { userId: "bounds-user", sandboxId: "bounds-box", grantToken: grant.token };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const proxy = yield* SponsoredResponses.SponsoredResponsesProxy;
        const oversized = yield* proxy
          .execute({
            ...base,
            parentRequestId: "big",
            body: {
              model: "salvo-default",
              stream: true,
              input: "x".repeat(SponsoredResponses.MAX_RESPONSES_REQUEST_BYTES),
            },
          })
          .pipe(Effect.flip);
        let deep: unknown = "x";
        for (let index = 0; index < 40; index++) deep = [deep];
        const nested = yield* proxy
          .execute({
            ...base,
            parentRequestId: "deep",
            body: { model: "salvo-default", stream: true, input: deep },
          })
          .pipe(Effect.flip);
        const streamed = yield* proxy.execute({
          ...base,
          parentRequestId: "stream",
          body: { model: "salvo-default", stream: true, input: "x" },
        });
        const streamFailed = yield* Effect.promise(() =>
          streamed.arrayBuffer().then(
            () => false,
            () => true,
          ),
        );
        return { oversized: oversized.code, nested: nested.code, streamFailed };
      }).pipe(Effect.provide(responsesLayer(upstream))),
    );
    expect(result).toEqual({
      oversized: "invalid_request",
      nested: "invalid_request",
      streamFailed: true,
    });
  }, 30_000);
});
