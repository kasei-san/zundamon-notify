#!/bin/bash
# SessionEnd Hook - セッション終了通知
# Claude Codeセッション終了時にずんだもんウィンドウを閉じる

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからsession_idを抽出
INPUT=$(cat)

REQUEST=$(echo "$INPUT" | python3 -c "
import sys, json, uuid

data = json.load(sys.stdin)
req = {
    'type': 'session_end',
    'id': str(uuid.uuid4()),
    'session_id': data.get('session_id', 'default')
}
print(json.dumps(req))
" 2>/dev/null)

# REQUESTが空ならフォールバック
if [ -z "$REQUEST" ]; then
  exit 0
fi

echo "$REQUEST" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
