// @effect-diagnostics globalDate:off -- Deterministic adapter over provider clients.
import * as NodeCrypto from "node:crypto";

export type SandboxTunnelCredential = {
  readonly token: string;
  readonly endpoint: string;
  readonly tunnelId: string;
};
export type SandboxTunnelProvider = {
  readonly findTunnel: (name: string) => Promise<ReadonlyArray<{ id: string; name: string }>>;
  readonly createTunnel: (name: string) => Promise<{ id: string; name: string }>;
  readonly configureTunnel: (id: string, hostname: string, origin: string) => Promise<void>;
  readonly bindHostname: (hostname: string, tunnelId: string) => Promise<void>;
  readonly getToken: (id: string) => Promise<string>;
  readonly unbindHostname: (hostname: string, tunnelId: string) => Promise<void>;
  readonly deleteTunnel: (id: string) => Promise<void>;
};

const validSandboxId = (value: string) => /^[A-Za-z0-9_-]{1,64}$/.test(value);
const safeBaseDomain = (value: string) =>
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);

export const sandboxTunnelIdentity = (sandboxId: string, baseDomain: string) => {
  if (!validSandboxId(sandboxId) || !safeBaseDomain(baseDomain))
    throw new Error("invalid_sandbox_tunnel_identity");
  const key = NodeCrypto.createHash("sha256").update(sandboxId).digest("hex").slice(0, 32);
  return { name: `salvo-sandbox-${key}`, hostname: `sbx-${key}.${baseDomain}` };
};

export const makeSandboxTunnelProvisioner = (
  provider: SandboxTunnelProvider,
  options: {
    readonly baseDomain: string;
    readonly localOrigin?: string;
    readonly cleanupAttempts?: number;
  },
) => ({
  provision: async (sandboxId: string): Promise<SandboxTunnelCredential> => {
    const identity = sandboxTunnelIdentity(sandboxId, options.baseDomain);
    const matches = await provider.findTunnel(identity.name);
    if (matches.length > 1 || matches.some((item) => item.name !== identity.name || !item.id))
      throw new Error("ambiguous_sandbox_tunnel");
    const tunnel = matches[0] ?? (await provider.createTunnel(identity.name));
    if (!tunnel.id || tunnel.name !== identity.name)
      throw new Error("invalid_sandbox_tunnel_allocation");
    await provider.configureTunnel(
      tunnel.id,
      identity.hostname,
      options.localOrigin ?? "http://127.0.0.1:4318",
    );
    await provider.bindHostname(identity.hostname, tunnel.id);
    const token = await provider.getToken(tunnel.id);
    if (token.length < 32) throw new Error("invalid_sandbox_tunnel_token");
    return { token, endpoint: `https://${identity.hostname}`, tunnelId: tunnel.id };
  },
  retire: async (
    sandboxId: string,
    expectedTunnelId: string,
  ): Promise<{ retired: boolean; attempts: number }> => {
    const identity = sandboxTunnelIdentity(sandboxId, options.baseDomain);
    const maxAttempts = Math.min(Math.max(options.cleanupAttempts ?? 3, 1), 5);
    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const matches = await provider.findTunnel(identity.name);
        if (matches.length === 0) return { retired: true, attempts };
        if (
          matches.length !== 1 ||
          matches[0]!.name !== identity.name ||
          matches[0]!.id !== expectedTunnelId
        ) {
          throw new Error("sandbox_tunnel_ownership_mismatch");
        }
        await provider.unbindHostname(identity.hostname, expectedTunnelId);
        await provider.deleteTunnel(expectedTunnelId);
        const remaining = await provider.findTunnel(identity.name);
        if (remaining.length === 0) return { retired: true, attempts };
        if (remaining.some((item) => item.id !== expectedTunnelId || item.name !== identity.name))
          throw new Error("sandbox_tunnel_ownership_mismatch");
        throw new Error("sandbox_tunnel_cleanup_not_confirmed");
      } catch (error) {
        if (error instanceof Error && error.message === "sandbox_tunnel_ownership_mismatch")
          throw error;
        if (attempts >= maxAttempts)
          throw new Error("sandbox_tunnel_cleanup_failed", { cause: error });
      }
    }
  },
});
