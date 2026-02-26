#!/usr/bin/env python3
"""
codex CLIによるPermissionリクエスト自動リスク判定。
環境変数 ZUNDAMON_HOOK_DATA から hook の生JSONを受け取り、
codex でリスク判定を行う。

exit 0 + stdout "SAFE" → 自動許可
exit 1 → 従来フロー（Electron通知）に進む
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "zundamon-notify" / "config.json"
DEFAULT_LOG_PATH = Path.home() / ".config" / "zundamon-notify" / "auto-approve.log"


def load_config():
    """設定ファイルを読み込む。未存在やパースエラー時はNone。"""
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_log(log_path, entry):
    """JSON Lines形式でログを追記。"""
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def build_prompt(tool_name, tool_input, cwd, description):
    """codex に渡すリスク判定プロンプトを生成。"""
    tool_input_str = json.dumps(tool_input, ensure_ascii=False)[:500]
    return f"""You are a security risk assessor for CLI tool executions.
Evaluate the following tool execution and respond with EXACTLY one word: "SAFE" or "RISK".

Rules for RISK:
- AWS/GCP/Azure destructive operations (delete, terminate, destroy, etc.)
- terraform apply/destroy
- git push --force, git reset --hard
- rm -rf, mass deletion
- sudo operations, sending secrets externally
- DB DROP/TRUNCATE
- curl/wget posting data to external URLs
- Package install with suspicious sources

Rules for SAFE:
- File reading (cat, head, tail, less, Read, Grep, Glob)
- Git read operations (status, log, diff, branch)
- ls, pwd, find (without deletion)
- Code editing (Edit, Write)
- Test execution, lint, format
- npm test, npm run build
- echo, printf (local only)

When in doubt, respond "RISK".

Tool: {tool_name}
Input: {tool_input_str}
Working directory: {cwd}
Description: {description}

Your assessment (one word only):"""


def judge_with_codex(prompt):
    """codex CLIでリスク判定を実行。タイムアウトやエラー時はNone。"""
    codex_path = shutil.which("codex")
    if not codex_path:
        return None

    try:
        result = subprocess.run(
            ["perl", "-e", "alarm 10; exec @ARGV", codex_path, "exec", "--ephemeral", "-"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            output = result.stdout.strip()
            # 最終行から判定結果を取得
            lines = output.split("\n")
            last_line = lines[-1].strip().upper() if lines else ""
            if last_line == "SAFE":
                return "SAFE"
            elif last_line == "RISK":
                return "RISK"
        return None
    except Exception:
        return None


def main():
    # 環境変数からhookデータを取得
    hook_data_str = os.environ.get("ZUNDAMON_HOOK_DATA")
    if not hook_data_str:
        sys.exit(1)

    try:
        data = json.loads(hook_data_str)
    except json.JSONDecodeError:
        sys.exit(1)

    # 設定ファイル読み込み
    config = load_config()
    if not config:
        sys.exit(1)

    auto_approve = config.get("auto_approve", {})
    if not auto_approve.get("enabled", False):
        sys.exit(1)

    # codexがインストールされているか確認
    if not shutil.which("codex"):
        sys.exit(1)

    # hookデータからツール情報を抽出
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    cwd = data.get("cwd", "")
    description = tool_input.get("command", "") or tool_input.get("description", "") or str(tool_input)[:200]
    session_id = data.get("session_id", "default")

    # codexでリスク判定
    prompt = build_prompt(tool_name, tool_input, cwd, description)
    result = judge_with_codex(prompt)

    if result == "SAFE":
        # ログ記録
        log_path_str = auto_approve.get("log_file", "")
        if log_path_str:
            log_path = Path(log_path_str).expanduser()
        else:
            log_path = DEFAULT_LOG_PATH

        write_log(log_path, {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "tool_name": tool_name,
            "description": description,
            "cwd": cwd,
            "session_id": session_id,
        })

        print("SAFE")
        sys.exit(0)

    # RISK or エラー → 従来フローへ
    sys.exit(1)


if __name__ == "__main__":
    main()
