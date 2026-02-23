# ずんだもん通知 - Claude Code デスクトップ通知アプリ

Claude Code で作業中、PermissionRequest（許可確認）や入力待ちが発生してもターミナルを見ていないと気づけない問題を解決するデスクトップアプリです。

画面端にずんだもんが常駐し、Claude Code の hook 経由で通知や許可操作をデスクトップ上で完結させます。

## 動作イメージ

- 画面右下にずんだもんが常駐
- Claude Code が許可を求めると、ずんだもんが吹き出しで通知
- 「許可するのだ！」「ダメなのだ！」ボタンで操作
- 吹き出しが出ていないときはクリックスルー（背面の操作を邪魔しない）

## 必要なもの

- **Node.js** (v18 以上)
- **socat** (`brew install socat`)

## セットアップ

```bash
# 1. リポジトリをクローン
git clone <repo-url> ~/work/zundamon-notify
cd ~/work/zundamon-notify

# 2. 依存パッケージをインストール
npm install

# 3. socat をインストール（未インストールの場合）
brew install socat
```

### Claude Code hooks の設定

`~/.claude/settings.json` の `hooks` に以下を追加してください。

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/work/zundamon-notify/hooks/zundamon-permission.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/work/zundamon-notify/hooks/zundamon-stop.sh"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/work/zundamon-notify/hooks/zundamon-notify.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/work/zundamon-notify/hooks/zundamon-dismiss.sh"
          }
        ]
      }
    ]
  }
}
```

> 既存の hooks 設定がある場合は、`hooks` 配列にエントリを追加する形でマージしてください。

## 使い方

### サービスとして自動起動（推奨）

```bash
# インストール（LaunchAgent 登録 + ログイン時自動起動）
bash scripts/install.sh
```

インストール後はログイン時に自動起動します。手動でサービスを制御するには：

```bash
# サービスの状態確認
launchctl list | grep zundamon

# 手動で起動/停止
launchctl start com.zundamon.notify
launchctl stop com.zundamon.notify

# ログの確認
tail -f ~/Library/Logs/zundamon-notify/stdout.log

# アンインストール（サービス解除）
bash scripts/uninstall.sh
```

### 手動起動

```bash
cd ~/work/zundamon-notify
npm start
```

起動すると画面右下にずんだもんが表示されます。この状態で Claude Code を使うと：

| イベント | 動作 |
|---------|------|
| **PermissionRequest** | 吹き出しにツール名・コマンドを表示。「許可するのだ！」「ダメなのだ！」ボタンで応答 |
| **Stop**（入力待ち） | 「入力を待っているのだ！」と吹き出し表示（8秒で自動消去） |
| **Notification** | 通知メッセージを吹き出し表示（5秒で自動消去） |
| **PostToolUse** | コンソール側で許可/拒否した場合、残っている吹き出しを自動dismiss |

アプリ未起動時は hook がフォールバック（exit 0）するため、通常の Claude Code の動作に影響しません。

## アーキテクチャ

```
Claude Code
  │ hook 発火 (stdin JSON)
  ▼
Hook Script (bash)
  │ Unix Domain Socket 経由でアプリに送信
  │ PermissionRequest はレスポンスを待ってブロック
  ▼
Electron App (UDS Server: /tmp/zundamon-claude.sock)
  │ 吹き出し UI 表示
  │ ユーザーがボタンクリック → レスポンス返却
  ▼
Hook Script
  │ Claude Code 用 JSON を stdout に出力
  ▼
Claude Code (decision 適用)
```

## ファイル構成

```
zundamon-notify/
├── package.json
├── main.js                    # Electron メインプロセス
├── preload.js                 # preload スクリプト
├── renderer/
│   ├── index.html             # メインウィンドウ
│   ├── style.css              # スタイル（吹き出し、キャラクター）
│   └── renderer.js            # UI 制御ロジック
├── src/
│   ├── socket-server.js       # UDS サーバー（メインプロセス側）
│   └── protocol.js            # メッセージプロトコル定義
├── assets/
│   └── zundamon.png           # 立ち絵 PNG（196x300px）
├── hooks/
│   ├── zundamon-permission.sh # PermissionRequest hook（ブロッキング）
│   ├── zundamon-notify.sh     # Notification hook
│   ├── zundamon-stop.sh       # Stop hook（入力待ち通知）
│   └── zundamon-dismiss.sh    # PostToolUse hook（吹き出しdismiss）
├── com.zundamon.notify.plist   # LaunchAgent 定義（テンプレート）
└── scripts/
    ├── install.sh             # インストールスクリプト（LaunchAgent 登録込み）
    └── uninstall.sh           # アンインストールスクリプト
```

## 動作確認（手動テスト）

アプリ起動中に socat で直接メッセージを送信してテストできます。

```bash
# Stop 通知テスト
echo '{"type":"stop","id":"test","message":"入力を待っているのだ！"}' \
  | socat - UNIX-CONNECT:/tmp/zundamon-claude.sock

# Permission Request テスト（ボタンクリックでレスポンスが返る）
echo '{"type":"permission_request","id":"test","tool_name":"Bash","tool_input":{"command":"echo hello"},"description":"echo hello"}' \
  | socat -t 30 - UNIX-CONNECT:/tmp/zundamon-claude.sock
```

## 立ち絵の差し替え

`assets/zundamon.png` を差し替えれば、別の画像に変更できます。

## 素材のライセンス

ずんだもん立ち絵素材は坂本アヒル氏による制作物です。利用規約に従ってご利用ください。

- [坂本アヒル - ずんだもん立ち絵素材](https://seiga.nicovideo.jp/seiga/im10788496)
