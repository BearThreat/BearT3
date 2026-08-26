import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { CanaryBudgetAuthority } from "./CanaryBudgetAuthority.ts";

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};
const json = (status: number, body: Readonly<Record<string, unknown>>) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

export const routes = (configuration: {
  readonly enabled: boolean;
  readonly token: string;
  readonly operatorUserIds: ReadonlySet<string>;
}) => {
  if (!configuration.enabled || !configuration.token || configuration.operatorUserIds.size === 0)
    return Layer.empty;
  const operation = (kind: "status" | "stop" | "reconcileAndUnstop") =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const userId = request.headers["x-salvo-operator-user-id"];
      if (
        !authorization?.startsWith("Bearer ") ||
        !safeEqual(authorization.slice(7), configuration.token) ||
        !userId ||
        !configuration.operatorUserIds.has(userId)
      )
        return json(401, { code: "authentication_required" });
      const authority = yield* CanaryBudgetAuthority;
      const result = yield* Effect.result(authority[kind](userId));
      return Result.isFailure(result)
        ? json(result.failure.code === "cap_exceeded" ? 409 : 503, { code: result.failure.code })
        : json(200, result.success);
    });
  return Layer.mergeAll(
    HttpRouter.add("GET", "/api/salvo/canary-budget/v1/status", operation("status")),
    HttpRouter.add("POST", "/api/salvo/canary-budget/v1/stop", operation("stop")),
    HttpRouter.add(
      "POST",
      "/api/salvo/canary-budget/v1/reconcile-unstop",
      operation("reconcileAndUnstop"),
    ),
  );
};
