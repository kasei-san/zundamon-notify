#!/bin/bash
# Notification Hook - Fire and Forget
# Claude Codeからの通知をずんだもんアプリに送信

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからhookデータを読み取り、Pythonで安全にパースしてUDSリクエストJSON生成
INPUT=$(cat)

REQUEST=$(echo "$INPUT" | python3 -c "
import sys, json, uuid, os

data = json.load(sys.stdin)
message = data.get('message', '') or 'Claude Codeからの通知なのだ'

# 不要な通知をフィルタリング
# permission_prompt由来の通知はPermissionRequest hookで処理済みのためスキップ
# Stop hook由来の入力待ち通知はStop hookで処理済みのためスキップ
for skip in ['Claude needs your permission', 'Claude is waiting for your input']:
    if skip in message:
        sys.exit(1)

req = {
    'type': 'notification',
    'id': str(uuid.uuid4()),
    'session_id': data.get('session_id', 'default'),
    'cwd': data.get('cwd', ''),
    'pid': os.getppid(),
    'message': message
}
print(json.dumps(req))
" 2>/dev/null)

# REQUESTが空（パースエラーまたはスキップ）ならフォールバック
if [ -z "$REQUEST" ]; then
  exit 0
fi

echo "$REQUEST" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
