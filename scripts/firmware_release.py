#!/usr/bin/env python3
"""固件构建 / 发布 / 校验工具（BLE OTA 的服务端一侧）。

凭据只从 deploy/server.env 读取（模板 deploy/server.env.example，已被
.gitignore 排除）。本脚本绝不打印密码，也不把它写进 manifest / 日志。

用法（仓库根目录）：
    python scripts/firmware_release.py probe         # SSH 探测服务器现状（只读）
    python scripts/firmware_release.py setup-nginx   # 挂载 /firmware/ 静态目录（幂等）
    python scripts/firmware_release.py build         # pio run + 产出 dist/firmware/*
    python scripts/firmware_release.py publish       # 上传 bin + manifest 到服务器
    python scripts/firmware_release.py verify        # HTTP 拉回 manifest/bin 校验
    python scripts/firmware_release.py status        # 打印本地 dist 与远端目录

依赖：paramiko（仅 probe/setup-nginx/publish/status 需要），pio（仅 build）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / "deploy" / "server.env"
DIST_DIR = ROOT / "dist" / "firmware"
BUILD_DIR = ROOT / "firmware" / ".pio" / "build" / "esp32-c3-devkitm-1"
BIN_NAME = "firmware.bin"
OTA_MAX_IMAGE_BYTES = 0x1E0000  # ota_0/ota_1 分区大小（partitions.csv）

REQUIRED_KEYS = (
    "SERVER_HOST",
    "SERVER_PORT",
    "SERVER_USER",
    "SERVER_PASSWORD",
    "SERVER_FIRMWARE_DIR",
    "FIRMWARE_BASE_URL",
)


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def load_env() -> dict:
    """读取 deploy/server.env（KEY=VALUE，# 注释）。缺失即报错退出。"""
    if not ENV_FILE.exists():
        sys.exit(
            f"缺少 {ENV_FILE.relative_to(ROOT)}。"
            f"\n从 deploy/server.env.example 复制并填入真实值，或参考 AGENTS.md"
            "\n「服务器与固件发布」。"
        )
    env = {}
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    missing = [k for k in REQUIRED_KEYS if not env.get(k)]
    if missing:
        sys.exit(f"deploy/server.env 缺少字段: {', '.join(missing)}")
    return env


def redact(env: dict) -> dict:
    """给日志用的脱敏副本。"""
    out = dict(env)
    out["SERVER_PASSWORD"] = "***"
    return out


# ---------------------------------------------------------------------------
# 版本 / 产物
# ---------------------------------------------------------------------------


def read_version() -> tuple[str, str]:
    """从 protocol/versions.csv 取 (firmware_version, protocol_version)。"""
    path = ROOT / "protocol" / "versions.csv"
    fw = proto = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.split(",")]
        if len(cells) < 3:
            continue
        if cells[0] == "firmware_version":
            fw = f"{cells[1]}.{cells[2]}"
        elif cells[0] == "protocol_version":
            proto = f"{cells[1]}.{cells[2]}"
    if not fw or not proto:
        sys.exit("protocol/versions.csv 缺少 firmware_version / protocol_version")
    return fw, proto


def bin_path(version: str) -> Path:
    return DIST_DIR / f"bt-model-light-esp32c3-{version}.bin"


