#!/usr/bin/env python3
"""
Smoke test for the Odoo event ticket API.

This script is meant to run on a machine that can reach the target Odoo site.
It can send the payload as:
- JSON-RPC envelope
- direct JSON body
- both (default)

Usage examples:
  python BETIME/scripts/test_event_ticket_api.py ^
    --base-url http://bt.dev.demotoday.net ^
    --api-key change-me ^
    --event-id 1 ^
    --name "Codex Test Ticket"

  python BETIME/scripts/test_event_ticket_api.py ^
    --base-url http://127.0.0.1:8069 ^
    --api-key change-me ^
    --event-id 1 ^
    --name "Local Test" ^
    --mode both
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional


DEFAULT_ENDPOINT = "/api/event/tickets"


@dataclass
class Result:
    mode: str
    status: Any
    body: str


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Test the Odoo event ticket API with JSON-RPC or direct JSON."
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("ODOO_BASE_URL", "http://bt.dev.demotoday.net"),
        help="Base URL of the Odoo site, e.g. http://bt.dev.demotoday.net",
    )
    parser.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help=f"API path to call (default: {DEFAULT_ENDPOINT})",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("ODOO_EVENT_API_KEY"),
        required=os.environ.get("ODOO_EVENT_API_KEY") is None,
        help="Shared API key stored in ir.config_parameter as event.ticket_api_key",
    )
    parser.add_argument(
        "--event-id",
        type=int,
        required=True,
        help="Target event.event ID",
    )
    parser.add_argument(
        "--name",
        required=True,
        help="Ticket name",
    )
    parser.add_argument(
        "--description",
        default="Codex smoke test",
        help="Optional description",
    )
    parser.add_argument(
        "--seats-max",
        type=int,
        default=0,
        help="Optional max seats (0 means unlimited)",
    )
    parser.add_argument(
        "--start-sale-datetime",
        default="",
        help="Optional registration start datetime in Odoo format: YYYY-MM-DD HH:MM:SS",
    )
    parser.add_argument(
        "--end-sale-datetime",
        default="",
        help="Optional registration end datetime in Odoo format: YYYY-MM-DD HH:MM:SS",
    )
    parser.add_argument(
        "--mode",
        choices=("jsonrpc", "json", "both"),
        default="both",
        help="Payload format to test",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=20.0,
        help="Request timeout in seconds",
    )
    return parser


def make_payload(args: argparse.Namespace) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "api_key": args.api_key,
        "event_id": args.event_id,
        "name": args.name,
    }
    if args.description:
        payload["description"] = args.description
    if args.seats_max is not None:
        payload["seats_max"] = args.seats_max
    if args.start_sale_datetime:
        payload["start_sale_datetime"] = args.start_sale_datetime
    if args.end_sale_datetime:
        payload["end_sale_datetime"] = args.end_sale_datetime
    return payload


def post_json(url: str, body: Dict[str, Any], timeout: float) -> Result:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return Result(
                mode="",
                status=response.status,
                body=response.read().decode("utf-8", errors="replace"),
            )
    except urllib.error.HTTPError as exc:
        return Result(
            mode="",
            status=exc.code,
            body=exc.read().decode("utf-8", errors="replace"),
        )
    except Exception as exc:  # pragma: no cover - network dependent
        return Result(mode="", status="ERR", body=f"{type(exc).__name__}: {exc}")


def run_modes(base_url: str, endpoint: str, payload: Dict[str, Any], mode: str, timeout: float) -> Iterable[Result]:
    url = base_url.rstrip("/") + "/" + endpoint.lstrip("/")

    if mode in ("jsonrpc", "both"):
        rpc_body = {
            "jsonrpc": "2.0",
            "method": "call",
            "id": 1,
            "params": payload,
        }
        result = post_json(url, rpc_body, timeout)
        result.mode = "jsonrpc"
        yield result

    if mode in ("json", "both"):
        result = post_json(url, payload, timeout)
        result.mode = "json"
        yield result


def main() -> int:
    args = build_parser().parse_args()
    payload = make_payload(args)

    print(f"Base URL : {args.base_url}")
    print(f"Endpoint : {args.endpoint}")
    print(f"Mode     : {args.mode}")
    print(f"Event ID : {args.event_id}")
    print(f"Name     : {args.name}")

    results = list(run_modes(args.base_url, args.endpoint, payload, args.mode, args.timeout))
    print()
    for result in results:
        print(f"[{result.mode}] status={result.status}")
        print(result.body)
        print()

    failed = any(str(r.status) not in ("200", "201") for r in results)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
