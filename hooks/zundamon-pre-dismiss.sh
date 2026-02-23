#!/bin/bash
# UserPromptSubmit Hook - 非ブロッキング
# ユーザー入力時に、残っている吹き出し（Stop等）をdismissする

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# dismissメッセージを送信（レスポンス不要）
echo '{"type":"dismiss","id":"dismiss"}' | socat -t 1 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
