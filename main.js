const { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { SocketServer } = require('./src/socket-server');

// セッション別ウィンドウ管理: session_id -> BrowserWindow
const windows = new Map();
let socketServer;

// 色テーマパレット（セッションごとに順番に割り当て）
// image: 事前生成済みの色違いずんだもん画像ファイル名
const COLOR_THEMES = [
  { name: 'green',    primary: '#5b9a2f', hoverBg: '#f0f7e8', shadow: 'rgba(91, 154, 47, @@)',  image: 'zundamon.png' },
  { name: 'blue',     primary: '#2f7a9a', hoverBg: '#e8f2f7', shadow: 'rgba(47, 122, 154, @@)', image: 'zundamon-blue.png' },
  { name: 'purple',   primary: '#7a2f9a', hoverBg: '#f3e8f7', shadow: 'rgba(122, 47, 154, @@)', image: 'zundamon-purple.png' },
  { name: 'orange',   primary: '#9a6f2f', hoverBg: '#f7f0e8', shadow: 'rgba(154, 111, 47, @@)', image: 'zundamon-orange.png' },
  { name: 'pink',     primary: '#9a2f5b', hoverBg: '#f7e8ef', shadow: 'rgba(154, 47, 91, @@)',  image: 'zundamon-pink.png' },
  { name: 'red',      primary: '#9a2f2f', hoverBg: '#f7e8e8', shadow: 'rgba(154, 47, 47, @@)',  image: 'zundamon-red.png' },
  { name: 'cyan',     primary: '#2f9a8a', hoverBg: '#e8f7f4', shadow: 'rgba(47, 154, 138, @@)', image: 'zundamon-cyan.png' },
  { name: 'yellow',   primary: '#9a8a2f', hoverBg: '#f7f5e8', shadow: 'rgba(154, 138, 47, @@)', image: 'zundamon-yellow.png' },
  { name: 'lavender', primary: '#5b2f9a', hoverBg: '#ede8f7', shadow: 'rgba(91, 47, 154, @@)',  image: 'zundamon-lavender.png' },
  { name: 'teal',     primary: '#2f9a6f', hoverBg: '#e8f7f0', shadow: 'rgba(47, 154, 111, @@)', image: 'zundamon-teal.png' },
];
let nextThemeIndex = 0;

// ショートカットFIFO: Permission到着順でセッションを管理
const permissionFIFO = [];

/**
 * event.senderからsession_idを逆引きする
 */
function getSessionIdFromSender(sender) {
  for (const [sessionId, win] of windows) {
    if (!win.isDestroyed() && win.webContents === sender) {
      return sessionId;
    }
  }
  return null;
}

/**
 * セッション用ウィンドウを生成する
 */
function createSessionWindow(sessionId, { pid, cwd }) {
  if (windows.has(sessionId)) return windows.get(sessionId);

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 400;
  const winHeight = 340; // コンパクト（キャラクターのみ）。吹き出し表示時にrendererからexpand-windowで拡張

  // ウィンドウ位置: 既存ウィンドウ数に応じてオフセット
  const offset = windows.size * 60;
  const x = screenWidth - winWidth - offset;
  const y = screenHeight - winHeight;

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 吹き出し非表示時はクリックスルー
  win.setIgnoreMouseEvents(true, { forward: true });

  // デバッグ用: Cmd+Shift+I でDevTools
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.meta && input.shift && input.key === 'i') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // ページロード完了後にセッション情報を送信
  const theme = COLOR_THEMES[nextThemeIndex % COLOR_THEMES.length];
  nextThemeIndex++;

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('session-info', { sessionId, pid, cwd, colorTheme: theme });
  });

  win.on('closed', () => {
    windows.delete(sessionId);
    // FIFOからも除去
    const fifoIdx = permissionFIFO.indexOf(sessionId);
    if (fifoIdx !== -1) permissionFIFO.splice(fifoIdx, 1);
    updateActiveSession();
  });

  windows.set(sessionId, win);
  return win;
}

/**
 * セッションを削除する
 */
function removeSession(sessionId) {
  const win = windows.get(sessionId);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  windows.delete(sessionId);
  const fifoIdx = permissionFIFO.indexOf(sessionId);
  if (fifoIdx !== -1) permissionFIFO.splice(fifoIdx, 1);
  if (socketServer) socketServer.removeSession(sessionId);
  updateActiveSession();
}

/**
 * FIFO先頭のPermissionセッションを最前面にする
 * Permission待ちがなければ全ウィンドウ同レベル
 */
function updateActiveSession() {
  const activeSessionId = permissionFIFO.length > 0 ? permissionFIFO[0] : null;
  let activeWin = null;
  for (const [sessionId, win] of windows) {
    if (!win.isDestroyed()) {
      if (activeSessionId && sessionId === activeSessionId) {
        win.setAlwaysOnTop(true, 'screen-saver');
        activeWin = win;
      } else {
        win.setAlwaysOnTop(true, 'floating');
      }
    }
  }
  // FIFO先頭ウィンドウを確実に最前面に持ってくる
  if (activeWin) {
    activeWin.moveTop();
  }
}

/**
 * ショートカットイベントをFIFO先頭のセッションウィンドウに送信
 */
function sendShortcutToActiveSession(channel) {
  if (permissionFIFO.length === 0) return;
  const activeSessionId = permissionFIFO[0];
  const win = windows.get(activeSessionId);
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel);
  }
}

function registerPermissionShortcuts() {
  globalShortcut.unregisterAll();
  globalShortcut.register('Ctrl+Shift+Y', () => sendShortcutToActiveSession('shortcut-allow'));
  globalShortcut.register('Ctrl+Shift+N', () => sendShortcutToActiveSession('shortcut-deny'));
  globalShortcut.register('Ctrl+Shift+A', () => sendShortcutToActiveSession('shortcut-always-allow'));
}

