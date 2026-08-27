#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const imageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(imageDir, "../../..");
const configPath = join(imageDir, "build-config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const command = process.argv[2] ?? "status";
const flag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const resolveCommand = (name) =>
  realpathSync(execFileSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim());
const resolveInputs = () => {
  const serverBundle = resolve(repoRoot, flag("--server-bundle") ?? config.serverBundle);
  const nodeBinary = realpathSync(flag("--node") ?? resolveCommand("node"));
  const codexCandidate = flag("--codex") ?? resolveCommand("codex");
  if (!existsSync(codexCandidate))
    throw new Error("Codex package is incomplete: bin/codex.js missing");
  const codexEntry = realpathSync(codexCandidate);
  const codexPackage = resolve(codexEntry, "../..");
  const cloudflaredReleasePath = resolve(
    flag("--cloudflared-release") ?? join(imageDir, "cloudflared-release.json"),
  );
  const cloudflaredBinary = realpathSync(
    flag("--cloudflared") ?? resolve(repoRoot, config.cloudflaredBinary),
  );
  const skillsDirectory = realpathSync(
    flag("--skills-dir") ?? process.env.SALVO_SKILLS_DIR ?? "/home/blackbear/.agents/skills",
  );
  const artifactDirectory = resolve(repoRoot, flag("--output") ?? config.artifactDirectory);
  return {
    serverBundle,
    nodeBinary,
    codexPackage,
    cloudflaredBinary,
    cloudflaredReleasePath,
    skillsDirectory,
    artifactDirectory,
  };
};
const requiredSourceFiles = [
  "image-manifest.json",
  "skills-release.json",
  "validate.py",
  "validate-image.sh",
  "prepare-image.sh",
  "readiness-check.sh",
  "codex.sh",
  "salvo-bootstrap.sh",
  "components/salvo-runtime.yml",
  "systemd/salvo.service",
  "cloudflared-release.json",
  "systemd/salvo-bootstrap.service",
  "systemd/salvo-tunnel.service",
  "systemd/salvo-readiness.service",
];
const checkInputs = (inputs) => {
  if (config.schemaVersion !== 1 || config.artifactName !== "salvo-ami-payload")
    throw new Error("invalid build config");
  const imageConfig = JSON.parse(readFileSync(join(imageDir, "image-manifest.json"), "utf8"));
  if (
    imageConfig.schemaVersion !== 1 ||
    imageConfig.cloudInitRuntimeConfiguration !== "bootstrap-payload-only" ||
    imageConfig.inboundAccess !== "none" ||
    imageConfig.management !== "ssm-outbound-only"
  )
    throw new Error("invalid image security config");
  const skillRelease = resolve(imageDir, imageConfig.skillRelease?.path ?? "");
  if (
    !inside(imageDir, skillRelease) ||
    !existsSync(skillRelease) ||
    sha256(skillRelease) !== imageConfig.skillRelease?.sha256
  )
    throw new Error("invalid skill release config or hash");
  if (!existsSync(inputs.serverBundle) || !statSync(inputs.serverBundle).isFile())
    throw new Error(`missing server bundle: ${inputs.serverBundle}`);
  if (!statSync(inputs.nodeBinary).isFile() || !(statSync(inputs.nodeBinary).mode & 0o111))
    throw new Error("node runtime is missing or not executable");
  if (!existsSync(join(inputs.codexPackage, "bin/codex.js")))
    throw new Error("Codex package is incomplete: bin/codex.js missing");
  const cloudflaredRelease = JSON.parse(readFileSync(inputs.cloudflaredReleasePath, "utf8"));
  if (
    !statSync(inputs.cloudflaredBinary).isFile() ||
    !(statSync(inputs.cloudflaredBinary).mode & 0o111) ||
    sha256(inputs.cloudflaredBinary) !== cloudflaredRelease.sha256
  )
    throw new Error(
      "cloudflared binary is missing, not executable, or does not match the pinned release",
    );
  if (!statSync(inputs.skillsDirectory).isDirectory())
    throw new Error("skills directory is missing");
  for (const path of requiredSourceFiles)
    if (!existsSync(join(imageDir, path))) throw new Error(`missing image source: ${path}`);
};
async function walk(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`symlinks are not allowed in staged inputs: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
      else throw new Error(`unsupported staged input: ${path}`);
    }
  }
  await visit(root);
  return output.sort();
}
async function manifestFor(root, inputs) {
  const files = await walk(root);
  return {
    schemaVersion: 1,
    artifactName: config.artifactName,
    inputs: {
      serverBundleSha256: sha256(inputs.serverBundle),
      nodeSha256: sha256(inputs.nodeBinary),
      codexPackageVersion: JSON.parse(
        readFileSync(join(inputs.codexPackage, "package.json"), "utf8"),
      ).version,
      cloudflaredSha256: sha256(inputs.cloudflaredBinary),
      skillsReleaseSha256: sha256(join(imageDir, "skills-release.json")),
    },
    files: files.map((path) => ({
      path: relative(root, path),
      mode: statSync(path).mode & 0o777,
      size: statSync(path).size,
      sha256: sha256(path),
    })),
  };
}
async function stage(inputs) {
  checkInputs(inputs);
  if (
    inside(inputs.artifactDirectory, inputs.skillsDirectory) ||
    inside(inputs.skillsDirectory, inputs.artifactDirectory)
  )
    throw new Error("artifact and skills directories must not overlap");
  rmSync(inputs.artifactDirectory, { recursive: true, force: true });
  const rootfs = join(inputs.artifactDirectory, "rootfs");
  const put = async (source, destination, dereference = false) => {
    mkdirSync(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference, preserveTimestamps: false });
  };
  await put(inputs.serverBundle, join(rootfs, "opt/salvo/server/dist/sandbox-runtime.mjs"));
  await put(inputs.nodeBinary, join(rootfs, "opt/salvo/runtime/node/bin/node"));
  await put(inputs.codexPackage, join(rootfs, "opt/salvo/runtime/codex"));
  await put(inputs.cloudflaredBinary, join(rootfs, "opt/salvo/runtime/cloudflared"));
  await put(inputs.skillsDirectory, join(rootfs, "opt/salvo/skills/library"), true);
  for (const path of requiredSourceFiles)
    await put(join(imageDir, path), join(rootfs, "opt/salvo/image", path));
  await put(
    join(imageDir, "systemd/salvo.service"),
    join(rootfs, "etc/systemd/system/salvo.service"),
  );
  await put(
    join(imageDir, "systemd/salvo-bootstrap.service"),
    join(rootfs, "etc/systemd/system/salvo-bootstrap.service"),
  );
  await put(
    join(imageDir, "systemd/salvo-tunnel.service"),
    join(rootfs, "etc/systemd/system/salvo-tunnel.service"),
  );
  await put(
    join(imageDir, "systemd/salvo-readiness.service"),
    join(rootfs, "etc/systemd/system/salvo-readiness.service"),
  );
  const manifest = await manifestFor(rootfs, inputs);
  writeFileSync(
    join(inputs.artifactDirectory, "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return validate(inputs);
}
async function validate(inputs) {
  const root = inputs.artifactDirectory;
  const manifestPath = join(root, "artifact-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing artifact manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactName !== config.artifactName ||
    !Array.isArray(manifest.files)
  )
    throw new Error("invalid artifact manifest shape");
  const rootfs = realpathSync(join(root, "rootfs"));
  const actualFiles = await walk(rootfs);
  if (actualFiles.length !== manifest.files.length)
    throw new Error("artifact file set does not match manifest");
  for (const record of manifest.files) {
    const path = resolve(rootfs, record.path);
    if (!inside(rootfs, path) || !existsSync(path) || !lstatSync(path).isFile())
      throw new Error(`invalid or missing artifact file: ${record.path}`);
    if (
      sha256(path) !== record.sha256 ||
      statSync(path).size !== record.size ||
      (statSync(path).mode & 0o777) !== record.mode
    )
      throw new Error(`artifact metadata mismatch: ${record.path}`);
  }
  const required = [
    "opt/salvo/server/dist/sandbox-runtime.mjs",
    "opt/salvo/runtime/node/bin/node",
    "opt/salvo/runtime/codex/bin/codex.js",
    "opt/salvo/runtime/cloudflared",
    "opt/salvo/image/codex.sh",
    "etc/systemd/system/salvo.service",
    "etc/systemd/system/salvo-bootstrap.service",
    "etc/systemd/system/salvo-tunnel.service",
    "etc/systemd/system/salvo-readiness.service",
    "opt/salvo/image/image-manifest.json",
    "opt/salvo/image/skills-release.json",
  ];
  for (const path of required)
    if (!existsSync(join(rootfs, path))) throw new Error(`required artifact missing: ${path}`);
  const runtimeUnit = readFileSync(join(rootfs, "etc/systemd/system/salvo.service"), "utf8");
  if (
    !runtimeUnit.includes("Requires=salvo-bootstrap.service") ||
    !runtimeUnit.includes("ExecStart=/opt/salvo/runtime/node/bin/node")
  )
    throw new Error("runtime unit configuration is incomplete");
  for (const path of [
    "opt/salvo/runtime/node/bin/node",
    "opt/salvo/runtime/cloudflared",
    "opt/salvo/image/codex.sh",
    "opt/salvo/image/salvo-bootstrap.sh",
    "opt/salvo/image/prepare-image.sh",
    "opt/salvo/image/validate-image.sh",
    "opt/salvo/image/readiness-check.sh",
  ])
    if (!(statSync(join(rootfs, path)).mode & 0o111))
      throw new Error(`required executable bit missing: ${path}`);
  const codexNative = (
    await walk(join(rootfs, "opt/salvo/runtime/codex/node_modules/@openai"))
  ).filter((path) => path.endsWith("/bin/codex"));
  if (codexNative.length !== 1 || !(statSync(codexNative[0]).mode & 0o111))
    throw new Error("exactly one executable native Codex runtime is required");
  if (
    !(await walk(join(rootfs, "opt/salvo/skills/library"))).some((path) =>
      path.endsWith("SKILL.md"),
    )
  )
    throw new Error("staged skill library has no SKILL.md files");
  return {
    valid: true,
    artifactDirectory: root,
    fileCount: manifest.files.length,
    manifestSha256: sha256(manifestPath),
  };
}
function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
try {
  if (command === "capabilities")
    print({
      commands: ["capabilities", "plan", "stage", "validate", "status"],
      awsMutation: false,
      applySupported: false,
    });
  else if (command === "plan") {
    const inputs = resolveInputs();
    checkInputs(inputs);
    print({ action: "local-stage", awsMutation: false, ...inputs });
  } else {
    const inputs = resolveInputs();
    if (command === "stage") print(await stage(inputs));
    else if (command === "validate") print(await validate(inputs));
    else if (command === "status")
      print(
        existsSync(join(inputs.artifactDirectory, "artifact-manifest.json"))
          ? await validate(inputs)
          : { valid: false, staged: false, artifactDirectory: inputs.artifactDirectory },
      );
    else throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
}
