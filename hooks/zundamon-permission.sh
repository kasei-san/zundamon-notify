#!/bin/bash
# PermissionRequest Hook - ブロッキング
# stdinからJSON読み取り → UDS経由でアプリに送信 → レスポンス待ち → Claude Code用JSON出力

SOCKET_PATH="/tmp/zundamon-claude.sock"
TIMEOUT=590  # Claude Codeの600秒タイムアウトより短く

# ソケットが存在しなければフォールバック（アプリ未起動）
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからhookデータを読み取り、Pythonで安全にパースしてUDSリクエストJSON生成
# シェル変数展開を経由しないのでエスケープ問題が起きない
REQUEST=$(python3 -c "
import sys, json, uuid

data = json.load(sys.stdin)
tool_input = data.get('tool_input', {})
description = tool_input.get('command', '') or tool_input.get('description', '') or str(tool_input)[:200]

req = {
    'type': 'permission_request',
    'id': str(uuid.uuid4()),
    'tool_name': data.get('tool_name', ''),
    'tool_input': tool_input,
    'description': description
}
suggestions = data.get('permission_suggestions')
if suggestions:
    req['permission_suggestions'] = suggestions
print(json.dumps(req))
" 2>/dev/null)

# REQUESTが空ならフォールバック
if [ -z "$REQUEST" ]; then
  exit 0
fi

# UDS経由でアプリに送信し、レスポンスを待つ
RESPONSE=$(echo "$REQUEST" | socat -t "$TIMEOUT" - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null)

# レスポンスが空（タイムアウトやエラー）ならフォールバック
if [ -z "$RESPONSE" ]; then
  exit 0
fi

# レスポンスをPython3でパースし、Claude Code用JSON出力を生成
echo "$RESPONSE" | python3 -c "
import sys, json

resp = json.load(sys.stdin)
decision = resp.get('decision', '')

if decision == 'allow':
    output = {'behavior': 'allow'}
    updated = resp.get('updatedPermissions')
    if updated:
        output['updatedPermissions'] = updated
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': output}}))
elif decision == 'deny':
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {'behavior': 'deny', 'message': 'ずんだもんが拒否したのだ'}}}))
else:
    sys.exit(0)
" 2>/dev/null || exit 0