function setupIPC() {
  // レンダラーからのマウスイベント制御（sender経由でウィンドウ特定）
  ipcMain.on('set-ignore-mouse', (event, ignore) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  // ウィンドウ位置の取得・設定（ドラッグ移動用）
  ipcMain.handle('get-window-position', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.getPosition() : [0, 0];
  });

  ipcMain.on('set-window-position', (event, x, y) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setPosition(x, y);
    }
  });

  // ウィンドウを上方向に拡張（吹き出し表示用）
  const EXPANDED_WIN_HEIGHT = 550;
  const COMPACT_WIN_HEIGHT = 340;

  ipcMain.on('expand-window', (event, targetHeight) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      const expandTo = Math.min(targetHeight || EXPANDED_WIN_HEIGHT, EXPANDED_WIN_HEIGHT);
      const diff = expandTo - bounds.height;
      if (diff > 0) {
        win.setBounds({ x: bounds.x, y: bounds.y - diff, width: bounds.width, height: expandTo });
      }
    }
  });

  ipcMain.on('compact-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      const diff = bounds.height - COMPACT_WIN_HEIGHT;
      if (diff > 0) {
        win.setBounds({ x: bounds.x, y: bounds.y + diff, width: bounds.width, height: COMPACT_WIN_HEIGHT });
      }
    }
  });

  // Permission Requestレスポンス
  ipcMain.on('permission-response', (_event, response) => {
    console.log('Permission response received:', JSON.stringify(response));
    if (socketServer) {
      socketServer.sendResponse(response);
    }
  });

  // 右クリックコンテキストメニュー
  ipcMain.on('show-context-menu', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const sessionId = getSessionIdFromSender(event.sender);

    const template = [
      {
        label: '吹き出しを消す',
        click: () => {
          if (win && !win.isDestroyed()) {
            win.webContents.send('hide-bubble');
          }
        },
      },
      { type: 'separator' },
      {
        label: '再起動',
        click: () => {
          app.relaunch();
          app.exit(0);
        },
      },
      { type: 'separator' },
    ];

    // セッション別の「このずんだもんを終了」
    if (sessionId && sessionId !== 'default') {
      template.push({
        label: 'このずんだもんを終了',
        click: () => removeSession(sessionId),
      });
      template.push({ type: 'separator' });
    }

    template.push({
      label: '終了',
      click: () => app.quit(),
    });

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win });
  });
}

function startSocketServer() {
  socketServer = new SocketServer({
    onMessage: (sessionId, channel, data) => {
      const win = windows.get(sessionId);
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
      // メッセージ送信後にPermission先頭を最前面に再適用
      if (permissionFIFO.length > 0) {
        updateActiveSession();
      }
    },
    onSessionStart: (sessionId, info) => {
      console.log(`Session started: ${sessionId}`, info);
      createSessionWindow(sessionId, info);
    },
    onSessionEnd: (sessionId) => {
      console.log(`Session ended: ${sessionId}`);
      removeSession(sessionId);
    },
    onPermissionRequest: (sessionId) => {
      // FIFOに追加（まだ含まれていなければ）
      if (!permissionFIFO.includes(sessionId)) {
        permissionFIFO.push(sessionId);
      }
      updateActiveSession();
    },
    onSessionPermissionsDismiss: (sessionId) => {
      // 特定セッションのPermissionが全て解消 → FIFOから除去
      const idx = permissionFIFO.indexOf(sessionId);
      if (idx !== -1) {
        permissionFIFO.splice(idx, 1);
        updateActiveSession();
      }
    },
    onAllPermissionsDismiss: () => {
      permissionFIFO.length = 0;
      updateActiveSession();
    },
  });
  socketServer.start();
}

/**
 * セッションGC: 最後のメッセージ受信から一定時間経過したセッションを破棄する
 * hookのPIDは一時プロセスなのでPID生存確認は使えない。
 * 代わりにSessionEnd hookとタイムアウトベースのGCで管理する。
 */
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5分間メッセージなしでGC
let gcInterval;
function startSessionGC() {
  gcInterval = setInterval(() => {
    if (!socketServer) return;
    const now = Date.now();
    for (const sessionId of socketServer.getAllSessionIds()) {
      if (sessionId === 'default') continue;
      const session = socketServer.getSession(sessionId);
      if (!session) continue;
      // pending接続がある場合はGCしない（Permission待ち中）
      if (session.pendingConnections.size > 0) continue;
      // 最終メッセージ時刻からタイムアウト経過でGC
      if (session.lastMessageAt && (now - session.lastMessageAt) > SESSION_TIMEOUT_MS) {
        console.log(`Session GC: session ${sessionId} timed out, removing`);
        removeSession(sessionId);
      }
    }
  }, 30000); // 30秒間隔でチェック
}

app.whenReady().then(() => {
  // アプリ名とアイコンを設定
  app.setName('ずんだもん通知');
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (process.platform === 'darwin') {
    app.dock.setIcon(iconPath);
  }

  setupIPC();
  startSocketServer();
  startSessionGC();
  // ショートカット登録を遅延実行（macOSアクセシビリティの準備完了を待つ必要がある）
  setTimeout(() => registerPermissionShortcuts(), 3000);
});

app.on('window-all-closed', () => {
  // 新セッションが来る可能性があるのでquitしない
});

app.on('before-quit', () => {
  if (gcInterval) clearInterval(gcInterval);
  if (socketServer) {
    socketServer.stop();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
