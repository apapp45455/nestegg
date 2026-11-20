const { contextBridge, ipcRenderer } = require('electron')

const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('nestegg', {
  onState: cb => ipcRenderer.on('state', (_e, state) => cb(state)),
  onSay: cb => ipcRenderer.on('say', (_e, text) => cb(text)),
  // The custom look (see skin.js): fetched once, then pushed whenever the appearance window saves
  skin: invoke('skin:get'),
  onSkin: cb => ipcRenderer.on('skin', (_e, skin) => cb(skin)),
  moveTo: (x, y) => ipcRenderer.send('move', x, y),
  drop: () => ipcRenderer.send('drop'),
  setSolid: solid => ipcRenderer.send('solid', solid),
})

// For the setup wizard; the first argument is the broker id (for example 'fubon'), and every call returns { ok } or { error }
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

// For the recurring plans window: get and set both return { today, plans } with each plan's count and total so far;
// set rejects invalid plans with a message that names the problem
contextBridge.exposeInMainWorld('plans', { get: invoke('plans:get'), set: invoke('plans:set') })

// For the appearance window: get returns the saved custom look ({} when there is none); set validates, saves and returns it
contextBridge.exposeInMainWorld('appearance', { get: invoke('skin:get'), set: invoke('skin:set') })
