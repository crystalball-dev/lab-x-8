import type { ParamStore } from '../params/ParamStore';
import { CUSTOM_PALETTE, findPalette } from '../params/palettes';
import { button, h } from '../util/dom';
import { storage } from '../util/storage';
import { createParamRow, type ParamRow } from './ParamRow';

const OPEN_KEY = 'visualizer.panel.open.v1';
/** Parameters whose value decides which controls are shown. */
const STRUCTURAL = new Set(['layers.a', 'layers.b', 'color.palette']);
/** Sections that start expanded on first launch. */
const DEFAULT_OPEN = ['tempo', 'layers', 'color', 'crt'];

export interface PanelActions {
  tapTempo(): void;
  loadImage(): void;
  useTestCard(): void;
  removeImage(): void;
  hasImage(): boolean;
}

interface Section {
  id: string;
  title: string;
  /** Parameter groups reset by the section's reset button. */
  groups: () => string[];
  build: (body: HTMLElement) => void;
}

/**
 * The control panel. Every slider, toggle and selector is generated from the parameter schema,
 * so new effects and parameters show up here without any UI code.
 */
export class Panel {
  readonly element: HTMLElement;
  private rows: ParamRow[] = [];
  private readonly bodies = new Map<string, HTMLElement>();
  private readonly sections: Section[];
  private readonly unsubscribe: () => void;
  private frame = 0;

  constructor(
    private readonly params: ParamStore,
    private readonly actions: PanelActions,
  ) {
    this.sections = this.describeSections();
    this.element = h('div', { class: 'panel-body' });

    const open = this.readOpen();
    for (const section of this.sections) {
      const body = h('div', { class: 'section-body' });
      this.bodies.set(section.id, body);
      const reset = h('button', {
        class: 'reset',
        text: 'reset',
        attrs: { type: 'button' },
        title: 'Reset this section to its defaults',
      });
      reset.addEventListener('click', (event) => {
        event.preventDefault();
        for (const group of section.groups()) this.params.resetGroup(group);
      });
      const details = h('details', { class: 'section' }, [
        h('summary', {}, [section.title, reset]),
        body,
      ]);
      details.open = open.includes(section.id);
      details.addEventListener('toggle', () => this.writeOpen());
      details.dataset.section = section.id;
      this.element.append(details);
    }
    this.rebuild();

    this.unsubscribe = params.subscribe((path) => {
      if (path === '*') {
        this.rebuild();
      } else if (STRUCTURAL.has(path)) {
        // These change which controls exist.
        this.rebuild();
      } else {
        for (const row of this.rows) if (row.path === path) row.refresh();
      }
    });
  }

  /** Rebuilds every section. Cheap enough to do on structural changes. */
  rebuild(): void {
    // Rebuilding replaces the control that has focus. Remember it so keyboard use keeps working,
    // for example when stepping through palettes with the arrow keys.
    const active = document.activeElement;
    const focused = active instanceof HTMLElement ? active.dataset.path : undefined;

    this.rows = [];
    for (const section of this.sections) {
      const body = this.bodies.get(section.id)!;
      body.replaceChildren();
      section.build(body);
    }

    if (focused) {
      this.element.querySelector<HTMLElement>(`[data-path="${focused}"]`)?.focus();
    }
  }

