#!/usr/bin/env python3
"""后端 API + 管理后台的构建 / 部署 / 校验工具（ADR-0036）。

凭据只从 deploy/server.env 读取（与 scripts/firmware_release.py 同一份，
已被 .gitignore 排除）。本脚本绝不打印密码、AppSecret 或 admin 初始密码。

用法（仓库根目录）：
    python scripts/backend_deploy.py probe          # SSH 探测（只读：node/nginx/systemd/目录）
    python scripts/backend_deploy.py setup          # 建目录 + 装 systemd unit（幂等）
    python scripts/backend_deploy.py build          # 本地 vite build 管理后台
    python scripts/backend_deploy.py publish        # 上传 server/ + admin dist，远端 npm ci
    python scripts/backend_deploy.py setup-nginx    # 挂 /api/ 反代 + /admin/ 静态目录（幂等）
    python scripts/backend_deploy.py restart        # systemctl restart bt-light-api
    python scripts/backend_deploy.py verify         # 本机 + 反代两条路径的 HTTP 校验
    python scripts/backend_deploy.py status         # 服务状态 + DB 大小 + 最近日志
    python scripts/backend_deploy.py logs           # journalctl 最近 80 行
    python scripts/backend_deploy.py backup         # 备份远端 SQLite（带时间戳）

依赖：paramiko（除 build 外都需要）、npm（仅 build）。
远端要求 Node >= 22.5（node:sqlite 内置模块，无需编译任何原生依赖）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / "deploy" / "server.env"
SERVER_DIR = ROOT / "server"
ADMIN_DIR = ROOT / "admin"
ADMIN_DIST = ADMIN_DIR / "dist"

SERVICE_NAME = "bt-light-api"
SERVICE_FILE = f"/etc/systemd/system/{SERVICE_NAME}.service"
ENV_FILE_REMOTE = "/etc/bt-light/api.env"
NGINX_SITE = "/etc/nginx/sites-available/pandanote"

# server.env 里后端相关的必填键（旧文件缺这些也能跑 probe/status）。
BACKEND_KEYS = (
    "SERVER_API_DIR",
    "SERVER_ADMIN_DIR",
    "DB_PATH",
    "API_BASE_URL",
    "WX_APP_ID",
    "WX_APP_SECRET",
    "ADMIN_INIT_USER",
    "ADMIN_INIT_PASSWORD",
)
FIRMWARE_KEYS = ("SERVER_HOST", "SERVER_PORT", "SERVER_USER", "SERVER_PASSWORD")

# 上传到远端的源码目录（node_modules / data 由远端自己生成）。
UPLOAD_DIRS = ("src",)
UPLOAD_FILES = ("package.json", "package-lock.json")


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------


def load_env(require_backend: bool = False) -> dict:
    if not ENV_FILE.exists():
        sys.exit(
            f"缺少 {ENV_FILE.relative_to(ROOT)}。\n"
            "从 deploy/server.env.example 复制并填入真实值（见 AGENTS.md）。"
        )
    env: dict[str, str] = {}
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")

    missing = [k for k in FIRMWARE_KEYS if not env.get(k)]
    if require_backend:
        missing += [k for k in BACKEND_KEYS if not env.get(k)]
    if missing:
        sys.exit(f"deploy/server.env 缺少字段: {', '.join(missing)}")
    return env


def redact(value: str) -> str:
    """日志里只露长度，不露值。"""
    return f"<{len(value)} 字符>"


# ---------------------------------------------------------------------------
# SSH
# ---------------------------------------------------------------------------


def sftp_client(env: dict):
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
        timeout=20,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run_remote(client, command: str, timeout: int = 120) -> tuple[int, str, str]:
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


def ensure_remote_dir(sftp, path: str) -> None:
    parts = [p for p in path.split("/") if p]
    cur = ""
    for part in parts:
        cur += "/" + part
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


def upload_tree(sftp, local: Path, remote: str, skip: tuple[str, ...] = ()) -> int:
    """递归上传目录；skip 里的名字（任意层）跳过。返回文件数。"""
    count = 0
    ensure_remote_dir(sftp, remote)
    for item in sorted(local.iterdir()):
        if item.name in skip:
            continue
        rpath = f"{remote}/{item.name}"
        if item.is_dir():
            count += upload_tree(sftp, item, rpath, skip)
        else:
            sftp.put(str(item), rpath)
            count += 1
    return count


# ---------------------------------------------------------------------------
# probe
# ---------------------------------------------------------------------------


def cmd_probe(_args) -> int:
    env = load_env()
    print(f"[probe] {env['SERVER_USER']}@{env['SERVER_HOST']}:{env['SERVER_PORT']}")
    client = sftp_client(env)
    commands = [
        ("Node", "command -v node && node -v; echo ---; command -v npm && npm -v"),
        (
            "node:sqlite",
            "node -e \"const{DatabaseSync}=require('node:sqlite');"
            "const d=new DatabaseSync(':memory:');d.exec('create table t(a)');"
            "d.prepare('insert into t values(1)').run();"
            "console.log('OK', d.prepare('select count(*) c from t').get().c)\" 2>&1 | tail -3",
        ),
        ("systemd", f"systemctl is-active {SERVICE_NAME} 2>&1; echo ---; "
                    f"systemctl is-enabled {SERVICE_NAME} 2>&1"),
        ("nginx", "nginx -v 2>&1; systemctl is-active nginx"),
        ("站点文件", f"ls -la {NGINX_SITE} 2>/dev/null && "
                     f"grep -n 'location /api/\\|location /admin/' {NGINX_SITE} 2>/dev/null || echo '(无)'"),
        ("后端目录", f"ls -la '{env.get('SERVER_API_DIR', '/var/www/bt-model-light/api')}' 2>/dev/null || echo '(不存在)'"),
        ("后台目录", f"ls -la '{env.get('SERVER_ADMIN_DIR', '/var/www/bt-model-light/admin')}' 2>/dev/null || echo '(不存在)'"),
        ("数据库", f"ls -lh '{env.get('DB_PATH', '/var/lib/bt-light/bt-light.db')}'* 2>/dev/null || echo '(不存在)'"),
        ("监听 3000", "ss -lntp 2>/dev/null | grep -w 3000 || echo '(未监听)'"),
    ]
    try:
        for title, command in commands:
            _rc, out, _err = run_remote(client, command, timeout=60)
            print(f"\n--- {title} ---\n{out.strip() or '(空)'}")
    finally:
        client.close()
    return 0


# ---------------------------------------------------------------------------
# setup：目录 + systemd unit
# ---------------------------------------------------------------------------


SERVICE_UNIT = """[Unit]
Description=bt-model-light API (Express + SQLite)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory={api_dir}
EnvironmentFile={env_file}
# node:sqlite 仍是 experimental，屏蔽告警但保留错误输出。
ExecStart=/usr/bin/node --no-warnings {api_dir}/src/server.js
Restart=always
RestartSec=3
# 只监听回环：对外一律经 nginx 反代（location /api/）。
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths={db_dir}

