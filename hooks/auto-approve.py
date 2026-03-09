#!/usr/bin/env python3
"""
Permissionリクエスト自動リスク判定（2段構成）。
環境変数 ZUNDAMON_HOOK_DATA から hook の生JSONを受け取り、
1. settings.json の allow/deny パターンで決定論的に判定（高速・無料）
2. パターンで判定できない場合のみ codex CLI でLLM判定

exit 0 + stdout "SAFE\t概要テキスト" → 自動許可（概要を吹き出し表示）
exit 1 → 従来フロー（Electron通知）に進む
"""

import fnmatch
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "zundamon-notify"
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_LOG_PATH = CONFIG_DIR / "auto-approve.log"
STREAK_FILE = CONFIG_DIR / "error-streak.count"
SOCKET_PATH = "/tmp/zundamon-claude.sock"
MONITOR_SESSION_ID = "zundamon-monitor"
ERROR_STREAK_THRESHOLD = 3


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


def read_error_streak():
    """連続エラー回数を読み取る。ファイル未存在時は0。"""
    try:
        return int(STREAK_FILE.read_text().strip())
    except (FileNotFoundError, ValueError):
        return 0


def write_error_streak(count):
    """連続エラー回数を書き込む。"""
    try:
        STREAK_FILE.parent.mkdir(parents=True, exist_ok=True)
        STREAK_FILE.write_text(str(count))
    except Exception:
        pass


def send_monitor_notification(message):
    """モニター用ずんだもん（別ウィンドウ）にnotificationを送信。"""
    try:
        sock_path = Path(SOCKET_PATH)
        if not sock_path.exists():
            return
        notif = json.dumps({
            "type": "notification",
            "id": str(uuid.uuid4()),
            "session_id": MONITOR_SESSION_ID,
            "cwd": "",
            "message": message,
        }, ensure_ascii=False)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect(SOCKET_PATH)
            s.sendall((notif + "\n").encode())
    except Exception:
        pass


def update_error_streak(judgment):
    """判定結果に応じてエラーストリークを更新し、閾値到達時に通知。"""
    if judgment in ("SAFE", "RISK"):
        write_error_streak(0)
        return

    streak = read_error_streak() + 1
    write_error_streak(streak)

    if streak == ERROR_STREAK_THRESHOLD:
        send_monitor_notification(
            f"⚠️ codex判定が{ERROR_STREAK_THRESHOLD}回連続で失敗しているのだ！"
            "自動許可が動いていない可能性があるのだ。"
            "デバッグログ: ~/.config/zundamon-notify/auto-approve-debug.log"
        )


# --- settings.json パターンマッチング（決定論的判定） ---

# シェルビルトイン: 単独で実行されても安全なコマンド
SHELL_BUILTINS = frozenset([
    "cd", "echo", "printf", "export", "unset", "set", "shopt",
    "local", "declare", "readonly", "typeset", "true", "false",
    "test", "[", "[[", ":", "pwd", "pushd", "popd", "dirs",
    "alias", "unalias", "hash", "type", "command", "builtin",
    "source", ".", "eval", "shift", "return", "break", "continue",
])


def load_settings_permissions():
    """settings.json 4層から allow/deny パターンを読み込む。"""
    allow_patterns = []
    deny_patterns = []

    # Git root を検出（cwd ベース）
    git_root = None
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            git_root = result.stdout.strip()
    except Exception:
        pass

    # 4層の設定ファイル
    home = Path.home()
    paths = [
        home / ".claude" / "settings.json",
        home / ".claude" / "settings.local.json",
    ]
    if git_root:
        paths.extend([
            Path(git_root) / ".claude" / "settings.json",
            Path(git_root) / ".claude" / "settings.local.json",
        ])

    for path in paths:
        try:
            with open(path) as f:
                settings = json.load(f)
            perms = settings.get("permissions", {})
            for pattern in perms.get("allow", []):
                allow_patterns.append(pattern)
            for pattern in perms.get("deny", []):
                deny_patterns.append(pattern)
        except (FileNotFoundError, json.JSONDecodeError):
            continue

    return allow_patterns, deny_patterns


def extract_bash_pattern(permission_str):
    """'Bash(cmd:*)' / 'Bash(cmd *)' / 'Bash(cmd)' → コマンドプレフィックスを抽出。
    Bash以外のパターンはNoneを返す。"""
    m = re.match(r'^Bash\((.+)\)$', permission_str)
    if not m:
        return None
    inner = m.group(1)
    # 末尾の :* や スペース* を除去してプレフィックス部分を取得
    if inner.endswith(":*"):
        return inner[:-2]
    if inner.endswith(" *"):
        return inner[:-2]
    return inner


def matches_bash_pattern(command, permission_str):
    """コマンド文字列が Bash(...) パターンにマッチするか判定。"""
    m = re.match(r'^Bash\((.+)\)$', permission_str)
    if not m:
        return False
    inner = m.group(1)

    if inner == "*":
        return True

    if ":" in inner:
        prefix, glob_part = inner.split(":", 1)
        if command == prefix:
            return True
        if command.startswith(prefix + " "):
            remainder = command[len(prefix) + 1:]
            return fnmatch.fnmatch(remainder, glob_part)
        if command.startswith(prefix):
            remainder = command[len(prefix):]
            return fnmatch.fnmatch(remainder, glob_part)
        return False

    # スペース区切り: "git status *" 形式
    if " *" in inner:
        prefix = inner.replace(" *", "")
        return command == prefix or command.startswith(prefix + " ")

    # 完全一致
    return fnmatch.fnmatch(command, inner)


