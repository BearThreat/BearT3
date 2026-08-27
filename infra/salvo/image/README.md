# Salvo cached AMI pipeline

This directory is the reproducible, local source for the Salvo sandbox AMI. It uses an EC2 Image Builder component because the AWS CLI is already available and Packer is not. Nothing here mutates AWS: promotion remains a separate, explicitly authorized operation.

`build-controller.mjs` creates a local, content-addressed payload containing the already-built sandbox server entrypoint, the exact Node binary, the installed Codex package and native executable, the pinned cloudflared 2026.5.2 Linux x64 binary, systemd and preparation files, and a dereferenced snapshot of the maintained skill library. `artifact-manifest.json` records the mode, size, and SHA-256 of every staged file. Validation recomputes the full file set and every record, so additions, removals, content changes, and executable-bit changes fail closed.

The controller does not resolve an AMI, call AWS, or support `apply`. EC2 Image Builder is a later, separately authorized consumer: it must extract the validated payload at `/`, run `components/salvo-runtime.yml`, and perform the disposable-instance checks described below. Cloud-init remains enabled only to stage the short-lived first-boot bootstrap payload; it does no package installation or build work.

Build and stage locally with:

```bash
./node_modules/.bin/vp run --filter t3 build:bundle
node infra/salvo/image/build-controller.mjs plan
node infra/salvo/image/build-controller.mjs stage
node infra/salvo/image/build-controller.mjs validate
node infra/salvo/image/build-controller.mjs status
```

The default output is the ignored `.salvo-build/image-stage` directory. The pinned cloudflared binary is cached at `.salvo-build/downloads/cloudflared-linux-amd64`; its expected URL and SHA-256 are in `cloudflared-release.json`. The controller never downloads it and refuses a missing, non-executable, or mismatched binary. Override inputs with `--server-bundle`, `--node`, `--codex`, `--cloudflared`, `--skills-dir`, and `--output`. Instance provisioning supplies `/etc/salvo/sandbox.env`, the control-secret file, and a unique Cloudflare connector token after launch. None may be captured in the image.

## Outbound tunnel contract

Each sandbox has its own remotely managed Cloudflare Tunnel. Its ingress configuration maps the sandbox's private hostname to `http://127.0.0.1:4318` and preserves the request path. The authenticated tunnel control service used by `WorkerAwsSandboxLifecycleClient` keeps the sandbox-to-hostname mapping and forwards these exact operations:

- `GET /v1/sandboxes/:sandboxId/health?instanceId=:instanceId` to the same path through that sandbox's hostname.
- `POST /v1/sandboxes/:sandboxId/prompts` to the same path, preserving `authorization`, `idempotency-key`, content type, and body.

Bootstrap redemption must return `controlSecret`, `environment`, `tunnelToken`, and `tunnelEndpoint`. The token must be unique to that sandbox tunnel. `salvo-bootstrap.sh` writes it directly to `/etc/salvo/tunnel-token` with mode `0640`, removes the one-time inputs, and never prints either credential. `salvo-tunnel.service` passes it to cloudflared via `--token-file`, binds its metrics/readiness listener to loopback, and restarts on failure. Salvo readiness is withheld until both the prompt receiver and cloudflared report ready. The instance has no public IP and no inbound security-group rule.

The tunnel control service must reject a hostname whose stored sandbox and instance ownership do not match the route, authenticate the worker's gateway bearer before proxying, and independently authenticate the sandbox response. A connector process becoming healthy is transport evidence only; `WorkerAwsSandboxLifecycleClient` treats the authenticated sandbox health response as readiness.

Launch policy must enforce an encrypted gp3 root volume, no inbound security-group rules, an SSM instance profile, IMDSv2, and `HibernationOptions.Configured=true`. The selected instance type must be in the manifest allowlist and its RAM must fit the encrypted root volume under EC2's hibernation requirements. Outbound access should be limited to SSM, artifact/model endpoints, DNS, time synchronization, and the Salvo tunnel.

Test the controller and source policy locally with:

```bash
uv run infra/salvo/image/validate.py infra/salvo/image/image-manifest.json
uv run infra/salvo/image/test/test_validate_image.py
node --test infra/salvo/image/test/build-controller.test.mjs
```

Image Builder must additionally run `validate-image.sh --installed`, boot a disposable test instance with no inbound rules, wait for the SSM and `/run/salvo/image-ready` signals, and terminate it. Only that tested AMI may be written to a versioned image registry record. A small `current.json` pointer should contain release, AMI ID, region, manifest hash, skill-release hash, verification time, and previous release. Promotion is an atomic pointer update after verification. Rollback changes the pointer to the previous still-verified record; running or hibernated sandboxes are not silently replaced and are migrated on an explicit lifecycle event.

Secrets and user data never enter the AMI. The skill release is immutable input, not a mutable checkout. Updating it requires changing the release file and its manifest hash, rebuilding, testing, and promoting a new image version.
