// @effect-diagnostics globalErrorInEffectFailure:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { SandboxBootstrapCredentials } from "../hostedSandboxes/SandboxBootstrapTokens.ts";
import {
  SponsoredInferenceGateway,
  type SponsoredInferenceUnavailable,
} from "./SponsoredInferenceGateway.ts";
import {
  SponsoredResponsesProxy,
  SponsoredResponsesProxyError,
} from "./SponsoredResponsesProxy.ts";

const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const statusFor = (code: SponsoredInferenceUnavailable["code"]) => {
  if (["invalid_grant", "grant_expired", "grant_revoked"].includes(code)) return 401;
  if (code === "budget_denied") return 402;
  if (code === "request_in_progress" || code === "conflicting_replay") return 409;
  if (code === "global_stop" || code === "not_configured") return 503;
  if (
    code === "provider_failed" ||
    code === "provider_over_budget" ||
    code === "persistence_failed"
  )
    return 502;
  return 400;
};

/** Private sandbox execution boundary. The bootstrap control secret authenticates a durable user/sandbox binding. */
const executeRoute = HttpRouter.add(
  "POST",
  "/v1/sponsored-inference/execute",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      return json(401, { code: "authentication_required" });
    const credentials = yield* SandboxBootstrapCredentials;
    const principal = yield* credentials
      .authenticate(authorization.slice(7))
      .pipe(Effect.orElseSucceed(() => null));
    if (!principal) return json(401, { code: "authentication_required" });
    const grantToken = request.headers["salvo-inference-grant"];
    if (!grantToken) return json(401, { code: "invalid_grant" });
    const value = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    if (!value || typeof value !== "object") return json(400, { code: "invalid_request" });
    const gateway = yield* SponsoredInferenceGateway;
    return yield* gateway
      .execute({
        ...(value as Record<string, unknown>),
        userId: principal.userId,
        sandboxId: principal.sandboxId,
        grant: { token: grantToken, userId: principal.userId, sandboxId: principal.sandboxId },
      } as never)
      .pipe(
        Effect.map((result) =>
          json(200, {
            gatewayProviderReceiptId: result.providerReceiptId,
            requestId: result.requestId,
            text: result.text,
            billedMicros: result.billedMicros,
            replayed: result.replayed,
            acceptedAt: result.acceptedAt,
          }),
        ),
        Effect.catchTag("SponsoredInferenceUnavailable", (error) =>
          Effect.succeed(json(statusFor(error.code), { code: error.code })),
        ),
      );
  }),
);

const responsesRoute = HttpRouter.add(
  "POST",
  "/v1/responses",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      return json(401, { code: "authentication_required" });
    const credentials = yield* SandboxBootstrapCredentials;
    const principal = yield* credentials
      .authenticate(authorization.slice(7))
      .pipe(Effect.orElseSucceed(() => null));
    if (!principal) return json(401, { code: "authentication_required" });
    const grantToken = request.headers["salvo-inference-grant"];
    const parentRequestId = request.headers["salvo-parent-request-id"];
    if (!grantToken || !parentRequestId) return json(401, { code: "invalid_grant" });
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const proxy = yield* SponsoredResponsesProxy;
    return yield* proxy.execute({ ...principal, parentRequestId, grantToken, body }).pipe(
      Effect.map(HttpServerResponse.fromWeb),
      Effect.catch((error) =>
        Effect.succeed(
          json(
            error instanceof SponsoredResponsesProxyError && error.code === "budget_denied"
              ? 402
              : error instanceof SponsoredResponsesProxyError &&
                  ["invalid_grant", "grant_expired", "grant_revoked"].includes(error.code)
                ? 401
                : error instanceof SponsoredResponsesProxyError &&
                    ["request_in_progress", "conflicting_replay"].includes(error.code)
                  ? 409
                  : error instanceof SponsoredResponsesProxyError &&
                      error.code === "invalid_request"
                    ? 400
                    : 502,
            { code: error instanceof SponsoredResponsesProxyError ? error.code : "proxy_failed" },
          ),
        ),
      ),
    );
  }),
);

export const routes = Layer.merge(executeRoute, responsesRoute);
