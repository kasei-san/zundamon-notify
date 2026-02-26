#!/bin/bash
# PermissionRequest Hook - ブロッキング
# stdinからJSON読み取り → UDS経由でアプリに送信 → レスポンス待ち → Claude Code用JSON出力

SOCKET_PATH="/tmp/zundamon-claude.sock"
TIMEOUT=590  # Claude Codeの600秒タイムアウトより短く

# シグナルハンドラ: プロセスグループごとkillしてsocat子プロセスの孤立を防ぐ
# コンソール側で許可/拒否された場合、Claude Codeがこのスクリプトにシグナルを送る
trap 'kill 0 2>/dev/null; exit 0' TERM INT

# ソケットが存在しなければフォールバック（アプリ未起動）
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinを変数に保存（Python3とauto-approve.pyの両方で使うため）
INPUT=$(cat)

# stdinからhookデータを読み取り、Pythonで安全にパースしてUDSリクエストJSON生成
# シェル変数展開を経由しないのでエスケープ問題が起きない
REQUEST=$(echo "$INPUT" | python3 -c "
import sys, json, uuid, os

data = json.load(sys.stdin)
tool_input = data.get('tool_input', {})
description = tool_input.get('command', '') or tool_input.get('description', '') or str(tool_input)[:200]

req = {
    'type': 'permission_request',
    'id': str(uuid.uuid4()),
    'session_id': data.get('session_id', 'default'),
    'cwd': data.get('cwd', ''),
    'pid': os.getppid(),
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

# codexによる自動リスク判定（設定で有効化されている場合のみ）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTO_RESULT=$(ZUNDAMON_HOOK_DATA="$INPUT" python3 "$SCRIPT_DIR/auto-approve.py" 2>/dev/null)
if [ "$AUTO_RESULT" = "SAFE" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
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
