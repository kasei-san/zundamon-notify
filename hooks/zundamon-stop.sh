#!/bin/bash
# Stop Hook - 入力待ち通知
# Claude Codeが応答を完了し、入力待ちになったことを通知

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

ID=$(python3 -c "import uuid; print(uuid.uuid4())")

REQUEST="{\"type\":\"stop\",\"id\":\"$ID\",\"message\":\"入力を待っているのだ！\"}"

echo "$REQUEST" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
