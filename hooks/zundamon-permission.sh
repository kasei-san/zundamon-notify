#!/bin/bash
# PermissionRequest Hook - ブロッキング
# stdinからJSON読み取り → UDS経由でアプリに送信 → レスポンス待ち → Claude Code用JSON出力

SOCKET_PATH="/tmp/zundamon-claude.sock"
TIMEOUT=590  # Claude Codeの600秒タイムアウトより短く

# ソケットが存在しなければフォールバック（アプリ未起動）
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからhookデータを読み取り
INPUT=$(cat)

# hookデータからtool_name, tool_input, descriptionを抽出
# Claude Code hookのstdinはトップレベルにtool_name, tool_inputがある
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('tool_input',{})))" 2>/dev/null)
DESCRIPTION=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); ti=d.get('tool_input',{}); print(ti.get('command','') or ti.get('description','') or str(ti)[:200])" 2>/dev/null)

# UUIDを生成
ID=$(python3 -c "import uuid; print(uuid.uuid4())")

# UDS経由でアプリに送信し、レスポンスを待つ
REQUEST=$(python3 -c "
import json
req = {
    'type': 'permission_request',
    'id': '$ID',
    'tool_name': '$TOOL_NAME',
    'tool_input': json.loads('$TOOL_INPUT' or '{}'),
    'description': '''$DESCRIPTION'''
}
print(json.dumps(req))
" 2>/dev/null)

RESPONSE=$(echo "$REQUEST" | socat -t "$TIMEOUT" - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null)

# レスポンスが空（タイムアウトやエラー）ならフォールバック
if [ -z "$RESPONSE" ]; then
  exit 0
fi

# レスポンスからdecisionを抽出
DECISION=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision',''))" 2>/dev/null)

if [ "$DECISION" = "allow" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
elif [ "$DECISION" = "deny" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"ずんだもんが拒否したのだ"}}}'
else
  # 不明なレスポンスはフォールバック
  exit 0
fi
