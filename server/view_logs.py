#!/usr/bin/env python3
"""命令行快速查看与跟踪 maps-live 本地日志工具。

用法:
    python3 view_logs.py               # 查看最近 30 条日志
    python3 view_logs.py -n 100        # 查看最近 100 条日志
    python3 view_logs.py --tail        # 实时跟踪新日志 (类似 tail -f)
    python3 view_logs.py --nav         # 只看路线规划与导航事件
    python3 view_logs.py --tools       # 只看工具与函数调用
    python3 view_logs.py --errors      # 只看警告与错误
    python3 view_logs.py --json        # 以 JSON 格式输出结构化事件
"""
import os
import sys
import time
import re
import argparse
from datetime import datetime
from logger import TEXT_LOG_PATH, JSONL_LOG_PATH, get_recent_logs, get_recent_events

TS_REGEX = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\]")


def parse_timestamp(line: str):
    """解析日志行首的时间戳对象。"""
    m = TS_REGEX.match(line)
    if not m:
        return None
    raw = m.group(1)
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def format_and_colorize(line: str, prev_dt: datetime = None, show_delta: bool = False) -> tuple:
    """格式化日志行：突出显示时间戳与相对耗时 (+Δt)，并给各级别着色。"""
    cur_dt = parse_timestamp(line)
    delta_str = ""
    if show_delta and cur_dt and prev_dt:
        diff_ms = int((cur_dt - prev_dt).total_seconds() * 1000)
        if diff_ms < 1000:
            delta_str = f" \033[90m(+{diff_ms}ms)\033[0m"
        else:
            delta_str = f" \033[90m(+{diff_ms / 1000:.2f}s)\033[0m"
    elif show_delta and cur_dt:
        delta_str = " \033[90m(----)\033[0m"

    # 高亮时间戳前缀
    m = TS_REGEX.match(line)
    if m:
        ts_part = m.group(0)
        rest = line[len(ts_part):]
        # 时间戳用青色/灰色高亮显示
        ts_styled = f"\033[36m{ts_part}\033[0m{delta_str}"
    else:
        ts_styled = ""
        rest = line

    # 针对不同事件和错误级别着色 rest 部分
    if "[ERROR]" in rest:
        rest_styled = f"\033[31;1m{rest}\033[0m"
    elif "[WARN]" in rest or "[WARNING]" in rest:
        rest_styled = f"\033[33;1m{rest}\033[0m"
    elif "[TOOL_CALL]" in rest or "[TOOL_RESP]" in rest:
        rest_styled = f"\033[35;1m{rest}\033[0m"
    elif "[NAVIGATION]" in rest:
        rest_styled = f"\033[32;1m{rest}\033[0m"
    elif "[VOICE]" in rest:
        rest_styled = f"\033[35m{rest}\033[0m"
    elif "[MODEL_TURN]" in rest:
        rest_styled = f"\033[36m{rest}\033[0m"
    elif "[USER_INPUT]" in rest:
        rest_styled = f"\033[32m{rest}\033[0m"
    elif "[MODEL_OUTPUT]" in rest:
        rest_styled = f"\033[34m{rest}\033[0m"
    elif "[WS_CONN]" in rest:
        rest_styled = f"\033[33m{rest}\033[0m"
    else:
        rest_styled = rest

    formatted = f"{ts_styled}{rest_styled}" if ts_styled else rest_styled
    return formatted, (cur_dt or prev_dt)


def main():
    parser = argparse.ArgumentParser(description="查看 maps-live 本地日志 (带完整日期与毫秒时间戳)")
    parser.add_argument("-n", "--limit", type=int, default=30, help="显示最近多少条 (默认 30)")
    parser.add_argument("-f", "--tail", action="store_true", help="实时跟踪 (类似 tail -f)")
    parser.add_argument("-d", "--delta", action="store_true", help="显示与上一行日志的时间差 (+Δt)")
    parser.add_argument("--nav", action="store_true", help="仅显示导航路线相关")
    parser.add_argument("--tools", action="store_true", help="仅显示工具与 Function Call")
    parser.add_argument("--voice", action="store_true", help="仅显示全双工语音相关")
    parser.add_argument("--errors", action="store_true", help="仅显示错误与警告")
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON 格式")
    args = parser.parse_args()

    category = None
    if args.nav:
        category = "NAVIGATION"
    elif args.tools:
        category = "TOOL_CALL"
    elif args.voice:
        category = "VOICE"
    
    level = "WARN" if args.errors else None

    if args.json:
        events = get_recent_events(limit=args.limit, category=category)
        import json
        print(json.dumps(events, indent=2, ensure_ascii=False))
        return

    lines = get_recent_logs(limit=args.limit, category=category, level=level)
    print(f"\n===== maps-live 本地日志 (最近 {len(lines)} 条) [{TEXT_LOG_PATH}] =====")
    last_dt = None
    for l in lines:
        formatted, last_dt = format_and_colorize(l, prev_dt=last_dt, show_delta=args.delta)
        print(formatted)
    print("=" * 60)

    if args.tail:
        print("正在实时跟踪日志更新 (按 Ctrl+C 退出)...")
        if not os.path.exists(TEXT_LOG_PATH):
            print("等待日志文件创建...")
        while not os.path.exists(TEXT_LOG_PATH):
            time.sleep(0.5)
        tail_dt = None
        with open(TEXT_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            f.seek(0, os.SEEK_END)
            try:
                while True:
                    line = f.readline()
                    if line:
                        s = line.rstrip("\r\n")
                        if category and f"[{category}]" not in s:
                            continue
                        if level and f"[{level}]" not in s and "[ERROR]" not in s:
                            continue
                        formatted, tail_dt = format_and_colorize(s, prev_dt=tail_dt, show_delta=args.delta)
                        print(formatted, flush=True)
                    else:
                        time.sleep(0.2)
            except KeyboardInterrupt:
                print("\n已退出跟踪。")


if __name__ == "__main__":
    main()
