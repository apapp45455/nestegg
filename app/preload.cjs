const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nestegg', {
  onState: cb => ipcRenderer.on('state', (_e, state) => cb(state)),
  onSay: cb => ipcRenderer.on('say', (_e, text) => cb(text)),
  moveTo: (x, y) => ipcRenderer.send('move', x, y),
  drop: () => ipcRenderer.send('drop'),
  setSolid: solid => ipcRenderer.send('solid', solid),
})

// 設定精靈用；每個呼叫回傳 { ok } 或 { error }
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args)
contextBridge.exposeInMainWorld('fubon', {
  status: invoke('fubon:status'),
  installSdk: invoke('fubon:install-sdk'),
  pickCert: invoke('fubon:pick-cert'),
  connect: invoke('fubon:connect'),
  sync: invoke('fubon:sync'),
  disconnect: invoke('fubon:disconnect'),
})
