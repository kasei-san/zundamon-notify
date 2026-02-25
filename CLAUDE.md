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

# AskUserQuestion のテスト（質問と選択肢を表示、ボタンなし）
echo '{"type":"permission_request","id":"test-q1","session_id":"session-aaa","cwd":"/tmp","pid":12345,"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"どちらのアプローチを使うのだ？","header":"Approach","options":[{"label":"Option A","description":"既存パターンを使う"},{"label":"Option B","description":"新しいパターンを作る"}],"multiSelect":false}]},"description":"AskUserQuestion"}' | socat -t 30 - UNIX-CONNECT:/tmp/zundamon-claude.sock

# session_idなし（後方互換: "default"セッション）
echo '{"type":"notification","id":"test-3","message":"旧形式テスト"}' | socat -t 2 - UNIX-CONNECT:/tmp/zundamon-claude.sock
```

## アーキテクチャ

通信フロー: **Claude Code hook → bash スクリプト → UDS (`/tmp/zundamon-claude.sock`) → Electron main → IPC → renderer**

### メインプロセス (`main.js`)
`app.setName('ずんだもん通知')` と `app.dock.setIcon()` でアプリ名とDockアイコンを設定（`assets/icon.icns`）。セッションごとに透明・フレームレス・常時最前面のウィンドウを動的生成し画面右下に配置（ウィンドウ数に応じてオフセット）。`windows: Map<session_id, BrowserWindow>` でセッション別に管理。**ウィンドウ高さは動的**: 通常時はコンパクト（340px、キャラクターのみ）、吹き出し表示時にrendererからの`expand-window` IPCで上方向に拡張（550px）、非表示時に`compact-window`で縮小。これにより画面上部へのドラッグ移動範囲を最大化。色テーマパレット（10色: green/blue/purple/orange/pink/red/cyan/yellow/lavender/teal）をセッション順に割り当て、事前生成済みの色違い画像を切り替えて表示（`scripts/generate-variants.py` で緑ピクセルだけ色相回転した画像を生成）。Permission FIFO で到着順管理し、先頭セッションのウィンドウを`screen-saver`レベルで最前面に配置。グローバルショートカット（Ctrl+Shift+Y/N/A）はアプリ起動3秒後に一度だけ登録し常時有効（macOSアクセシビリティの準備完了を待つ必要があるため遅延。Permission待ちがない時は空チェックでno-op）。タイムアウトベースGC（30秒間隔チェック、5分間メッセージなしでセッション破棄）。hookの`$PPID`は一時プロセスのためPID生存確認は不可。SessionEnd hookとタイムアウトGCでライフサイクル管理。

### UDS サーバー (`src/socket-server.js`)
`/tmp/zundamon-claude.sock` で JSON Lines プロトコルを処理。`sessions: Map<session_id, {pid, cwd, pendingConnections}>` でセッション単位管理。コールバック方式（`onMessage`, `onSessionStart`, `onSessionEnd`, `onPermissionRequest`, `onSessionPermissionsDismiss`, `onAllPermissionsDismiss`）で main.js が適切なウィンドウにルーティング。`session_id` 未設定メッセージは `"default"` にフォールバック。DISMISS ハンドラは `getOrCreateSession` を呼ぶため、UserPromptSubmit hook での最初の dismiss メッセージでセッションが自動作成される。

### プロトコル (`src/protocol.js`)
メッセージ型（`PERMISSION_REQUEST`, `NOTIFICATION`, `STOP`, `DISMISS`, `STATUS_UPDATE`, `SESSION_END`）の定義とパース/シリアライズ。`session_id` 未設定時は `"default"` にフォールバック。

### レンダラー (`renderer/`)
吹き出し UI の表示制御。Permission はキューベースで複数同時保持し順次表示（待ち件数表示付き）。許可/拒否ボタン付き（590秒タイムアウト）。`permission_suggestions` がある場合は「次回から聞かないのだ」ボタンを表示。`AskUserQuestion`（`tool_name === 'AskUserQuestion'`）の場合は質問テキストと選択肢を番号付きリスト（label + description）で表示し、許可/拒否ボタンは非表示（ユーザーはターミナルで回答、dismiss hookで自動消去）。CSS変数で色テーマを適用。キャラクターのドラッグ&ドロップによるウィンドウ移動、右クリックコンテキストメニュー（吹き出しを消す・再起動・このずんだもんを終了・終了）に対応。**足元ステータステキスト**（`#status-text`）: PreToolUse hookで`status_update`メッセージとして送信され、ツール名から「コマンド実行中」「ファイル編集中」等の簡易ラベルを表示。黒背景＋テーマカラー＋センタリング＋回転スピナー付き。`#character-container`でキャラクター画像とセンタリング。

### Hook スクリプト (`hooks/`)
全スクリプトでstdin JSONから `session_id`/`cwd`/`transcript_path` を抽出し、`$PPID` を pid としてUDSメッセージに含める。`zundamon-permission.sh` は Python3 で安全にパースし socat でブロッキング送信（590秒タイムアウト）。シグナルトラップ（`trap 'kill 0' TERM INT`）でコンソール側操作時にsocat子プロセスの孤立を防止。`zundamon-notify.sh` は permission_prompt 由来の通知をフィルタリング。`zundamon-stop.sh` は `last_assistant_message` を codex CLI（インストール済みの場合）で30文字以内のずんだもん口調に要約して表示（質問・確認事項がある場合はその内容を優先）（codex 未インストール時は「入力を待っているのだ！」にフォールバック。`stop_hook_active` チェックで無限ループ防止）。`zundamon-dismiss.sh`/`zundamon-pre-dismiss.sh` はセッション単位でdismiss（`zundamon-pre-dismiss.sh` は `cwd`/`pid`/`transcript_path` も含めて送信し、セッション作成のトリガーにもなる。PreToolUseの場合は `tool_name` から簡易ラベルを生成して `status_update` メッセージも同時送信）。`zundamon-session-end.sh` は SessionEnd hook でセッション終了を通知。`~/.claude/settings.json` に SessionEnd hook を登録済み。

## 参考プロジェクト

- **[claude-island](https://github.com/farouqaldori/claude-island)**: macOS ネイティブ（Swift）の複数 Claude Code セッション管理ツール。hook の仕組み、UDS 通信、session_id によるマルチセッション管理など、本プロジェクトと共通する課題を解決済み。調査が必要だったりハマったときに参考にすること。

## 開発ルール

### 動作確認時のアプリ再起動
コード変更後に動作確認が必要な場合は、ユーザーに確認せずずんだもんアプリを再起動すること：
```bash
./scripts/restart.sh
```

### コミット後のPR作成
コミットしたら、ユーザーに確認せず即座にPR作成・pushまで実行すること。

### ドキュメント更新
コードを変更した場合は、以下のドキュメントも合わせて更新すること：
- **CLAUDE.md**: アーキテクチャ説明、プロトコル定義、hookスクリプトの説明など
- **README.md**: hooks設定例、ファイル構成、イベント表など
