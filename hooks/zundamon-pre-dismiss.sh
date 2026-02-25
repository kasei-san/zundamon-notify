#!/bin/bash
# UserPromptSubmit/PreToolUse Hook - 非ブロッキング
# ユーザー入力時・ツール実行開始時に、残っている吹き出し（Stop等）をdismissする
# UserPromptSubmitではセッション作成も兼ねる（cwd, pid, transcript_pathを含める）

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからsession_id, cwd, transcript_pathを抽出
INPUT=$(cat)

MESSAGES=$(echo "$INPUT" | python3 -c "
import sys, json, os

TOOL_LABELS = {
    'Bash': 'コマンド実行中',
    'Read': 'ファイル読み中',
    'Edit': 'ファイル編集中',
    'Write': 'ファイル作成中',
    'Grep': 'コード検索中',
    'Glob': 'ファイル検索中',
    'Task': 'タスク実行中',
    'WebFetch': 'Web取得中',
    'WebSearch': 'Web検索中',
    'NotebookEdit': 'ノートブック編集中',
}

data = json.load(sys.stdin)
session_id = data.get('session_id', 'default')
cwd = data.get('cwd', '')
pid = int(os.environ.get('PPID', 0))

# dismiss メッセージ
dismiss = {
    'type': 'dismiss',
    'id': 'dismiss',
    'session_id': session_id,
    'cwd': cwd,
    'pid': pid
}
print(json.dumps(dismiss))

# status_update メッセージ（tool_nameがある場合 = PreToolUse）
tool_name = data.get('tool_name', '')
if tool_name:
    label = TOOL_LABELS.get(tool_name, tool_name)
    status = {
        'type': 'status_update',
        'id': 'status',
        'session_id': session_id,
        'message': label
    }
    print(json.dumps(status, ensure_ascii=False))
" 2>/dev/null)

# MESSAGESが空ならフォールバック（旧形式）
if [ -z "$MESSAGES" ]; then
  MESSAGES='{"type":"dismiss","id":"dismiss"}'
fi

echo "$MESSAGES" | socat -t 1 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
