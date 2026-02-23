#!/bin/bash
# ずんだもん通知アプリ インストールスクリプト

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.zundamon.notify"
PLIST_SRC="$SCRIPT_DIR/$PLIST_NAME.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME/Library/Logs/zundamon-notify"

echo "=== ずんだもん通知アプリ インストール ==="

# npm install
echo "npm install を実行中..."
cd "$SCRIPT_DIR"
npm install

# socat確認
if ! command -v socat &> /dev/null; then
  echo "socat がインストールされていません。brew install socat を実行してください。"
  exit 1
fi

# --- LaunchAgent セットアップ ---
echo ""
echo "LaunchAgent をセットアップ中..."

# ログディレクトリ作成
mkdir -p "$LOG_DIR"

# plist のプレースホルダーを置換して配置
# テンプレートからシンボリックリンクではなく実体ファイルを生成
sed -e "s|__WORKING_DIRECTORY__|$SCRIPT_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DEST"

# 既に登録されていたら一旦解除
if launchctl list | grep -q "$PLIST_NAME"; then
  echo "既存のサービスを解除中..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# サービス登録
launchctl load "$PLIST_DEST"
echo "LaunchAgent を登録したのだ。"

echo ""
echo "=== インストール完了 ==="
echo ""
echo "サービスの状態確認:"
echo "  launchctl list | grep zundamon"
echo ""
echo "手動でサービスを起動/停止:"
echo "  launchctl start $PLIST_NAME"
echo "  launchctl stop $PLIST_NAME"
echo ""
echo "ログの確認:"
echo "  tail -f $LOG_DIR/stdout.log"
echo "  tail -f $LOG_DIR/stderr.log"
echo ""
echo "アンインストール:"
echo "  bash $SCRIPT_DIR/scripts/uninstall.sh"
echo ""
echo "ずんだもんがログイン時に自動起動するようになったのだ！"
