#!/usr/bin/env python3
"""analytics.py 访客与 API 用量统计模块单元测试。

运行： python3 server/tests/analytics_test.py
使用独立的临时 SQLite 文件，绝不污染生产 logs/analytics.db。
"""
import os
import sys
import time
import tempfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(HERE)
sys.path.insert(0, SERVER_DIR)

# 必须在 import analytics 之前指定临时库路径
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="mlstats_"), "analytics_test.db")
os.environ["STATS_DB"] = _TMP_DB

import analytics  # noqa: E402

passed = 0
failed = 0


def assert_(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS [{name}]" + (f" {detail}" if detail else ""))
    else:
        failed += 1
        print(f"FAIL [{name}]" + (f" {detail}" if detail else ""))


UA_CHROME_MAC = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
UA_SAFARI_IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
                    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
UA_ANDROID_TABLET = ("Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
UA_GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"


def main():
    analytics.init_db()
    analytics.reset_all()

    # ---------------- T1 User-Agent 解析：设备 / 浏览器 / 操作系统 ----------------
    m = analytics.parse_ua(UA_CHROME_MAC)
    assert_("T1 桌面 Chrome/macOS 解析正确",
            m == {"device": "桌面", "browser": "Chrome", "os": "macOS"}, str(m))
    i = analytics.parse_ua(UA_SAFARI_IPHONE)
    assert_("T1 iPhone Safari/iOS 解析正确",
            i == {"device": "手机", "browser": "Safari", "os": "iOS"}, str(i))
    t = analytics.parse_ua(UA_ANDROID_TABLET)
    assert_("T1 Android 平板（无 Mobile 标识）识别为平板",
            t["device"] == "平板" and t["os"] == "Android", str(t))
    assert_("T1 空 UA 全部归为未知",
            analytics.parse_ua("") == {"device": "未知", "browser": "未知", "os": "未知"})

    # ---------------- T2 爬虫识别 ----------------
    assert_("T2 Googlebot 判定为爬虫", analytics.is_bot_ua(UA_GOOGLEBOT) is True)
    assert_("T2 python-requests 判定为爬虫", analytics.is_bot_ua("python-requests/2.31.0") is True)
    assert_("T2 真实 Chrome 不是爬虫", analytics.is_bot_ua(UA_CHROME_MAC) is False)

    # ---------------- T3 统计路径过滤（静态资源与看板轮询不计入 API 用量）----------------
    assert_("T3 /api/directions 计入统计", analytics.should_count("/api/directions") is True)
    assert_("T3 首页 / 计入统计", analytics.should_count("/") is True)
    assert_("T3 /static/app.js 不计入", analytics.should_count("/static/app.js") is False)
    assert_("T3 /api/stats 自身轮询不计入", analytics.should_count("/api/stats") is False)
    assert_("T3 /healthz 探活不计入", analytics.should_count("/healthz") is False)
    assert_("T3 /ws 长连接不计入 HTTP 用量（由 sessions 单独统计）",
            analytics.should_count("/ws") is False)

    # ---------------- T4 访客记录：新访客 / 回访 / 独立访客去重 ----------------
    v1, v2 = analytics.new_visitor_id(), analytics.new_visitor_id()
    assert_("T4 访客 ID 唯一且为 32 位 hex", v1 != v2 and len(v1) == 32)
    analytics.record_visit(v1, "203.0.113.5", UA_CHROME_MAC, "https://x.com", "/", True)
    analytics.record_visit(v1, "203.0.113.5", UA_CHROME_MAC, "", "/", False)   # 同一访客回访
    analytics.record_visit(v2, "198.51.100.9", UA_SAFARI_IPHONE, "", "/", True)
    analytics.record_visit(analytics.new_visitor_id(), "8.8.8.8", UA_GOOGLEBOT, "", "/", True)  # 爬虫

    s = analytics.get_stats(days=30)
    assert_("T4 PV 统计为 3（已排除爬虫）", s["totals"]["visits"] == 3, str(s["totals"]["visits"]))
    assert_("T4 独立访客为 2（同一 Cookie 回访不重复计人）",
            s["totals"]["unique_visitors"] == 2, str(s["totals"]["unique_visitors"]))
    assert_("T4 独立 IP 为 2", s["totals"]["unique_ips"] == 2, str(s["totals"]["unique_ips"]))
    assert_("T4 新访客数为 2", s["totals"]["new_visitors"] == 2, str(s["totals"]["new_visitors"]))
    assert_("T4 爬虫命中单独计数为 1", s["totals"]["bot_hits"] == 1, str(s["totals"]["bot_hits"]))
    assert_("T4 今日访问数同步", s["today"]["visits"] == 3 and s["today"]["unique_visitors"] == 2)

    sb = analytics.get_stats(days=30, include_bots=True)
    assert_("T4 开启含爬虫后 PV 变为 4", sb["totals"]["visits"] == 4, str(sb["totals"]["visits"]))

    # ---------------- T5 API 调用统计：次数 / 平均耗时 / 错误数 ----------------
    analytics.record_api_call("/api/directions", "GET", 200, 120.0, v1, "203.0.113.5", UA_CHROME_MAC)
    analytics.record_api_call("/api/directions", "GET", 200, 80.0, v1, "203.0.113.5", UA_CHROME_MAC)
    analytics.record_api_call("/api/directions", "GET", 400, 40.0, v2, "198.51.100.9", UA_SAFARI_IPHONE)
    analytics.record_api_call("/api/geo", "GET", 200, 300.0, v2, "198.51.100.9", UA_SAFARI_IPHONE)
    analytics.record_api_call("/api/geo", "GET", 200, 10.0, "", "8.8.8.8", UA_GOOGLEBOT)   # 爬虫调用

    s = analytics.get_stats(days=30)
    assert_("T5 API 总调用数为 4（排除爬虫）", s["totals"]["api_calls"] == 4, str(s["totals"]["api_calls"]))
    assert_("T5 API 错误数为 1", s["totals"]["api_errors"] == 1, str(s["totals"]["api_errors"]))
    eps = {e["endpoint"]: e for e in s["by_endpoint"]}
    assert_("T5 /api/directions 计 3 次", eps["/api/directions"]["calls"] == 3)
    assert_("T5 /api/directions 平均耗时为 80ms",
            abs(eps["/api/directions"]["avg_ms"] - 80.0) < 0.01, str(eps["/api/directions"]["avg_ms"]))
    assert_("T5 /api/geo 排除爬虫后计 1 次", eps["/api/geo"]["calls"] == 1)

    # ---------------- T6 Live 会话：模型 / 语音时长 / 轮次 / 打断 ----------------
    analytics.session_start(101, "203.0.113.5", UA_CHROME_MAC, v1)
    analytics.session_set_model(101, "models/gemini-3.8-live", "无")
    for _ in range(50):                                  # 50 帧 × 40ms = 2.0s 语音
        analytics.session_bump(101, "audio_frames")
    analytics.session_bump(101, "user_turns", 3)
    analytics.session_bump(101, "model_turns", 2)
    analytics.session_bump(101, "interrupts", 4)
    analytics.session_bump(101, "searches")
    analytics.record_tool_event(101, "start_navigation", {"destination": "义安城", "travel_mode": "DRIVING"})
    analytics.session_bump(101, "tool_calls")
    analytics.record_tool_event(101, "start_navigation", {"destination": "义安城", "travel_mode": "WALKING"})
    analytics.session_bump(101, "tool_calls")
    time.sleep(0.05)
    analytics.session_end(101)

    analytics.session_start(102, "198.51.100.9", UA_SAFARI_IPHONE, v2)
    analytics.session_set_model(102, "models/gemini-3.1-flash-live-preview")
    analytics.session_bump(102, "user_turns")
    analytics.record_tool_event(102, "start_navigation", {"destination": "滨海湾金沙"})
    analytics.session_bump(102, "tool_calls")
    analytics.session_end(102)

    analytics.session_start(103, "8.8.8.8", UA_GOOGLEBOT)      # 爬虫会话，应被过滤
    analytics.session_end(103)

    s = analytics.get_stats(days=30)
    tt = s["totals"]
    assert_("T6 会话总数为 2（排除爬虫会话）", tt["sessions"] == 2, str(tt["sessions"]))
    assert_("T6 语音时长换算正确 (50帧×40ms = 2s ≈ 0.0 分)",
            abs(tt["voice_minutes"] - round(2.0 / 60.0, 1)) < 0.01, str(tt["voice_minutes"]))
    assert_("T6 用户提问轮次累计为 4", tt["user_turns"] == 4, str(tt["user_turns"]))
    assert_("T6 模型回复轮次累计为 2", tt["model_turns"] == 2, str(tt["model_turns"]))
    assert_("T6 工具调用累计为 3", tt["tool_calls"] == 3, str(tt["tool_calls"]))
    assert_("T6 打断次数累计为 4", tt["interrupts"] == 4, str(tt["interrupts"]))
    assert_("T6 联网搜索累计为 1", tt["searches"] == 1, str(tt["searches"]))
    assert_("T6 会话时长为正数", tt["session_minutes"] >= 0 and tt["avg_session_s"] >= 0)

    models = {m["model"]: m for m in s["by_model"]}
    assert_("T6 3.8 Live 模型会话归类正确",
            models.get("models/gemini-3.8-live", {}).get("sessions") == 1, str(list(models)))
    assert_("T6 3.8 Live 打断数归类正确",
            models.get("models/gemini-3.8-live", {}).get("interrupts") == 4)
    assert_("T6 3.1 Live 模型会话归类正确",
            models.get("models/gemini-3.1-flash-live-preview", {}).get("sessions") == 1)

    # ---------------- T7 工具调用与热门目的地聚合 ----------------
    tools = {t["tool_name"]: t["count"] for t in s["top_tools"]}
    assert_("T7 start_navigation 工具调用合计 3 次", tools.get("start_navigation") == 3, str(tools))
    dests = {d["destination"]: d["count"] for d in s["top_destinations"]}
    assert_("T7 义安城为最热目的地（2 次）", dests.get("义安城") == 2, str(dests))
    assert_("T7 滨海湾金沙记录 1 次", dests.get("滨海湾金沙") == 1)
    assert_("T7 热门目的地按次数倒序", s["top_destinations"][0]["destination"] == "义安城")

    # ---------------- T8 地理位置回填（/geo 反查成功后补写历史记录）----------------
    analytics.cache_geo("203.0.113.5", "新加坡", "新加坡")
    s = analytics.get_stats(days=30)
    regions = {(r["country"], r["city"]): r for r in s["by_region"]}
    assert_("T8 地理位置成功回填至访客记录",
            regions.get(("新加坡", "新加坡"), {}).get("visits") == 2, str(list(regions)))
    sess_sg = [x for x in s["recent_sessions"] if x["city"] == "新加坡"]
    assert_("T8 地理位置同步回填至会话记录", len(sess_sg) == 1, str(len(sess_sg)))

    # ---------------- T9 设备与浏览器维度聚合 ----------------
    dev = {d["device"]: d["visits"] for d in s["by_device"]}
    assert_("T9 桌面访问 2 次、手机 1 次", dev.get("桌面") == 2 and dev.get("手机") == 1, str(dev))
    brw = {b["browser"]: b["visits"] for b in s["by_browser"]}
    assert_("T9 Chrome 2 次、Safari 1 次", brw.get("Chrome") == 2 and brw.get("Safari") == 1, str(brw))

    # ---------------- T10 每日趋势与明细列表 ----------------
    today = datetime.now().strftime("%Y-%m-%d")
    days = {d["day"]: d for d in s["by_day"]}
    assert_("T10 今日趋势含访问/会话/API 三条序列",
            days[today]["visits"] == 3 and days[today]["sessions"] == 2 and days[today]["api_calls"] == 4,
            str(days.get(today)))
    assert_("T10 最近访客明细返回 3 条且按时间倒序", len(s["recent_visitors"]) == 3)
    assert_("T10 访客明细含可读时间与短 ID",
            bool(s["recent_visitors"][0]["time"]) and len(s["recent_visitors"][0]["visitor_short"]) == 8)
    assert_("T10 最近会话明细返回 2 条", len(s["recent_sessions"]) == 2)
    assert_("T10 会话明细模型名已去掉 models/ 前缀",
            all(not x["model_short"].startswith("models/") for x in s["recent_sessions"]))

    # ---------------- T11 重复 session_start 不产生重复会话（断线重连幂等）----------------
    analytics.session_start(101, "203.0.113.5", UA_CHROME_MAC, v1)
    analytics.session_end(101)
    s = analytics.get_stats(days=30)
    assert_("T11 相同 client_id 重复开启仅保留一条会话", s["totals"]["sessions"] == 2,
            str(s["totals"]["sessions"]))

    # ---------------- T12 数据持久化：重连数据库后数据仍在 ----------------
    analytics._conn.close()
    analytics._conn = None
    s = analytics.get_stats(days=30)
    assert_("T12 SQLite 持久化生效，重连后数据不丢失",
            s["totals"]["visits"] == 3 and s["totals"]["sessions"] == 2)

    # ---------------- T13 时间范围过滤 ----------------
    s1 = analytics.get_stats(days=1)
    assert_("T13 单日范围仍可查到今日全部数据", s1["totals"]["visits"] == 3 and s1["range_days"] == 1)

    # ---------------- T14 互联网漏洞扫描器探测过滤 ----------------
    v_scan = analytics.new_visitor_id()
    analytics.record_visit(v_scan, "198.51.100.99", UA_CHROME_MAC, "", "/", True)
    analytics.record_api_call("/.env", "GET", 404, 1.0, v_scan, "198.51.100.99", UA_CHROME_MAC)
    analytics.record_api_call("/phpinfo.php", "GET", 404, 1.0, v_scan, "198.51.100.99", UA_CHROME_MAC)
    s_clean = analytics.get_stats(days=30, include_bots=False)
    eps_clean = {e["endpoint"] for e in s_clean["by_endpoint"]}
    assert_("T14 漏洞扫描 IP 被自动归为爬虫，不污染真实 PV", s_clean["totals"]["visits"] == 3,
            str(s_clean["totals"]["visits"]))
    assert_("T14 /.env 等 404 探测不进入 API 端点排行榜", "/.env" not in eps_clean and "/phpinfo.php" not in eps_clean)

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
