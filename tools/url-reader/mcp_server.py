#!/usr/bin/env python3
"""read_url 을 Claude Desktop / Claude Code 에서 쓰는 MCP 도구로 노출하는 stdio 서버.

외부 패키지 없이 JSON-RPC(줄 단위)만 구현한 최소 서버다.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from read_url import read_url  # noqa: E402

TOOL = {
    "name": "read_url",
    "description": (
        "웹페이지 URL의 본문을 마크다운 텍스트로 읽어온다. 네이버 블로그(m.blog.naver.com, "
        "blog.naver.com)처럼 일반 웹 가져오기로 안 읽히는 페이지도 읽을 수 있다. "
        "사용자가 URL을 주면 캡처/PDF를 요구하지 말고 이 도구를 먼저 써라."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "읽을 페이지 주소"},
            "max_chars": {"type": "integer", "description": "본문 최대 글자 수 (선택)"},
        },
        "required": ["url"],
    },
}


def handle(msg):
    method = msg.get("method")
    params = msg.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "url-reader", "version": "1.0.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method == "tools/call":
        args = params.get("arguments") or {}
        try:
            text = read_url(args["url"], args.get("max_chars"))
            return {"content": [{"type": "text", "text": text}]}
        except Exception as e:  # noqa: BLE001 - 오류도 도구 결과로 돌려준다
            return {"content": [{"type": "text", "text": str(e)}], "isError": True}
    raise KeyError(method)


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        if "id" not in msg:  # notification (예: notifications/initialized)
            continue
        try:
            reply = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg)}
        except KeyError:
            reply = {"jsonrpc": "2.0", "id": msg["id"],
                     "error": {"code": -32601, "message": f"Method not found: {msg.get('method')}"}}
        sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
