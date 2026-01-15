const { app, BrowserWindow, ipcMain, Menu, Tray, dialog, nativeImage } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');

let mainWindow;
let tray;
let serverProcess;

// Server port
const SERVER_PORT = 3847;

function createWindow() {
  const iconPath = path.join(__dirname, '../../public/icon.png');
  console.log('Icon path:', iconPath);
  console.log('Icon exists:', fs.existsSync(iconPath));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: iconPath,
    title: '微信AI助手',
    show: false
  });

  // Load the main HTML file
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window close - minimize to tray
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Create system tray
  createTray();
}

function createTray() {
  const iconPath = path.join(__dirname, '../../public/icon.png');
  console.log('Tray icon path:', iconPath);
  
  try {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    
    const contextMenu = Menu.buildFromTemplate([
      { 
        label: '显示主窗口', 
        click: () => mainWindow.show() 
      },
      { 
        label: '设置', 
        click: () => {
          mainWindow.show();
          mainWindow.webContents.send('navigate', 'settings');
        }
      },
      { type: 'separator' },
      { 
        label: '退出', 
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('微信AI助手');
    tray.setContextMenu(contextMenu);
    
    tray.on('double-click', () => {
      mainWindow.show();
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function startServer() {
  const serverPath = path.join(__dirname, '../server/index.js');
  serverProcess = fork(serverPath, [], {
    env: { ...process.env, PORT: SERVER_PORT }
  });

  serverProcess.on('message', (message) => {
    console.log('Server message:', message);
    if (mainWindow) {
      mainWindow.webContents.send('server-message', message);
    }
  });

  serverProcess.on('error', (error) => {
    console.error('Server error:', error);
  });
}

// IPC Handlers
ipcMain.handle('get-server-port', () => SERVER_PORT);

ipcMain.handle('select-wechat-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择微信数据目录',
    properties: ['openDirectory']
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('select-database-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择微信数据库文件',
    properties: ['openFile'],
    filters: [
      { name: '数据库文件', extensions: ['db'] }
    ]
  });
  return result.filePaths[0] || null;
});

// App lifecycle
app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
  }
});
