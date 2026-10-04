/**
 * The desktop shell, as seen from the app.
 *
 * When the app runs inside the desktop application, the shell's preload script puts this
 * object on `window.desktop`. In an ordinary browser it is absent and the app uses web
 * facilities instead. Nothing else in the app knows which of the two it is running in.
 */
export interface DesktopApi {
  /** Version of the desktop application. */
  readonly version: string;
  readonly platform: string;
  /** True when settings and exports are kept next to the executable. */
  readonly portable: boolean;
  /** Secret that every request to the export bridge has to carry. */
  readonly bridgeToken: string;
  /** Folder that receives exports by default. */
  readonly exportDir: string;

  /** Everything stored so far. Read once at startup. */
  readState(): Record<string, string>;
  /** Stores a value in the settings file, or removes it when `value` is null. */
  writeState(key: string, value: string | null): void;

  /**
   * Opens the system's save dialog.
   * @returns the chosen path, or null when the dialog was dismissed
   */
  chooseExportFile(suggestedName: string): Promise<string | null>;
  /** Reveals an exported file in the file manager. */
  showInFolder(path: string): void;
  openExportFolder(): void;

  /**
   * Keeps a copy of a picture file in the data folder.
   * @returns its id, or null when it is not a picture or too large
   */
  putPicture(bytes: Uint8Array): Promise<string | null>;
  /** A kept picture, or null when there is none by that id. */
  getPicture(id: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Deletes every kept picture not in `ids`. Resolves with how many went. */
  keepPictures(ids: string[]): Promise<number>;
}

function find(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  return (window as { desktop?: DesktopApi }).desktop ?? null;
}

/** The desktop shell, or null in a browser. */
export const desktop: DesktopApi | null = find();
