#!/usr/bin/env python3
"""往线上后端灌演示遥测数据（ADR-0037），用于验证后台图表渲染。

**这是本地/验收工具，不是业务代码**：只在开发/验收时跑，清空用 --reset。

用法：
    python scripts/seed_telemetry.py --days 14            # 灌 14 天演示数据
    python scripts/seed_telemetry.py --days 14 --reset    # 先清空 telemetry 再灌
    python scripts/seed_telemetry.py --url http://127.0.0.1:3000/api

凭据来自 deploy/server.env（与其它脚本一致）。会上报到 /telemetry 接口，
走真实白名单校验；未登录也可上报（user_id 为空）。

注意：数据带有明显的模拟特征（deviceId 以 seed- 开头），后台可直接辨认。
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / "deploy" / "server.env"

BATCH = 200  # 与后端 BATCH_MAX 一致

# 演示用的指标权重（模拟真实分布：启动多、错误少）。
WEIGHTS = {
    "app.launch": 40,
    "user.login.ok": 12,
    "user.login.fail": 2,
    "ble.scan.start": 14,
    "ble.connect.ok": 20,
    "ble.connect.fail": 3,
    "ble.disconnect": 16,
    "config.write": 30,
    "config.write.fail": 2,
    "ota.check": 4,
    "ota.start": 2,
    "ota.done": 2,
    "ota.fail": 1,
    "error": 5,
}

ERROR_CODES = ["10001", "10009", "10012", "10005", "0x03", "0x05", "UNKNOWN"]
LOGIN_FAIL_STATUS = ["400", "502"]
CONNECT_FAIL_CODES = ["10009", "10012", "10005"]
MTU_VALUES = [20, 20, 20, 182, 509, 509, 509, 509, 24, 185]
RSSI_VALUES = [-95, -88, -82, -75, -68, -62, -55, -48, -40]


def load_env() -> dict:
    env = {}
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def post(base: str, path: str, body: dict) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def build_events(days: int, seed: int) -> list[dict]:
    rnd = random.Random(seed)
    now = datetime.now(timezone.utc)
    events: list[dict] = []
    for d in range(days):
        day = now - timedelta(days=days - 1 - d)
        # 工作日多、周末略少；再加一点上升趋势，让折线有形状。
        grow = 0.6 + 0.5 * (d / max(1, days - 1))
        weekend = 0.7 if day.weekday() >= 5 else 1.0
        for metric, weight in WEIGHTS.items():
            n = int(weight * grow * weekend * rnd.uniform(0.7, 1.3))
            for _ in range(n):
                at = day.replace(
                    hour=rnd.randint(0, 23), minute=rnd.randint(0, 59), second=rnd.randint(0, 59)
                )
                ev = {"metric": metric, "at": int(at.timestamp()), "value": 1}
                if metric == "error":
                    ev["dim"] = rnd.choice(ERROR_CODES)
                elif metric == "user.login.fail":
                    ev["dim"] = rnd.choice(LOGIN_FAIL_STATUS)
                elif metric == "ble.connect.fail":
                    ev["dim"] = rnd.choice(CONNECT_FAIL_CODES)
                elif metric in ("config.write.fail", "ota.fail"):
                    ev["dim"] = rnd.choice(["timeout", "crc", "disconnect"])
                elif metric == "app.launch":
                    ev["dim"] = "sim" if rnd.random() < 0.15 else "real"
                events.append(ev)

        # 连续量（分片/信号/流量/耗时）单独一批
        for _ in range(int(20 * grow * weekend)):
            at = day.replace(hour=rnd.randint(8, 23), minute=rnd.randint(0, 59))
            events.append({"metric": "ble.mtu", "at": int(at.timestamp()), "value": rnd.choice(MTU_VALUES)})
            events.append({"metric": "ble.rssi", "at": int(at.timestamp()), "value": rnd.choice(RSSI_VALUES)})
        for _ in range(int(6 * grow)):
            at = day.replace(hour=rnd.randint(8, 23), minute=rnd.randint(0, 59))
            events.append(
                {"metric": "config.bytes", "at": int(at.timestamp()), "value": rnd.randint(120, 1400)}
            )
        for _ in range(int(2 * grow)):
            at = day.replace(hour=rnd.randint(8, 23), minute=rnd.randint(0, 59))
            size = rnd.randint(900_000, 1_060_000)
            events.append({"metric": "ota.bytes", "at": int(at.timestamp()), "value": size})
            events.append({"metric": "ota.duration", "at": int(at.timestamp()), "value": rnd.randint(60_000, 240_000)})
    events.sort(key=lambda e: e["at"])
    return events


def main() -> int:
    ap = argparse.ArgumentParser(description="灌演示遥测数据（验证后台图表）")
    ap.add_argument("--days", type=int, default=14, help="生成多少天（默认 14）")
    ap.add_argument("--seed", type=int, default=20261127, help="随机种子（可复现）")
    ap.add_argument("--url", default="", help="后端基地址；缺省取 server.env 的 API_BASE_URL")
    ap.add_argument("--reset", action="store_true", help="先清空（仅打印提示，不直接删库）")
    args = ap.parse_args()

    env = load_env()
    base = args.url or env.get("API_BASE_URL") or "http://127.0.0.1:3000/api"
    print(f"[seed] 目标 {base}")

    if args.reset:
        print(
            "[seed] --reset 不会远程删库（避免误删真实数据）。\n"
            "        需要清空请在服务器上执行：\n"
            "        sqlite3 /var/lib/bt-light/bt-light.db \"delete from telemetry;\"\n"
            "        或 node --no-warnings -e \"...\"（见 README）"
        )

    events = build_events(args.days, args.seed)
    print(f"[seed] 生成 {len(events)} 条事件（{args.days} 天）")

    accepted = rejected = failed = 0
    for i in range(0, len(events), BATCH):
        chunk = events[i : i + BATCH]
        status, body = post(base, "/telemetry", {"events": chunk})
        if status == 200:
            accepted += int(body.get("accepted") or 0)
            rejected += int(body.get("rejected") or 0)
        else:
            failed += 1
            print(f"[seed] 批次失败 HTTP {status}: {body}")
            if failed >= 3:
                print("[seed] 连续失败，中止")
                return 1
        if (i // BATCH) % 20 == 0:
            print(f"[seed] {i + len(chunk)}/{len(events)}")

    print(f"[seed] 完成：accepted={accepted} rejected={rejected} failedBatches={failed}")
    print("[seed] 打开 /admin/ → 概览 / 遥测 / 诊断 查看图表")
    return 0


if __name__ == "__main__":
    sys.exit(main())
