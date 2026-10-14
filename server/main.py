#!/usr/bin/env python3
"""maps-live 后端:Gemini Live API 的 WebSocket 反向代理 + 静态页托管 + 本地可观测日志系统。

安全要点:API key 只存在服务端环境变量 GEMINI_KEY,浏览器永远拿不到 key。
浏览器连到本服务的 /ws,本服务再带 key 连上游 Google Live API,双向透传帧。
全程记录用户输入、大模型回复、工具调用与路线导航，支持本地日志持久化与可视化实时排查。
"""
import os
import hmac
import time
import json
import hashlib
import secrets
import asyncio
import threading
import urllib.parse
import aiohttp
from aiohttp import web, WSMsgType

from logger import (
    log_event, log_user_msg, log_model_msg, log_tool_call, log_tool_resp,
    log_navigation
)
import analytics

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")


def _load_env_files():
    """自动从 /etc/maps-live.env 或本地 .env 加载环境变量（不覆盖已存在变量）。"""
    for p in ("/etc/maps-live.env", os.path.join(HERE, ".env"), os.path.join(os.path.dirname(HERE), ".env")):
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for raw in f:
                        line = raw.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k and k not in os.environ:
                            os.environ[k] = v
            except Exception:
                pass


_load_env_files()

IDLE_TIMEOUT = float(os.environ.get("WS_IDLE_TIMEOUT", "900"))    # 客户端无任何上行帧超过该秒数才判定僵尸
MAX_LIFETIME = float(os.environ.get("WS_MAX_LIFETIME", "21600"))  # 单条连接绝对上限 6h

GEMINI_KEY = os.environ.get("GEMINI_KEY", "").strip()
# Maps Embed API key（浏览器端 iframe 用,受 referrer 限制,按设计公开）
MAPS_KEY = os.environ.get("MAPS_KEY", "").strip()
# 统计看板访问令牌：设置后访问 /stats 与 /api/stats 需带 ?token=xxx（留空则不鉴权）
STATS_TOKEN = os.environ.get("STATS_TOKEN", "").strip()
UPSTREAM = ("wss://generativelanguage.googleapis.com/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService."
            "BidiGenerateContent?key=")

# --------------------------------------------------------------------------
# 访问安全网关：复杂密码 + HMAC 签名 Cookie + IP 防暴力破解 (与 Gemini TTS 同构)
# --------------------------------------------------------------------------
ACCESS_PASSWORD = (
    os.environ.get("MAPS_ACCESS_PASSWORD")
    or os.environ.get("ACCESS_PASSWORD")
    or ""
).strip()
COOKIE_AUTH = "ml_auth"
COOKIE_AUTH_MAX_AGE = 7 * 86400  # 7 天免重登

_auth_lock = threading.Lock()
_failed_attempts = {}   # ip -> [ts, ...]
_lockout_until = {}     # ip -> unlock_ts
AUTH_WINDOW_S = 600     # 10 分钟滑动窗口
AUTH_MAX_FAILS = 5      # 连续错 5 次封禁
AUTH_LOCKOUT_S = 900    # 封禁 15 分钟


def _get_access_password() -> str:
    return (
        os.environ.get("MAPS_ACCESS_PASSWORD")
        or os.environ.get("ACCESS_PASSWORD")
        or ACCESS_PASSWORD
    ).strip()


def _auth_secret(pwd: str = None) -> bytes:
    p = pwd if pwd is not None else _get_access_password()
    return hashlib.sha256(("maps-live-auth-v1:" + p).encode("utf-8")).digest()


def _check_ip_lockout(ip: str) -> int:
    """返回剩余封禁秒数；0 表示未封禁。"""
    now = time.time()
    with _auth_lock:
        until = _lockout_until.get(ip, 0)
        if until > now:
            return int(until - now) + 1
        if until:
            _lockout_until.pop(ip, None)
        return 0


