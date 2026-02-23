# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Claude Code の hook（PermissionRequest / Notification / Stop）発火時にデスクトップ通知を表示する Electron アプリ。ずんだもんキャラクターの吹き出しで通知を表示し、Permission はブロッキングでユーザーの許可/拒否を待つ。

## 開発コマンド

```bash
npm install            # 依存インストール
brew install socat     # UDS通信用（hook スクリプトで必要）
npm start              # Electron アプリ起動（= electron .）
```

テストフレームワークは未導入。手動テストは socat で UDS にメッセージ送信して行う:

```bash
# Permission リクエストのテスト
echo '{"type":"permission_request","id":"test-1","tool_name":"Bash","tool_input":{"command":"ls"},"description":"テスト"}' | socat - UNIX-CONNECT:/tmp/zundamon-claude.sock

# Notification のテスト
echo '{"type":"notification","id":"test-2","message":"テスト通知"}' | socat - UNIX-CONNECT:/tmp/zundamon-claude.sock
```

## アーキテクチャ

通信フロー: **Claude Code hook → bash スクリプト → UDS (`/tmp/zundamon-claude.sock`) → Electron main → IPC → renderer**

### メインプロセス (`main.js`)
透明・フレームレス・常時最前面のウィンドウを画面右下に配置。UDS サーバーを起動し、IPC でレンダラーと通信。吹き出し非表示時はマウスイベント透過（クリックスルー）。

### UDS サーバー (`src/socket-server.js`)
`/tmp/zundamon-claude.sock` で JSON Lines プロトコルを処理。`permission_request` は接続を保持してレスポンス待ち、`notification`/`stop` は即座にクローズ。

### プロトコル (`src/protocol.js`)
メッセージ型（`PERMISSION_REQUEST`, `NOTIFICATION`, `STOP`）の定義とパース/シリアライズ。

### レンダラー (`renderer/`)
吹き出し UI の表示制御。Permission は許可/拒否ボタン付き（590秒タイムアウト）、Notification は5秒、Stop は8秒で自動消去。

### Hook スクリプト (`hooks/`)
Claude Code の hook から呼ばれる bash スクリプト。Python3 で JSON パース/UUID 生成し、socat で UDS に送信。`zundamon-permission.sh` のみブロッキング（590秒タイムアウト）。
