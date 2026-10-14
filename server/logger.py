#!/usr/bin/env python3
"""maps-live 本地日志系统模块。

提供文件持久化轮转日志 (maps_live.log) 与结构化事件流 (events.jsonl)，
记录用户会话、输入识别、大模型回复、工具调用 (Function Call)、导航路由与前端遥测事件，
方便本地排查问题与回放验证。
"""
import os
import sys
import time
import json
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(HERE, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

TEXT_LOG_PATH = os.path.join(LOG_DIR, "maps_live.log")
JSONL_LOG_PATH = os.path.join(LOG_DIR, "events.jsonl")

# 文本日志 Handler（10MB 轮转，保留 5 份备份）
logger = logging.getLogger("maps_live")
logger.setLevel(logging.INFO)
logger.propagate = False

class MillisecondFormatter(logging.Formatter):
    def formatTime(self, record, datefmt=None):
        ct = self.converter(record.created)
        t = time.strftime("%Y-%m-%d %H:%M:%S", ct)
        return f"{t}.{int(record.msecs):03d}"

if not logger.handlers:
    file_handler = RotatingFileHandler(
        TEXT_LOG_PATH, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    formatter = MillisecondFormatter("[%(asctime)s] [%(levelname)s] %(message)s")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)


def _append_jsonl(event_data: dict):
    """追加写入一行结构化 JSON 数据。"""
    try:
        with open(JSONL_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(event_data, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.warning(f"Failed to write events.jsonl: {e}")


def log_event(category: str, message: str, level: str = "INFO", client_id=None, extra: dict = None):
    """统一日志记录入口。"""
    cid_str = f"[client #{client_id}] " if client_id is not None else ""
    log_line = f"[{category}] {cid_str}{message}"
    
    lvl = level.upper()
    if lvl == "DEBUG":
        logger.debug(log_line)
    elif lvl == "WARN" or lvl == "WARNING":
        logger.warning(log_line)
    elif lvl == "ERROR":
        logger.error(log_line)
    else:
        logger.info(log_line)

    now = datetime.now()
    now_ms = int(now.timestamp() * 1000)
    record = {
        "timestamp": now.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
        "ts_ms": now_ms,
        "iso": now.isoformat(),
        "category": category,
        "level": lvl,
        "client_id": client_id,
        "message": message,
        "extra": extra or {}
    }
    _append_jsonl(record)


def log_user_msg(client_id, text: str, source: str = "client"):
    """记录用户输入（语音识别或文本输入）。"""
    log_event("USER_INPUT", f"用户输入 ({source}): {text}", level="INFO", client_id=client_id, extra={"text": text, "source": source})


def log_model_msg(client_id, text: str, is_final: bool = False):
    """记录模型回复内容。"""
    status = "最终转录完成" if is_final else "流式回复片段"
    log_event("MODEL_OUTPUT", f"模型回复 [{status}]: {text}", level="INFO", client_id=client_id, extra={"text": text, "is_final": is_final})


def log_tool_call(client_id, name: str, args: dict):
    """记录模型触发的 Function Call / Tool Call。"""
    args_str = json.dumps(args, ensure_ascii=False)
    log_event("TOOL_CALL", f"函数调用触发: {name}(args={args_str})", level="INFO", client_id=client_id, extra={"tool_name": name, "args": args})


def log_tool_resp(client_id, name: str, resp: dict):
    """记录客户端给模型的 Tool Response。"""
    resp_str = json.dumps(resp, ensure_ascii=False)
    log_event("TOOL_RESP", f"函数返回下发: {name} => {resp_str}", level="INFO", client_id=client_id, extra={"tool_name": name, "resp": resp})


def log_navigation(client_id, origin: str, dest: str, mode: str, dist_km=None, dur_min=None, status="OK", error=None):
    """记录路线规划请求与计算结果。"""
    lvl = "WARN" if (error or status != "OK") else "INFO"
    detail = f"起点='{origin}', 终点='{dest}', 方式={mode}, 状态={status}"
    if dist_km is not None:
        detail += f", 距离={dist_km:.2f}km"
    if dur_min is not None:
        detail += f", 耗时={dur_min:.1f}分钟"
    if error:
        detail += f", 异常={error}"
    log_event("NAVIGATION", f"路线规划: {detail}", level=lvl, client_id=client_id, extra={
        "origin": origin, "destination": dest, "travel_mode": mode,
        "distance_km": dist_km, "duration_min": dur_min, "status": status, "error": error
    })


def log_client_telemetry(data: dict):
    """记录前端通过 HTTP /api/logs 上报的事件。"""
    category = data.get("category", "CLIENT_EVENT")
    level = data.get("level", "INFO")
    msg = data.get("message", "")
    client_id = data.get("client_id")
    extra = data.get("extra")
    log_event(category, f"前端上报: {msg}", level=level, client_id=client_id, extra=extra)


def get_recent_logs(limit: int = 100, category: str = None, level: str = None) -> list:
    """获取最近的日志文本行。"""
    if not os.path.exists(TEXT_LOG_PATH):
        return []
    try:
        with open(TEXT_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        matched = []
        for line in reversed(lines):
            if category and f"[{category}]" not in line:
                continue
            if level and f"[{level.upper()}]" not in line:
                continue
            matched.append(line.rstrip("\r\n"))
            if len(matched) >= limit:
                break
        return list(reversed(matched))
    except Exception as e:
        return [f"读取日志失败: {e}"]


def get_recent_events(limit: int = 100, category: str = None) -> list:
    """从 jsonl 获取最近的结构化事件列表。"""
    if not os.path.exists(JSONL_LOG_PATH):
        return []
    events = []
    try:
        with open(JSONL_LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
                if category and ev.get("category") != category:
                    continue
                events.append(ev)
                if len(events) >= limit:
                    break
            except json.JSONDecodeError:
                continue
        return list(reversed(events))
    except Exception as e:
        return [{"error": f"读取事件失败: {e}"}]
