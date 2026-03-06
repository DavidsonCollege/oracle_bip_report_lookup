const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hcmAPI', {
  budgetReport    : (params) => ipcRenderer.invoke('hcm:budgetReport', params),
  getReportParams : (params) => ipcRenderer.invoke('hcm:getReportParams', params),
  getSettings : ()       => ipcRenderer.invoke('hcm:getSettings'),
  saveSettings: (params) => ipcRenderer.invoke('hcm:saveSettings', params),
  openExternal: (url)    => ipcRenderer.invoke('shell:openExternal', url),
});