  /** Updates the live modulation markers, at a third of the frame rate. */
  tick(): void {
    if (this.frame++ % 3 !== 0) return;
    for (const row of this.rows) row.tick();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private addRows(body: HTMLElement, groupId: string, keys?: string[]): void {
    const group = this.params.groups.find((g) => g.id === groupId);
    if (!group) return;
    for (const def of group.params) {
      if (keys && !keys.includes(def.key)) continue;
      const row = createParamRow(this.params, `${groupId}.${def.key}`);
      this.rows.push(row);
      body.append(...row.elements);
    }
  }

  private addGenerator(body: HTMLElement, slot: string, shortId: string): void {
    if (shortId === 'none') return;
    const groupId = `gen.${shortId}`;
    const group = this.params.groups.find((g) => g.id === groupId);
    if (!group) return;
    body.append(h('div', { class: 'subhead', text: `${slot} · ${group.label}` }));
    this.addRows(body, groupId);
  }

  private describeSections(): Section[] {
    const p = this.params;
    const simple = (id: string, title: string): Section => ({
      id,
      title,
      groups: () => [id],
      build: (body) => this.addRows(body, id),
    });

    return [
      {
        id: 'tempo',
        title: 'Tempo',
        groups: () => ['tempo'],
        build: (body) => {
          this.addRows(body, 'tempo');
          body.append(
            h('div', { class: 'button-row' }, [
              button(
                'Tap tempo',
                () => this.actions.tapTempo(),
                '',
                'Tap with the beat, starting on the first beat of a bar (T)',
              ),
            ]),
            h('div', {
              class: 'note',
              text: 'Set the BPM of your track. With a file, beats count from the start of the file, so an export lines up exactly like the preview.',
            }),
          );
        },
      },
      {
        id: 'audio',
        title: 'Audio input',
        groups: () => ['audio'],
        build: (body) => {
          this.addRows(body, 'audio', ['gain', 'reactivity', 'smoothing', 'onsets', 'agc', 'volume']);

          body.append(h('div', { class: 'subhead', text: 'Sensitivity per band' }));
          this.addRows(body, 'audio', ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'high']);
        },
      },
      {
        id: 'layers',
        title: 'Patterns',
        groups: () => {
          const groups = ['layers', `gen.${p.str('layers.a')}`, 'motion'];
          if (p.str('layers.b') !== 'none') groups.push(`gen.${p.str('layers.b')}`);
          return groups;
        },
        build: (body) => {
          this.addRows(body, 'layers');
          this.addGenerator(body, 'Layer A', p.str('layers.a'));
          if (p.str('layers.b') !== p.str('layers.a')) {
            this.addGenerator(body, 'Layer B', p.str('layers.b'));
          }
          body.append(h('div', { class: 'subhead', text: 'Motion' }));
          this.addRows(body, 'motion');
        },
      },
      {
        id: 'image',
        title: 'Image',
        groups: () => ['image'],
        build: (body) => {
          body.append(
            h('div', { class: 'button-row' }, [
              button('Load image', () => this.actions.loadImage()),
              button('Test card', () => this.actions.useTestCard(), '', 'A generated TV test card'),
              button('Remove', () => this.actions.removeImage()),
            ]),
          );
          if (!this.actions.hasImage()) {
            body.append(
              h('div', {
                class: 'note',
                text: 'No image loaded. Load one here or drop a file onto the picture.',
              }),
            );
          }
          this.addRows(body, 'image');
        },
      },
      simple('feedback', 'Feedback'),
      {
        id: 'color',
        title: 'Colour',
        groups: () => ['color'],
        build: (body) => {
          const id = p.str('color.palette');
          const custom = id === CUSTOM_PALETTE;
          this.addRows(body, 'color', ['palette']);
          const strip = h('div', { class: 'palette-strip' });
          const paint = (): void => {
            const stops = custom
              ? ['custom1', 'custom2', 'custom3', 'custom4'].map((k) => p.str(`color.${k}`))
              : (findPalette(id)?.stops ?? []);
            strip.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
          };
          paint();
          body.append(strip);
          if (custom) {
            this.addRows(body, 'color', ['custom1', 'custom2', 'custom3', 'custom4']);
            // Keep the preview in step with the colour pickers.
            this.rows.push({ path: 'color.custom1', elements: [], refresh: paint, tick() {} });
            this.rows.push({ path: 'color.custom2', elements: [], refresh: paint, tick() {} });
            this.rows.push({ path: 'color.custom3', elements: [], refresh: paint, tick() {} });
            this.rows.push({ path: 'color.custom4', elements: [], refresh: paint, tick() {} });
          }
          this.addRows(body, 'color', [
            'exposure',
            'contrast',
            'saturation',
            'hue',
            'paletteMap',
            'posterize',
            'invert',
          ]);
        },
      },
      simple('glitch', 'Glitch'),
      simple('bloom', 'Bloom'),
      simple('crt', 'CRT'),
      {
        id: 'output',
        title: 'Output',
        groups: () => ['output', 'system'],
        build: (body) => {
          this.addRows(body, 'system');
          this.addRows(body, 'output');
        },
      },
    ];
  }

  private readOpen(): string[] {
    try {
      const raw = storage.get(OPEN_KEY);
      if (raw) return JSON.parse(raw) as string[];
    } catch {
      // Fall through to the defaults.
    }
    return DEFAULT_OPEN;
  }

  private writeOpen(): void {
    const open = [...this.element.querySelectorAll<HTMLDetailsElement>('details.section')]
      .filter((d) => d.open)
      .map((d) => d.dataset.section ?? '');
    storage.set(OPEN_KEY, JSON.stringify(open));
  }
}