[Install]
WantedBy=multi-user.target
"""


def cmd_setup(_args) -> int:
    env = load_env(require_backend=True)
    api_dir = env["SERVER_API_DIR"].rstrip("/")
    admin_dir = env["SERVER_ADMIN_DIR"].rstrip("/")
    db_path = env["DB_PATH"]
    db_dir = str(Path(db_path).parent).replace("\\", "/")

    client = sftp_client(env)
    try:
        rc, out, _err = run_remote(client, "node -e \"process.exit(process.versions.node.split('.')[0]>=22?0:1)\"")
        if rc != 0:
            sys.exit("远端 Node 版本 < 22，node:sqlite 不可用。先装 Node 22+ 再来。")
        print("[setup] Node 版本检查通过")

        # 目录：api（代码）/ admin（前端产物）/ db（数据）。属主 www-data。
        rc, _out, err = run_remote(
            client,
            f"mkdir -p '{api_dir}' '{admin_dir}' '{db_dir}' && "
            f"chown -R www-data:www-data '{api_dir}' '{admin_dir}' '{db_dir}' && "
            f"chmod 755 '{api_dir}' '{admin_dir}' && chmod 750 '{db_dir}'",
        )
        if rc != 0:
            sys.exit(f"创建远端目录失败：{err.strip()}")
        print(f"[setup] 目录就绪：{api_dir} / {admin_dir} / {db_dir}")

        # systemd unit（内容确定 → 重复执行无副作用）。
        unit = SERVICE_UNIT.format(api_dir=api_dir, env_file=ENV_FILE_REMOTE, db_dir=db_dir)
        sftp = client.open_sftp()
        try:
            ensure_remote_dir(sftp, str(Path(ENV_FILE_REMOTE).parent).replace("\\", "/"))
            sftp.putfo(_bytes_io(unit), f"{SERVICE_FILE}.tmp")
        finally:
            sftp.close()
        rc, _out, err = run_remote(
            client,
            f"mv {SERVICE_FILE}.tmp {SERVICE_FILE} && chmod 644 {SERVICE_FILE} && "
            "systemctl daemon-reload && systemctl enable " + SERVICE_NAME,
        )
        if rc != 0:
            sys.exit(f"安装 systemd unit 失败：{err.strip()}")
        print(f"[setup] {SERVICE_FILE} 已安装并 enable")
    finally:
        client.close()
    return 0


def _bytes_io(text: str):
    import io

    return io.BytesIO(text.encode("utf-8"))


# ---------------------------------------------------------------------------
# build（本地）
# ---------------------------------------------------------------------------


def cmd_build(_args) -> int:
    npm = shutil.which("npm")
    if not npm:
        sys.exit("本机缺少 npm（构建管理后台需要）")
    if not (ADMIN_DIR / "node_modules").exists():
        print("[build] npm ci（admin/）")
        rc = subprocess.call([npm, "ci", "--no-audit", "--no-fund"], cwd=str(ADMIN_DIR))
        if rc != 0:
            return rc
    print("[build] npm run build（admin/）")
    rc = subprocess.call([npm, "run", "build"], cwd=str(ADMIN_DIR), shell=(os.name == "nt"))
    if rc != 0:
        return rc
    if not (ADMIN_DIST / "index.html").exists():
        sys.exit("admin/dist/index.html 不存在，构建未产出")
    total = sum(f.stat().st_size for f in ADMIN_DIST.rglob("*") if f.is_file())
    print(f"[build] {ADMIN_DIST.relative_to(ROOT)}  {total} 字节")
    return 0


# ---------------------------------------------------------------------------
# publish
# ---------------------------------------------------------------------------


def cmd_publish(_args) -> int:
    env = load_env(require_backend=True)
    if not (ADMIN_DIST / "index.html").exists():
        sys.exit("admin/dist 为空，先跑 build")

    api_dir = env["SERVER_API_DIR"].rstrip("/")
    admin_dir = env["SERVER_ADMIN_DIR"].rstrip("/")

    client = sftp_client(env)
    try:
        # 1) SQLite 备份（有库才备份）：迁移风险最低的受访点。
        rc, out, _err = run_remote(
            client,
            f"test -f '{env['DB_PATH']}' && "
            f"cp -a '{env['DB_PATH']}' '{env['DB_PATH']}.bak.'$(date +%Y%m%d%H%M%S) && echo backed-up"
            " || echo skip",
        )
        print(f"[publish] DB 备份：{out.strip()}")

        sftp = client.open_sftp()
        try:
            # 2) 后端源码（不含 node_modules / data）：先传到 .new，再原子替换。
            staging = f"{api_dir}.new"
            run_remote(client, f"rm -rf '{staging}'")
            files = 0
            for name in UPLOAD_DIRS:
                files += upload_tree(sftp, SERVER_DIR / name, f"{staging}/{name}")
            for name in UPLOAD_FILES:
                local = SERVER_DIR / name
                if local.exists():
                    sftp.put(str(local), f"{staging}/{name}")
                    files += 1

            # 3) 管理后台产物。
            admin_files = upload_tree(sftp, ADMIN_DIST, f"{admin_dir}.new")

            # 4) env 文件（600，root 可读、www-data 通过 systemd 注入）。
            env_body = render_backend_env(env)
            sftp.putfo(_bytes_io(env_body), f"{ENV_FILE_REMOTE}.tmp")
        finally:
            sftp.close()

        print(f"[publish] 已上传 后端 {files} 个文件 / 后台 {admin_files} 个文件")

        # 5) 原子切换 + 远端装依赖。
        rc, out, err = run_remote(
            client,
            f"rm -rf '{api_dir}.old' && "
            f"(test -d '{api_dir}' && mv '{api_dir}' '{api_dir}.old' || true) && "
            f"mv '{api_dir}.new' '{api_dir}' && "
            f"rm -rf '{admin_dir}.old' && "
            f"(test -d '{admin_dir}' && mv '{admin_dir}' '{admin_dir}.old' || true) && "
            f"mv '{admin_dir}.new' '{admin_dir}' && "
            f"install -m 600 -o root -g root {ENV_FILE_REMOTE}.tmp {ENV_FILE_REMOTE} && "
            f"chown -R www-data:www-data '{api_dir}' '{admin_dir}'",
            timeout=120,
        )
        if rc != 0:
            sys.exit(f"切换目录失败：{err.strip()}")

        print("[publish] 远端 npm ci --omit=dev")
        rc, out, err = run_remote(
            client,
            f"cd '{api_dir}' && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -5",
            timeout=600,
        )
        print(out.strip())
        if rc != 0:
            sys.exit(f"远端 npm ci 失败：{err.strip()}")
    finally:
        client.close()
    return 0


def render_backend_env(env: dict) -> str:
    """生成远端 env 文件（600）。只写后端需要的键，不带 SSH 凭据。"""
    keys = (
        "PORT",
        "BIND",
        "DB_PATH",
        "WX_APP_ID",
        "WX_APP_SECRET",
        "TOKEN_TTL_DAYS",
        "ADMIN_INIT_USER",
        "ADMIN_INIT_PASSWORD",
        "AVATAR_MAX_BYTES",
        "LOG_LEVEL",
    )
    defaults = {
        "PORT": "3000",
        "BIND": "127.0.0.1",
        "TOKEN_TTL_DAYS": "30",
        "AVATAR_MAX_BYTES": str(200 * 1024),
        "LOG_LEVEL": "info",
    }
    lines = ["# 由 scripts/backend_deploy.py 生成，勿手改（改动会在下次 publish 被覆盖）。"]
    for key in keys:
        value = env.get(key) or defaults.get(key)
        if not value:
            continue
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------


# 挂在 server 块内、location / 之前（同 firmware_release.py 的插入点策略）。
# 用 %(...)s 而不是 str.format：nginx 里的 `{` `}` 与 try_files 不能被当成占位符。
API_LOCATIONS = """    # 后端 API（Node/Express，scripts/backend_deploy.py 维护）
    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
        client_max_body_size 1m;
    }

    # 管理后台 SPA（Vue 3 构建产物，scripts/backend_deploy.py 维护）
    location /admin/ {
        alias %(admin_dir)s/;
        index index.html;
        try_files $uri $uri/ %(admin_dir)s/index.html;
        add_header Cache-Control "no-cache";
    }
