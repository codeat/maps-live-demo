#!/usr/bin/env python3
"""tests/proxy_close_relay_test.py — v121 服务端回归：上游 Gemini Live WebSocket 关闭码/原因必须被记录并原样透传给浏览器。

背景：客户 sei-ai-test 的 Live API 429 事故里，客户端拿不到关闭原因 → 2s 无退避重连 → 每小时 1,400+ 次 429 的重连风暴。
本测试起一个假上游（发 setupComplete 后以 1008 + 配额原因关闭）与真实 ws_proxy，断言浏览器侧收到的 close_code == 1008 且原因原样透传。
运行：python3 tests/proxy_close_relay_test.py
"""
import asyncio
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, ".."))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)   # main.py 以 `from logger import ...` 方式引用同目录模块
os.environ.setdefault("GEMINI_KEY", "dummy-key-for-test")
spec = importlib.util.spec_from_file_location("mainmod", os.path.join(SERVER_DIR, "main.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

from aiohttp import web, ClientSession, WSMsgType  # noqa: E402

QUOTA_REASON = "Quota exceeded for quota metric 'generate_content_search_request_paid' (429 RESOURCE_EXHAUSTED)"
passed = failed = 0


def check(name, cond, details=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS [{name}] {details}")
    else:
        failed += 1
        print(f"FAIL [{name}] {details}")


def test_classify():
    c = m.classify_upstream_close
    check("classify: 1008 → quota", c(1008, "") == "quota")
    check("classify: 429 文本 → quota", c(None, "You exceeded your current quota, please check your plan and billing details") == "quota")
    check("classify: status 429 → quota", c(429, "") == "quota")
    check("classify: Resource exhausted → capacity", c(1011, "Resource exhausted, please try again later") == "capacity")
    check("classify: 1000 → normal / 1011 internal → other", c(1000, "") == "normal" and c(1011, "internal") == "other")


async def run_relay_case(close_code, reason, expect_code):
    async def fake_upstream(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_str(json.dumps({"setupComplete": {}}))
        await ws.close(code=close_code, message=reason.encode("utf-8"))
        return ws

    up = web.Application(); up.router.add_get("/up", fake_upstream)
    r1 = web.AppRunner(up); await r1.setup(); s1 = web.TCPSite(r1, "127.0.0.1", 18701); await s1.start()
    m.UPSTREAM = "ws://127.0.0.1:18701/up?key="
    app = web.Application(); app.router.add_get("/ws", m.ws_proxy)
    r2 = web.AppRunner(app); await r2.setup(); s2 = web.TCPSite(r2, "127.0.0.1", 18702); await s2.start()
    got_frames, got_close_code, got_reason = [], None, ""
    try:
        async with ClientSession() as cs:
            async with cs.ws_connect("ws://127.0.0.1:18702/ws") as ws:
                while True:
                    msg = await ws.receive()
                    if msg.type == WSMsgType.TEXT:
                        got_frames.append(msg.data)
                    elif msg.type == WSMsgType.CLOSE:
                        got_close_code, got_reason = msg.data, str(msg.extra or "")
                        break
                    elif msg.type in (WSMsgType.CLOSING, WSMsgType.CLOSED, WSMsgType.ERROR):
                        got_close_code = ws.close_code
                        break
    finally:
        await r2.cleanup(); await r1.cleanup()
    return got_frames, got_close_code, got_reason


async def main():
    test_classify()
    frames, code, reason = await run_relay_case(1008, QUOTA_REASON, 1008)
    check("relay: setupComplete 正常透传", frames == [json.dumps({"setupComplete": {}})], str(frames))
    check("relay: 上游 1008 配额关闭码原样透传给浏览器", code == 1008, f"code={code}")
    check("relay: 配额原因文本原样透传（截断 ≤120B）", reason.startswith("Quota exceeded for quota metric"), f"reason={reason!r}")
    frames, code, reason = await run_relay_case(1011, "Resource exhausted, please try again later", 1011)
    check("relay: 上游 1011 容量关闭码透传", code == 1011 and "Resource exhausted" in reason, f"code={code} reason={reason!r}")
    frames, code, reason = await run_relay_case(1000, "", 1000)
    check("relay: 上游 1000 正常关闭透传", code == 1000, f"code={code}")
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
