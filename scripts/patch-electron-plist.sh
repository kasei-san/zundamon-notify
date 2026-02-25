#!/bin/bash
# Electron.app の Info.plist を修正してアプリ名とアイコンを設定する
# npm install で上書きされるため、起動前に毎回実行する

ELECTRON_APP="node_modules/electron/dist/Electron.app"
PLIST="$ELECTRON_APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "Electron.app not found, skipping plist patch"
  exit 0
fi

# アプリ名を変更
plutil -replace CFBundleDisplayName -string "ずんだもん通知" "$PLIST"
plutil -replace CFBundleName -string "ずんだもん通知" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.zundamon.notify" "$PLIST"

# アイコンをコピーして設定
ICON_SRC="$(cd "$(dirname "$0")/.." && pwd)/assets/icon.icns"
ICON_DST="$ELECTRON_APP/Contents/Resources/zundamon.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$ICON_DST"
  plutil -replace CFBundleIconFile -string "zundamon" "$PLIST"
fi

echo "Electron.app patched: name=ずんだもん通知, icon=zundamon.icns"
