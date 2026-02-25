#!/bin/bash
# ずんだもんアプリを再起動するスクリプト
cd "$(dirname "$0")/.."
pkill -f "electron \." 2>/dev/null
sleep 1
npm start &
