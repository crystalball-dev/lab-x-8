import './ui/styles.css';
import { App } from './app/App';
import { h } from './util/dom';

const root = document.getElementById('app')!;

try {
  const app = new App(root);
  // Exposed for debugging from the browser console.
  (window as unknown as { visualizer: App }).visualizer = app;
} catch (error) {
  console.error(error);
  root.append(
    h('div', { class: 'start' }, [
      h('div', { class: 'start-card' }, [
        h('h1', { text: 'CANNOT START' }),
        h('p', { text: error instanceof Error ? error.message : String(error) }),
      ]),
    ]),
  );
}
