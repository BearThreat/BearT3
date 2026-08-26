// @effect-diagnostics globalErrorInEffectFailure:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};
const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
const body = Effect.fn("salvo.bootstrap.read_body")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const value = yield* request.json.pipe(Effect.mapError(() => new Error("invalid_json")));
  if (!value || typeof value !== "object") return yield* Effect.fail(new Error("invalid_json"));
  return value as Record<string, unknown>;
});

export const routes = (gatewayToken: string) =>
  Layer.merge(
    HttpRouter.add(
      "POST",
      "/v1/sandboxes/:sandboxId/bootstrap-tokens",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        if (
          !authorization?.startsWith("Bearer ") ||
          !safeEqual(authorization.slice(7), gatewayToken)
        )
          return json(401, { code: "authentication_required" });
        const { sandboxId } = yield* HttpRouter.params;
        const value: Record<string, unknown> = yield* body().pipe(Effect.orElseSucceed(() => ({})));
        if (!sandboxId || typeof value.userId !== "string" || typeof value.clientToken !== "string")
          return json(400, { code: "invalid_request" });
        const credentials = yield* SandboxBootstrapCredentials;
        return yield* credentials
          .issue({ sandboxId, userId: value.userId, clientToken: value.clientToken })
          .pipe(
            Effect.map((issued) => json(201, issued)),
            Effect.orElseSucceed(() => json(400, { code: "bootstrap_issue_rejected" })),
          );
      }),
    ),
    HttpRouter.add(
      "POST",
      "/v1/bootstrap/redeem",
      Effect.gen(function* () {
        const value: Record<string, unknown> = yield* body().pipe(Effect.orElseSucceed(() => ({})));
        if (
          typeof value.token !== "string" ||
          typeof value.sandboxId !== "string" ||
          typeof value.userId !== "string" ||
          typeof value.clientToken !== "string"
        )
          return json(400, { code: "invalid_request" });
        const credentials = yield* SandboxBootstrapCredentials;
        return yield* credentials
          .redeem({
            token: value.token,
            sandboxId: value.sandboxId,
            userId: value.userId,
            clientToken: value.clientToken,
          })
          .pipe(
            Effect.map((redeemed) => json(200, redeemed)),
            Effect.orElseSucceed(() => json(403, { code: "bootstrap_token_rejected" })),
          );
      }),
    ),
  );