def _record_auth_fail(ip: str) -> int:
    """记录一次密码错误；若触发阈值则封禁并返回封禁秒数，否则返回剩余可试次数(负值区分)。"""
    now = time.time()
    with _auth_lock:
        arr = [t for t in _failed_attempts.get(ip, []) if now - t < AUTH_WINDOW_S]
        arr.append(now)
        if len(arr) >= AUTH_MAX_FAILS:
            _failed_attempts.pop(ip, None)
            _lockout_until[ip] = now + AUTH_LOCKOUT_S
            return AUTH_LOCKOUT_S
        _failed_attempts[ip] = arr
        return -(AUTH_MAX_FAILS - len(arr))


def _clear_auth_fail(ip: str):
    with _auth_lock:
        _failed_attempts.pop(ip, None)
        _lockout_until.pop(ip, None)


def make_auth_token(ttl_s: int = COOKIE_AUTH_MAX_AGE) -> str:
    exp = int(time.time()) + ttl_s
    nonce = secrets.token_hex(8)
    payload = f"{exp}.{nonce}"
    sig = hmac.new(_auth_secret(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_auth_token(token: str) -> bool:
    if not token or token.count(".") != 2:
        return False
    try:
        exp_s, nonce, sig = token.split(".")
        if int(exp_s) < int(time.time()):
            return False
        payload = f"{exp_s}.{nonce}"
        expected = hmac.new(_auth_secret(), payload.encode("ascii"), hashlib.sha256).hexdigest()
        return secrets.compare_digest(sig, expected)
    except Exception:
        return False


def is_authenticated(request) -> bool:
    pwd = _get_access_password()
    if not pwd:
        return True
    tok = request.cookies.get(COOKIE_AUTH)
    if verify_auth_token(tok):
        return True
    hdr_key = request.headers.get("X-Access-Key", "")
    if hdr_key and secrets.compare_digest(hdr_key, pwd):
        return True
    return False


def _is_private_ip(ip: str) -> bool:
    return (not ip) or ip.startswith(("127.", "10.", "192.168.", "172.16.", "::1"))


async def _enrich_geo(ip: str):
    """后台异步反查访客 IP 归属地并回填统计记录（每个 IP 仅查一次，结果进缓存）。"""
    if _is_private_ip(ip) or analytics.geo_known(ip):
        return
    try:
        timeout = aiohttp.ClientTimeout(total=4.0)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.get(f"http://ip-api.com/json/{ip}?lang=zh-CN") as r:
                if r.status != 200:
                    return
                d = await r.json()
        if d.get("status") == "success":
            city = d.get("city") or d.get("regionName") or "未知"
            country = d.get("country") or "未知"
            analytics.cache_geo(ip, city, country)
            log_event("VISIT", f"访客归属地反查: {ip} → {country} · {city}")
    except Exception:
        pass


async def index(request):
    """首页：下发页面的同时记录一次访客 PV（Cookie 唯一标识访客，可跨会话去重）。"""
    resp = web.FileResponse(os.path.join(STATIC, "index.html"))
    try:
        vid = request.cookies.get(analytics.VISITOR_COOKIE, "")
        is_new = not vid
        if is_new:
            vid = analytics.new_visitor_id()
            resp.set_cookie(analytics.VISITOR_COOKIE, vid,
                            max_age=analytics.COOKIE_MAX_AGE, httponly=True, samesite="Lax")
        ua = request.headers.get("User-Agent", "")
        ip = analytics.client_ip_of(request)
        info = analytics.record_visit(vid, ip, ua, request.headers.get("Referer", ""),
                                      request.path, is_new)
        log_event("VISIT", f"访客{'（新）' if is_new else '（回访）'} vid={vid[:8]} ip={ip} "
                           f"{info['device']}/{info['browser']}/{info['os']}"
                           f"{'  [疑似爬虫]' if info['is_bot'] else ''}")
        if not info["is_bot"]:
            asyncio.create_task(_enrich_geo(ip))   # 不阻塞页面下发
    except Exception as e:  # noqa: BLE001
        log_event("WARN", f"[analytics] 记录访客失败: {e}", level="WARN")
    return resp


async def login_page(request):
    """Google 白底风格访问验证页。"""
    if is_authenticated(request):
        nxt = request.query.get("next") or "/"
        raise web.HTTPFound(location=nxt if nxt.startswith("/") else "/")
    return web.FileResponse(os.path.join(STATIC, "login.html"))


async def login_post(request):
    """POST /api/login：验证口令、防暴力破解封禁并下发 7 天签名 Cookie。"""
    ip = analytics.client_ip_of(request)
    lock_s = _check_ip_lockout(ip)
    if lock_s > 0:
        return web.json_response(
            {"ok": False, "error": f"密码连续错误次数过多，当前 IP 已封禁，请 {lock_s} 秒后再试"},
            status=429,
        )
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "请求格式错误"}, status=400)

    pwd_cfg = _get_access_password()
    pwd = (body.get("password") or "").strip()
    if (not pwd_cfg) or (pwd and secrets.compare_digest(pwd, pwd_cfg)):
        _clear_auth_fail(ip)
        log_event("AUTH", f"密码验证通过 ip={ip}")
        resp = web.json_response({"ok": True})
        if pwd_cfg:
            resp.set_cookie(
                COOKIE_AUTH, make_auth_token(),
                max_age=COOKIE_AUTH_MAX_AGE, path="/", httponly=True, samesite="Lax",
            )
        return resp

    res = _record_auth_fail(ip)
    if res > 0:
        log_event("ERROR", f"密码连续错误触发 IP 封禁 ({res}s) ip={ip}", level="WARN")
        return web.json_response(
            {"ok": False, "error": f"密码连续错误达 {AUTH_MAX_FAILS} 次，当前 IP 已封禁 15 分钟"},
            status=429,
        )
    remain = -res
    log_event("ERROR", f"登录密码错误 (剩余 {remain} 次机会) ip={ip}", level="WARN")
    return web.json_response(
        {"ok": False, "error": f"访问口令错误（剩余 {remain} 次尝试机会）"},
        status=401,
    )