def split_compound_command(command):
    """複合コマンドを &&, ||, ;, | で分割する。
    クォート内の演算子は分割しない。簡易パーサー。"""
    # メタ文字が含まれていなければ単一コマンド
    if not re.search(r'[&|;]', command):
        return [command.strip()]

    segments = []
    current = []
    i = 0
    in_single = False
    in_double = False

    while i < len(command):
        c = command[i]

        if c == "'" and not in_double:
            in_single = not in_single
            current.append(c)
        elif c == '"' and not in_single:
            in_double = not in_double
            current.append(c)
        elif c == '\\' and not in_single and i + 1 < len(command):
            current.append(c)
            current.append(command[i + 1])
            i += 1
        elif not in_single and not in_double:
            if c == '&' and i + 1 < len(command) and command[i + 1] == '&':
                seg = "".join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
                i += 1  # skip second &
            elif c == '|' and i + 1 < len(command) and command[i + 1] == '|':
                seg = "".join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
                i += 1  # skip second |
            elif c == '|':
                seg = "".join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
            elif c == ';':
                seg = "".join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
            else:
                current.append(c)
        else:
            current.append(c)
        i += 1

    seg = "".join(current).strip()
    if seg:
        segments.append(seg)

    return segments if segments else [command.strip()]


def strip_env_prefix(command):
    """コマンド先頭の環境変数代入 (FOO=bar cmd ...) を除去。"""
    pattern = re.compile(r'^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+(.+)$')
    m = pattern.match(command)
    if m:
        return m.group(1)
    return command


def is_builtin(command):
    """コマンドがシェルビルトインか判定。"""
    cmd_name = command.split()[0] if command.split() else ""
    return cmd_name in SHELL_BUILTINS


def judge_with_settings(tool_name, tool_input):
    """settings.json の allow/deny パターンで判定。
    Returns:
        ("ALLOW", summary) — 全コマンドが allow にマッチ
        ("DENY", summary)  — いずれかが deny にマッチ
        (None, None)       — 判定不能（codex にフォールバック）
    """
    if tool_name != "Bash":
        return None, None

    command = tool_input.get("command", "")
    if not command:
        return None, None

    allow_patterns, deny_patterns = load_settings_permissions()
    if not allow_patterns and not deny_patterns:
        return None, None

    segments = split_compound_command(command)

    for seg in segments:
        stripped = strip_env_prefix(seg)
        # deny チェック（最優先）
        for pattern in deny_patterns:
            if matches_bash_pattern(stripped, pattern):
                return "DENY", f"denyルールにマッチしたのだ: {stripped[:50]}"

    all_allowed = True
    for seg in segments:
        stripped = strip_env_prefix(seg)
        # ビルトインは自動許可
        if is_builtin(stripped):
            continue
        # allow チェック
        matched = False
        for pattern in allow_patterns:
            if matches_bash_pattern(stripped, pattern):
                matched = True
                break
        if not matched:
            all_allowed = False
            break

    if all_allowed:
        # コマンドの概要を生成
        if len(segments) == 1:
            summary = f"{segments[0][:40]}を実行するのだ"
        else:
            summary = f"{segments[0].split()[0]}など{len(segments)}コマンドを実行するのだ"
        return "ALLOW", summary

    return None, None


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
        # returncodeに関わらずstdoutをパース（SIGALRM=-14でも応答が出力済みの場合がある）
        output = result.stdout.strip() if result.stdout else ""
        if output:
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
    except subprocess.TimeoutExpired as e:
        # タイムアウトでもpartial outputがあればパースを試みる
        stdout = e.stdout or ""
        write_log(debug_log, {"timestamp": datetime.now(timezone.utc).isoformat(), "exception": str(e), "partial_stdout": stdout[:500]})
        if stdout:
            for line in stdout.strip().split("\n"):
                stripped = line.strip()
                upper = stripped.upper()
                if upper.startswith("SAFE"):
                    summary = stripped.split(":", 1)[1].strip() if ":" in stripped else stripped[4:].lstrip()
                    return "SAFE", summary
                elif upper.startswith("RISK"):
                    summary = stripped.split(":", 1)[1].strip() if ":" in stripped else stripped[4:].lstrip()
                    return "RISK", summary
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

    # hookデータからツール情報を抽出
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    cwd = data.get("cwd", "")
    description = tool_input.get("command", "") or tool_input.get("description", "") or str(tool_input)[:200]
    session_id = data.get("session_id", "default")

    # --- 第1段: settings.json パターンマッチング（決定論的・高速） ---
    settings_judgment, settings_summary = judge_with_settings(tool_name, tool_input)

    if settings_judgment == "DENY":
        judgment, summary = "RISK", settings_summary
    elif settings_judgment == "ALLOW":
        judgment, summary = "SAFE", settings_summary
    else:
        # --- 第2段: codex LLM判定（フォールバック） ---
        if not shutil.which("codex"):
            # codex未インストール: 判定不能
            judgment, summary = None, None
        else:
            custom_rules = auto_approve.get("custom_rules", [])
            if isinstance(custom_rules, str):
                custom_rules = [custom_rules]

            prompt = build_prompt(tool_name, tool_input, cwd, description, custom_rules)
            judgment, summary = judge_with_codex(prompt)

    # ログ記録（SAFE/RISK両方）
    log_path_str = auto_approve.get("log_file", "")
    if log_path_str:
        log_path = Path(log_path_str).expanduser()
    else:
        log_path = DEFAULT_LOG_PATH

    # 判定方式を記録
    judge_method = "settings" if settings_judgment else "codex"

    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "judgment": judgment or "UNKNOWN",
        "judge_method": judge_method,
        "tool_name": tool_name,
        "description": description,
        "summary": summary or "",
        "cwd": cwd,
        "session_id": session_id,
    }
    write_log(log_path, log_entry)

    # エラーストリーク管理（閾値到達時にモニター用ずんだもんで通知）
    update_error_streak(judgment)

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
