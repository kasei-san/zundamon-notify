#!/bin/bash
# Stop Hook - 入力待ち通知
# Claude Codeが応答を完了し、入力待ちになったことを通知

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからhookデータを読み取り、Pythonで安全にパース
INPUT=$(cat)

REQUEST=$(echo "$INPUT" | python3 -c "
import sys, json, uuid, os

data = json.load(sys.stdin)
req = {
    'type': 'stop',
    'id': str(uuid.uuid4()),
    'session_id': data.get('session_id', 'default'),
    'cwd': data.get('cwd', ''),
    'pid': os.getppid(),
    'message': '入力を待っているのだ！',
    'transcript_path': data.get('transcript_path', '')
}
print(json.dumps(req))
" 2>/dev/null)

# REQUESTが空ならフォールバック（旧形式）
if [ -z "$REQUEST" ]; then
  ID=$(python3 -c "import uuid; print(uuid.uuid4())")
  REQUEST="{\"type\":\"stop\",\"id\":\"$ID\",\"message\":\"入力を待っているのだ！\"}"
fi

echo "$REQUEST" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
