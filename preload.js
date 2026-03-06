const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bipAPI', {
  runReport       : (params) => ipcRenderer.invoke('bip:runReport', params),
  getReportParams : (params) => ipcRenderer.invoke('bip:getReportParams', params),
  getSettings     : ()       => ipcRenderer.invoke('bip:getSettings'),
  saveSettings    : (params) => ipcRenderer.invoke('bip:saveSettings', params),
  openExternal    : (url)    => ipcRenderer.invoke('shell:openExternal', url),
});