"""


def cmd_setup_nginx(_args) -> int:
    env = load_env(require_backend=True)
    admin_dir = env["SERVER_ADMIN_DIR"].rstrip("/")
    block = API_LOCATIONS % {"admin_dir": admin_dir}

    client = sftp_client(env)
    try:
        _rc, out, _err = run_remote(client, f"cat {NGINX_SITE}")
        if not out.strip():
            sys.exit(f"远端缺少 {NGINX_SITE}")
        has_api = "location /api/" in out
        has_admin = "location /admin/" in out
        if has_api and has_admin:
            print(f"[nginx] {NGINX_SITE} 已含 /api/ 与 /admin/，跳过")
            return 0
        if "location / {" not in out:
            sys.exit(f"{NGINX_SITE} 结构超出预期（无 location /），请手工处理")

        patched = out
        if not has_api and not has_admin:
            patched = out.replace("    location / {", block + "\n    location / {", 1)
        elif not has_api:
            sys.exit(f"{NGINX_SITE} 已有 /admin/ 但缺 /api/，结构超出预期，请手工处理")
        else:
            sys.exit(f"{NGINX_SITE} 已有 /api/ 但缺 /admin/，结构超出预期，请手工处理")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        backup = f"{NGINX_SITE}.bak.{stamp}"
        run_remote(client, f"cp -a {NGINX_SITE} {backup}")

        sftp = client.open_sftp()
        try:
            sftp.putfo(_bytes_io(patched), f"{NGINX_SITE}.tmp")
        finally:
            sftp.close()

        rc, out, err = run_remote(client, "nginx -t")
        print((out + err).strip())
        if rc != 0:
            run_remote(client, f"rm -f {NGINX_SITE}.tmp")
            sys.exit(f"nginx -t 失败，未改动 {NGINX_SITE}（配置非法，备份 {backup}）")

        run_remote(client, f"mv {NGINX_SITE}.tmp {NGINX_SITE} && systemctl reload nginx")
        print(f"[nginx] 已挂载 /api/ 与 /admin/（备份 {backup}）")

        for label, path in (("API", "/api/health"), ("后台", "/admin/")):
            _rc, code, _err = run_remote(
                client,
                f"curl -s -o /dev/null -w '%{{http_code}}' "
                f"-H 'Host: {env['SERVER_HOST']}' http://127.0.0.1{path}",
            )
            print(f"[nginx] 本机自测 GET {path} → {code.strip()}（{label}）")
    finally:
        client.close()
    return 0


# ---------------------------------------------------------------------------
# restart / verify / status / logs / backup
# ---------------------------------------------------------------------------


def cmd_restart(_args) -> int:
    env = load_env(require_backend=True)
    client = sftp_client(env)
    try:
        rc, out, err = run_remote(
            client, f"systemctl restart {SERVICE_NAME} && sleep 2 && systemctl is-active {SERVICE_NAME}",
            timeout=60,
        )
        print((out + err).strip())
        if rc != 0:
            _rc, logs, _e = run_remote(
                client, f"journalctl -u {SERVICE_NAME} -n 30 --no-pager", timeout=30
            )
            print(logs)
            return rc
        print(f"[restart] {SERVICE_NAME} 已重启")
    finally:
        client.close()
    return 0


def cmd_verify(_args) -> int:
    env = load_env(require_backend=True)
    client = sftp_client(env)
    ok = True
    try:
        checks = [
            ("直连 /api/health", "http://127.0.0.1:3000/api/health"),
            ("反代 /api/health", "http://127.0.0.1/api/health"),
            ("反代 /admin/", "http://127.0.0.1/admin/"),
        ]
        for label, url in checks:
            rc, out, _err = run_remote(
                client,
                f"curl -s -m 10 -o /tmp/btl.out -w '%{{http_code}}' "
                f"-H 'Host: {env['SERVER_HOST']}' {url} && echo && head -c 300 /tmp/btl.out",
                timeout=30,
            )
            body = out.strip()
            print(f"[verify] {label} → {body[:400]}")
            if not body.startswith("200"):
                ok = False

        # 未登录访问受保护接口必须是 401（权限链路真的生效了）。
        rc, out, _err = run_remote(
            client,
            f"curl -s -o /dev/null -w '%{{http_code}}' -H 'Host: {env['SERVER_HOST']}' "
            "http://127.0.0.1/api/me",
            timeout=30,
        )
        code = out.strip()
        print(f"[verify] GET /api/me（未带 token）→ {code}（期望 401）")
        if code != "401":
            ok = False

        # 管理员登录接口：错密码必须 401（说明 admin 已落库且 scrypt 生效）。
        rc, out, _err = run_remote(
            client,
            "curl -s -o /dev/null -w '%{http_code}' -X POST "
            "-H 'content-type: application/json' "
            f"-H 'Host: {env['SERVER_HOST']}' "
            "-d '{\"username\":\"__nobody__\",\"password\":\"__wrong__\"}' "
            "http://127.0.0.1/api/admin/login",
            timeout=30,
        )
        code = out.strip()
        print(f"[verify] POST /api/admin/login（错误凭据）→ {code}（期望 401）")
        if code != "401":
            ok = False
    finally:
        client.close()

    print("[verify] OK 通过" if ok else "[verify] FAILED")
    return 0 if ok else 1


def cmd_status(_args) -> int:
    env = load_env()
    print(f"API 基地址：{env.get('API_BASE_URL', '(未配置)')}")
    print(f"后台 URL：  {env.get('API_BASE_URL', '').rstrip('/api').rstrip('/')}/admin/")

    client = sftp_client(env)
    try:
        commands = [
            ("服务", f"systemctl is-active {SERVICE_NAME}; systemctl is-enabled {SERVICE_NAME}"),
            ("进程", "pgrep -af 'src/server.js' | head -3 || echo '(未运行)'"),
            ("数据库", f"ls -lh '{env.get('DB_PATH', '')}'* 2>/dev/null | head -5 || echo '(不存在)'"),
        ]
        for title, command in commands:
            _rc, out, _err = run_remote(client, command, timeout=30)
            print(f"\n--- {title} ---\n{out.strip() or '(空)'}")

        db = env.get("DB_PATH") or ""
        if db:
            # 用 heredoc 传 JS：双引号里 ${...} 会被远端 shell 当变量展开。
            script = (
                "const{DatabaseSync}=require('node:sqlite');"
                f"const d=new DatabaseSync('{db}');"
                "for(const t of ['users','devices','sessions','audit_log']){"
                "try{console.log(t, d.prepare('select count(*) c from '+t).get().c)}"
                "catch(e){console.log(t,'-',e.message)}}"
            )
            _rc, out, _err = run_remote(
                client,
                f"node --no-warnings <<'EOJS'\n{script}\nEOJS",
                timeout=30,
            )
            print(f"\n--- 表行数 ---\n{out.strip() or '(空)'}")
    finally:
        client.close()
    return 0


def cmd_logs(_args) -> int:
    env = load_env()
    client = sftp_client(env)
    try:
        _rc, out, err = run_remote(
            client, f"journalctl -u {SERVICE_NAME} -n 80 --no-pager", timeout=60
        )
        print((out + err).strip() or "(无日志)")
    finally:
        client.close()
    return 0


def cmd_backup(_args) -> int:
    env = load_env(require_backend=True)
    db = env["DB_PATH"]
    client = sftp_client(env)
    try:
        rc, out, err = run_remote(
            client,
            f"test -f '{db}' && cp -a '{db}' '{db}.bak.'$(date +%Y%m%d%H%M%S) && "
            f"ls -lh '{db}'.bak.* | tail -5 || echo '(数据库不存在，无需备份)'",
            timeout=60,
        )
        print((out + err).strip())
        return 0 if rc == 0 else rc
    finally:
        client.close()


def cmd_pipeline(_args) -> int:
    """build → publish → setup-nginx → restart → verify（顺序不可颠倒）。"""
    steps = [
        ("build", cmd_build),
        ("publish", cmd_publish),
        ("setup-nginx", cmd_setup_nginx),
        ("restart", cmd_restart),
        ("verify", cmd_verify),
    ]
    for name, fn in steps:
        print(f"\n{'=' * 60}\n[{name}]")
        rc = fn(_args)
        if rc != 0:
            print(f"\n[pipeline] 在 {name} 失败（rc={rc}），已停止")
            return rc
    print("\n[pipeline] 全部通过")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="bt-model-light 后端 + 管理后台部署工具")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="SSH 探测服务器现状（只读）").set_defaults(fn=cmd_probe)
    sub.add_parser("setup", help="建目录 + 安装 systemd unit（幂等）").set_defaults(fn=cmd_setup)
    sub.add_parser("build", help="本地构建管理后台（vite build）").set_defaults(fn=cmd_build)
    sub.add_parser("publish", help="上传后端与后台产物 + 远端 npm ci").set_defaults(fn=cmd_publish)
    sub.add_parser("setup-nginx", help="挂 /api/ 反代与 /admin/ 静态目录（幂等）").set_defaults(
        fn=cmd_setup_nginx
    )
    sub.add_parser("restart", help="重启后端服务").set_defaults(fn=cmd_restart)
    sub.add_parser("verify", help="HTTP 校验（直连 + 反代 + 权限链路）").set_defaults(fn=cmd_verify)
    sub.add_parser("status", help="服务状态 / DB / 表行数").set_defaults(fn=cmd_status)
    sub.add_parser("logs", help="journalctl 最近 80 行").set_defaults(fn=cmd_logs)
    sub.add_parser("backup", help="备份远端 SQLite").set_defaults(fn=cmd_backup)
    sub.add_parser("pipeline", help="build → publish → setup-nginx → restart → verify").set_defaults(
        fn=cmd_pipeline
    )
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
