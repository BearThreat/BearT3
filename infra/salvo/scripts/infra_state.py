#!/usr/bin/env python3
"""Salvo infrastructure state registry. Stores summaries only; never credentials."""

from __future__ import annotations

import argparse
import html
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
DEFAULT_ROOT = Path(__file__).resolve().parents[1]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def paths(root: Path) -> tuple[Path, Path, Path]:
    return root / "state" / "infra-state.sqlite", root / "state" / "infra-state.json", root / "public" / "provider-registry.html"


def connect(root: Path) -> sqlite3.Connection:
    db, _, _ = paths(root)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (
        name TEXT PRIMARY KEY, category TEXT NOT NULL, use_case TEXT NOT NULL,
        credential_location TEXT NOT NULL, billing_posture TEXT NOT NULL,
        status_json TEXT NOT NULL DEFAULT '{}', cost_json TEXT NOT NULL DEFAULT '{}',
        last_status_check TEXT, last_cost_check TEXT, last_error TEXT,
        status_command TEXT NOT NULL, cost_command TEXT NOT NULL
      );
    """)
    conn.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
    conn.execute("""INSERT OR IGNORE INTO providers
      (name,category,use_case,credential_location,billing_posture,status_command,cost_command)
      VALUES (?,?,?,?,?,?,?)""", (
        "aws", "compute", "On-demand isolated Salvo sandboxes",
        "AWS CLI credential chain (location intentionally unresolved)",
        "On-demand compute; retained encrypted EBS; operator budget caps required",
        "providers/aws/status", "providers/aws/cost-check"
    ))
    conn.commit()
    return conn


def public_provider(row: sqlite3.Row) -> dict:
    return {
        "name": row["name"], "category": row["category"], "useCase": row["use_case"],
        "credentialLocation": row["credential_location"], "billingPosture": row["billing_posture"],
        "status": json.loads(row["status_json"]), "cost": json.loads(row["cost_json"]),
        "lastStatusCheck": row["last_status_check"], "lastCostCheck": row["last_cost_check"],
        "lastError": row["last_error"], "commands": {"status": row["status_command"], "costCheck": row["cost_command"]}
    }


def snapshot(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT * FROM providers ORDER BY name").fetchall()
    return {"schemaVersion": SCHEMA_VERSION, "generatedAt": now(), "providers": [public_provider(row) for row in rows]}


def write_export(root: Path, data: dict) -> Path:
    _, target, _ = paths(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return target


def run_adapter(root: Path, relative: str) -> tuple[dict | None, str | None]:
    command = root / relative
    try:
        result = subprocess.run([str(command)], cwd=root, text=True, capture_output=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, "adapter_timeout" if isinstance(exc, subprocess.TimeoutExpired) else "adapter_unavailable"
    if result.returncode != 0:
        try:
            payload = json.loads(result.stdout or result.stderr)
            return None, str(payload.get("error", "adapter_failed"))[:120]
        except (json.JSONDecodeError, AttributeError):
            return None, "adapter_failed"
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None, "adapter_invalid_json"
    return payload, None


def refresh(root: Path, conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT * FROM providers ORDER BY name").fetchall()
    for row in rows:
        status, status_error = run_adapter(root, row["status_command"])
        cost, cost_error = run_adapter(root, row["cost_command"])
        errors = [value for value in (status_error, cost_error) if value]
        conn.execute("""UPDATE providers SET
          status_json=COALESCE(?,status_json), cost_json=COALESCE(?,cost_json),
          last_status_check=?, last_cost_check=?, last_error=? WHERE name=?""", (
            json.dumps(status, separators=(",", ":")) if status is not None else None,
            json.dumps(cost, separators=(",", ":")) if cost is not None else None,
            now(), now(), "; ".join(errors) or None, row["name"]
        ))
    conn.commit()
    data = snapshot(conn)
    write_export(root, data)
    return data


def render(root: Path, data: dict) -> Path:
    _, _, target = paths(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    cards = []
    for provider in data["providers"]:
        cards.append("<section><h2>{}</h2><p>{}</p><pre>{}</pre></section>".format(
            html.escape(provider["name"]), html.escape(provider["useCase"]),
            html.escape(json.dumps({"status": provider["status"], "cost": provider["cost"], "lastError": provider["lastError"]}, indent=2))
        ))
    target.write_text("<!doctype html><meta charset=utf-8><title>Salvo infrastructure</title><h1>Salvo infrastructure</h1>" + "".join(cards) + "\n", encoding="utf-8")
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("init", "refresh", "export", "list", "render"))
    parser.add_argument("--root", type=Path, default=Path(os.environ.get("SALVO_INFRA_ROOT", DEFAULT_ROOT)))
    args = parser.parse_args()
    root = args.root.resolve()
    conn = connect(root)
    if args.command == "init":
        result = {"ok": True, "command": "init", "database": str(paths(root)[0]), "schemaVersion": SCHEMA_VERSION}
    elif args.command == "refresh":
        data = refresh(root, conn)
        result = {"ok": True, "command": "refresh", "providers": data["providers"]}
    elif args.command == "export":
        target = write_export(root, snapshot(conn))
        result = {"ok": True, "command": "export", "path": str(target)}
    elif args.command == "list":
        result = {"ok": True, "command": "list", "providers": snapshot(conn)["providers"]}
    else:
        target = render(root, snapshot(conn))
        result = {"ok": True, "command": "render", "path": str(target)}
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
