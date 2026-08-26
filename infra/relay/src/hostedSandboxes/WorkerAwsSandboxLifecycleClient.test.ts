// @effect-diagnostics globalDate:off preferSchemaOverJson:off -- fixed platform dates and JSON fixtures exercise the Worker boundary.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeWorkerAwsSandboxLifecycleClient,
  parseAwsTemporaryCredentials,
  signEc2Request,
} from "./WorkerAwsSandboxLifecycleClient.ts";

const credentials = {
  accessKeyId: "ASIAEXAMPLE",
  secretAccessKey: "example-secret",
  sessionToken: "example-session",
  expiresAt: "2026-08-24T13:00:00.000Z",
};
const config = {
  region: "us-east-1",
  promotedImageId: "ami-promoted",
  imageRelease: "release-1",
  launchTemplateId: "lt-salvo",
  launchTemplateVersion: "7",
  gatewayOrigin: "https://gateway.test",
  gatewayToken: "gateway-secret",
  credentials,
};
const xml = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/xml" } });

describe("Worker AWS sandbox lifecycle client", () => {
  it("produces deterministic SigV4 and rejects operations outside the EC2 allowlist", async () => {
    const signed = await signEc2Request({
      region: "us-east-1",
      credentials,
      parameters: { Action: "StartInstances", "InstanceId.1": "i-owned", Version: "2016-11-15" },
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(signed.body).toBe("Action=StartInstances&InstanceId.1=i-owned&Version=2016-11-15");
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/20260824/us-east-1/ec2/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=dbaa7e3f8c3c3ed14b9f25182b7731db61020f1db04eb2495d45c810156843ca",
    );
    await expect(
      signEc2Request({
        region: "us-east-1",
        credentials,
        parameters: { Action: "TerminateInstances" },
        now: new Date(),
      }),
    ).rejects.toThrow("not allowlisted");
  });

  it("accepts only short-lived session credentials", () => {
    expect(
      parseAwsTemporaryCredentials(JSON.stringify(credentials), Date.parse("2026-08-24T12:00:00Z")),
    ).toEqual(credentials);
    expect(
      parseAwsTemporaryCredentials(
        JSON.stringify({ ...credentials, sessionToken: "" }),
        Date.parse("2026-08-24T12:00:00Z"),
      ),
    ).toBeNull();
    expect(
      parseAwsTemporaryCredentials(
        JSON.stringify({ ...credentials, expiresAt: "2026-08-26T12:00:00Z" }),
        Date.parse("2026-08-24T12:00:00Z"),
      ),
    ).toBeNull();
  });

  it.effect(
    "verifies volume encryption and ownership while projecting only allowlisted fields",
    () => {
      const actions: Array<string | null> = [];
      const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        actions.push(body.get("Action"));
        if (body.get("Action") === "DescribeInstances")
          return xml(
            `<DescribeInstancesResponse><instancesSet><item><instanceId>i-owned</instanceId><imageId>ami-promoted</imageId><instanceState><name>stopped</name></instanceState><blockDeviceMapping><item><ebs><volumeId>vol-owned</volumeId></ebs></item></blockDeviceMapping><tagSet><item><key>salvo:sandbox-id</key><value>sandbox-a</value></item><item><key>salvo:user-id</key><value>user-a</value></item></tagSet><privateData>must-not-escape</privateData></item></instancesSet></DescribeInstancesResponse>`,
          );
        if (body.get("Action") === "DescribeVolumes")
          return xml(
            `<DescribeVolumesResponse><volumeSet><item><volumeId>vol-owned</volumeId><encrypted>true</encrypted><tagSet><item><key>salvo:sandbox-id</key><value>sandbox-a</value></item><item><key>salvo:user-id</key><value>user-a</value></item></tagSet></item></volumeSet></DescribeVolumesResponse>`,
          );
        throw new Error("unexpected action");
      };
      const client = makeWorkerAwsSandboxLifecycleClient(config, {
        fetch,
        now: () => new Date("2026-08-24T12:00:00Z"),
      });
      return Effect.gen(function* () {
        const found = yield* client.findBySandboxId({ sandboxId: "sandbox-a" });
        expect(found).toEqual([
          {
            instanceId: "i-owned",
            imageId: "ami-promoted",
            state: "stopped",
            sandboxId: "sandbox-a",
            userId: "user-a",
            volume: {
              volumeId: "vol-owned",
              encrypted: true,
              sandboxId: "sandbox-a",
              userId: "user-a",
            },
          },
        ]);
        expect(actions).toEqual(["DescribeInstances", "DescribeVolumes"]);
        expect(JSON.stringify(found)).not.toContain("must-not-escape");
      });
    },
  );

  it.effect(
    "validates the promoted AMI and emits an encrypted, private, identically tagged launch",
    () => {
      const bodies: URLSearchParams[] = [];
      const fetch = async (target: RequestInfo | URL, init?: RequestInit) => {
        if (String(target).startsWith("https://gateway.test/"))
          return Response.json({
            token: "aa".repeat(32),
            bootstrapUrl: "https://gateway.test/v1/bootstrap/redeem",
            expiresAt: "2026-08-24T12:05:00Z",
          });
        const body = new URLSearchParams(String(init?.body));
        bodies.push(body);
        if (body.get("Action") === "DescribeImages")
          return xml(
            `<DescribeImagesResponse><imagesSet><item><imageId>ami-promoted</imageId><imageState>available</imageState><tagSet><item><key>salvo:image-release</key><value>release-1</value></item></tagSet></item></imagesSet></DescribeImagesResponse>`,
          );
        if (body.get("Action") === "RunInstances")
          return xml(
            `<RunInstancesResponse><instancesSet><item><instanceId>i-new</instanceId></item></instancesSet></RunInstancesResponse>`,
          );
        throw new Error("unexpected action");
      };
      const client = makeWorkerAwsSandboxLifecycleClient(config, {
        fetch,
        now: () => new Date("2026-08-24T12:00:00Z"),
      });
      return Effect.gen(function* () {
        expect(
          yield* client.runInstance({
            clientToken: "salvo-sandbox-a",
            sandboxId: "sandbox-a",
            userId: "user-a",
            imageId: "ami-promoted",
            imageRelease: "release-1",
            instanceType: "t3.medium",
            subnetId: "subnet-a",
            securityGroupId: "sg-a",
            instanceProfileArn: "arn:profile",
            encryptedVolume: true,
            hibernationPreferred: true,
            tags: {
              "salvo:sandbox-id": "sandbox-a",
              "salvo:user-id": "user-a",
              "salvo:image-release": "release-1",
            },
          }),
        ).toEqual({ instanceId: "i-new" });
        const run = bodies.find((body) => body.get("Action") === "RunInstances")!;
        expect(run.get("ClientToken")).toBe("salvo-sandbox-a");
        expect(run.get("LaunchTemplate.LaunchTemplateId")).toBe("lt-salvo");
        expect(run.get("LaunchTemplate.Version")).toBe("7");
        expect(Buffer.from(run.get("UserData")!, "base64").toString()).toContain(
          "/run/salvo/bootstrap-token",
        );
        for (const forbidden of [
          "ImageId",
          "InstanceType",
          "SubnetId",
          "SecurityGroupId.1",
          "IamInstanceProfile.Arn",
          "NetworkInterface.1.AssociatePublicIpAddress",
          "BlockDeviceMapping.1.Ebs.Encrypted",
        ])
          expect(run.has(forbidden)).toBe(false);
        expect(
          [...run.keys()].filter(
            (key) => key.includes("TagSpecification.1.Tag") && key.endsWith(".Key"),
          ),
        ).toHaveLength(3);
        expect(
          [...run.keys()].filter(
            (key) => key.includes("TagSpecification.2.Tag") && key.endsWith(".Key"),
          ),
        ).toHaveLength(3);
      });
    },
  );

  it.effect("does not retry a write or expose AWS error bodies", () => {
    let calls = 0;
    const client = makeWorkerAwsSandboxLifecycleClient(config, {
      fetch: async () => {
        calls++;
        return new Response(
          `<Error><Code>UnauthorizedOperation</Code><Message>secret detail</Message></Error>`,
          { status: 403 },
        );
      },
      now: () => new Date("2026-08-24T12:00:00Z"),
    });
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(client.startInstance({ instanceId: "i-owned" }));
      expect(calls).toBe(1);
      expect(String(failure.cause)).toContain("UnauthorizedOperation");
      expect(String(failure.cause)).not.toContain("secret detail");
    });
  });

  it.effect("requests hibernation through the bounded stop operation", () => {
    let body: URLSearchParams | null = null;
    const client = makeWorkerAwsSandboxLifecycleClient(config, {
      fetch: async (_target, init) => {
        body = new URLSearchParams(String(init?.body));
        return xml("<StopInstancesResponse />");
      },
      now: () => new Date("2026-08-24T12:00:00Z"),
    });
    return Effect.gen(function* () {
      yield* client.stopInstance({ instanceId: "i-owned", hibernate: true });
      expect(body!.get("Action")).toBe("StopInstances");
      expect(body!.get("Hibernate")).toBe("true");
    });
  });

  it.effect("rebootstraps only an owned instance through the exact SSM document", () => {
    const seen: Array<{ target: string; body: string }> = [];
    const fetch = async (target: RequestInfo | URL, init?: RequestInit) => {
      if (
        String(target).startsWith("https://gateway.test/v1/sandboxes/") &&
        String(target).includes("bootstrap-tokens")
      )
        return Response.json({
          token: "aa".repeat(32),
          bootstrapUrl: "https://gateway.test/v1/bootstrap/redeem",
          expiresAt: "2026-08-24T12:05:00Z",
        });
      if (String(target).startsWith("https://gateway.test/"))
        return Response.json({ ready: true, endpoint: "https://sandbox.test" });
      if (String(target).startsWith("https://ssm.")) {
        seen.push({ target: String(target), body: String(init?.body) });
        const operation = new Headers(init?.headers).get("x-amz-target");
        if (operation === "AmazonSSM.DescribeInstanceInformation")
          return Response.json({
            InstanceInformationList: [{ InstanceId: "i-owned", PingStatus: "Online" }],
          });
        if (operation === "AmazonSSM.SendCommand")
          return Response.json({ Command: { CommandId: "command-a" } });
        if (operation === "AmazonSSM.GetCommandInvocation")
          return Response.json({ Status: "Success" });
      }
      const body = new URLSearchParams(String(init?.body));
      if (body.get("Action") === "DescribeInstances")
        return xml(
          `<DescribeInstancesResponse><instancesSet><item><instanceId>i-owned</instanceId><imageId>ami-promoted</imageId><instanceState><name>running</name></instanceState><blockDeviceMapping><item><ebs><volumeId>vol-owned</volumeId></ebs></item></blockDeviceMapping><tagSet><item><key>salvo:sandbox-id</key><value>sandbox-a</value></item><item><key>salvo:user-id</key><value>user-a</value></item></tagSet></item></instancesSet></DescribeInstancesResponse>`,
        );
      if (body.get("Action") === "DescribeVolumes")
        return xml(
          `<DescribeVolumesResponse><volumeSet><item><volumeId>vol-owned</volumeId><encrypted>true</encrypted><tagSet><item><key>salvo:sandbox-id</key><value>sandbox-a</value></item><item><key>salvo:user-id</key><value>user-a</value></item></tagSet></item></volumeSet></DescribeVolumesResponse>`,
        );
      throw new Error("unexpected request");
    };
    const client = makeWorkerAwsSandboxLifecycleClient(config, {
      fetch,
      now: () => new Date("2026-08-24T12:00:00Z"),
      delay: async () => {},
    });
    return Effect.gen(function* () {
      expect(
        yield* client.rebootstrapInstance({
          instanceId: "i-owned",
          sandboxId: "sandbox-a",
          userId: "user-a",
          clientToken: "salvo-sandbox-a",
        }),
      ).toEqual({ commandId: "command-a" });
      const command = JSON.parse(
        seen.find((entry) => entry.body.includes("AWS-RunShellScript"))!.body,
      ) as Record<string, unknown>;
      expect(command).toMatchObject({
        DocumentName: "AWS-RunShellScript",
        InstanceIds: ["i-owned"],
        TimeoutSeconds: 120,
      });
      expect(JSON.stringify(command)).toContain("salvo-bootstrap.service");
      expect(JSON.stringify(command)).not.toContain("gateway-secret");
    });
  });
});
