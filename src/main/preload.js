const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  selectWechatPath: () => ipcRenderer.invoke('select-wechat-path'),
  selectDatabaseFile: () => ipcRenderer.invoke('select-database-file'),
  onNavigate: (callback) => ipcRenderer.on('navigate', (_, page) => callback(page)),
  onServerMessage: (callback) => ipcRenderer.on('server-message', (_, message) => callback(message)),
  quitApp: () => ipcRenderer.invoke('quit-app')
});
