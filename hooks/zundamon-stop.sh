#!/bin/bash
# Stop Hook - 入力待ち通知 + セッションタイトル動的更新
# Claude Codeが応答を完了し、入力待ちになったことを通知
# ANTHROPIC_API_KEY設定時はHaiku APIでタイトルを動的更新

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

# --- Haiku API でセッションタイトルを動的更新 ---

# ANTHROPIC_API_KEY が未設定なら何もしない
if [ -z "$ANTHROPIC_API_KEY" ]; then
  exit 0
fi

# transcript_path と session_id を抽出
TITLE_META=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('transcript_path', ''))
print(data.get('session_id', 'default'))
" 2>/dev/null)

TRANSCRIPT_PATH=$(echo "$TITLE_META" | head -1)
SESSION_ID=$(echo "$TITLE_META" | tail -1)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# transcript 末尾64KBを取得し、直近10メッセージ(user/assistant)を抽出
CONVERSATION=$(tail -c 65536 "$TRANSCRIPT_PATH" | python3 -c "
import sys, json

lines = sys.stdin.read().splitlines()
turns = []
for line in reversed(lines):
    line = line.strip()
    if not line:
        continue
    try:
        entry = json.loads(line)
    except Exception:
        continue
    role = entry.get('type', '')
    if role not in ('user', 'assistant'):
        continue
    msg = entry.get('message', {})
    content = msg.get('content', '') if isinstance(msg, dict) else ''
    text = ''
    if isinstance(content, str):
        text = content[:300]
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text':
                text = block.get('text', '')[:300]
                break
    if text.strip():
        turns.append(f'{role}: {text.strip()}')
    if len(turns) >= 10:
        break

turns.reverse()
print('\n'.join(turns))
" 2>/dev/null)

if [ -z "$CONVERSATION" ]; then
  exit 0
fi

# Haiku API 呼び出し（urllib.request使用、外部依存ゼロ）
HAIKU_RESPONSE=$(python3 -c "
import urllib.request, json, sys, os

api_key = os.environ.get('ANTHROPIC_API_KEY', '')
if not api_key:
    sys.exit(1)

conversation = sys.stdin.read()

payload = {
    'model': 'claude-haiku-4-5-20251001',
    'max_tokens': 50,
    'messages': [{
        'role': 'user',
        'content': f'以下はClaudeとユーザーの会話の末尾部分です。この会話のトピックを日本語で20文字以内で要約してください。記号・改行なしで名詞句のみ返してください。\n\n{conversation}'
    }]
}

req = urllib.request.Request(
    'https://api.anthropic.com/v1/messages',
    data=json.dumps(payload).encode(),
    headers={
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
    },
    method='POST'
)

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
        text = data.get('content', [{}])[0].get('text', '').strip()
        print(text[:20] if text else '')
except Exception:
    sys.exit(1)
" <<< "$CONVERSATION" 2>/dev/null)

if [ -z "$HAIKU_RESPONSE" ]; then
  exit 0
fi

# title_update メッセージを送信
TITLE_MSG=$(python3 -c "
import json, uuid, sys
title = sys.stdin.read().strip()
msg = {
    'type': 'title_update',
    'id': str(uuid.uuid4()),
    'session_id': '$SESSION_ID',
    'title': title
}
print(json.dumps(msg))
" <<< "$HAIKU_RESPONSE" 2>/dev/null)

if [ -n "$TITLE_MSG" ]; then
  echo "$TITLE_MSG" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null
fi

exit 0
