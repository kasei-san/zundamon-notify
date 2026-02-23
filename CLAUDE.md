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
透明・フレームレス・常時最前面のウィンドウを画面右下に配置。UDS サーバーを起動し、IPC でレンダラーと通信。吹き出し非表示時はマウスイベント透過（クリックスルー）。右クリックコンテキストメニュー（再起動・終了）の処理も担当。

### UDS サーバー (`src/socket-server.js`)
`/tmp/zundamon-claude.sock` で JSON Lines プロトコルを処理。`permission_request` は接続を保持してレスポンス待ち、`notification`/`stop` は即座にクローズ。

### プロトコル (`src/protocol.js`)
メッセージ型（`PERMISSION_REQUEST`, `NOTIFICATION`, `STOP`, `DISMISS`）の定義とパース/シリアライズ。

### レンダラー (`renderer/`)
吹き出し UI の表示制御。Permission は許可/拒否ボタン付き（590秒タイムアウト）。`permission_suggestions` がある場合は「次回から聞かないのだ」ボタンを表示し、押すと許可 + `updatedPermissions` をレスポンスに含める。Notification・Stop はユーザーが×ボタンで閉じるか、dismiss メッセージで消去。キャラクターのドラッグ&ドロップによるウィンドウ移動にも対応（JavaScript + IPC で実装、`-webkit-app-region: drag` は未使用）。キャラクターの右クリックでコンテキストメニュー（再起動・終了）を表示。

### Hook スクリプト (`hooks/`)
Claude Code の hook から呼ばれる bash スクリプト。`zundamon-permission.sh` は Python3 で stdin から直接 JSON パースし、`permission_suggestions` があればUDSリクエストに含める。socat で UDS に送信（ブロッキング、590秒タイムアウト）。レスポンスに `updatedPermissions` があれば Claude Code 出力の `decision` に含めて返す。`zundamon-notify.sh` は Notification hook で、`permission_prompt` 由来の通知（"Claude needs your permission"を含むメッセージ）をスクリプト内でフィルタリングしスキップする。`zundamon-dismiss.sh` は PostToolUse で、`zundamon-pre-dismiss.sh` は UserPromptSubmit と PreToolUse で発火し、残った吹き出しを dismiss する。

## 開発ルール

### 動作確認時のアプリ再起動
コード変更後に動作確認が必要な場合は、ユーザーに確認せずずんだもんアプリを再起動すること：
```bash
pkill -f "electron \." 2>/dev/null; sleep 1; npm start &
```

### ドキュメント更新
コードを変更した場合は、以下のドキュメントも合わせて更新すること：
- **CLAUDE.md**: アーキテクチャ説明、プロトコル定義、hookスクリプトの説明など
- **README.md**: hooks設定例、ファイル構成、イベント表など
