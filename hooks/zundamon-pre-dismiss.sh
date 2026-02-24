#!/bin/bash
# UserPromptSubmit/PreToolUse Hook - 非ブロッキング
# ユーザー入力時・ツール実行開始時に、残っている吹き出し（Stop等）をdismissする

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからsession_idを抽出
INPUT=$(cat)

REQUEST=$(echo "$INPUT" | python3 -c "
import sys, json

data = json.load(sys.stdin)
req = {
    'type': 'dismiss',
    'id': 'dismiss',
    'session_id': data.get('session_id', 'default')
}
print(json.dumps(req))
" 2>/dev/null)

# REQUESTが空ならフォールバック（旧形式）
if [ -z "$REQUEST" ]; then
  REQUEST='{"type":"dismiss","id":"dismiss"}'
fi

echo "$REQUEST" | socat -t 1 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
