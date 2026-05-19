const { contextBridge, ipcRenderer } = require('electron')

// Expose a minimal, explicit API to the renderer.
// Only add here when a feature actually needs Node/OS access.
contextBridge.exposeInMainWorld('twist', {
    platform: process.platform,

    // File I/O — stubs until save/load is wired in main.js
    saveFile: (filePath, data) => ipcRenderer.invoke('file:save', filePath, data),
    openFile: (filePath)       => ipcRenderer.invoke('file:open', filePath),
})
