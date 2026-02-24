/**
 * Unix Domain Socket サーバー
 * Hook Script からのメッセージを受信し、Electron UIと連携する
 */

const net = require('net');
const fs = require('fs');
const { MESSAGE_TYPES, parseMessage, serializeResponse } = require('./protocol');

const SOCKET_PATH = '/tmp/zundamon-claude.sock';

class SocketServer {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.server = null;
    // permission_request の接続を保持 (id -> socket)
    this.pendingConnections = new Map();
    // コールバック（main.js から設定）
    this.onPermissionRequest = null;
    this.onPermissionDismiss = null;
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
        // 切断されたpending接続を削除し、レンダラーに通知
        let dismissed = false;
        for (const [id, s] of this.pendingConnections) {
          if (s === socket) {
            this.pendingConnections.delete(id);
            this.mainWindow.webContents.send('permission-dismissed', { id });
            dismissed = true;
          }
        }
        if (dismissed && this.pendingConnections.size === 0 && this.onPermissionDismiss) {
          this.onPermissionDismiss();
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

  /**
   * 未応答のpending接続を全てdismissする
   * コンソール側で許可/拒否された後、次のメッセージが来た時に古い吹き出しを消す
   */
  dismissPendingConnections() {
    for (const [id, s] of this.pendingConnections) {
      this.mainWindow.webContents.send('permission-dismissed', { id });
      s.end();
    }
    this.pendingConnections.clear();
    if (this.onPermissionDismiss) this.onPermissionDismiss();
  }

  handleMessage(msg, socket) {
    console.log('Received message:', JSON.stringify(msg));

    switch (msg.type) {
      case MESSAGE_TYPES.PERMISSION_REQUEST:
        // 接続を保持してレスポンスを待つ
        this.pendingConnections.set(msg.id, socket);
        console.log('Pending connections:', [...this.pendingConnections.keys()]);
        this.mainWindow.webContents.send('permission-request', msg);
        if (this.onPermissionRequest) this.onPermissionRequest(msg);
        break;

      case MESSAGE_TYPES.NOTIFICATION:
        this.mainWindow.webContents.send('notification', msg);
        socket.end();
        break;

      case MESSAGE_TYPES.STOP:
        this.mainWindow.webContents.send('stop', msg);
        socket.end();
        break;

      case MESSAGE_TYPES.DISMISS:
        // pending permissionの吹き出しを全て閉じる
        this.dismissPendingConnections();
        // Notification/Stopの吹き出しも閉じる
        this.mainWindow.webContents.send('dismiss-bubble');
        socket.end();
        break;

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
    console.log('Pending IDs:', [...this.pendingConnections.keys()]);
    const socket = this.pendingConnections.get(response.id);
    if (socket) {
      socket.write(serializeResponse(response));
      socket.end();
      this.pendingConnections.delete(response.id);
      // 全てのpendingが解消されたらショートカット解除
      if (this.pendingConnections.size === 0 && this.onPermissionDismiss) {
        this.onPermissionDismiss();
      }
    }
  }

  stop() {
    // 保持中の接続を全て閉じる
    for (const [, socket] of this.pendingConnections) {
      socket.end();
    }
    this.pendingConnections.clear();

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
