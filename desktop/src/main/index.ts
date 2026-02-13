import {
  app,
  BrowserWindow,
  Menu,
  shell,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { join } from 'path'
import { arch, platform, release, tmpdir, version as osVersion } from 'os'
import { debugLog, resolveDefaultShell } from '@shared/platform'
import { registerIpcHandlers } from './ipc'
import { NotificationWatcher } from './notification-watcher'

let mainWindow: BrowserWindow | null = null
const notificationWatcher = new NotificationWatcher()

function createWindow(): void {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#13141b',
    show: false,
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // needed for node-pty IPC
    },
  }

  mainWindow = new BrowserWindow(windowOptions)

  // Show window when ready to avoid white flash (skip in tests)
  if (!process.env.CI_TEST) {
    mainWindow.on('ready-to-show', () => {
      mainWindow?.show()
    })
  }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName('Constellagent')

// Isolate test data so e2e tests never touch real app state
if (process.env.CI_TEST) {
  const { mkdtempSync } = require('fs')
  const { join } = require('path')
  const testData = mkdtempSync(join(require('os').tmpdir(), 'constellagent-test-'))
  app.setPath('userData', testData)
}

app.whenReady().then(() => {
  const detectedShell = resolveDefaultShell()
  debugLog('Startup info', {
    platform: platform(),
    release: release(),
    version: osVersion(),
    arch: arch(),
    detectedShell,
    tempDir: tmpdir(),
    appPaths: {
      appPath: app.getAppPath(),
      exe: app.getPath('exe'),
      home: app.getPath('home'),
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
      temp: app.getPath('temp'),
      logs: app.getPath('logs'),
    },
  })

  Menu.setApplicationMenu(null)

  registerIpcHandlers()
  notificationWatcher.start()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  notificationWatcher.stop()
})
