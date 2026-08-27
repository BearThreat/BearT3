import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SOURCE_ROOT / "scripts" / "infra_state.py"


class InfraStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "providers" / "aws").mkdir(parents=True)
        for name, payload in (("status", {"provider": "aws", "count": 2}), ("cost-check", {"provider": "aws", "amount": "1.23", "unit": "USD"})):
            path = self.root / "providers" / "aws" / name
            path.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps(payload) + "'\n")
            path.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, command):
        raw = subprocess.check_output(["uv", "run", str(SCRIPT), command, "--root", str(self.root)], text=True)
        return json.loads(raw)

    def test_init_refresh_export_list_and_render(self):
        self.assertTrue(self.invoke("init")["ok"])
        refreshed = self.invoke("refresh")
        self.assertEqual(refreshed["providers"][0]["status"]["count"], 2)
        self.assertIsNone(refreshed["providers"][0]["lastError"])
        self.assertTrue(self.invoke("export")["ok"])
        self.assertEqual(self.invoke("list")["providers"][0]["cost"]["amount"], "1.23")
        self.assertTrue(self.invoke("render")["ok"])
        self.assertTrue((self.root / "state" / "infra-state.sqlite").is_file())
        self.assertTrue((self.root / "state" / "infra-state.json").is_file())
        self.assertTrue((self.root / "public" / "provider-registry.html").is_file())

    def test_failed_adapter_records_error_without_destroying_prior_state(self):
        self.invoke("refresh")
        status = self.root / "providers" / "aws" / "status"
        status.write_text("#!/bin/sh\nexit 1\n")
        status.chmod(0o755)
        result = self.invoke("refresh")
        provider = result["providers"][0]
        self.assertEqual(provider["status"]["count"], 2)
        self.assertIn("adapter_failed", provider["lastError"])


if __name__ == "__main__":
    unittest.main()
