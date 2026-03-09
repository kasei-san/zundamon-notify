#!/usr/bin/env python3
"""
codex CLIによるPermissionリクエスト自動リスク判定。
環境変数 ZUNDAMON_HOOK_DATA から hook の生JSONを受け取り、
codex でリスク判定を行う。

exit 0 + stdout "SAFE\t概要テキスト" → 自動許可（概要を吹き出し表示）
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


MAX_LOG_SIZE = 512 * 1024  # 512KB
KEEP_LINES = 500  # ローテート後に残す行数


def rotate_log_if_needed(log_path):
    """ログファイルがMAX_LOG_SIZEを超えたら最新KEEP_LINES行だけ残す。"""
    try:
        if not log_path.exists() or log_path.stat().st_size <= MAX_LOG_SIZE:
            return
        lines = log_path.read_text().splitlines()
        log_path.write_text("\n".join(lines[-KEEP_LINES:]) + "\n")
    except Exception:
        pass


def write_log(log_path, entry):
    """JSON Lines形式でログを追記。サイズ超過時は自動ローテート。"""
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        rotate_log_if_needed(log_path)
        with open(log_path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def build_prompt(tool_name, tool_input, cwd, description, custom_rules=None):
    """codex に渡すリスク判定プロンプトを生成。"""
    tool_input_str = json.dumps(tool_input, ensure_ascii=False)[:500]

    custom_rules_section = ""
    if custom_rules:
        rules_text = "\n".join(f"- {rule}" for rule in custom_rules)
        custom_rules_section = f"""

Additional user-defined rules (these take priority over the rules above):
{rules_text}"""

    return f"""You are a security risk assessor for CLI tool executions.
Evaluate the following tool execution and respond in this EXACT format:
SAFE: <20-30文字の日本語でコマンド概要>
or
RISK: <20-30文字の日本語でコマンド概要>

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

When in doubt, respond "RISK".{custom_rules_section}

概要はずんだもん口調（〜のだ）で書いてください。例:
- SAFE: ファイル一覧を確認するのだ
- SAFE: gitの差分を見るのだ
- RISK: ファイルを全削除するのだ

Tool: {tool_name}
Input: {tool_input_str}
Working directory: {cwd}
Description: {description}

Your assessment (SAFE or RISK with summary):"""


def judge_with_codex(prompt):
    """codex CLIでリスク判定を実行。(判定, 概要)のタプルを返す。エラー時は(None, None)。"""
    codex_path = shutil.which("codex")
    if not codex_path:
        return None, None

    debug_log = Path.home() / ".config" / "zundamon-notify" / "auto-approve-debug.log"
    try:
        result = subprocess.run(
            ["perl", "-e", "alarm 10; exec @ARGV", codex_path, "exec", "--ephemeral", "-"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=15,
        )
        # デバッグログ出力
        write_log(debug_log, {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "codex_path": codex_path,
            "returncode": result.returncode,
            "stdout": result.stdout[:500],
            "stderr": result.stderr[:500],
        })
        if result.returncode == 0:
            output = result.stdout.strip()
            # 全行をスキャンしてSAFE/RISKで始まる行を探す（最後に見つかったものを採用）
            lines = output.split("\n")
            judgment = None
            summary = ""
            for line in lines:
                stripped = line.strip()
                upper = stripped.upper()
                if upper.startswith("SAFE"):
                    judgment = "SAFE"
                    summary = stripped.split(":", 1)[1].strip() if ":" in stripped else stripped[4:].lstrip()
                elif upper.startswith("RISK"):
                    judgment = "RISK"
                    summary = stripped.split(":", 1)[1].strip() if ":" in stripped else stripped[4:].lstrip()
            if judgment:
                return judgment, summary
        return None, None
    except Exception as e:
        write_log(debug_log, {"timestamp": datetime.now(timezone.utc).isoformat(), "exception": str(e)})
        return None, None


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

    # カスタムルールの取得
    custom_rules = auto_approve.get("custom_rules", [])
    if isinstance(custom_rules, str):
        custom_rules = [custom_rules]

    # codexでリスク判定
    prompt = build_prompt(tool_name, tool_input, cwd, description, custom_rules)
    judgment, summary = judge_with_codex(prompt)

    # ログ記録（SAFE/RISK両方）
    log_path_str = auto_approve.get("log_file", "")
    if log_path_str:
        log_path = Path(log_path_str).expanduser()
    else:
        log_path = DEFAULT_LOG_PATH

    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "judgment": judgment or "UNKNOWN",
        "tool_name": tool_name,
        "description": description,
        "summary": summary or "",
        "cwd": cwd,
        "session_id": session_id,
    }
    write_log(log_path, log_entry)

    if judgment == "SAFE":
        # タブ区切りで判定と概要を出力
        print(f"SAFE\t{summary}")
        sys.exit(0)

    # RISK → 概要を出力して従来フローへ（吹き出しに理由表示用）
    if judgment == "RISK":
        print(f"RISK\t⚠️RISK: {summary}" if summary else "RISK\t⚠️RISK判定なのだ")
    else:
        # UNKNOWN: codexがタイムアウトまたは形式エラー
        print("UNKNOWN\t❓判定不能なのだ")
    sys.exit(1)


if __name__ == "__main__":
    main()
