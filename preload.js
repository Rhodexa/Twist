const { contextBridge, ipcRenderer } = require('electron')

// Expose a minimal, explicit API to the renderer.
// Only add here when a feature actually needs Node/OS access.
contextBridge.exposeInMainWorld('twist', {
    platform: process.platform,

    // Twist project I/O
    openProject: ()                    => ipcRenderer.invoke('twist:openProject'),
    saveProject: (projectData, suggestedPath) => ipcRenderer.invoke('twist:saveProject', projectData, suggestedPath),

    // FLA import
    openFla: () => ipcRenderer.invoke('fla:open'),
})
