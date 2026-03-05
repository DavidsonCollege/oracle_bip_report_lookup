const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcmAPI', {
  budgetReport: (params) => ipcRenderer.invoke('hcm:budgetReport', params),
  getSettings : ()       => ipcRenderer.invoke('hcm:getSettings'),
  saveSettings: (params) => ipcRenderer.invoke('hcm:saveSettings', params),
  openExternal: (url)    => ipcRenderer.invoke('shell:openExternal', url),
});
