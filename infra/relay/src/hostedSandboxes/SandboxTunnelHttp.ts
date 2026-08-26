// @effect-diagnostics globalErrorInEffectFailure:off globalErrorInEffectCatch:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SandboxBootstrapCredentials } from "./SandboxBootstrapTokens.ts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};
const json = (status: number, body: Record<string, unknown>) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

export const routes = (
  gatewayToken: string,
  options: { readonly fetch?: Fetch; readonly timeoutMs?: number } = {},
) => {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1_000), 30_000);
  const proxy = (kind: "health" | "prompts") =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ") || !safeEqual(authorization.slice(7), gatewayToken))
        return json(401, { code: "authentication_required" });
      const { sandboxId } = yield* HttpRouter.params;
      if (!sandboxId) return json(400, { code: "invalid_request" });
      const credentials = yield* SandboxBootstrapCredentials;
      const target = yield* credentials.resolve(sandboxId).pipe(Effect.orElseSucceed(() => null));
      if (!target) return json(404, { code: "sandbox_tunnel_unavailable" });
      const incomingUrl = new URL(request.url, "https://relay.invalid");
      if (kind === "health" && incomingUrl.searchParams.get("instanceId") !== target.providerRef)
        return json(403, { code: "sandbox_instance_mismatch" });
      const path = `/v1/sandboxes/${encodeURIComponent(sandboxId)}/${kind}`;
      const body = kind === "prompts" ? yield* request.text : undefined;
      if (body && body.length > 1_100_000) return json(413, { code: "request_too_large" });
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchFn(new URL(path, target.tunnelEndpoint), {
            method: kind === "health" ? "GET" : "POST",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              authorization: `Bearer ${target.controlSecret}`,
              ...(kind === "prompts"
                ? {
                    "content-type": "application/json",
                    ...(request.headers["idempotency-key"]
                      ? { "idempotency-key": request.headers["idempotency-key"] }
                      : {}),
                  }
                : {}),
            },
            ...(body === undefined ? {} : { body }),
          }),
        catch: () => new Error("sandbox_tunnel_request_failed"),
      }).pipe(Effect.orElseSucceed(() => null));
      if (!response) return json(503, { code: "sandbox_tunnel_unavailable" });
      const value = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new Error("invalid_sandbox_response"),
      }).pipe(Effect.orElseSucceed(() => null));
      if (!value || typeof value !== "object")
        return json(502, { code: "invalid_sandbox_response" });
      return json(response.status, value as Record<string, unknown>);
    });
  return Layer.merge(
    HttpRouter.add("GET", "/v1/sandboxes/:sandboxId/health", proxy("health")),
    HttpRouter.add("POST", "/v1/sandboxes/:sandboxId/prompts", proxy("prompts")),
  );
};