async def logout_handler(request):
    """GET/POST /api/logout：销毁登录态并跳转至 /login。"""
    resp = web.HTTPFound(location="/login")
    resp.del_cookie(COOKIE_AUTH, path="/")
    raise resp


async def healthz(request):
    ip = analytics.client_ip_of(request)
    auth_protected = bool(_get_access_password())
    if (not auth_protected) or is_authenticated(request) or ip in ("127.0.0.1", "::1", "localhost"):
        return web.json_response({
            "ok": True,
            "service": "maps-live",
            "auth_protected": auth_protected,
            "key_loaded": bool(GEMINI_KEY),
            "maps_key_loaded": bool(MAPS_KEY),
        })
    # 未授权公网探针：仅返回最小存活性与鉴权开启状态，不暴露内部密钥加载详情
    return web.json_response({
        "ok": True,
        "service": "maps-live",
        "auth_protected": True,
    })


async def config(request):
    """把浏览器需要的前端配置(Maps Embed key)吐给客户端。"""
    return web.json_response({"mapsKey": MAPS_KEY})


def _stats_authorized(request) -> bool:
    """若已通过全局密码网关，直接放行；否则检查 STATS_TOKEN。"""
    if _get_access_password() and is_authenticated(request):
        return True
    if not STATS_TOKEN:
        return True
    return request.query.get("token", "") == STATS_TOKEN


async def stats_page(request):
    """访客与 API 用量可视化看板页面。"""
    if not _stats_authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.FileResponse(os.path.join(STATIC, "stats.html"))


async def stats_api(request):
    """聚合统计 JSON：?days=30&bots=1"""
    if not _stats_authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        days = max(1, min(365, int(request.query.get("days", "30"))))
    except ValueError:
        days = 30
    include_bots = request.query.get("bots", "0") in ("1", "true", "yes")
    data = analytics.get_stats(days=days, include_bots=include_bots)
    return web.json_response(data)


