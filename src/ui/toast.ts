import { h } from '../util/dom';

let container: HTMLElement | null = null;

/** Places the toast area inside `parent`. Call once at startup. */
export function mountToasts(parent: HTMLElement): void {
  container = h('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  parent.append(container);
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  if (!container) return;
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`.trim(), text: message });
  container.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3200);
}

/** Shows the message of any thrown value. */
export function toastError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  toast(message, 'error');
}
