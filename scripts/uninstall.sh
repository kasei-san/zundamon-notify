#!/bin/bash
# ずんだもん通知アプリ アンインストールスクリプト

set -e

PLIST_NAME="com.zundamon.notify"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo "=== ずんだもん通知アプリ アンインストール ==="

# サービス停止・解除
if launchctl list | grep -q "$PLIST_NAME"; then
  echo "サービスを停止中..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  echo "サービスを停止したのだ。"
else
  echo "サービスは登録されていないのだ。"
fi

# シンボリックリンク削除
if [ -L "$PLIST_DEST" ] || [ -f "$PLIST_DEST" ]; then
  rm "$PLIST_DEST"
  echo "plist シンボリックリンクを削除したのだ。"
fi

echo ""
echo "=== アンインストール完了 ==="
echo "ログファイルは ~/Library/Logs/zundamon-notify/ に残っています。"
echo "必要に応じて手動で削除してください。"
