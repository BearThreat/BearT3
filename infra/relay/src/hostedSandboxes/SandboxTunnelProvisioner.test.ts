import { describe, expect, it } from "@effect/vitest";
import {
  makeSandboxTunnelProvisioner,
  sandboxTunnelIdentity,
  type SandboxTunnelProvider,
} from "./SandboxTunnelProvisioner.ts";

const fake = (existing = false) => {
  const calls: Array<unknown> = [];
  const identity = sandboxTunnelIdentity("sandbox-a", "sandboxes.example.com");
  const provider: SandboxTunnelProvider = {
    findTunnel: async (name) => {
      calls.push(["find", name]);
      return existing ? [{ id: "tunnel-1", name }] : [];
    },
    createTunnel: async (name) => {
      calls.push(["create", name]);
      return { id: "tunnel-1", name };
    },
    configureTunnel: async (...args) => {
      calls.push(["configure", ...args]);
    },
    bindHostname: async (...args) => {
      calls.push(["bind", ...args]);
    },
    getToken: async (id) => {
      calls.push(["token", id]);
      return "token".repeat(8);
    },
    unbindHostname: async (...args) => {
      calls.push(["unbind", ...args]);
    },
    deleteTunnel: async (id) => {
      calls.push(["delete", id]);
      existing = false;
    },
  };
  return {
    calls,
    identity,
    provisioner: makeSandboxTunnelProvisioner(provider, { baseDomain: "sandboxes.example.com" }),
  };
};

describe("SandboxTunnelProvisioner", () => {
  it("idempotently configures one private loopback origin and returns its scoped credential", async () => {
    const context = fake(true);
    const result = await context.provisioner.provision("sandbox-a");
    expect(result).toEqual({
      token: "token".repeat(8),
      endpoint: `https://${context.identity.hostname}`,
      tunnelId: "tunnel-1",
    });
    expect(context.calls).toEqual([
      ["find", context.identity.name],
      ["configure", "tunnel-1", context.identity.hostname, "http://127.0.0.1:4318"],
      ["bind", context.identity.hostname, "tunnel-1"],
      ["token", "tunnel-1"],
    ]);
  });

  it("retires only the exact owned tunnel and confirms deletion", async () => {
    const context = fake(true);
    expect(await context.provisioner.retire("sandbox-a", "tunnel-1")).toEqual({
      retired: true,
      attempts: 1,
    });
    expect(context.calls).toEqual([
      ["find", context.identity.name],
      ["unbind", context.identity.hostname, "tunnel-1"],
      ["delete", "tunnel-1"],
      ["find", context.identity.name],
    ]);
    const mismatch = fake(true);
    await expect(mismatch.provisioner.retire("sandbox-a", "not-owned")).rejects.toThrow(
      "sandbox_tunnel_ownership_mismatch",
    );
    expect(mismatch.calls).toEqual([["find", mismatch.identity.name]]);
  });

  it("bounds cleanup retries and treats already-absent tunnels as retired", async () => {
    const absent = fake(false);
    expect(await absent.provisioner.retire("sandbox-a", "tunnel-1")).toEqual({
      retired: true,
      attempts: 1,
    });
    const context = fake(true);
    let failures = 0;
    const provider = {
      ...({} as SandboxTunnelProvider),
      findTunnel: async () => [{ id: "tunnel-1", name: context.identity.name }],
      unbindHostname: async () => {
        failures++;
        throw new Error("transient");
      },
      deleteTunnel: async () => {},
      createTunnel: async () => ({ id: "", name: "" }),
      configureTunnel: async () => {},
      bindHostname: async () => {},
      getToken: async () => "",
    };
    await expect(
      makeSandboxTunnelProvisioner(provider, {
        baseDomain: "sandboxes.example.com",
        cleanupAttempts: 2,
      }).retire("sandbox-a", "tunnel-1"),
    ).rejects.toThrow("sandbox_tunnel_cleanup_failed");
    expect(failures).toBe(2);
  });

  it("creates a missing tunnel and rejects ambiguous provider state", async () => {
    const created = fake(false);
    await created.provisioner.provision("sandbox-a");
    expect(created.calls[1]).toEqual(["create", created.identity.name]);
    const provider: SandboxTunnelProvider = {
      ...({} as SandboxTunnelProvider),
      findTunnel: async () => [
        { id: "a", name: "x" },
        { id: "b", name: "x" },
      ],
    };
    await expect(
      makeSandboxTunnelProvisioner(provider, { baseDomain: "sandboxes.example.com" }).provision(
        "sandbox-a",
      ),
    ).rejects.toThrow("ambiguous_sandbox_tunnel");
  });
});
