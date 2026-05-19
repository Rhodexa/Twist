const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')

function createWindow() {
    const win = new BrowserWindow({
        width:           1440,
        height:          900,
        minWidth:        800,
        minHeight:       600,
        backgroundColor: '#1e1e1e',
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false
        }
    })

    win.setMenuBarVisibility(false)
    win.loadFile('index.html')

    if (process.argv.includes('--dev')) {
        win.webContents.openDevTools({ mode: 'detach' })

        // Make Ctrl+R do a hard reload (cache-busting) so CSS/JS edits
        // show up immediately without needing Ctrl+Shift+R.
        win.webContents.on('before-input-event', (event, input) => {
            if (input.control && !input.shift && input.key === 'r') {
                event.preventDefault()
                win.webContents.reloadIgnoringCache()
            }
        })
    }
}

app.whenReady().then(() => {
    // Block all external network access. Twist is a local tool.
    // Allows: file:, devtools:, blob:, data: — blocks: http(s):, ws(s):, ftp:
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const blocked = /^https?:|^wss?:|^ftp:/i.test(details.url)
        callback({ cancel: blocked })
    })

    createWindow()
})

// No macOS handling — Twist targets Linux and Windows only.
app.on('window-all-closed', () => app.quit())
