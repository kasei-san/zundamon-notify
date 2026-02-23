const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  onPermissionRequest: (callback) => ipcRenderer.on('permission-request', (_event, data) => callback(data)),
  onNotification: (callback) => ipcRenderer.on('notification', (_event, data) => callback(data)),
  onStop: (callback) => ipcRenderer.on('stop', (_event, data) => callback(data)),
  sendPermissionResponse: (response) => ipcRenderer.send('permission-response', response),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),
  onPermissionDismissed: (callback) => ipcRenderer.on('permission-dismissed', (_event, data) => callback(data)),
  onDismissBubble: (callback) => ipcRenderer.on('dismiss-bubble', () => callback()),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  onShortcutAllow: (callback) => ipcRenderer.on('shortcut-allow', () => callback()),
  onShortcutDeny: (callback) => ipcRenderer.on('shortcut-deny', () => callback()),
});
