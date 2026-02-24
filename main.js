const { app, BrowserWindow, screen, ipcMain, Menu, globalShortcut } = require('electron');
const path = require('path');
const { SocketServer } = require('./src/socket-server');

let mainWindow;
let socketServer;

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const winWidth = 400;
  const winHeight = 500;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: screenWidth - winWidth,
    y: screenHeight - winHeight,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 吹き出し非表示時はクリックスルー
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // レンダラーからのマウスイベント制御
  ipcMain.on('set-ignore-mouse', (_event, ignore) => {
    mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });

  // ウィンドウ位置の取得・設定（ドラッグ移動用）
  ipcMain.handle('get-window-position', () => mainWindow.getPosition());
  ipcMain.on('set-window-position', (_event, x, y) => mainWindow.setPosition(x, y));

  // Permission Requestレスポンス
  ipcMain.on('permission-response', (_event, response) => {
    console.log('Permission response received:', JSON.stringify(response));
    if (socketServer) {
      socketServer.sendResponse(response);
    }
  });

  // 右クリックコンテキストメニュー
  ipcMain.on('show-context-menu', () => {
    const template = [
      {
        label: '再起動',
        click: () => {
          app.relaunch();
          app.exit(0);
        },
      },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          app.quit();
        },
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // デバッグ用: Cmd+Shift+I でDevTools
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.meta && input.shift && input.key === 'i') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // UDSサーバー起動（コールバック方式）
  socketServer = new SocketServer({
    onMessage: (_sessionId, channel, data) => {
      // 全メッセージをmainWindowにルーティング（シングルウィンドウ）
      mainWindow.webContents.send(channel, data);
    },
    onSessionStart: (sessionId, info) => {
      console.log(`Session started: ${sessionId}`, info);
    },
    onSessionEnd: (sessionId) => {
      console.log(`Session ended: ${sessionId}`);
    },
    onPermissionRequest: () => {
      if (!globalShortcut.isRegistered('Ctrl+Shift+Y')) {
        registerPermissionShortcuts();
      }
    },
    onAllPermissionsDismiss: () => unregisterPermissionShortcuts(),
  });
  socketServer.start();
}

function registerPermissionShortcuts() {
  globalShortcut.register('Ctrl+Shift+Y', () => {
    mainWindow.webContents.send('shortcut-allow');
  });
  globalShortcut.register('Ctrl+Shift+N', () => {
    mainWindow.webContents.send('shortcut-deny');
  });
  globalShortcut.register('Ctrl+Shift+A', () => {
    mainWindow.webContents.send('shortcut-always-allow');
  });
}

function unregisterPermissionShortcuts() {
  globalShortcut.unregister('Ctrl+Shift+Y');
  globalShortcut.unregister('Ctrl+Shift+N');
  globalShortcut.unregister('Ctrl+Shift+A');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (socketServer) {
    socketServer.stop();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (socketServer) {
    socketServer.stop();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
