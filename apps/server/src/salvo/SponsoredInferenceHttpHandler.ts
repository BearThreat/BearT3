import {
  SponsoredInferenceGateway,
  SponsoredInferenceGatewayError,
  type SponsoredInferencePrincipal,
  type SponsoredInferenceRequest,
} from "./SponsoredInferenceGateway.js";

export type SponsoredInferenceAuthenticator = (
  request: Request,
) => Promise<SponsoredInferencePrincipal | null>;

const json = (status: number, body: Readonly<Record<string, unknown>>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const statusFor = (code: SponsoredInferenceGatewayError["code"]) => {
  switch (code) {
    case "invalid_grant":
    case "grant_expired":
    case "grant_revoked":
      return 401;
    case "global_stop":
      return 503;
    case "budget_denied":
      return 402;
    case "provider_failed":
    case "provider_over_budget":
      return 502;
    case "request_in_progress":
      return 409;
    default:
      return 400;
  }
};

/**
 * Hosted Salvo can mount this transport-neutral Fetch handler in its control plane.
 * Authentication is injected so sandbox grants never become environment sessions.
 */
export const makeSponsoredInferenceHttpHandler =
  (options: {
    readonly gateway: SponsoredInferenceGateway;
    readonly authenticate: SponsoredInferenceAuthenticator;
  }) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
    const principal = await options.authenticate(request);
    if (!principal) return json(401, { code: "authentication_required" });
    const grant = request.headers.get("salvo-inference-grant");
    if (!grant) return json(401, { code: "invalid_grant" });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { code: "invalid_request" });
    }
    try {
      const result = await options.gateway.execute(
        principal,
        grant,
        body as SponsoredInferenceRequest,
      );
      return json(200, result);
    } catch (cause) {
      const error =
        cause instanceof SponsoredInferenceGatewayError
          ? cause
          : new SponsoredInferenceGatewayError("provider_failed");
      return json(statusFor(error.code), { code: error.code });
    }
  };
