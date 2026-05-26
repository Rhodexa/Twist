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

// ── Twist project open ────────────────────────────────────────────────────
// Reads a .twist folder: project.json + all library/*.json files.
// Returns an assembled TwistProject object to the renderer.

ipcMain.handle('twist:openProject', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title:      'Open Twist Project',
        properties: ['openDirectory'],
        buttonLabel: 'Open',
    })
    if (canceled || !filePaths.length) return null

    const projectDir = filePaths[0]
    const projectFile = path.join(projectDir, 'project.json')

    if (!fs.existsSync(projectFile)) {
        return { error: `Not a Twist project — no project.json found in: ${projectDir}` }
    }

    let project
    try {
        project = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
    } catch (err) {
        return { error: `Failed to parse project.json: ${err.message}` }
    }

    // Read each library symbol file and replace the ID list with full objects.
    const libraryDir = path.join(projectDir, 'library')
    const symbols    = []

    for (const symId of (project.library ?? [])) {
        const symFile = path.join(libraryDir, `${symId}.json`)
        try {
            const sym = JSON.parse(fs.readFileSync(symFile, 'utf8'))
            symbols.push(sym)
        } catch (err) {
            console.warn(`[twist:openProject] could not read symbol ${symId}: ${err.message}`)
        }
    }

    // Assemble the final project object the renderer expects.
    const assembled = {
        version:  project.version,
        name:     project.name,
        camera:   project.camera,
        timeline: project.timeline,
        symbols,
        stage:    project.stage,
    }

    return { project: assembled, path: projectDir }
})

// ── Twist project save ────────────────────────────────────────────────────
// Writes a .twist folder: project.json + library/*.json per symbol.
// Accepts the assembled TwistProject object from the renderer.

ipcMain.handle('twist:saveProject', async (_, projectData, suggestedPath) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title:       'Save Twist Project',
        defaultPath: suggestedPath || path.join(app.getPath('documents'), 'untitled.twist'),
        buttonLabel: 'Save',
    })
    if (canceled || !filePath) return null

    try {
        // filePath is the chosen folder path (with or without .twist extension).
        const projectDir = filePath.endsWith('.twist') ? filePath : filePath + '.twist'
        const libraryDir = path.join(projectDir, 'library')

        fs.mkdirSync(libraryDir, { recursive: true })

        const libIds = (projectData.symbols ?? []).map(s => s.id)

        // Write each symbol to its own file.
        for (const sym of (projectData.symbols ?? [])) {
            fs.writeFileSync(
                path.join(libraryDir, `${sym.id}.json`),
                JSON.stringify(sym, null, 2),
                'utf8'
            )
        }

        // Write project.json (without inlined symbols — use ID list instead).
        const projectJson = {
            version:  projectData.version,
            name:     projectData.name,
            camera:   projectData.camera,
            timeline: projectData.timeline,
            library:  libIds,
            stage:    projectData.stage,
        }
        fs.writeFileSync(
            path.join(projectDir, 'project.json'),
            JSON.stringify(projectJson, null, 2),
            'utf8'
        )

        return { path: projectDir }
    } catch (err) {
        return { error: `Save failed: ${err.message}` }
    }
})

// No macOS handling — Twist targets Linux and Windows only.
app.on('window-all-closed', () => app.quit())
