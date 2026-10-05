const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nestegg', {
  onState: cb => ipcRenderer.on('state', (_e, state) => cb(state)),
  onSay: cb => ipcRenderer.on('say', (_e, text) => cb(text)),
  moveTo: (x, y) => ipcRenderer.send('move', x, y),
  drop: () => ipcRenderer.send('drop'),
  setSolid: solid => ipcRenderer.send('solid', solid),
})

// For the setup wizard; the first argument is the broker id (for example 'fubon'), and every call returns { ok } or { error }
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args)
contextBridge.exposeInMainWorld('broker', {
  list: invoke('broker:list'),
  status: invoke('broker:status'),
  installSdk: invoke('broker:install-sdk'),
  pickCert: invoke('broker:pick-cert'),
  connect: invoke('broker:connect'),
  sync: invoke('broker:sync'),
  disconnect: invoke('broker:disconnect'),
})

// For the pet settings window: get returns { values, limits }; set saves and returns the values actually used (invalid ones become defaults)
contextBridge.exposeInMainWorld('petSettings', { get: invoke('settings:get'), set: invoke('settings:set') })
