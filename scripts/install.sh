#!/bin/bash
# ずんだもん通知アプリ インストールスクリプト

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

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

echo ""
echo "=== インストール完了 ==="
echo ""
echo "使い方:"
echo "  1. アプリ起動: cd $SCRIPT_DIR && npm start"
echo "  2. ~/.claude/settings.json に hooks が設定済みか確認"
echo "  3. Claude Code を起動すると、ずんだもんが通知してくれるのだ！"