async def geo(request):
    """提供客户端网络 IP 及真实地理位置反查。"""
    forwarded = request.headers.get("X-Forwarded-For", "")
    client_ip = forwarded.split(",")[0].strip() if forwarded else (request.remote or "")

    location_data = {
        "client_ip": client_ip,
        "lat": 1.30480,
        "lng": 103.83180,
        "city": "新加坡",
        "country": "新加坡",
        "region": "SG",
        "is_real_ip": False
    }

    if client_ip and not client_ip.startswith(("127.", "10.", "172.16.", "192.168.")):
        try:
            api_url = f"http://ip-api.com/json/{client_ip}?lang=zh-CN"
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3.0)) as session:
                async with session.get(api_url) as resp:
                    if resp.status == 200:
                        d = await resp.json()
                        if d.get("status") == "success":
                            location_data["lat"] = float(d.get("lat", 1.30480))
                            location_data["lng"] = float(d.get("lon", 103.83180))
                            location_data["city"] = d.get("city") or d.get("regionName") or "本地周边"
                            location_data["country"] = d.get("country") or "本地"
                            location_data["region"] = d.get("countryCode", "SG")
                            location_data["is_real_ip"] = True
                            # 反查成功：回填该 IP 最近的访客与会话记录的地理位置
                            try:
                                analytics.cache_geo(client_ip, location_data["city"],
                                                    location_data["country"])
                            except Exception:
                                pass
        except Exception as e:
            log_event("WARN", f"[geo] IP 查询异常 {client_ip}: {e}", level="WARN")

    return web.json_response(location_data)


async def directions(request):
    """代理 Google Directions API，以服务端 MAPS_KEY 查询完整路线与折线点。"""
    origin = request.query.get("origin", "")
    destination = request.query.get("destination", "")
    mode = request.query.get("mode", "DRIVING").lower()
    region = request.query.get("region", "sg").lower()

    if not origin or not destination:
        log_navigation(None, origin, destination, mode, status="INVALID_REQUEST", error="Missing origin or destination")
        return web.json_response(
            {"status": "INVALID_REQUEST", "error_message": "Missing origin or destination"},
            status=400
        )

    api_url = "https://maps.googleapis.com/maps/api/directions/json"
    params = {
        "origin": origin,
        "destination": destination,
        "mode": mode,
        "key": MAPS_KEY,
        "language": "zh-CN"
    }
    if region and len(region) == 2 and region != "auto":
        params["region"] = region

    async with aiohttp.ClientSession() as session:
        async with session.get(api_url, params=params) as resp:
            data = await resp.json()
            dist_km = None
            dur_min = None
            status = data.get("status", "UNKNOWN")
            
            if status == "OK" and data.get("routes"):
                leg = data["routes"][0]["legs"][0]
                dist_m = leg.get("distance", {}).get("value", 0)
                dur_s = leg.get("duration", {}).get("value", 0)
                dist_km = dist_m / 1000.0
                dur_min = dur_s / 60.0
                
                # 跨国漂移安全防护：如果当前在新加坡(SG)但规划出了跨国超远路线(>60km)
                if region == "sg" and dist_km > 60:
                    log_event("WARN", f"⚠️ 跨国超远路线拦截! 起点='{origin}', 终点='{destination}', 规划距离={dist_km:.1f}km (超新加坡全境50km上限!)", level="WARN", extra={
                        "origin": origin, "destination": destination, "distance_km": dist_km, "region": region
                    })

            log_navigation(None, origin, destination, mode, dist_km, dur_min, status, data.get("error_message"))
            return web.json_response(data)


