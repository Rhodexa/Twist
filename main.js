const { app, BrowserWindow, ipcMain, dialog, session } = require('electron')
const path   = require('path')
const fs     = require('fs')
const fflate = require('fflate')

let win = null

function createWindow() {
    win = new BrowserWindow({
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

// ── FLA import ────────────────────────────────────────────────────────────

ipcMain.handle('fla:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title:      'Open FLA',
        filters:    [{ name: 'Flash Animation', extensions: ['fla'] }],
        properties: ['openFile']
    })
    if (canceled || !filePaths.length) return null

    const buf   = fs.readFileSync(filePaths[0])
    const magic = Array.from(buf.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    const isZip = buf[0] === 0x50 && buf[1] === 0x4B   // PK magic

    if (!isZip) {
        return { error: `not a ZIP-based FLA — magic bytes: ${magic}`, magic, path: filePaths[0] }
    }

    let zip
    try {
        zip = fflate.unzipSync(new Uint8Array(buf))
    } catch (err) {
        return { error: `ZIP parse failed: ${err.message}`, magic, path: filePaths[0] }
    }

    const entries = Object.keys(zip).sort()

    // DOMDocument.xml is the main scene XML in every FLA
    const domBytes = zip['DOMDocument.xml']
    const dom      = domBytes ? new TextDecoder().decode(domBytes) : null

    // Library symbol XMLs — decode all of them for the importer
    const libEntries = entries.filter(e => e.startsWith('LIBRARY/') && e.endsWith('.xml'))
    const libXmls    = {}
    for (const key of libEntries) {
        if (zip[key]) libXmls[key] = new TextDecoder().decode(zip[key])
    }

    return { path: filePaths[0], magic, entries, dom, libEntries, libXmls }
})

// No macOS handling — Twist targets Linux and Windows only.
app.on('window-all-closed', () => app.quit())
