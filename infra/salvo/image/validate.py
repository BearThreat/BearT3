#!/usr/bin/env python3
import hashlib
import json
import pathlib
import sys


def fail(message: str) -> None:
    raise SystemExit(f"INVALID_IMAGE_MANIFEST: {message}")


def validate(manifest_path: pathlib.Path) -> dict:
    root = manifest_path.resolve().parent
    data = json.loads(manifest_path.read_text())
    if data.get("schemaVersion") != 1:
        fail("schemaVersion must be 1")
    if data.get("baseImage", "").startswith("ami-"):
        fail("baseImage must be resolved at build time, not pinned by hand")
    if data.get("cloudInitRuntimeConfiguration") != "bootstrap-payload-only":
        fail("cloud-init must be limited to the one-time bootstrap payload")
    if data.get("inboundAccess") != "none" or data.get("management") != "ssm-outbound-only":
        fail("image requires SSM outbound-only management and no inbound access")
    if not data.get("rootVolumeEncrypted") or data.get("rootVolumeType") != "gp3":
        fail("root volume must be encrypted gp3")
    hibernation = data.get("hibernation", {})
    if not hibernation.get("configuredAtLaunch") or not hibernation.get("encryptedRootRequired"):
        fail("hibernation must be enabled at launch with encrypted root")
    if data.get("rootVolumeGiB", 0) < hibernation.get("minimumRootGiB", 0):
        fail("root volume is too small for declared hibernation policy")
    release = data.get("skillRelease", {})
    release_path = (root / release.get("path", "")).resolve()
    if root not in release_path.parents or not release_path.is_file():
        fail("skill release must be a regular file inside the image directory")
    actual = hashlib.sha256(release_path.read_bytes()).hexdigest()
    if release.get("sha256") != actual:
        fail("skill release hash mismatch")
    return {"valid": True, "skillReleaseSha256": actual, "manifest": str(manifest_path)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        fail("usage: validate.py MANIFEST")
    print(json.dumps(validate(pathlib.Path(sys.argv[1])), sort_keys=True))