def crc32_bytes(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def cmd_build(_args) -> int:
    version, proto = read_version()
    print(f"[build] 固件 {version} / 协议 {proto}")
    rc = subprocess.call(
        ["pio", "run", "-e", "esp32-c3-devkitm-1"], cwd=str(ROOT / "firmware")
    )
    if rc != 0:
        return rc
    src = BUILD_DIR / BIN_NAME
    if not src.exists():
        sys.exit(f"构建产物不存在: {src}")
    data = src.read_bytes()
    if len(data) > OTA_MAX_IMAGE_BYTES:
        sys.exit(
            f"固件 {len(data)} 字节超过 ota 分区 {OTA_MAX_IMAGE_BYTES} 字节，"
            "OTA 无法容纳（需调分区表）"
        )
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    dst = bin_path(version)
    shutil.copyfile(src, dst)
    manifest = {
        "version": version,
        "protocol_version": proto,
        "file": dst.name,
        "size": len(data),
        "crc32": f"{crc32_bytes(data):08x}",
        "sha256": hashlib.sha256(data).hexdigest(),
        "released": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": f"bt-model-light ESP32-C3 固件 {version}",
    }
    (DIST_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[build] {dst.relative_to(ROOT)}  {len(data)} 字节  crc32={manifest['crc32']}")
    print(f"[build] {DIST_DIR.relative_to(ROOT) / 'manifest.json'}")
    return 0


# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------


def _sftp_client(env: dict):
    try:
        import paramiko
    except ImportError:
        sys.exit("需要 paramiko：python -m pip install paramiko")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=env["SERVER_HOST"],
        port=int(env["SERVER_PORT"]),
        username=env["SERVER_USER"],
        password=env["SERVER_PASSWORD"],
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run_remote(client, command: str, timeout: int = 20) -> tuple[int, str, str]:
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


PROBE_COMMANDS = [
    ("系统", "uname -a; cat /etc/os-release 2>/dev/null | head -3"),
    ("磁盘", "df -h / | tail -1"),
    ("Web 服务", "systemctl is-active nginx httpd apache2 2>/dev/null; echo ---; "
                  "which nginx httpd apache2 2>/dev/null"),
    ("宝塔", "ls -d /www /www/server/panel /www/server/nginx 2>/dev/null"),
    ("监听端口", "ss -lntp 2>/dev/null | head -20 || netstat -lntp 2>/dev/null | head -20"),
    ("HTTP 根目录", "ls -la /var/www 2>/dev/null | head -20"),
    ("固件目录", "ls -la '{dir}' 2>/dev/null || echo '固件目录不存在'"),
    ("防火墙", "systemctl is-active firewalld ufw 2>/dev/null; "
               "ufw status 2>/dev/null | head -10"),
    ("已有证书", "ls -la /etc/letsencrypt/live 2>/dev/null | head; "
                 "ls /www/server/panel/vhost/cert 2>/dev/null | head"),
]


def cmd_probe(args) -> int:
    env = load_env()
    print(f"[probe] 连接 {env['SERVER_USER']}@{env['SERVER_HOST']}:{env['SERVER_PORT']}")
    client = _sftp_client(env)
    try:
        for title, command in PROBE_COMMANDS:
            command = command.replace("{dir}", env["SERVER_FIRMWARE_DIR"])
            _rc, out, _err = run_remote(client, command, timeout=20)
            body = out.strip() or "(空)"
            print(f"\n--- {title} ---\n{body}")
    finally:
        client.close()
    return 0


def _ensure_remote_dir(sftp, path: str) -> None:
    """递归创建远端目录（SFTP 无 mkdir -p）。"""
    parts = [p for p in path.split("/") if p]
    cur = ""
    for part in parts:
        cur += "/" + part
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def cmd_publish(args) -> int:
    env = load_env()
    manifest_path = DIST_DIR / "manifest.json"
    if not manifest_path.exists():
        sys.exit("dist/firmware 为空，先跑 build")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest["version"]
    artifact = DIST_DIR / manifest["file"]
    if not artifact.exists():
        sys.exit(f"缺少产物 {artifact.relative_to(ROOT)}，先跑 build")

    data = artifact.read_bytes()
    if f"{crc32_bytes(data):08x}" != manifest["crc32"]:
        sys.exit("manifest.crc32 与 bin 不一致（bin 被改动过？重新 build）")

    remote_dir = env["SERVER_FIRMWARE_DIR"].rstrip("/")
    print(f"[publish] {artifact.name} → {env['SERVER_HOST']}:{remote_dir}/")

    client = _sftp_client(env)
    try:
        sftp = client.open_sftp()
        try:
            _ensure_remote_dir(sftp, remote_dir)
            sftp.put(str(artifact), f"{remote_dir}/{artifact.name}")
            # 先传 bin，再传 manifest：别人看到新 manifest 时 bin 一定已在。
            sftp.put(str(manifest_path), f"{remote_dir}/manifest.json")
        finally:
            sftp.close()
        run_remote(client, f"chmod 644 '{remote_dir}'/*", timeout=10)
    finally:
        client.close()

    print(f"[publish] 完成：{env['FIRMWARE_BASE_URL'].rstrip('/')}/manifest.json")
    if env["FIRMWARE_BASE_URL"].startswith("http://"):
        print("[publish] 注意：体验版/正式版小程序要求 HTTPS + 备案域名，"
              "当前 HTTP+IP 仅开发期与真机调试可用（见 ADR-0034）")
    return 0


NGINX_SITE = "/etc/nginx/sites-available/pandanote"

# 只读静态目录，挂在 404 兜底之前：不影响既有 /pandanote/ 与 location /。
FIRMWARE_LOCATION = """    # 固件发布目录（BLE OTA 下载源，scripts/firmware_release.py 维护）
    location /firmware/ {{
        alias {dir}/;
        autoindex on;
        add_header Cache-Control "no-cache";
        types {{ application/octet-stream bin; application/json json; }}
    }}
"""


def cmd_setup_nginx(_args) -> int:
    """在现有 server 块里挂 /firmware/ 静态目录（幂等、先备份、nginx -t 失败即还原）。"""
    env = load_env()
    remote_dir = env["SERVER_FIRMWARE_DIR"].rstrip("/")
    block = FIRMWARE_LOCATION.format(dir=remote_dir)

    client = _sftp_client(env)
    try:
        _rc, out, _err = run_remote(client, f"cat {NGINX_SITE}")
        if not out.strip():
            sys.exit(f"远端缺少 {NGINX_SITE}")
        if "location /firmware/" in out:
            print(f"[nginx] {NGINX_SITE} 已含 /firmware/，跳过")
            return 0
        if "location / {" not in out:
            sys.exit(f"{NGINX_SITE} 结构超出预期（无 location /），请手工处理")

        patched = out.replace("    location / {", block + "\n    location / {", 1)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = f"{NGINX_SITE}.bak.{stamp}"
        run_remote(client, f"cp -a {NGINX_SITE} {backup}")

        sftp = client.open_sftp()
        try:
            with sftp.file(f"{NGINX_SITE}.tmp", "w") as fh:
                fh.write(patched)
        finally:
            sftp.close()
        run_remote(client, f"mkdir -p '{remote_dir}' && chmod 755 '{remote_dir}'")

        rc, out, err = run_remote(client, "nginx -t")
        print((out + err).strip())
        if rc != 0:
            run_remote(client, f"rm -f {NGINX_SITE}.tmp")
            sys.exit(f"nginx -t 失败，未改动 {NGINX_SITE}（备份 {backup}）")

        run_remote(client, f"mv {NGINX_SITE}.tmp {NGINX_SITE} && systemctl reload nginx")
        print(f"[nginx] 已挂载 /firmware/ → {remote_dir}/（备份 {backup}）")

        _rc, out, _err = run_remote(
            client,
            f"curl -s -o /dev/null -w '%{{http_code}}' "
            f"-H 'Host: {env['SERVER_HOST']}' http://127.0.0.1/firmware/",
        )
        print(f"[nginx] 本机自测 GET /firmware/ → {out.strip()}（需 Host 头才命中该 server 块）")
    finally:
        client.close()
    return 0


def cmd_verify(_args) -> int:
    """HTTP 侧校验：manifest 可访问、size/crc32 与本地一致。"""
    import urllib.request

    env = load_env()
    base = env["FIRMWARE_BASE_URL"].rstrip("/")
    manifest_url = f"{base}/manifest.json"
    print(f"[verify] GET {manifest_url}")
    with urllib.request.urlopen(manifest_url, timeout=20) as resp:
        remote = json.loads(resp.read().decode("utf-8"))
    print(json.dumps(remote, ensure_ascii=False, indent=2))

    bin_url = f"{base}/{remote['file']}"
    print(f"[verify] GET {bin_url}")
    with urllib.request.urlopen(bin_url, timeout=60) as resp:
        data = resp.read()

    ok = True
    if len(data) != remote["size"]:
        print(f"[verify] FAIL size 不符：{len(data)} != {remote['size']}")
        ok = False
    if f"{crc32_bytes(data):08x}" != remote["crc32"]:
        print("[verify] FAIL crc32 不符")
        ok = False

    local = DIST_DIR / "manifest.json"
    if local.exists():
        want = json.loads(local.read_text(encoding="utf-8"))
        if want.get("crc32") != remote.get("crc32"):
            print(f"[verify] FAIL 远端 crc32 与本地 dist 不一致（本地 "
                  f"{want.get('crc32')} / 远端 {remote.get('crc32')}），可能没重新 publish")
            ok = False

    print("[verify] OK 通过" if ok else "[verify] FAILED")
    return 0 if ok else 1


def cmd_status(_args) -> int:
    env = load_env()
    version, proto = read_version()
    print(f"本地版本 firmware={version} protocol={proto}")
    if DIST_DIR.exists():
        for f in sorted(DIST_DIR.iterdir()):
            print(f"  dist/firmware/{f.name}  {f.stat().st_size} 字节")
    else:
        print("  (dist/firmware 不存在，先跑 build)")

    client = _sftp_client(env)
    try:
        _rc, out, _err = run_remote(
            client, f"ls -la '{env['SERVER_FIRMWARE_DIR']}' 2>/dev/null || echo '目录不存在'"
        )
        print(f"\n远端 {env['SERVER_FIRMWARE_DIR']}:\n{out.strip()}")
    finally:
        client.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="bt-model-light 固件发布工具")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="SSH 探测服务器现状（只读）").set_defaults(fn=cmd_probe)
    sub.add_parser("setup-nginx", help="挂载 /firmware/ 静态目录（幂等）").set_defaults(
        fn=cmd_setup_nginx
    )
    sub.add_parser("build", help="构建固件并生成 dist/firmware").set_defaults(fn=cmd_build)
    sub.add_parser("publish", help="上传 bin + manifest").set_defaults(fn=cmd_publish)
    sub.add_parser("verify", help="HTTP 校验线上产物").set_defaults(fn=cmd_verify)
    sub.add_parser("status", help="本地与远端目录状态").set_defaults(fn=cmd_status)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
