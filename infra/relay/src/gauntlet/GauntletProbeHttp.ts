import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  candidateTuple,
  executeProbe,
  GauntletProbeAdapter,
  parseProbeRequest,
  validateConfiguration,
  type ProbeConfiguration,
} from "./GauntletProbe.ts";

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};
const json = (status: number, body: Readonly<Record<string, unknown>>) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });
const authenticated = (configuration: ProbeConfiguration, authorization: string | undefined) =>
  authorization?.startsWith("Bearer ") === true &&
  safeEqual(authorization.slice(7), configuration.token);

export const routes = (configuration: ProbeConfiguration) => {
  if (!validateConfiguration(configuration)) return Layer.empty;
  return Layer.merge(
    HttpRouter.add(
      "GET",
      "/api/salvo/gauntlet/v1/capabilities",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!authenticated(configuration, request.headers.authorization))
          return json(401, { code: "authentication_required" });
        const adapter = yield* GauntletProbeAdapter;
        return json(200, {
          version: 1,
          protocol: "salvo-gauntlet-v1",
          origin: configuration.origin,
          productionEquivalent: configuration.productionEquivalent,
          productionEquivalentBasis: configuration.productionEquivalent
            ? "explicit-deployment-attestation"
            : "not-attested",
          candidate: candidateTuple(configuration),
          gates: [...adapter.gates],
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/api/salvo/gauntlet/v1/gates/:gate",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!authenticated(configuration, request.headers.authorization))
          return json(401, { code: "authentication_required" });
        const { gate } = yield* HttpRouter.params;
        const input = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const probe = parseProbeRequest(gate ?? "", input);
        if (!probe || request.headers["x-salvo-gauntlet-scenario"] !== probe.scenarioId)
          return json(400, { code: "invalid_probe_request" });
        const response = yield* executeProbe(configuration, probe);
        return json(response.status, response.body);
      }),
    ),
  );
};
