#!/bin/bash
# Codex CLI notify hook - 入力待ち通知
# Codex CLIがagent-turn-completeイベントを発火した時にずんだもん通知を表示
# Claude Code hookと異なり、JSONは$1（第1引数）で渡される

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# 第1引数からJSONを取得
INPUT="$1"

if [ -z "$INPUT" ]; then
  exit 0
fi

# Python3でJSONをパースしてUDSメッセージを生成
MESSAGE=$(python3 -c "
import json, sys, uuid, os

try:
    data = json.loads(sys.argv[1])
except (json.JSONDecodeError, IndexError):
    sys.exit(1)

# agent-turn-complete以外は無視
if data.get('type') != 'agent-turn-complete':
    sys.exit(0)

cwd = data.get('cwd', '')
basename = os.path.basename(cwd) if cwd else 'unknown'
session_id = f'codex-{basename}'

req = {
    'type': 'stop',
    'id': str(uuid.uuid4()),
    'session_id': session_id,
    'cwd': cwd,
    'pid': 0,
    'message': 'Codexが入力を待っているのだ！',
}
print(json.dumps(req, ensure_ascii=False))
" "$INPUT" 2>/dev/null)

if [ -z "$MESSAGE" ]; then
  exit 0
fi

echo "$MESSAGE" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
