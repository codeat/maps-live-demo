#!/usr/bin/env python3
"""maps-live 访客记录与 API 调用统计模块。

使用 SQLite 做持久化（服务重启不丢数据），记录四类核心数据：
  1. visits      —— 页面访客（Cookie 唯一访客 ID + IP + 地理位置 + 设备/浏览器 + 爬虫识别）
  2. api_calls   —— 所有 HTTP API 调用（端点、方法、状态码、耗时）
  3. sessions    —— Gemini Live WebSocket 会话（模型、时长、语音秒数、对话轮次、工具调用、打断次数）
  4. tool_events —— 模型触发的 Function Call 与导航目的地明细

对外提供 get_stats() 聚合看板数据与 get_recent_visitors() 明细，供 /api/stats 与 /stats 看板消费。
"""
import os
import re
import json
import time
import uuid
import sqlite3
import threading
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "logs")
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.environ.get("STATS_DB", os.path.join(DATA_DIR, "analytics.db"))
VISITOR_COOKIE = "mlvid"          # 唯一访客标识 Cookie 名
COOKIE_MAX_AGE = 365 * 24 * 3600  # 访客 Cookie 有效期 1 年

# 这些路径属于页面访问（计入访客 PV），其余算纯 API 调用
PAGE_PATHS = ("/",)
# 统计时忽略的路径：静态资源、看板自身轮询、探活，以及 /ws 长连接
# （/ws 存活可达数分钟，计入 HTTP 用量会严重拉高平均耗时；它已由 sessions 表单独统计）
IGNORED_PREFIXES = ("/static/", "/favicon", "/api/stats", "/healthz", "/ws", "/login", "/api/login", "/api/logout")

_BOT_RE = re.compile(
    r"bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headlesschrome|"
    r"python-requests|aiohttp|curl|wget|monitor|uptime|scanner|probe",
    re.I,
)
_SCANNER_PATH_RE = re.compile(
    r"(\.env|\.php|\.git|\.aws|\.ssh|credentials\.json|wp-admin|phpmyadmin|actuator|cgi-bin|vendor/)",
    re.I,
)
_MOBILE_RE = re.compile(r"iphone|android.*mobile|windows phone|ipod", re.I)
_TABLET_RE = re.compile(r"ipad|android(?!.*mobile)|tablet", re.I)

_lock = threading.Lock()
_conn = None
_geo_cache = {}          # ip -> (city, country)
_scanner_ips = set()     # 触发过漏洞探测的 IP 自动归为 bot
_live_sessions = {}      # client_id -> 运行中的会话累计计数


# --------------------------------------------------------------------------- #
# 初始化
# --------------------------------------------------------------------------- #
def _connect():
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
    return _conn


