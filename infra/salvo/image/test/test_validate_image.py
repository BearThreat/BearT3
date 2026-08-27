import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("salvo_image_validate", ROOT / "validate.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ValidateImageTest(unittest.TestCase):
    def test_checked_in_manifest_is_valid(self):
        result = MODULE.validate(ROOT / "image-manifest.json")
        self.assertTrue(result["valid"])

    def test_skill_release_tampering_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory)
            manifest = json.loads((ROOT / "image-manifest.json").read_text())
            (target / "skills-release.json").write_text("tampered")
            (target / "image-manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(SystemExit, "skill release hash mismatch"):
                MODULE.validate(target / "image-manifest.json")

    def test_public_inbound_policy_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory)
            manifest = copy.deepcopy(json.loads((ROOT / "image-manifest.json").read_text()))
            manifest["inboundAccess"] = "ssh"
            (target / "skills-release.json").write_bytes((ROOT / "skills-release.json").read_bytes())
            (target / "image-manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(SystemExit, "no inbound access"):
                MODULE.validate(target / "image-manifest.json")

    def test_runtime_artifacts_encode_boot_contract(self):
        unit = (ROOT / "systemd/salvo-readiness.service").read_text()
        runtime_unit = (ROOT / "systemd/salvo.service").read_text()
        component = (ROOT / "components/salvo-runtime.yml").read_text()
        preparation = (ROOT / "prepare-image.sh").read_text()
        self.assertIn("amazon-ssm-agent.service", unit)
        self.assertIn("salvo.service", unit)
        self.assertIn("EnvironmentFile=/etc/salvo/sandbox.env", runtime_unit)
        self.assertIn("RequiresMountsFor=/var/lib/salvo", runtime_unit)
        self.assertIn("TimeoutStopSec=130", runtime_unit)
        self.assertNotIn("SALVO_CONTROL_SECRET", runtime_unit)
        self.assertIn("validate-image.sh --installed", component)
        validation = (ROOT / "validate-image.sh").read_text()
        self.assertIn("sha256sum --check --status", validation)
        self.assertIn("cloudflared version 2026.5.2", validation)
        self.assertNotIn("systemctl disable cloud-init.service", preparation)
        self.assertIn("rm -rf /var/lib/cloud/instances", preparation)
        self.assertNotIn("yum install", preparation)
        self.assertNotIn("dnf install", preparation)


if __name__ == "__main__":
    unittest.main()
