/**
 * Lets the browser handle input and painting, then continues.
 * Uses a message channel because timers are throttled to once per second in background tabs,
 * which would make a long export crawl as soon as the window loses focus.
 */
export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Returns a function that runs `fn` once, `delay` milliseconds after the last call. */
export function debounce(fn: () => void, delay: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}
