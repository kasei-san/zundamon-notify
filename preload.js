const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  onPermissionRequest: (callback) => ipcRenderer.on('permission-request', (_event, data) => callback(data)),
  onNotification: (callback) => ipcRenderer.on('notification', (_event, data) => callback(data)),
  onStop: (callback) => ipcRenderer.on('stop', (_event, data) => callback(data)),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', (_event, data) => callback(data)),
  sendPermissionResponse: (response) => ipcRenderer.send('permission-response', response),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),
  onPermissionDismissed: (callback) => ipcRenderer.on('permission-dismissed', (_event, data) => callback(data)),
  onDismissBubble: (callback) => ipcRenderer.on('dismiss-bubble', () => callback()),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  onShortcutAllow: (callback) => ipcRenderer.on('shortcut-allow', () => callback()),
  onShortcutDeny: (callback) => ipcRenderer.on('shortcut-deny', () => callback()),
  onShortcutAlwaysAllow: (callback) => ipcRenderer.on('shortcut-always-allow', () => callback()),
  onHideBubble: (callback) => ipcRenderer.on('hide-bubble', () => callback()),
  // 吹き出し表示時のウィンドウ拡張/縮小
  expandWindow: (targetHeight) => ipcRenderer.send('expand-window', targetHeight),
  compactWindow: () => ipcRenderer.send('compact-window'),
  // マルチセッション用
  onSessionInfo: (callback) => ipcRenderer.on('session-info', (_event, data) => callback(data)),
  onSetActiveState: (callback) => ipcRenderer.on('set-active-state', (_event, data) => callback(data)),
});
