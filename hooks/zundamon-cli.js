#!/usr/bin/env node
/**
 * ずんだもん通知 統一CLI
 *
 * 6つのbash+python3+socatスクリプトと同等の機能を
 * Node.js単体で実装した統一CLI。socat/python3依存を除去。
 *
 * Usage:
 *   node hooks/zundamon-cli.js permission    # PermissionRequest (blocking)
 *   node hooks/zundamon-cli.js notify        # Notification
 *   node hooks/zundamon-cli.js stop          # Stop/input waiting
 *   node hooks/zundamon-cli.js dismiss       # Dismiss (UserPromptSubmit/PreToolUse/PostToolUse)
 *   node hooks/zundamon-cli.js session-end   # SessionEnd
 */

const net = require('net');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOCKET_PATH = '/tmp/zundamon-claude.sock';

// ツール名から日本語ラベルへのマッピング
const TOOL_LABELS = {
  Bash: 'コマンド実行中',
  Read: 'ファイル読み中',
  Edit: 'ファイル編集中',
  Write: 'ファイル作成中',
  Grep: 'コード検索中',
  Glob: 'ファイル検索中',
  Task: 'タスク実行中',
  WebFetch: 'Web取得中',
  WebSearch: 'Web検索中',
  NotebookEdit: 'ノートブック編集中',
};

// ---- UDS通信 ----

/**
 * stdinを全て読み取ってJSONパースする
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * UDSにメッセージを送信し、オプションでレスポンスを待つ
 * @param {object|string} msg 送信するメッセージ（objectならJSON.stringifyする）
 * @param {object} opts オプション
 * @param {boolean} opts.waitResponse レスポンスを待つか
 * @param {number} opts.timeout タイムアウト(ms)
 * @returns {Promise<object|null>} レスポンスJSON or null
 */
function sendMessage(msg, { waitResponse = false, timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      resolve(null);
      return;
    }

    const socket = net.createConnection(SOCKET_PATH);
    let buffer = '';

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeout);

    socket.on('connect', () => {
      const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
      socket.write(data + '\n');
      if (!waitResponse) {
        clearTimeout(timer);
        socket.end();
        resolve(null);
      }
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line.trim());
            clearTimeout(timer);
            socket.end();
            resolve(parsed);
            return;
          } catch {
            // パース失敗は無視して次の行を待つ
          }
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * 複数メッセージを1接続で送信する（dismiss + status_update用）
 */
function sendMessages(messages, { timeout = 1000 } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      resolve(null);
      return;
    }

    const socket = net.createConnection(SOCKET_PATH);

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, timeout);

    socket.on('connect', () => {
      for (const msg of messages) {
        socket.write(JSON.stringify(msg) + '\n');
      }
      clearTimeout(timer);
      socket.end();
      resolve(null);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// ---- サブコマンド ----

/**
 * permission: PermissionRequest（ブロッキング）
 *
 * 1. auto-approve.py で自動リスク判定
 * 2. SAFEなら即allow返却 + notification吹き出し
 * 3. SAFEでなければUDS経由でElectronアプリに送信、レスポンスを待つ
 */
async function handlePermission(data) {
  const TIMEOUT = 590; // Claude Codeの600秒タイムアウトより短く

  // シグナルハンドラ: プロセスグループごとkillして子プロセスの孤立を防ぐ
  const cleanup = () => {
    try { process.kill(-process.pid, 'SIGTERM'); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // ソケットが存在しなければフォールバック
  if (!fs.existsSync(SOCKET_PATH)) {
    process.exit(0);
  }

  const toolInput = data.tool_input || {};
  const description = toolInput.command || toolInput.description || JSON.stringify(toolInput).slice(0, 200);
  const sessionId = data.session_id || 'default';
  const cwd = data.cwd || '';
  const pid = process.ppid;

  // codexによる自動リスク判定
  // auto-approve.py: SAFE時exit 0 + stdout "SAFE\t概要"
  //                  RISK/UNKNOWN時exit 1 + stdout "RISK\t概要" or "UNKNOWN\t概要"
  let autoJudgment = '';
  let autoSummary = '';
  try {
    const scriptDir = path.dirname(__filename);
    const result = execSync(
      `python3 "${path.join(scriptDir, 'auto-approve.py')}"`,
      {
        env: { ...process.env, ZUNDAMON_HOOK_DATA: JSON.stringify(data) },
        timeout: 15000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    // exit 0 = SAFE
    const parts = result.trim().split('\t');
    autoJudgment = parts[0] || '';
    autoSummary = parts.slice(1).join('\t') || '';
  } catch (e) {
    // exit 1 = RISK/UNKNOWN、またはpython3未インストール等
    // execSyncのエラーオブジェクトにstdoutがある場合はパースを試みる
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    if (stdout) {
      const parts = stdout.split('\t');
      autoJudgment = parts[0] || '';
      autoSummary = parts.slice(1).join('\t') || '';
    }
    // stdoutが空の場合はautoJudgment=''のまま → 従来フロー続行
  }

  if (autoJudgment === 'SAFE') {
    // 概要をnotification表示
    if (autoSummary && fs.existsSync(SOCKET_PATH)) {
      const notif = {
        type: 'notification',
        id: randomUUID(),
        session_id: sessionId,
        cwd,
        message: '\u2705 ' + autoSummary,
      };
      await sendMessage(notif);
    }
    // allow JSON を stdout に出力
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(0);
  }

  // RISK/UNKNOWN/エラー → 従来フロー: UDS経由でElectronアプリに送信

  // リスク概要がある場合はdescriptionに追記
  let fullDescription = description;
  if (autoSummary) {
    fullDescription = autoSummary + '\n' + description;
  }

  const request = {
    type: 'permission_request',
    id: randomUUID(),
    session_id: sessionId,
    cwd,
    pid,
    tool_name: data.tool_name || '',
    tool_input: toolInput,
    description: fullDescription,
  };

  // permission_suggestionsがある場合は含める
  if (data.permission_suggestions) {
    request.permission_suggestions = data.permission_suggestions;
  }

  // UDS経由で送信してレスポンスを待つ
  const response = await sendMessage(request, {
    waitResponse: true,
    timeout: TIMEOUT * 1000,
  });

  if (!response) {
    process.exit(0);
  }

  // レスポンスをClaude Code用JSON出力に変換
  const decision = response.decision || '';
  if (decision === 'allow') {
    const output = { behavior: 'allow' };
    if (response.updatedPermissions) {
      output.updatedPermissions = response.updatedPermissions;
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: output,
        },
      }) + '\n'
    );
  } else if (decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'ずんだもんが拒否したのだ',
          },
        },
      }) + '\n'
    );
  }
  // decision が allow/deny 以外の場合は何も出力せずexit 0
}

