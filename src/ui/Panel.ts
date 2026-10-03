import type { ParamStore } from '../params/ParamStore';
import { CUSTOM_PALETTE, findPalette } from '../params/palettes';
import { button, h } from '../util/dom';
import { storage } from '../util/storage';
import { createParamRow, type ParamRow } from './ParamRow';

const OPEN_KEY = 'lab-x-8.panel.open.v1';
/** Sections that start expanded on first launch. */
const DEFAULT_OPEN = ['tempo', 'layers', 'color', 'crt'];

export interface PanelActions {
  tapTempo(): void;
  loadImage(): void;
  useTestCard(): void;
  removeImage(): void;
  hasImage(): boolean;
  /** One line about the look cycle: what plays, what comes next and when. */
  cycleStatus(): string;
}

interface Section {
  id: string;
  title: string;
  /** Parameter groups reset by the section's reset button. */
  groups: () => string[];
  /**
   * What decides which controls the section shows, for example the chosen generators. The
   * section is rebuilt when it changes. Without it the controls never change.
   */
  layout?: () => string;
  build: (body: HTMLElement) => void;
}

/** A section's controls, and the layout they were built for. */
interface Built {
  layout: string;
  rows: ParamRow[];
}

/**
 * The control panel. Every slider, toggle and selector is generated from the parameter schema,
 * so new effects and parameters show up here without any UI code.
 *
 * Loading a preset changes most parameters at once, and the cycle does that during a set. So
 * a section is only rebuilt when its controls change, otherwise its rows update in place, and
 * a closed section is built when it is opened.
 */
