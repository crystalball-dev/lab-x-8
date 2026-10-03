import { IMAGE_LAYERS } from '../effects/stages';
import type { ParamStore } from '../params/ParamStore';
import { CUSTOM_PALETTE, findPalette } from '../params/palettes';
import { CUSTOM_RESOLUTION } from '../params/schema';
import { button, h } from '../util/dom';
import { storage } from '../util/storage';
import { createParamRow, type ParamRow } from './ParamRow';

const OPEN_KEY = 'lab-x-8.panel.open.v1';
/** Carries the number of an image layer while it is dragged to another place. */
const LAYER_DRAG = 'application/x-lab-x-8-layer';
/** Sections that start expanded on first launch. */
const DEFAULT_OPEN = ['tempo', 'layers', 'color', 'crt'];

/** What the panel shows of the picture in an image layer. */
export interface LayerPicture {
  name: string;
  /** A small preview, as a URL. */
  thumbnail: string;
}

export interface PanelActions {
  tapTempo(): void;
  /** Asks for a picture to put into an image layer. */
  loadImage(layer: number): void;
  /** Asks for pictures to put into the empty image layers. */
  addImages(): void;
  /** Pictures dropped on an image layer: the first goes into it, the rest into empty layers. */
  dropImages(files: File[], layer: number): void;
  useTestCard(layer: number): void;
  removeImage(layer: number): void;
  /** Removes the pictures from every image layer. */
  clearImages(): void;
  /** Moves an image layer to another place in the drawing order, with its settings. */
  moveLayer(from: number, to: number): void;
  /** Puts a copy of an image layer directly above it. */
  duplicateLayer(layer: number): void;
  /** The picture in an image layer, or null when the layer is empty. */
  picture(layer: number): LayerPicture | null;
  /** Changes whenever a picture is loaded, removed or moved. */
  pictureRevision(): number;
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
  /** The image layer whose settings the Image section shows. */
  private selectedLayer = 0;
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

  /** The image layer selected in the Image section. */
  get imageLayer(): number {
    return this.selectedLayer;
  }

