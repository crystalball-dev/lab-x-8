import { desktop, type DesktopApi } from '../platform/desktop';
import { MAX_PICTURE_BYTES, hex, pictureExtension, pictureMime } from '../util/pictureFiles';

/**
 * Copies of the pictures that presets and the session use, so a look keeps its pictures when
 * the originals move. A picture is named by its content, so the same one is kept once.
 */
export interface PictureStore {
  /** Keeps a picture file. Resolves with its id, or null when it cannot be kept. */
  put(file: Blob): Promise<string | null>;
  /** A kept picture, or null when there is none by that id. */
  get(id: string): Promise<Blob | null>;
  /** Forgets every kept picture that is not in `ids`. */
  keepOnly(ids: Iterable<string>): Promise<void>;
}

/** The id the desktop shell gives the same bytes: their SHA-256 and the picture's type. */
async function idOf(bytes: Uint8Array<ArrayBuffer>): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES) return null;
  const extension = pictureExtension(bytes);
  if (!extension) return null;
  return `${hex(await crypto.subtle.digest('SHA-256', bytes))}.${extension}`;
}

/** Kept in the data folder of the desktop application. */
class DesktopPictures implements PictureStore {
  constructor(private readonly shell: DesktopApi) {}

  async put(file: Blob): Promise<string | null> {
    return this.shell.putPicture(new Uint8Array(await file.arrayBuffer()));
  }

  async get(id: string): Promise<Blob | null> {
    const bytes = await this.shell.getPicture(id);
    return bytes ? new Blob([bytes], { type: pictureMime(id) }) : null;
  }

  async keepOnly(ids: Iterable<string>): Promise<void> {
    await this.shell.keepPictures([...ids]);
  }
}

const DATABASE = 'lab-x-8';
const STORE = 'pictures';

/** Kept in the browser's IndexedDB. */
class BrowserPictures implements PictureStore {
  private database: Promise<IDBDatabase> | null = null;

  async put(file: Blob): Promise<string | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await idOf(bytes);
    if (!id) return null;
    await this.request('readwrite', (store) => store.put(new Blob([bytes], { type: pictureMime(id) }), id));
    return id;
  }

  async get(id: string): Promise<Blob | null> {
    const found = await this.request('readonly', (store) => store.get(id));
    return found instanceof Blob ? found : null;
  }

  async keepOnly(ids: Iterable<string>): Promise<void> {
    const keep = new Set(ids);
    const all = (await this.request('readonly', (store) => store.getAllKeys())) as IDBValidKey[];
    for (const key of all) {
      if (typeof key === 'string' && !keep.has(key)) await this.request('readwrite', (store) => store.delete(key));
    }
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('The picture store could not be opened.'));
    });
    return this.database;
  }

  private async request(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = run(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('The picture store failed.'));
    });
  }
}

/** Kept for this session only, where there is no storage at all. */
class MemoryPictures implements PictureStore {
  private readonly pictures = new Map<string, Blob>();

  async put(file: Blob): Promise<string | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = await idOf(bytes);
    if (id) this.pictures.set(id, new Blob([bytes], { type: pictureMime(id) }));
    return id;
  }

  async get(id: string): Promise<Blob | null> {
    return this.pictures.get(id) ?? null;
  }

  async keepOnly(ids: Iterable<string>): Promise<void> {
    const keep = new Set(ids);
    for (const id of this.pictures.keys()) if (!keep.has(id)) this.pictures.delete(id);
  }
}

export function createPictureStore(): PictureStore {
  if (desktop) return new DesktopPictures(desktop);
  if (typeof indexedDB !== 'undefined') return new BrowserPictures();
  return new MemoryPictures();
}