/**
 * notify: Notification（fire-and-forget）
 *
 * permission_prompt由来の通知とStop hook由来の入力待ち通知をフィルタリング
 */
async function handleNotify(data) {
  if (!fs.existsSync(SOCKET_PATH)) {
    process.exit(0);
  }

  const message = data.message || 'Claude Codeからの通知なのだ';

  // 不要な通知をフィルタリング
  const skipPatterns = [
    'Claude needs your permission',
    'Claude is waiting for your input',
  ];
  for (const skip of skipPatterns) {
    if (message.includes(skip)) {
      process.exit(0);
    }
  }

  const request = {
    type: 'notification',
    id: randomUUID(),
    session_id: data.session_id || 'default',
    cwd: data.cwd || '',
    pid: process.ppid,
    message,
  };

  await sendMessage(request);
}

/**
 * stop: Stop/入力待ち通知（fire-and-forget）
 *
 * codex CLIがインストール済みなら最後の出力を要約
 */
async function handleStop(data) {
  if (!fs.existsSync(SOCKET_PATH)) {
    process.exit(0);
  }

  // stop_hook_activeが true なら無限ループ防止のためスキップ
  if (data.stop_hook_active) {
    process.exit(0);
  }

  const sessionId = data.session_id || 'default';
  const cwd = data.cwd || '';
  const pid = process.ppid;
  const lastMsg = (data.last_assistant_message || '').slice(0, 1000);
  let message = '入力を待っているのだ！';

  // codex CLIがインストールされていて、last_assistant_messageがある場合は要約
  if (lastMsg) {
    try {
      const codexPath = execSync('which codex', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (codexPath) {
        const prompt = `以下の文章を30文字以内のずんだもん口調（〜のだ）で要約して。ユーザーへの質問や確認事項がある場合はその内容を最優先で出して。余計な説明は不要で、要約文だけ出力して: '${lastMsg}'`;
        const result = execSync(
          `perl -e 'alarm 10; exec @ARGV' "${codexPath}" exec --ephemeral -`,
          {
            input: prompt,
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        const lines = result.trim().split('\n');
        const summary = lines[lines.length - 1].trim();
        if (summary) {
          message = summary;
        }
      }
    } catch {
      // codex未インストールまたはエラー → デフォルトメッセージ
    }
  }

  const request = {
    type: 'stop',
    id: randomUUID(),
    session_id: sessionId,
    cwd,
    pid,
    message,
  };

  await sendMessage(request);
}

/**
 * dismiss: UserPromptSubmit/PreToolUse/PostToolUse（fire-and-forget）
 *
 * tool_nameがある場合（PreToolUse）→ dismiss + status_update
 * tool_nameがない場合（UserPromptSubmit/PostToolUse）→ dismiss のみ
 */
async function handleDismiss(data) {
  if (!fs.existsSync(SOCKET_PATH)) {
    process.exit(0);
  }

  const sessionId = data.session_id || 'default';
  const cwd = data.cwd || '';
  const pid = process.ppid;
  const toolName = data.tool_name || '';

  const messages = [];

  // dismiss メッセージ
  messages.push({
    type: 'dismiss',
    id: 'dismiss',
    session_id: sessionId,
    cwd,
    pid,
  });

  // status_update メッセージ（tool_nameがある場合 = PreToolUse）
  if (toolName) {
    const label = TOOL_LABELS[toolName] || toolName;
    messages.push({
      type: 'status_update',
      id: 'status',
      session_id: sessionId,
      message: label,
    });
  }

  await sendMessages(messages);
}

/**
 * session-end: SessionEnd（fire-and-forget）
 */
async function handleSessionEnd(data) {
  if (!fs.existsSync(SOCKET_PATH)) {
    process.exit(0);
  }

  const request = {
    type: 'session_end',
    id: randomUUID(),
    session_id: data.session_id || 'default',
  };

  await sendMessage(request);
}

// ---- メイン ----

async function main() {
  const subcommand = process.argv[2];
  if (!subcommand) {
    process.stderr.write(
      'Usage: zundamon-cli.js <permission|notify|stop|dismiss|session-end>\n'
    );
    process.exit(1);
  }

  let data;
  try {
    data = await readStdin();
  } catch {
    // stdinが空またはパースエラー → フォールバック
    process.exit(0);
  }

  switch (subcommand) {
    case 'permission':
      await handlePermission(data);
      break;
    case 'notify':
      await handleNotify(data);
      break;
    case 'stop':
      await handleStop(data);
      break;
    case 'dismiss':
      await handleDismiss(data);
      break;
    case 'session-end':
      await handleSessionEnd(data);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
      process.exit(1);
  }
}

main().catch(() => process.exit(0));