def init_db():
    """建表与建索引（幂等，可重复调用）。"""
    with _lock:
        c = _connect()
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS visits (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms       INTEGER NOT NULL,
                day         TEXT    NOT NULL,
                hour        INTEGER NOT NULL,
                visitor_id  TEXT    NOT NULL,
                ip          TEXT,
                city        TEXT,
                country     TEXT,
                device      TEXT,
                browser     TEXT,
                os          TEXT,
                referer     TEXT,
                path        TEXT,
                ua          TEXT,
                is_bot      INTEGER DEFAULT 0,
                is_new      INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
            CREATE INDEX IF NOT EXISTS idx_visits_ts  ON visits(ts_ms);
            CREATE INDEX IF NOT EXISTS idx_visits_vid ON visits(visitor_id);

            CREATE TABLE IF NOT EXISTS api_calls (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms       INTEGER NOT NULL,
                day         TEXT    NOT NULL,
                endpoint    TEXT    NOT NULL,
                method      TEXT,
                status      INTEGER,
                duration_ms REAL,
                visitor_id  TEXT,
                ip          TEXT,
                is_bot      INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_api_day ON api_calls(day);
            CREATE INDEX IF NOT EXISTS idx_api_ep  ON api_calls(endpoint);
            CREATE INDEX IF NOT EXISTS idx_api_ts  ON api_calls(ts_ms);

            CREATE TABLE IF NOT EXISTS sessions (
                client_id     INTEGER PRIMARY KEY,
                ts_ms         INTEGER NOT NULL,
                day           TEXT    NOT NULL,
                visitor_id    TEXT,
                ip            TEXT,
                city          TEXT,
                country       TEXT,
                model         TEXT,
                thinking      TEXT,
                started_ms    INTEGER,
                ended_ms      INTEGER,
                duration_s    REAL    DEFAULT 0,
                user_turns    INTEGER DEFAULT 0,
                model_turns   INTEGER DEFAULT 0,
                tool_calls    INTEGER DEFAULT 0,
                interrupts    INTEGER DEFAULT 0,
                audio_frames  INTEGER DEFAULT 0,
                audio_seconds REAL    DEFAULT 0,
                searches      INTEGER DEFAULT 0,
                is_bot        INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sess_day   ON sessions(day);
            CREATE INDEX IF NOT EXISTS idx_sess_model ON sessions(model);

            CREATE TABLE IF NOT EXISTS tool_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms       INTEGER NOT NULL,
                day         TEXT    NOT NULL,
                client_id   INTEGER,
                tool_name   TEXT,
                destination TEXT,
                travel_mode TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tool_day  ON tool_events(day);
            CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_events(tool_name);
            """
        )
        c.execute(
            "DELETE FROM api_calls WHERE endpoint LIKE '/ws%' OR endpoint LIKE '/static/%'"
            " OR endpoint LIKE '/api/stats%' OR endpoint LIKE '/healthz%' OR endpoint LIKE '/favicon%'"
        )
        c.execute(
            "UPDATE visits SET is_bot=1 WHERE ip IN ("
            "SELECT DISTINCT ip FROM api_calls WHERE (status=404 OR endpoint LIKE '%.env%' OR endpoint LIKE '%.php%')"
            " AND endpoint NOT IN ('/', '/config', '/api/directions', '/api/places', '/api/geo', '/stats') AND ip<>''"
            ")"
        )
        c.execute(
            "DELETE FROM api_calls WHERE (status=404 OR endpoint LIKE '%.env%' OR endpoint LIKE '%.php%')"
            " AND endpoint NOT IN ('/', '/config', '/api/directions', '/api/places', '/api/geo', '/stats')"
        )
        c.execute(
            "UPDATE api_calls SET is_bot=1 WHERE ip IN (SELECT DISTINCT ip FROM visits WHERE is_bot=1)"
        )
        c.commit()
    return True


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #
def _now():
    n = datetime.now()
    return int(n.timestamp() * 1000), n.strftime("%Y-%m-%d"), n.hour


def client_ip_of(request) -> str:
    """优先取反向代理链首个真实 IP。"""
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return getattr(request, "remote", "") or ""


def is_bot_ua(ua: str) -> bool:
    return bool(ua and _BOT_RE.search(ua))


def parse_ua(ua: str) -> dict:
    """从 User-Agent 解析设备类型 / 浏览器 / 操作系统。"""
    ua = ua or ""
    if _TABLET_RE.search(ua):
        device = "平板"
    elif _MOBILE_RE.search(ua):
        device = "手机"
    elif ua:
        device = "桌面"
    else:
        device = "未知"

    if re.search(r"edg/", ua, re.I):
        browser = "Edge"
    elif re.search(r"crios|chrome/", ua, re.I):
        browser = "Chrome"
    elif re.search(r"firefox|fxios", ua, re.I):
        browser = "Firefox"
    elif re.search(r"safari", ua, re.I):
        browser = "Safari"
    elif ua:
        browser = "其他"
    else:
        browser = "未知"

    if re.search(r"iphone|ipad|ipod|cpu os", ua, re.I):
        osname = "iOS"
    elif re.search(r"android", ua, re.I):
        osname = "Android"
    elif re.search(r"mac os x|macintosh", ua, re.I):
        osname = "macOS"
    elif re.search(r"windows", ua, re.I):
        osname = "Windows"
    elif re.search(r"linux|x11|cros", ua, re.I):
        osname = "Linux"
    else:
        osname = "未知"

    return {"device": device, "browser": browser, "os": osname}


def should_count(path: str) -> bool:
    """是否计入 API 用量统计（过滤静态资源与看板自身轮询）。"""
    return not any(path.startswith(p) for p in IGNORED_PREFIXES)


def new_visitor_id() -> str:
    return uuid.uuid4().hex


def geo_known(ip: str) -> bool:
    """该 IP 的地理位置是否已在缓存中（避免重复反查）。"""
    return bool(ip) and ip in _geo_cache


def cache_geo(ip: str, city: str, country: str):
    """/geo 反查成功后写入缓存，并回填该 IP 最近的访客与会话记录。"""
    if not ip or not city:
        return
    _geo_cache[ip] = (city, country)
    with _lock:
        c = _connect()
        c.execute(
            "UPDATE visits SET city=?, country=? "
            "WHERE ip=? AND (city IS NULL OR city='') AND ts_ms > ?",
            (city, country, ip, int(time.time() * 1000) - 6 * 3600 * 1000),
        )
        c.execute(
            "UPDATE sessions SET city=?, country=? "
            "WHERE ip=? AND (city IS NULL OR city='')",
            (city, country, ip),
        )
        c.commit()


# --------------------------------------------------------------------------- #
# 写入：访客 / API / 会话 / 工具
# --------------------------------------------------------------------------- #
def record_visit(visitor_id: str, ip: str, ua: str, referer: str, path: str, is_new: bool) -> dict:
    """记录一次页面访问（PV）。"""
    ts_ms, day, hour = _now()
    info = parse_ua(ua)
    if _SCANNER_PATH_RE.search(path or ""):
        if ip:
            _scanner_ips.add(ip)
    bot = 1 if (is_bot_ua(ua) or (ip and ip in _scanner_ips)) else 0
    city, country = _geo_cache.get(ip, ("", ""))
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO visits (ts_ms, day, hour, visitor_id, ip, city, country, device, browser, os,"
            " referer, path, ua, is_bot, is_new) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts_ms, day, hour, visitor_id, ip, city, country, info["device"], info["browser"],
             info["os"], (referer or "")[:300], path, (ua or "")[:400], bot, 1 if is_new else 0),
        )
        c.commit()
    return {"visitor_id": visitor_id, "is_bot": bool(bot), **info}


def record_api_call(endpoint: str, method: str, status: int, duration_ms: float,
                    visitor_id: str = "", ip: str = "", ua: str = ""):
    """记录一次 API 调用。"""
    if not should_count(endpoint):
        return
    status_code = int(status or 0)
    # 互联网漏洞扫描器探测未知路径（如 /.env、/phpinfo.php 返回 404）：
    # 自动将该 IP 标记为爬虫，且不计入业务 API 调用统计
    if _SCANNER_PATH_RE.search(endpoint or "") or (status_code == 404 and not endpoint.startswith("/api/")):
        if ip:
            _scanner_ips.add(ip)
            with _lock:
                c = _connect()
                c.execute("UPDATE visits SET is_bot=1 WHERE ip=?", (ip,))
                c.commit()
        return
    ts_ms, day, _ = _now()
    bot = 1 if (is_bot_ua(ua) or (ip and ip in _scanner_ips)) else 0
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO api_calls (ts_ms, day, endpoint, method, status, duration_ms, visitor_id, ip, is_bot)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (ts_ms, day, endpoint, method, status_code, round(float(duration_ms or 0), 2),
             visitor_id, ip, bot),
        )
        c.commit()


def session_start(client_id: int, ip: str, ua: str, visitor_id: str = ""):
    """Live WebSocket 会话开始。"""
    ts_ms, day, _ = _now()
    city, country = _geo_cache.get(ip, ("", ""))
    _live_sessions[client_id] = {
        "user_turns": 0, "model_turns": 0, "tool_calls": 0,
        "interrupts": 0, "audio_frames": 0, "searches": 0,
    }
    with _lock:
        c = _connect()
        c.execute(
            "INSERT OR REPLACE INTO sessions (client_id, ts_ms, day, visitor_id, ip, city, country,"
            " model, started_ms, is_bot) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (client_id, ts_ms, day, visitor_id, ip, city, country, "", ts_ms,
             1 if is_bot_ua(ua) else 0),
        )
        c.commit()


def session_set_model(client_id: int, model: str, thinking: str = ""):
    """收到 setup 帧后回填本次会话使用的模型。"""
    with _lock:
        c = _connect()
        c.execute("UPDATE sessions SET model=?, thinking=? WHERE client_id=?",
                  (model or "", thinking or "", client_id))
        c.commit()


def session_bump(client_id: int, field: str, delta: int = 1):
    """累加会话内的计数指标（user_turns / model_turns / tool_calls / interrupts / audio_frames / searches）。"""
    s = _live_sessions.get(client_id)
    if s is None or field not in s:
        return
    s[field] += delta


def session_end(client_id: int):
    """会话结束：把内存累计值一次性落库（避免每帧写盘）。"""
    s = _live_sessions.pop(client_id, None)
    ts_ms, _, _ = _now()
    with _lock:
        c = _connect()
        row = c.execute("SELECT started_ms FROM sessions WHERE client_id=?", (client_id,)).fetchone()
        started = row["started_ms"] if row else ts_ms
        duration_s = max(0.0, (ts_ms - (started or ts_ms)) / 1000.0)
        s = s or {}
        frames = s.get("audio_frames", 0)
        c.execute(
            "UPDATE sessions SET ended_ms=?, duration_s=?, user_turns=?, model_turns=?, tool_calls=?,"
            " interrupts=?, audio_frames=?, audio_seconds=?, searches=? WHERE client_id=?",
            (ts_ms, round(duration_s, 2), s.get("user_turns", 0), s.get("model_turns", 0),
             s.get("tool_calls", 0), s.get("interrupts", 0), frames, round(frames * 0.04, 2),
             s.get("searches", 0), client_id),
        )
        c.commit()


def record_tool_event(client_id: int, tool_name: str, args: dict = None):
    """记录一次模型 Function Call（含导航目的地与出行方式）。"""
    ts_ms, day, _ = _now()
    args = args or {}
    dest = args.get("destination") or args.get("query") or args.get("place") or ""
    mode = args.get("travel_mode") or args.get("mode") or ""
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO tool_events (ts_ms, day, client_id, tool_name, destination, travel_mode)"
            " VALUES (?,?,?,?,?,?)",
            (ts_ms, day, client_id, tool_name or "unknown", str(dest)[:160], str(mode)[:32]),
        )
        c.commit()


# --------------------------------------------------------------------------- #
# 读取：聚合看板
# --------------------------------------------------------------------------- #
def _rows(sql, params=()):
    with _lock:
        c = _connect()
        return [dict(r) for r in c.execute(sql, params).fetchall()]


def _one(sql, params=()):
    r = _rows(sql, params)
    return r[0] if r else {}


def get_stats(days: int = 30, include_bots: bool = False) -> dict:
    """产出看板所需的全部聚合指标。"""
    init_db()
    since_day = (datetime.now() - timedelta(days=max(1, days) - 1)).strftime("%Y-%m-%d")
    today = datetime.now().strftime("%Y-%m-%d")
    bot_f = "" if include_bots else " AND is_bot=0"

    totals = _one(
        f"SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS unique_visitors,"
        f" COUNT(DISTINCT ip) AS unique_ips, SUM(is_new) AS new_visitors"
        f" FROM visits WHERE day>=?{bot_f}", (since_day,))
    today_stat = _one(
        f"SELECT COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS unique_visitors"
        f" FROM visits WHERE day=?{bot_f}", (today,))
    bots = _one("SELECT COUNT(*) AS c FROM visits WHERE day>=? AND is_bot=1", (since_day,))

    sess = _one(
        f"SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_s),0) AS total_duration_s,"
        f" COALESCE(SUM(audio_seconds),0) AS voice_seconds, COALESCE(SUM(user_turns),0) AS user_turns,"
        f" COALESCE(SUM(model_turns),0) AS model_turns, COALESCE(SUM(tool_calls),0) AS tool_calls,"
        f" COALESCE(SUM(interrupts),0) AS interrupts, COALESCE(SUM(searches),0) AS searches,"
        f" COALESCE(AVG(duration_s),0) AS avg_duration_s"
        f" FROM sessions WHERE day>=?{bot_f}", (since_day,))
    today_sess = _one(
        f"SELECT COUNT(*) AS sessions FROM sessions WHERE day=?{bot_f}", (today,))

    api = _one(
        f"SELECT COUNT(*) AS calls, COALESCE(AVG(duration_ms),0) AS avg_ms,"
        f" SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS errors"
        f" FROM api_calls WHERE day>=?{bot_f}", (since_day,))
    today_api = _one(
        f"SELECT COUNT(*) AS calls FROM api_calls WHERE day=?{bot_f}", (today,))

    by_day = _rows(
        f"SELECT day, COUNT(*) AS visits, COUNT(DISTINCT visitor_id) AS unique_visitors"
        f" FROM visits WHERE day>=?{bot_f} GROUP BY day ORDER BY day", (since_day,))
    day_sess = {r["day"]: r for r in _rows(
        f"SELECT day, COUNT(*) AS sessions, COALESCE(SUM(audio_seconds),0) AS voice_seconds"
        f" FROM sessions WHERE day>=?{bot_f} GROUP BY day", (since_day,))}
    day_api = {r["day"]: r["calls"] for r in _rows(
        f"SELECT day, COUNT(*) AS calls FROM api_calls WHERE day>=?{bot_f} GROUP BY day", (since_day,))}
    for d in by_day:
        s = day_sess.get(d["day"], {})
        d["sessions"] = s.get("sessions", 0)
        d["voice_minutes"] = round(s.get("voice_seconds", 0) / 60.0, 1)
        d["api_calls"] = day_api.get(d["day"], 0)

    by_model = _rows(
        f"SELECT CASE WHEN model='' OR model IS NULL THEN '(未上报)' ELSE model END AS model,"
        f" COUNT(*) AS sessions, COALESCE(SUM(user_turns),0) AS user_turns,"
        f" COALESCE(SUM(tool_calls),0) AS tool_calls, COALESCE(SUM(interrupts),0) AS interrupts,"
        f" ROUND(COALESCE(SUM(audio_seconds),0)/60.0,1) AS voice_minutes,"
        f" ROUND(COALESCE(AVG(duration_s),0),1) AS avg_duration_s"
        f" FROM sessions WHERE day>=?{bot_f} GROUP BY model ORDER BY sessions DESC", (since_day,))

    by_endpoint = _rows(
        f"SELECT endpoint, COUNT(*) AS calls, ROUND(COALESCE(AVG(duration_ms),0),1) AS avg_ms,"
        f" SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) AS errors"
        f" FROM api_calls WHERE day>=?{bot_f} GROUP BY endpoint ORDER BY calls DESC", (since_day,))

    by_region = _rows(
        f"SELECT CASE WHEN country='' OR country IS NULL THEN '未知' ELSE country END AS country,"
        f" CASE WHEN city='' OR city IS NULL THEN '未知' ELSE city END AS city,"
        f" COUNT(*) AS visits, COUNT(DISTINCT ip) AS unique_ips"
        f" FROM visits WHERE day>=?{bot_f} GROUP BY country, city ORDER BY visits DESC LIMIT 20",
        (since_day,))

    by_device = _rows(
        f"SELECT device, COUNT(*) AS visits FROM visits WHERE day>=?{bot_f}"
        f" GROUP BY device ORDER BY visits DESC", (since_day,))
    by_browser = _rows(
        f"SELECT browser, COUNT(*) AS visits FROM visits WHERE day>=?{bot_f}"
        f" GROUP BY browser ORDER BY visits DESC", (since_day,))

    top_tools = _rows(
        "SELECT tool_name, COUNT(*) AS count FROM tool_events WHERE day>=?"
        " GROUP BY tool_name ORDER BY count DESC LIMIT 12", (since_day,))
    top_destinations = _rows(
        "SELECT destination, COUNT(*) AS count FROM tool_events"
        " WHERE day>=? AND destination<>'' GROUP BY destination ORDER BY count DESC LIMIT 15",
        (since_day,))

    recent_visitors = _rows(
        f"SELECT ts_ms, visitor_id, ip, city, country, device, browser, os, referer, is_new, is_bot"
        f" FROM visits WHERE day>=?{bot_f} ORDER BY ts_ms DESC LIMIT 40", (since_day,))
    for v in recent_visitors:
        v["time"] = datetime.fromtimestamp(v["ts_ms"] / 1000).strftime("%m-%d %H:%M:%S")
        v["visitor_short"] = (v.get("visitor_id") or "")[:8]

    recent_sessions = _rows(
        f"SELECT client_id, ts_ms, ip, city, country, model, duration_s, user_turns, model_turns,"
        f" tool_calls, interrupts, audio_seconds FROM sessions WHERE day>=?{bot_f}"
        f" ORDER BY ts_ms DESC LIMIT 30", (since_day,))
    for s in recent_sessions:
        s["time"] = datetime.fromtimestamp(s["ts_ms"] / 1000).strftime("%m-%d %H:%M:%S")
        s["voice_minutes"] = round((s.get("audio_seconds") or 0) / 60.0, 2)
        s["model_short"] = (s.get("model") or "(未上报)").replace("models/", "")

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "range_days": days,
        "include_bots": include_bots,
        "totals": {
            "visits": totals.get("visits", 0) or 0,
            "unique_visitors": totals.get("unique_visitors", 0) or 0,
            "unique_ips": totals.get("unique_ips", 0) or 0,
            "new_visitors": totals.get("new_visitors", 0) or 0,
            "bot_hits": bots.get("c", 0) or 0,
            "sessions": sess.get("sessions", 0) or 0,
            "voice_minutes": round((sess.get("voice_seconds", 0) or 0) / 60.0, 1),
            "session_minutes": round((sess.get("total_duration_s", 0) or 0) / 60.0, 1),
            "avg_session_s": round(sess.get("avg_duration_s", 0) or 0, 1),
            "user_turns": sess.get("user_turns", 0) or 0,
            "model_turns": sess.get("model_turns", 0) or 0,
            "tool_calls": sess.get("tool_calls", 0) or 0,
            "interrupts": sess.get("interrupts", 0) or 0,
            "searches": sess.get("searches", 0) or 0,
            "api_calls": api.get("calls", 0) or 0,
            "api_avg_ms": round(api.get("avg_ms", 0) or 0, 1),
            "api_errors": api.get("errors", 0) or 0,
        },
        "today": {
            "visits": today_stat.get("visits", 0) or 0,
            "unique_visitors": today_stat.get("unique_visitors", 0) or 0,
            "sessions": today_sess.get("sessions", 0) or 0,
            "api_calls": today_api.get("calls", 0) or 0,
        },
        "by_day": by_day,
        "by_model": by_model,
        "by_endpoint": by_endpoint,
        "by_region": by_region,
        "by_device": by_device,
        "by_browser": by_browser,
        "top_tools": top_tools,
        "top_destinations": top_destinations,
        "recent_visitors": recent_visitors,
        "recent_sessions": recent_sessions,
    }


def reset_all():
    """清空全部统计数据（仅测试与手动重置用）。"""
    with _lock:
        c = _connect()
        for t in ("visits", "api_calls", "sessions", "tool_events"):
            c.execute(f"DELETE FROM {t}")
        c.commit()
    _live_sessions.clear()
    _geo_cache.clear()
    _scanner_ips.clear()


init_db()
