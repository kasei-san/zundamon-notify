#!/bin/bash
# Notification Hook - Fire and Forget
# Claude Codeからの通知をずんだもんアプリに送信

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからhookデータを読み取り
INPUT=$(cat)

ID=$(python3 -c "import uuid; print(uuid.uuid4())")
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','') or 'Claude Codeからの通知なのだ')" 2>/dev/null)

REQUEST=$(python3 -c "
import json
req = {'type': 'notification', 'id': '$ID', 'message': '''$MESSAGE'''}
print(json.dumps(req))
" 2>/dev/null)

echo "$REQUEST" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
