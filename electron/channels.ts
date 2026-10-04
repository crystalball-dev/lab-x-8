/** Names of the messages between the desktop shell and the page. */
export const CHANNEL = {
  info: 'desktop:info',
  readState: 'desktop:state:read',
  writeState: 'desktop:state:write',
  chooseExportFile: 'desktop:choose-export-file',
  showInFolder: 'desktop:show-in-folder',
  openExportFolder: 'desktop:open-export-folder',
  putPicture: 'desktop:picture:put',
  getPicture: 'desktop:picture:get',
  keepPictures: 'desktop:picture:keep',
} as const;

/** Facts about the running app that the page needs at startup. */
export interface ShellInfo {
  version: string;
  platform: string;
  portable: boolean;
  bridgeToken: string;
  exportDir: string;
}