export class Panel {
  readonly element: HTMLElement;
  private readonly sections: Section[];
  private readonly details = new Map<string, HTMLDetailsElement>();
  private readonly bodies = new Map<string, HTMLElement>();
  private readonly built = new Map<string, Built>();
  /** Built sections still to bring up to date after a bulk change. */
  private readonly stale = new Set<Section>();
  /** Rows collected while a section builds. */
  private building: ParamRow[] = [];
  private cycleStatus: HTMLElement | null = null;
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
      details.dataset.section = section.id;
      details.addEventListener('toggle', () => {
        if (details.open && !this.built.has(section.id)) this.build(section);
        this.writeOpen();
      });
      this.details.set(section.id, details);
      this.element.append(details);
      if (details.open) this.build(section);
    }

    this.unsubscribe = params.subscribe((path) => this.update(path));
  }

  /** Brings every section up to date, for changes the parameters do not show, such as a new image. */
  rebuild(): void {
    this.update('*');
  }

  /**
   * Catches up with bulk changes, moves the live modulation markers at a third of the frame
   * rate, and updates the cycle status.
   */
  tick(): void {
    this.frame++;
    if (this.stale.size > 0) {
      const open = [...this.stale].find((s) => this.details.get(s.id)!.open);
      const next = open ?? this.stale.values().next().value!;
      this.stale.delete(next);
      this.refresh(next, '*');
    }
    if (this.frame % 3 === 0) {
      for (const [id, built] of this.built) {
        if (this.details.get(id)!.open) for (const row of built.rows) row.tick();
      }
    }
    if (this.frame % 15 === 0 && this.cycleStatus && this.details.get('cycle')!.open) {
      this.cycleStatus.textContent = this.actions.cycleStatus();
    }
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** `path` is the parameter that changed, or `*` after a bulk change such as a preset. */
  private update(path: string): void {
    if (path === '*') {
      // A preset changes everything at once. The panel catches up one section per frame, so a
      // change of look never holds up the picture.
      for (const section of this.sections) if (this.built.has(section.id)) this.stale.add(section);
      return;
    }
    for (const section of this.sections) this.refresh(section, path);
  }

  private refresh(section: Section, path: string): void {
    const built = this.built.get(section.id);
    if (!built) return;
    if ((section.layout?.() ?? '') !== built.layout) {
      // Open sections are rebuilt now, closed ones when they are opened again.
      if (this.details.get(section.id)!.open) this.build(section);
      else this.built.delete(section.id);
      return;
    }
    for (const row of built.rows) if (path === '*' || row.path === path) row.refresh();
  }

  private build(section: Section): void {
    // Rebuilding replaces the control that has focus. Remember it so keyboard use keeps working,
    // for example when stepping through palettes with the arrow keys.
    const body = this.bodies.get(section.id)!;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && body.contains(active) ? active.dataset.path : undefined;

    this.building = [];
    body.replaceChildren();
    section.build(body);
    this.built.set(section.id, { layout: section.layout?.() ?? '', rows: this.building });

    if (focused) body.querySelector<HTMLElement>(`[data-path="${focused}"]`)?.focus();
  }

  private addRows(body: HTMLElement, groupId: string, keys?: string[]): void {
    const group = this.params.groups.find((g) => g.id === groupId);
    if (!group) return;
    for (const def of group.params) {
      if (keys && !keys.includes(def.key)) continue;
      const row = createParamRow(this.params, `${groupId}.${def.key}`);
      this.building.push(row);
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
        id: 'cycle',
        title: 'Cycle',
        groups: () => ['cycle'],
        // Random looks have no order to choose, and the button rolls instead of dealing.
        layout: () => String(p.str('cycle.pool') === 'random'),
        build: (body) => {
          const random = p.str('cycle.pool') === 'random';
          this.addRows(body, 'cycle', ['on', 'pool', ...(random ? [] : ['order']), 'bars', 'fade', 'style']);
          this.cycleStatus = h('div', { class: 'cycle-status', text: this.actions.cycleStatus() });
          body.append(
            this.cycleStatus,
            h('div', { class: 'button-row' }, [
              button(
                random ? 'Roll new looks' : 'Reshuffle',
                () => p.set('cycle.seed', Math.floor(Math.random() * 10000)),
                '',
                random ? 'A different series of random looks' : 'Deal the shuffled order again',
              ),
            ]),
            h('div', {
              class: 'note',
              text: 'Looks change on bar lines counted from the start of the track, so an export changes at the same moments as the preview. C turns the cycle on and off.',
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
        layout: () => `${p.str('layers.a')}|${p.str('layers.b')}`,
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
        layout: () => String(this.actions.hasImage()),
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
                text: 'No image loaded. Load one here or drop a file onto the picture. Transparent PNGs keep their transparency, which suits logos.',
              }),
            );
          }
          this.addRows(body, 'image', ['placement', 'blend', 'opacity']);
          body.append(h('div', { class: 'subhead', text: 'Size and position' }));
          this.addRows(body, 'image', ['fit', 'scale', 'x', 'y', 'rotate', 'kaleido']);
          body.append(h('div', { class: 'subhead', text: 'Light' }));
          this.addRows(body, 'image', ['brightness', 'glow', 'shadow']);
          body.append(h('div', { class: 'subhead', text: 'Movement' }));
          this.addRows(body, 'image', ['glitch', 'split', 'warp', 'ripple', 'displace']);
        },
      },
      simple('feedback', 'Feedback'),
      {
        id: 'color',
        title: 'Colour',
        groups: () => ['color'],
        layout: () => String(p.str('color.palette') === CUSTOM_PALETTE),
        build: (body) => {
          this.addRows(body, 'color', ['palette']);
          const strip = h('div', { class: 'palette-strip' });
          const paint = (): void => {
            const id = p.str('color.palette');
            const stops =
              id === CUSTOM_PALETTE
                ? ['custom1', 'custom2', 'custom3', 'custom4'].map((k) => p.str(`color.${k}`))
                : (findPalette(id)?.stops ?? []);
            strip.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
          };
          paint();
          body.append(strip);
          // The strip follows the palette and the colour pickers.
          for (const path of ['color.palette', 'color.custom1', 'color.custom2', 'color.custom3', 'color.custom4']) {
            this.building.push({ path, elements: [], refresh: paint, tick() {} });
          }
          if (p.str('color.palette') === CUSTOM_PALETTE) {
            this.addRows(body, 'color', ['custom1', 'custom2', 'custom3', 'custom4']);
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
    const open = [...this.details].filter(([, d]) => d.open).map(([id]) => id);
    storage.set(OPEN_KEY, JSON.stringify(open));
  }
}