async def ws_proxy(request):
    """浏览器 <-> 本服务 <-> Google Live API 的双向透传（长连接全双工版 + 全链路本地事件记录）。"""
    ws_proxy.n = getattr(ws_proxy, "n", 0) + 1
    cid = ws_proxy.n
    client = web.WebSocketResponse(max_msg_size=16 * 1024 * 1024, heartbeat=30)
    await client.prepare(request)
    
    forwarded = request.headers.get("X-Forwarded-For", "")
    client_ip = forwarded.split(",")[0].strip() if forwarded else (request.remote or "")
    client_ua = request.headers.get("User-Agent", "")
    visitor_id = request.cookies.get(analytics.VISITOR_COOKIE, "")
    log_event("WS_CONN", f"客户端建立 WebSocket 连接 (ip={client_ip})", client_id=cid)
    try:
        analytics.session_start(cid, client_ip, client_ua, visitor_id)
    except Exception as e:  # noqa: BLE001
        log_event("WARN", f"[analytics] 会话开始记录失败: {e}", level="WARN")

    if not GEMINI_KEY:
        log_event("ERROR", "服务端环境变量 GEMINI_KEY 未配置，拒绝连接", client_id=cid)
        await client.send_json({"error": "server key missing"})
        await client.close()
        return client

    session = aiohttp.ClientSession()
    try:
        upstream = await session.ws_connect(UPSTREAM + GEMINI_KEY,
                                            max_msg_size=16 * 1024 * 1024,
                                            heartbeat=30)
    except Exception as e:  # noqa: BLE001
        log_event("ERROR", f"连结上游 Gemini Live API 失败: {e}", client_id=cid)
        await client.send_json({"error": "upstream connect failed: %s" % e})
        await client.close()
        await session.close()
        return client
    log_event("WS_CONN", "已成功桥接上游 Gemini Live API 会话通道", client_id=cid)

    last_up = time.monotonic()
    n_up = 0
    n_audio = 0          # 全双工上行 PCM 帧计数（25 帧/秒，不记录内容）

    async def c2u():
        nonlocal last_up, n_up, n_audio
        async for msg in client:
            last_up = time.monotonic()
            n_up += 1
            if msg.type == WSMsgType.TEXT:
                try:
                    parsed = json.loads(msg.data)
                    if "clientContent" in parsed:
                        turns = parsed["clientContent"].get("turns", [])
                        for turn in turns:
                            for part in turn.get("parts", []):
                                if "text" in part:
                                    log_user_msg(cid, part["text"], source="client_text")
                    elif "realtimeInput" in parsed:
                        ri = parsed["realtimeInput"]
                        if "audio" in ri:
                            n_audio += 1
                            analytics.session_bump(cid, "audio_frames")
                            if n_audio == 1:
                                log_event("VOICE", "全双工麦克风开始上行 16k PCM 音频流", client_id=cid)
                            elif n_audio % 1500 == 0:
                                log_event("VOICE", f"全双工音频流持续中，累计 {n_audio} 帧 (~{n_audio // 25}s)", client_id=cid)
                        if "text" in ri and ri["text"]:
                            log_user_msg(cid, ri["text"], source="client_realtime_text")
                        if ri.get("audioStreamEnd"):
                            log_event("VOICE", f"客户端关闭麦克风 (audioStreamEnd)，本段共 {n_audio} 帧", client_id=cid)
                            n_audio = 0
                        if "activityStart" in ri:
                            log_event("VOICE", "客户端手动标记活动开始 (activityStart)", client_id=cid)
                    elif "toolResponse" in parsed:
                        for fn in parsed["toolResponse"].get("functionResponses", []):
                            log_tool_resp(cid, fn.get("name", "unknown"), fn.get("response", {}))
                    elif "setup" in parsed:
                        model_name = parsed["setup"].get("model", "unknown")
                        ric = parsed["setup"].get("realtimeInputConfig", {}) or {}
                        aad = ric.get("automaticActivityDetection", {}) or {}
                        resume = bool((parsed["setup"].get("sessionResumption") or {}).get("handle"))
                        gc = parsed["setup"].get("generationConfig", {}) or {}
                        thinking = (gc.get("thinkingConfig") or {}).get("thinkingLevel", "无")
                        analytics.session_set_model(cid, model_name, str(thinking))
                        log_event("WS_CONN", f"setup: 模型={model_name} 思考={thinking} 服务端VAD={'关' if aad.get('disabled') else '开'} "
                                             f"activityHandling={ric.get('activityHandling', 'default')} 续接句柄={'有' if resume else '无'}",
                                  client_id=cid)
                except Exception:
                    pass
                await upstream.send_str(msg.data)
            elif msg.type == WSMsgType.BINARY:
                await upstream.send_bytes(msg.data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                break

    async def u2c():
        async for msg in upstream:
            if msg.type in (WSMsgType.TEXT, WSMsgType.BINARY):
                raw_text = msg.data if msg.type == WSMsgType.TEXT else (msg.data.decode("utf-8", errors="ignore") if isinstance(msg.data, (bytes, bytearray)) else "")
                if raw_text and (raw_text.startswith("{") or raw_text.startswith("[")):
                    try:
                        parsed = json.loads(raw_text)
                        sc = parsed.get("serverContent", {})
                        if "inputTranscription" in sc and sc["inputTranscription"].get("text"):
                            log_user_msg(cid, sc["inputTranscription"]["text"], source="voice_asr")
                            analytics.session_bump(cid, "user_turns")
                        if "outputTranscription" in sc and sc["outputTranscription"].get("text"):
                            log_model_msg(cid, sc["outputTranscription"]["text"], is_final=False)
                        if "modelTurn" in sc:
                            for part in sc["modelTurn"].get("parts", []):
                                if "text" in part:
                                    log_model_msg(cid, part["text"], is_final=False)
                        if sc.get("interrupted"):
                            analytics.session_bump(cid, "interrupts")
                            log_event("MODEL_TURN", "大模型播报被打断 (interrupted) —— 用户开口 / 新指令", client_id=cid)
                        if sc.get("turnComplete"):
                            analytics.session_bump(cid, "model_turns")
                            log_event("MODEL_TURN", "大模型本轮响应全部结束 (turnComplete)", client_id=cid)
                        if parsed.get("goAway"):
                            log_event("WS_CONN", f"上游 goAway，剩余 {parsed['goAway'].get('timeLeft')}，前端将带句柄续接", client_id=cid)
                        if "toolCall" in parsed:
                            for fc in parsed["toolCall"].get("functionCalls", []):
                                log_tool_call(cid, fc.get("name", "unknown"), fc.get("args", {}))
                                analytics.session_bump(cid, "tool_calls")
                                analytics.record_tool_event(cid, fc.get("name", "unknown"), fc.get("args", {}))
                        if "groundingMetadata" in sc:
                            gm = sc["groundingMetadata"]
                            if gm.get("webSearchQueries"):
                                analytics.session_bump(cid, "searches")
                                log_event("GROUNDING", f"Web搜索检索词: {gm['webSearchQueries']}", client_id=cid)
                            if gm.get("groundingChunks"):
                                maps_chunks = [c["maps"]["title"] for c in gm["groundingChunks"] if "maps" in c and "title" in c["maps"]]
                                if maps_chunks:
                                    log_event("GROUNDING", f"Google Maps位置对齐: {maps_chunks}", client_id=cid)
                    except Exception:
                        pass
                if msg.type == WSMsgType.TEXT:
                    await client.send_str(msg.data)
                else:
                    await client.send_bytes(msg.data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                break

    async def watchdog():
        while True:
            await asyncio.sleep(15)
            if time.monotonic() - last_up > IDLE_TIMEOUT:
                log_event("WS_CONN", f"客户端空闲超时 (>{IDLE_TIMEOUT}s)，自动安全断开", client_id=cid)
                return

    tasks = [asyncio.create_task(c2u()), asyncio.create_task(u2c()), asyncio.create_task(watchdog())]
    try:
        done, _ = await asyncio.wait(tasks, timeout=MAX_LIFETIME, return_when=asyncio.FIRST_COMPLETED)
        if not done:
            log_event("WS_CONN", "达到单会话绝对生命周期硬上限，安全关闭", client_id=cid)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await upstream.close()
        await session.close()
        if not client.closed:
            await client.close()
        try:
            analytics.session_end(cid)
        except Exception as e:  # noqa: BLE001
            log_event("WARN", f"[analytics] 会话结束落库失败: {e}", level="WARN")
        log_event("WS_CONN", f"会话通道关闭，累计透传客户端上行帧={n_up}", client_id=cid)
    return client


@web.middleware
async def no_cache(request, handler):
    resp = await handler(request)
    if request.path in ("/", "/login", "/config", "/api/config", "/stats") or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
    return resp


@web.middleware
async def auth_gate(request, handler):
    """全路由强制鉴权网关：阻断未授权 API/WebSocket 盗刷与配置/日志/统计泄露。"""
    pwd_cfg = _get_access_password()
    if not pwd_cfg:
        return await handler(request)

    path = request.path
    if path in ("/login", "/api/login", "/api/logout", "/healthz"):
        return await handler(request)

    # 支持书签直达免输密：GET /?key=<PASSWORD> 验证通过后写 Cookie 并 302 剥离地址栏明文口令
    q_key = request.query.get("key", "")
    if q_key and request.method == "GET":
        ip = analytics.client_ip_of(request)
        lock_s = _check_ip_lockout(ip)
        if lock_s > 0:
            return web.Response(
                status=429,
                text=f"429 Too Many Requests: IP locked for {lock_s}s due to repeated failed auth.",
            )
        if secrets.compare_digest(q_key, pwd_cfg):
            _clear_auth_fail(ip)
            log_event("AUTH", f"通过专属密钥链接授权成功 ip={ip}")
            clean_q = [(k, v) for k, v in request.query.items() if k != "key"]
            target = path + ("?" + urllib.parse.urlencode(clean_q) if clean_q else "")
            resp = web.HTTPFound(location=target)
            resp.set_cookie(
                COOKIE_AUTH, make_auth_token(),
                max_age=COOKIE_AUTH_MAX_AGE, path="/", httponly=True, samesite="Lax",
            )
            raise resp
        else:
            res = _record_auth_fail(ip)
            log_event("ERROR", f"URL 密钥口令错误 ip={ip}", level="WARN")
            if res > 0:
                return web.Response(status=429, text=f"429 Too Many Requests: IP locked for {res}s")

    if is_authenticated(request):
        return await handler(request)

    # 未授权拦截：API、WebSocket、配置接口一律 401 JSON，静态文件 401，页面访问 302 跳转至 /login
    if path.startswith("/api/") or path in ("/config", "/geo", "/ws") or request.method != "GET":
        return web.json_response(
            {"ok": False, "error": "未授权访问：请先输入访问密码登录"}, status=401
        )
    if path.startswith("/static/"):
        return web.Response(status=401, text="401 Unauthorized")

    next_url = request.rel_url.path_qs
    login_url = "/login"
    if next_url and next_url != "/":
        login_url = "/login?" + urllib.parse.urlencode({"next": next_url})
    raise web.HTTPFound(location=login_url)


@web.middleware
async def usage_tracker(request, handler):
    """记录每一次 HTTP API 调用的端点、状态码与耗时（静态资源与看板轮询不计）。"""
    if not analytics.should_count(request.path):
        return await handler(request)
    t0 = time.monotonic()
    status = 500
    try:
        resp = await handler(request)
        status = getattr(resp, "status", 200)
        return resp
    except web.HTTPException as e:
        status = e.status
        raise
    finally:
        try:
            analytics.record_api_call(
                endpoint=request.path,
                method=request.method,
                status=status,
                duration_ms=(time.monotonic() - t0) * 1000.0,
                visitor_id=request.cookies.get(analytics.VISITOR_COOKIE, ""),
                ip=analytics.client_ip_of(request),
                ua=request.headers.get("User-Agent", ""),
            )
        except Exception:
            pass


def make_app():
    app = web.Application(middlewares=[no_cache, auth_gate, usage_tracker])
    app.router.add_get("/", index)
    app.router.add_get("/login", login_page)
    app.router.add_post("/api/login", login_post)
    app.router.add_get("/api/logout", logout_handler)
    app.router.add_post("/api/logout", logout_handler)
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/config", config)
    app.router.add_get("/api/config", config)
    app.router.add_get("/geo", geo)
    app.router.add_get("/api/geo", geo)
    app.router.add_get("/api/directions", directions)
    app.router.add_get("/stats", stats_page)
    app.router.add_get("/api/stats", stats_api)
    app.router.add_get("/ws", ws_proxy)
    app.router.add_static("/static/", STATIC, show_index=False)
    return app


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 8080))
    web.run_app(make_app(), host=host, port=port)
