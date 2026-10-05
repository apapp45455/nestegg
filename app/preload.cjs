const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nestegg', {
  onState: cb => ipcRenderer.on('state', (_e, state) => cb(state)),
  onSay: cb => ipcRenderer.on('say', (_e, text) => cb(text)),
  moveTo: (x, y) => ipcRenderer.send('move', x, y),
  drop: () => ipcRenderer.send('drop'),
  setSolid: solid => ipcRenderer.send('solid', solid),
})

// 設定精靈用；第一個參數是券商 id（例如 'fubon'），每個呼叫回傳 { ok } 或 { error }
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

// 寵物設定視窗用：get 回傳 { values, limits }，set 存檔後回傳實際採用的值（不合理的會換成預設）
contextBridge.exposeInMainWorld('petSettings', { get: invoke('settings:get'), set: invoke('settings:set') })
