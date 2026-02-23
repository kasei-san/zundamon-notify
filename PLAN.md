# ずんだもん通知デスクトップアプリ 実装計画

## Context

Claude Codeで作業中、ユーザー入力待ちや許可確認が発生してもターミナルを見ていないと気づけない。
画面端にずんだもんキャラクターを常駐させ、hook経由で通知・許可操作をデスクトップ上で完結させるアプリを作る。

## 技術スタック

- **Electron** (HTML/CSS/JS)
- IPC: Unix Domain Socket (`/tmp/zundamon-claude.sock`)
- PSD→PNG変換: Python (`psd-tools` + `Pillow`)
- Hook scripts: Bash (socat or Python for UDS通信)

## アーキテクチャ

```
Claude Code
  │ hook発火 (stdin JSON)
  ▼
Hook Script (bash)
  │ UDS経由でアプリに送信
  │ PermissionRequestはレスポンスを待ってブロック
  ▼
Electron App (UDS Server)
  │ 吹き出しUI表示
  │ ユーザーがボタンクリック → レスポンス返却
  ▼
Hook Script
  │ Claude Code用JSONをstdoutに出力
  ▼
Claude Code (decision適用)
```

## ファイル構成

```
~/work/zundamon-notify/
├── package.json
├── main.js                    # Electronメインプロセス
├── preload.js                 # preloadスクリプト
├── renderer/
│   ├── index.html             # メインウィンドウ
│   ├── style.css              # スタイル（吹き出し、キャラクター）
│   └── renderer.js            # UI制御ロジック
├── src/
│   ├── socket-server.js       # UDSサーバー（メインプロセス側）
│   └── protocol.js            # メッセージプロトコル定義
├── assets/
│   ├── zundamon.png           # PSDから抽出した立ち絵
│   └── extract-sprite.py      # PSD→PNG変換スクリプト
├── hooks/
│   ├── zundamon-permission.sh # PermissionRequest hook（ブロッキング）
│   ├── zundamon-notify.sh     # Notification hook
│   └── zundamon-stop.sh       # Stop hook（入力待ち通知）
└── scripts/
    └── install.sh             # hooks設定登録スクリプト
```

## Hook通信プロトコル

### リクエスト (hook → app)
```json
{"type":"permission_request","id":"uuid","tool_name":"Bash","tool_input":{"command":"..."},"description":"..."}
{"type":"notification","id":"uuid","message":"Claude needs your permission"}
{"type":"stop","id":"uuid","message":"Claude has finished responding"}
```

### レスポンス (app → hook) ※permission_requestのみ
```json
{"id":"uuid","decision":"allow"}
{"id":"uuid","decision":"deny","message":"ユーザーが拒否"}
```

### Hook出力 (→ Claude Code)
```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

## UI仕様

- **キャラクター**: 画面右下に常駐、ドラッグで移動可能
- **吹き出し**: キャラクターの左上に表示
  - Permission時: ツール名 + コマンド概要 + 許可/拒否ボタン
  - Stop時: 「入力を待っているのだ！」テキスト（数秒で自動消去）
- **アニメーション**: 吹き出しのフェードイン/フェードアウト
- **クリックスルー**: 吹き出し非表示時はマウスイベントを透過

---

## 実装TODO

- [x] まずgit init して、作業ごとにgit commitしていくのだ

### Phase 1: 素材準備
- [x] `~/work/zundamon-notify/` ディレクトリ作成、`npm init`
- [x] `extract-sprite.py` でPSDからPNG抽出
  - PSDパス: `~/Downloads/ずんだもん立ち絵素材2.3/ずんだもん立ち絵素材2.3.psd`
  - まずレイヤー構成を確認し、適切な表情でcomposite
  - アプリ用にリサイズ（高さ300px程度）

### Phase 2: Electronアプリ骨格
- [x] `package.json` に electron依存を追加、`npm install`
- [x] `main.js`: 透明フレームレスウィンドウを作成
  - `transparent: true`, `frame: false`, `alwaysOnTop: true`
  - 画面右下に初期配置
  - `skipTaskbar: true` でタスクバー非表示
- [x] `renderer/index.html` + `style.css`: キャラクター画像 + 吹き出しUI
  - ずんだもん画像表示
  - 吹き出し（非表示状態で待機）
  - 「許可するのだ！」「ダメなのだ！」ボタン
- [x] ドラッグ移動: `-webkit-app-region: drag` でウィンドウごとドラッグ可能に
- [x] `npm start` でアプリ起動し、キャラクターが画面右下に表示されることを確認

### Phase 3: UDS通信
- [x] `src/protocol.js`: メッセージプロトコル定義
- [x] `src/socket-server.js`: Unix Domain Socketサーバー
  - `/tmp/zundamon-claude.sock` でリッスン
  - JSON Linesプロトコルでメッセージ受信
  - PermissionRequest: レスポンスが返るまで接続を保持
  - Notification/Stop: UI更新して即座に接続クローズ
- [x] `preload.js`: メインプロセス⇔レンダラー間のIPC bridge
- [x] `renderer/renderer.js`: UIイベント処理、ボタンクリック → IPCでメインへ送信
- [x] socat でテスト送信し、吹き出し表示 + ボタンクリックでレスポンス返却を確認

### Phase 4: Hook Scripts
- [x] `hooks/zundamon-permission.sh`: PermissionRequest hook
  - stdinからJSON読み取り → UDS経由でアプリに送信 → レスポンス待ち（ブロッキング）→ Claude Code用JSON出力
  - アプリ未起動時はexit 0でフォールバック
  - タイムアウト590秒（Claude Codeの600秒より短く）
- [x] `hooks/zundamon-notify.sh`: fire-and-forget通知
- [x] `hooks/zundamon-stop.sh`: 入力待ち通知（吹き出し表示→数秒で自動消去）

### Phase 5: settings.json統合
- [x] `~/.claude/settings.json` の hooks に追加
  - `PermissionRequest`: ずんだもんhookを追加
  - `Notification` (matcher: `permission_prompt`): ずんだもんnotify hook
  - `Stop`: ずんだもん stop hook
- [x] `scripts/install.sh` スクリプト作成（npm install + hooks設定）

### Phase 6: 仕上げ
- [x] 統合テスト（実際のClaude Codeセッションで動作確認）
- [x] 動作確認完了

## 検証方法

1. `npm start` でアプリ起動、キャラクターが画面右下に表示されることを確認
2. ドラッグでキャラクターを移動できることを確認
3. `echo '{"type":"permission_request","id":"test","tool_name":"Bash","tool_input":{"command":"echo hello"},"description":"echo hello"}' | socat - UNIX-CONNECT:/tmp/zundamon-claude.sock` で吹き出し表示を確認
4. ボタンクリックでレスポンスが返ることを確認
5. 実際のClaude Codeセッションでhookが発火し、アプリ経由で許可/拒否できることを確認
