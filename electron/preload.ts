/**
 * Preload script. Runs in the page's process before the app, with access to the messaging
 * channel of the shell but isolated from the page. It hands the page a small, fixed API and
 * nothing else: no Node, no file system, no way to run programs.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../src/platform/desktop';
import { CHANNEL, type ShellInfo } from './channels';

const info = ipcRenderer.sendSync(CHANNEL.info) as ShellInfo;
const state = ipcRenderer.sendSync(CHANNEL.readState) as Record<string, string>;

const api: DesktopApi = {
  version: info.version,
  platform: info.platform,
  portable: info.portable,
  bridgeToken: info.bridgeToken,
  exportDir: info.exportDir,
  readState: () => ({ ...state }),
  writeState: (key, value) => {
    ipcRenderer.send(CHANNEL.writeState, {
      key: String(key),
      value: value === null ? null : String(value),
    });
  },
  chooseExportFile: (suggestedName) =>
    ipcRenderer.invoke(CHANNEL.chooseExportFile, String(suggestedName)) as Promise<string | null>,
  showInFolder: (path) => ipcRenderer.send(CHANNEL.showInFolder, String(path)),
  openExportFolder: () => ipcRenderer.send(CHANNEL.openExportFolder),
};

contextBridge.exposeInMainWorld('desktop', api);
