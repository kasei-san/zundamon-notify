#!/bin/bash
# Stop Hook - 入力待ち通知
# Claude Codeが応答を完了し、入力待ちになったことを通知
# codex CLIがインストールされている場合、最後の出力を要約して表示

SOCKET_PATH="/tmp/zundamon-claude.sock"

# ソケットが存在しなければ何もしない
if [ ! -S "$SOCKET_PATH" ]; then
  exit 0
fi

# stdinからhookデータを読み取り
INPUT=$(cat)

# 一時Pythonスクリプトを作成（heredocでstdinを奪わないため）
PYSCRIPT=$(mktemp /tmp/zundamon-stop-XXXXXX.py)
trap 'rm -f "$PYSCRIPT"' EXIT

cat > "$PYSCRIPT" << 'PYEOF'
import sys, json, uuid, os, shutil, subprocess

DEFAULT_MESSAGE = "入力を待っているのだ！"

data = json.loads(os.environ["ZUNDAMON_INPUT"])

# stop_hook_active が true なら無限ループ防止のためスキップ
if data.get("stop_hook_active"):
    sys.exit(1)

session_id = data.get("session_id", "default")
cwd = data.get("cwd", "")
pid = os.getppid()
last_msg = (data.get("last_assistant_message") or "")[:1000]

message = DEFAULT_MESSAGE

# codex CLIがインストールされていて、last_assistant_messageがある場合は要約
if last_msg:
    codex_path = shutil.which("codex")
    if codex_path:
        try:
            prompt = f"以下の文章を30文字以内のずんだもん口調（〜のだ）で要約して。ユーザーへの質問や確認事項がある場合はその内容を最優先で出して。余計な説明は不要で、要約文だけ出力して: '{last_msg}'"
            result = subprocess.run(
                ["perl", "-e", "alarm 10; exec @ARGV", codex_path, "exec", "--ephemeral", "-"],
                input=prompt, capture_output=True, text=True, timeout=15
            )
            if result.returncode == 0:
                lines = result.stdout.strip().split("\n")
                summary = lines[-1].strip() if lines else ""
                if summary:
                    message = summary
        except Exception:
            pass

req = {
    "type": "stop",
    "id": str(uuid.uuid4()),
    "session_id": session_id,
    "cwd": cwd,
    "pid": pid,
    "message": message,
}
print(json.dumps(req, ensure_ascii=False))
PYEOF

REQUEST=$(ZUNDAMON_INPUT="$INPUT" python3 "$PYSCRIPT" 2>/dev/null)

# REQUESTが空ならフォールバック（旧形式）
if [ -z "$REQUEST" ]; then
  ID=$(python3 -c "import uuid; print(uuid.uuid4())")
  REQUEST="{\"type\":\"stop\",\"id\":\"$ID\",\"message\":\"入力を待っているのだ！\"}"
fi

echo "$REQUEST" | socat -t 2 - UNIX-CONNECT:"$SOCKET_PATH" 2>/dev/null

exit 0
