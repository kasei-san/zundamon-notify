#!/bin/bash
# PostToolUse Hook - PR URL検知・監視登録
# ツール出力からGitHub PR URLを検出し、PRモニターに登録する
# 非ブロッキング（fire-and-forget）

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからJSONを読み取り、PR URLを抽出して送信
INPUT=$(cat)

echo "$INPUT" | python3 -c "
import sys, json, re, uuid

data = json.load(sys.stdin)
session_id = data.get('session_id', 'default')

# tool_output または tool_result からテキストを取得
text = ''
if 'tool_output' in data:
    output = data['tool_output']
    if isinstance(output, str):
        text = output
    elif isinstance(output, dict):
        text = json.dumps(output)
elif 'tool_result' in data:
    result = data['tool_result']
    if isinstance(result, str):
        text = result
    elif isinstance(result, dict):
        text = json.dumps(result)

if not text:
    sys.exit(0)

# GitHub PR URLを抽出
urls = re.findall(r'https://github\.com/([^/\s]+)/([^/\s]+)/pull/(\d+)', text)

for owner, repo, number in urls:
    # プレースホルダURLをフィルタ
    if owner in ('owner', 'OWNER', 'example') or repo in ('repo', 'REPO', 'example'):
        continue

    url = f'https://github.com/{owner}/{repo}/pull/{number}'
    msg = {
        'type': 'pr_monitor',
        'id': str(uuid.uuid4()),
        'session_id': session_id,
        'url': url,
    }
    print(json.dumps(msg))
" 2>/dev/null | while IFS= read -r line; do
  echo "$line" | socat -t 1 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null &
done

exit 0