  /** Opens the Image section on an image layer. */
  showImageLayer(layer: number): void {
    this.selectedLayer = layer;
    const details = this.details.get('image')!;
    if (details.open) {
      this.build(this.sections.find((s) => s.id === 'image')!);
    } else {
      // Built by the toggle handler, once the section has opened.
      this.built.delete('image');
      details.open = true;
    }
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

  /** Rows for the parameters of a group: all of them, or those in `keys` in that order. */
  private addRows(body: HTMLElement, groupId: string, keys?: string[]): void {
    const group = this.params.groups.find((g) => g.id === groupId);
    if (!group) return;
    for (const key of keys ?? group.params.map((def) => def.key)) {
      if (!group.params.some((def) => def.key === key)) continue;
      const row = createParamRow(this.params, `${groupId}.${key}`);
      this.building.push(row);
      body.append(...row.elements);
    }
  }

  /**
   * Every image layer, in drawing order: later layers draw over earlier ones. Selecting one
   * shows its settings, and dragging one to another place moves it there.
   */
  private addLayerGrid(body: HTMLElement): void {
    const count = IMAGE_LAYERS.length;
    const used = IMAGE_LAYERS.filter((_, i) => this.actions.picture(i)).length;
    const cells = IMAGE_LAYERS.map((layer, i) => {
      const picture = this.actions.picture(i);
      const hidden = !this.params.bool(`${layer.id}.visible`);
      const state = picture ? `${picture.name}${hidden ? ', hidden' : ''}` : 'empty';
      const cell = h(
        'button',
        {
          class: `layer-cell${i === this.selectedLayer ? ' active' : ''}${picture ? '' : ' empty'}${hidden ? ' hidden-layer' : ''}`,
          title: `Layer ${i + 1}: ${state}`,
          attrs: { type: 'button', 'aria-pressed': String(i === this.selectedLayer) },
          on: { click: () => this.showImageLayer(i) },
        },
        [picture ? h('img', { attrs: { src: picture.thumbnail, alt: '' } }) : null, h('span', { text: String(i + 1) })],
      );
      if (picture) {
        cell.draggable = true;
        cell.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData(LAYER_DRAG, String(i));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
      }
      // A layer dragged from another place moves here. Picture files dropped here load into it.
      cell.addEventListener('dragover', (event) => {
        const types = event.dataTransfer?.types ?? [];
        if (!types.includes(LAYER_DRAG) && !types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer!.dropEffect = types.includes(LAYER_DRAG) ? 'move' : 'copy';
        cell.classList.add('drop-target');
      });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
      cell.addEventListener('drop', (event) => {
        cell.classList.remove('drop-target');
        const transfer = event.dataTransfer;
        if (!transfer) return;
        event.preventDefault();
        if (transfer.types.includes(LAYER_DRAG)) {
          const from = Number(transfer.getData(LAYER_DRAG));
          if (Number.isInteger(from) && from !== i) this.actions.moveLayer(from, i);
          return;
        }
        const files = [...transfer.files].filter((file) => file.type.startsWith('image/'));
        if (files.length > 0) this.actions.dropImages(files, i);
      });
      return cell;
    });

    const tools = h('div', { class: 'layer-tools' }, [h('span', { text: `${used} of ${count} in use` })]);
    if (used < count) {
      tools.append(
        h('button', {
          class: 'text-button',
          text: 'Add pictures',
          title: 'Several at once go into the empty layers in turn',
          attrs: { type: 'button' },
          on: { click: () => this.actions.addImages() },
        }),
      );
    }
    if (used > 1) {
      const clear = h('button', { class: 'text-button danger', text: 'Clear all', attrs: { type: 'button' } });
      let armed = 0;
      clear.addEventListener('click', () => {
        if (armed) {
          this.actions.clearImages();
          return;
        }
        // A second click within a few seconds clears, so one slip does not lose every picture.
        clear.textContent = `Click again to remove ${used}`;
        clear.classList.add('armed');
        armed = window.setTimeout(() => {
          armed = 0;
          clear.textContent = 'Clear all';
          clear.classList.remove('armed');
        }, 3000);
      });
      tools.append(clear);
    }
    body.append(h('div', { class: 'layer-grid', attrs: { role: 'group', 'aria-label': 'Image layers' } }, cells), tools);
  }

  /** The selected layer's picture, and its place in the drawing order. */
  private addLayerControls(body: HTMLElement): void {
    const count = IMAGE_LAYERS.length;
    const layer = this.selectedLayer;
    const picture = this.actions.picture(layer);
    body.append(
      h('div', { class: 'layer-name' }, [
        h('strong', { text: `Layer ${layer + 1}` }),
        h('span', { text: picture ? picture.name : 'Empty', title: picture?.name ?? '' }),
      ]),
    );
    if (!picture) {
      body.append(
        h('div', { class: 'button-row' }, [
          button('Load image', () => this.actions.loadImage(layer), '', `A picture for layer ${layer + 1}`),
          button('Test card', () => this.actions.useTestCard(layer), '', 'A generated TV test card'),
        ]),
        h('div', {
          class: 'note',
          text: `Layer ${layer + 1} is empty. Load a picture here, or add several at once, or drop them onto the screen: they fill the empty layers in turn. Transparent PNGs keep their transparency, which suits logos.`,
        }),
      );
      return;
    }
    const back = button('Back', () => this.actions.moveLayer(layer, layer - 1), '', `Draw under layer ${layer}`);
    back.disabled = layer === 0;
    const forward = button('Forward', () => this.actions.moveLayer(layer, layer + 1), '', `Draw over layer ${layer + 2}`);
    forward.disabled = layer === count - 1;
    body.append(
      h('div', { class: 'button-row' }, [
        back,
        forward,
        button('Duplicate', () => this.actions.duplicateLayer(layer), '', 'A copy with the same settings, right above this layer'),
      ]),
      h('div', { class: 'button-row' }, [
        button('Replace', () => this.actions.loadImage(layer), '', `Another picture for layer ${layer + 1}, with the same settings`),
        button('Test card', () => this.actions.useTestCard(layer), '', 'A generated TV test card'),
        button('Remove', () => this.actions.removeImage(layer), '', 'Empties the layer. Its settings stay.'),
      ]),
    );
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
        // The reset button resets the layer on show.
        groups: () => [IMAGE_LAYERS[this.selectedLayer]!.id],
        // The grid shows which layers are hidden.
        layout: () =>
          `${this.selectedLayer}:${this.actions.pictureRevision()}:${IMAGE_LAYERS.map((l) => Number(p.bool(`${l.id}.visible`))).join('')}`,
        build: (body) => {
          const layer = this.selectedLayer;
          const group = IMAGE_LAYERS[layer]!.id;
          this.addLayerGrid(body);
          this.addLayerControls(body);
          this.addRows(body, group, ['visible', 'placement', 'blend', 'opacity']);
          body.append(h('div', { class: 'subhead', text: 'Size and position' }));
          this.addRows(body, group, ['fit', 'scale', 'x', 'y', 'rotate', 'kaleido']);
          body.append(h('div', { class: 'subhead', text: 'Light' }));
          this.addRows(body, group, ['brightness', 'glow', 'shadow']);
          body.append(h('div', { class: 'subhead', text: 'Movement' }));
          this.addRows(body, group, ['glitch', 'split', 'warp', 'ripple', 'displace']);
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
        // Width and height only show for a custom size.
        layout: () => String(p.str('system.resolution') === CUSTOM_RESOLUTION),
        build: (body) => {
          const custom = p.str('system.resolution') === CUSTOM_RESOLUTION;
          this.addRows(body, 'system', ['resolution', ...(custom ? ['width', 'height'] : []), 'renderScale', 'fpsLimit', 'hud']);
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
