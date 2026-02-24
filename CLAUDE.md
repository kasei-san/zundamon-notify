# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Claude Code の hook（PermissionRequest / Notification / Stop / SessionEnd）発火時にデスクトップ通知を表示する Electron アプリ。ずんだもんキャラクターの吹き出しで通知を表示し、Permission はブロッキングでユーザーの許可/拒否を待つ。複数 Claude Code セッションに対応し、セッションごとに独立したずんだもんウィンドウを表示する。

## 開発コマンド

```bash
npm install            # 依存インストール
brew install socat     # UDS通信用（hook スクリプトで必要）
npm start              # Electron アプリ起動（= electron .）
```

テストフレームワークは未導入。手動テストは socat で UDS にメッセージ送信して行う:

```bash
# Permission リクエストのテスト（session_id付き）
echo '{"type":"permission_request","id":"test-1","session_id":"session-aaa","cwd":"/Users/you/work/project","pid":12345,"tool_name":"Bash","tool_input":{"command":"ls"},"description":"テスト"}' | socat -t 30 - UNIX-CONNECT:/tmp/zundamon-claude.sock

# Notification のテスト
echo '{"type":"notification","id":"test-2","session_id":"session-aaa","cwd":"/Users/you/work/project","message":"テスト通知"}' | socat -t 2 - UNIX-CONNECT:/tmp/zundamon-claude.sock

# セッション終了テスト
echo '{"type":"session_end","id":"end-1","session_id":"session-aaa"}' | socat -t 2 - UNIX-CONNECT:/tmp/zundamon-claude.sock

# session_idなし（後方互換: "default"セッション）
echo '{"type":"notification","id":"test-3","message":"旧形式テスト"}' | socat -t 2 - UNIX-CONNECT:/tmp/zundamon-claude.sock
```

## アーキテクチャ

通信フロー: **Claude Code hook → bash スクリプト → UDS (`/tmp/zundamon-claude.sock`) → Electron main → IPC → renderer**

### メインプロセス (`main.js`)
セッションごとに透明・フレームレス・常時最前面のウィンドウを動的生成し画面右下に配置（ウィンドウ数に応じてオフセット）。`windows: Map<session_id, BrowserWindow>` でセッション別に管理。色テーマパレット（green/blue/purple/orange/pink）をセッション順に割り当て、ずんだもん画像のhue-rotateで色相変更。Permission FIFO で到着順管理し、先頭セッションのウィンドウを`screen-saver`レベルで最前面に配置。グローバルショートカット（Ctrl+Shift+Y/N/A）はアプリ起動3秒後に一度だけ登録し常時有効（macOSアクセシビリティの準備完了を待つ必要があるため遅延。Permission待ちがない時は空チェックでno-op）。セッションタイトルは`transcript_path`からtranscript JSONLの最初のユーザーメッセージを抽出して表示（URL除去、50文字以内）。タイムアウトベースGC（30秒間隔チェック、5分間メッセージなしでセッション破棄）。hookの`$PPID`は一時プロセスのためPID生存確認は不可。SessionEnd hookとタイムアウトGCでライフサイクル管理。

### UDS サーバー (`src/socket-server.js`)
`/tmp/zundamon-claude.sock` で JSON Lines プロトコルを処理。`sessions: Map<session_id, {pid, cwd, pendingConnections}>` でセッション単位管理。コールバック方式（`onMessage`, `onSessionStart`, `onSessionEnd`, `onPermissionRequest`, `onSessionPermissionsDismiss`, `onAllPermissionsDismiss`）で main.js が適切なウィンドウにルーティング。`session_id` 未設定メッセージは `"default"` にフォールバック。DISMISS は対象セッションのpendingのみクリア。

### プロトコル (`src/protocol.js`)
メッセージ型（`PERMISSION_REQUEST`, `NOTIFICATION`, `STOP`, `DISMISS`, `SESSION_END`）の定義とパース/シリアライズ。`session_id` 未設定時は `"default"` にフォールバック。

### レンダラー (`renderer/`)
吹き出し UI の表示制御。Permission はキューベースで複数同時保持し順次表示（待ち件数表示付き）。許可/拒否ボタン付き（590秒タイムアウト）。`permission_suggestions` がある場合は「次回から聞かないのだ」ボタンを表示。セッションタイトル（最初のユーザーメッセージ）を足元に表示（フォールバック: cwdのディレクトリ名）。CSS変数で色テーマを適用。キャラクターのドラッグ&ドロップによるウィンドウ移動、右クリックコンテキストメニュー（再起動・このずんだもんを終了・終了）に対応。

### Hook スクリプト (`hooks/`)
全スクリプトでstdin JSONから `session_id`/`cwd`/`transcript_path` を抽出し、`$PPID` を pid としてUDSメッセージに含める。`zundamon-permission.sh` は Python3 で安全にパースし socat でブロッキング送信（590秒タイムアウト）。`zundamon-notify.sh` は permission_prompt 由来の通知をフィルタリング。`zundamon-dismiss.sh`/`zundamon-pre-dismiss.sh` はセッション単位でdismiss。`zundamon-session-end.sh` は SessionEnd hook でセッション終了を通知。

## 参考プロジェクト

- **[claude-island](https://github.com/farouqaldori/claude-island)**: macOS ネイティブ（Swift）の複数 Claude Code セッション管理ツール。hook の仕組み、UDS 通信、session_id によるマルチセッション管理など、本プロジェクトと共通する課題を解決済み。調査が必要だったりハマったときに参考にすること。

## 開発ルール

### 動作確認時のアプリ再起動
コード変更後に動作確認が必要な場合は、ユーザーに確認せずずんだもんアプリを再起動すること：
```bash
pkill -f "electron \." 2>/dev/null; sleep 1; npm start &
```

### コミット後のPR作成
コミットしたら、ユーザーに確認せず即座にPR作成・pushまで実行すること。

### ドキュメント更新
コードを変更した場合は、以下のドキュメントも合わせて更新すること：
- **CLAUDE.md**: アーキテクチャ説明、プロトコル定義、hookスクリプトの説明など
- **README.md**: hooks設定例、ファイル構成、イベント表など
