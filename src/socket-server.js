/**
 * Unix Domain Socket サーバー
 * Hook Script からのメッセージを受信し、セッション単位で管理する
 */

const net = require('net');
const fs = require('fs');
const { MESSAGE_TYPES, parseMessage, serializeResponse } = require('./protocol');

const SOCKET_PATH = '/tmp/zundamon-claude.sock';

class SocketServer {
  /**
   * @param {object} callbacks
   * @param {function} callbacks.onMessage - (session_id, channel, data) メッセージをウィンドウにルーティング
   * @param {function} callbacks.onSessionStart - (session_id, {pid, cwd}) 新セッション検知
   * @param {function} callbacks.onSessionEnd - (session_id) セッション終了
   * @param {function} callbacks.onPermissionRequest - (session_id) ショートカット登録用
   * @param {function} callbacks.onSessionPermissionsDismiss - (session_id) 特定セッションのpendingが解消
   * @param {function} callbacks.onAllPermissionsDismiss - () 全セッションのpendingが解消
   */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.server = null;
    // セッション単位の管理: session_id -> { pid, cwd, pendingConnections: Map<id, socket>, lastMessageAt: number }
    this.sessions = new Map();
  }

  /**
   * セッションを取得。未登録なら自動作成してonSessionStartを呼ぶ
   */
  getOrCreateSession(sessionId, msg) {
    if (!this.sessions.has(sessionId)) {
      const sessionInfo = {
        pid: msg.pid || null,
        cwd: msg.cwd || '',
        transcriptPath: msg.transcript_path || '',
        pendingConnections: new Map(),
        lastMessageAt: Date.now(),
      };
      this.sessions.set(sessionId, sessionInfo);
      if (this.callbacks.onSessionStart) {
        this.callbacks.onSessionStart(sessionId, { pid: sessionInfo.pid, cwd: sessionInfo.cwd, transcriptPath: sessionInfo.transcriptPath });
      }
    }
    const session = this.sessions.get(sessionId);
    session.lastMessageAt = Date.now();
    return session;
  }

  /**
   * 全セッションにpending接続が残っていないかチェック
   */
  checkAllPermissionsDismissed(changedSessionId) {
    // 特定セッションのpendingが0になったら通知
    if (changedSessionId) {
      const session = this.sessions.get(changedSessionId);
      if (session && session.pendingConnections.size === 0 && this.callbacks.onSessionPermissionsDismiss) {
        this.callbacks.onSessionPermissionsDismiss(changedSessionId);
      }
    }
    // 全セッションのpendingが解消されたかチェック
    for (const [, session] of this.sessions) {
      if (session.pendingConnections.size > 0) return;
    }
    if (this.callbacks.onAllPermissionsDismiss) {
      this.callbacks.onAllPermissionsDismiss();
    }
  }

  /**
   * 特定セッションのpending接続数を返す
   */
  getSessionPendingCount(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.pendingConnections.size : 0;
  }

  start() {
    // 既存のソケットファイルを削除
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }

    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString();

        // JSON Linesプロトコル: 改行区切りでメッセージを処理
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 最後の不完全な行をバッファに残す

        for (const line of lines) {
          const msg = parseMessage(line);
          if (!msg) continue;
          this.handleMessage(msg, socket);
        }
      });

      socket.on('error', (err) => {
        if (err.code !== 'ECONNRESET') {
          console.error('Socket error:', err.message);
        }
      });

      socket.on('end', () => {
        // ソケット終了時にバッファに残ったデータを処理
        if (buffer.trim()) {
          const msg = parseMessage(buffer);
          buffer = '';
          if (msg) {
            this.handleMessage(msg, socket);
          }
        }
      });

      socket.on('close', () => {
        // 切断されたpending接続を削除し、該当ウィンドウに通知
        let dismissed = false;
        for (const [sessionId, session] of this.sessions) {
          for (const [id, s] of session.pendingConnections) {
            if (s === socket) {
              session.pendingConnections.delete(id);
              if (this.callbacks.onMessage) {
                this.callbacks.onMessage(sessionId, 'permission-dismissed', { id });
              }
              dismissed = true;
            }
          }
        }
        if (dismissed) {
          this.checkAllPermissionsDismissed();
        }
      });
    });

    this.server.listen(SOCKET_PATH, () => {
      console.log(`UDS server listening on ${SOCKET_PATH}`);
    });

    this.server.on('error', (err) => {
      console.error('Server error:', err.message);
    });
  }

  handleMessage(msg, socket) {
    console.log('Received message:', JSON.stringify(msg));
    const sessionId = msg.session_id;

    switch (msg.type) {
      case MESSAGE_TYPES.PERMISSION_REQUEST: {
        const session = this.getOrCreateSession(sessionId, msg);
        session.pendingConnections.set(msg.id, socket);
        console.log(`[${sessionId}] Pending connections:`, [...session.pendingConnections.keys()]);
        if (this.callbacks.onMessage) {
          this.callbacks.onMessage(sessionId, 'permission-request', msg);
        }
        if (this.callbacks.onPermissionRequest) {
          this.callbacks.onPermissionRequest(sessionId);
        }
        break;
      }

      case MESSAGE_TYPES.NOTIFICATION: {
        this.getOrCreateSession(sessionId, msg);
        if (this.callbacks.onMessage) {
          this.callbacks.onMessage(sessionId, 'notification', msg);
        }
        socket.end();
        break;
      }

      case MESSAGE_TYPES.STOP: {
        this.getOrCreateSession(sessionId, msg);
        if (this.callbacks.onMessage) {
          this.callbacks.onMessage(sessionId, 'stop', msg);
        }
        socket.end();
        break;
      }

      case MESSAGE_TYPES.DISMISS: {
        // 対象セッションのpendingのみクリア
        const session = this.sessions.get(sessionId);
        if (session) {
          for (const [id, s] of session.pendingConnections) {
            if (this.callbacks.onMessage) {
              this.callbacks.onMessage(sessionId, 'permission-dismissed', { id });
            }
            s.end();
          }
          session.pendingConnections.clear();
        }
        // Notification/Stopの吹き出しも閉じる
        if (this.callbacks.onMessage) {
          this.callbacks.onMessage(sessionId, 'dismiss-bubble', {});
        }
        this.checkAllPermissionsDismissed(sessionId);
        socket.end();
        break;
      }

      case MESSAGE_TYPES.TITLE_UPDATE: {
        // セッションが存在する場合のみタイトル更新（存在しなければ無視）
        if (this.sessions.has(sessionId)) {
          this.sessions.get(sessionId).lastMessageAt = Date.now();
          if (this.callbacks.onMessage) {
            this.callbacks.onMessage(sessionId, 'title-update', { title: msg.title });
          }
        }
        socket.end();
        break;
      }

      case MESSAGE_TYPES.SESSION_END: {
        // セッション削除
        const endSession = this.sessions.get(sessionId);
        if (endSession) {
          // pending接続をクローズ
          for (const [, s] of endSession.pendingConnections) {
            s.end();
          }
          endSession.pendingConnections.clear();
          this.sessions.delete(sessionId);
        }
        if (this.callbacks.onSessionEnd) {
          this.callbacks.onSessionEnd(sessionId);
        }
        this.checkAllPermissionsDismissed(sessionId);
        socket.end();
        break;
      }

      default:
        console.warn('Unknown message type:', msg.type);
        socket.end();
    }
  }

  /**
   * Permission Requestへのレスポンスを送信する
   * @param {object} response - {id, decision, message?}
   */
  sendResponse(response) {
    console.log('sendResponse called:', JSON.stringify(response));
    // response内のidから該当セッションのpendingを検索
    for (const [sessionId, session] of this.sessions) {
      const socket = session.pendingConnections.get(response.id);
      if (socket) {
        socket.write(serializeResponse(response));
        socket.end();
        session.pendingConnections.delete(response.id);
        console.log(`[${sessionId}] Remaining pending:`, [...session.pendingConnections.keys()]);
        this.checkAllPermissionsDismissed(sessionId);
        return;
      }
    }
    console.warn('No pending connection found for response id:', response.id);
  }

  /**
   * 特定セッションを削除する
   */
  removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const [, s] of session.pendingConnections) {
        s.end();
      }
      session.pendingConnections.clear();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * セッション情報を取得
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * 全セッションIDを取得
   */
  getAllSessionIds() {
    return [...this.sessions.keys()];
  }

  stop() {
    // 保持中の全セッション接続を閉じる
    for (const [, session] of this.sessions) {
      for (const [, socket] of session.pendingConnections) {
        socket.end();
      }
      session.pendingConnections.clear();
    }
    this.sessions.clear();

    if (this.server) {
      this.server.close();
    }

    // ソケットファイルを削除
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  }
}

module.exports = { SocketServer };
