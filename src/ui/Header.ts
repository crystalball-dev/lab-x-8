import type { AudioEngine, EngineState, SourceKind } from '../audio/AudioEngine';
import type { PresetManager } from '../params/presets';
import { button, formatTime, h } from '../util/dom';

export interface HeaderActions {
  selectSource(kind: Exclude<SourceKind, 'none'>): void;
  openExport(): void;
  toggleRecording(): void;
  toggleFullscreen(): void;
  hidePanel(): void;
  randomize(): void;
  applyPreset(id: string): void;
  savePreset(name: string): void;
  deletePreset(id: string): void;
  importPreset(): void;
  exportPreset(): void;
}

/** Top of the control panel: input selection, transport, presets and the main actions. */
export class Header {
  readonly element: HTMLElement;
  private readonly sourceButtons = new Map<SourceKind, HTMLButtonElement>();
  private readonly playButton: HTMLButtonElement;
  private readonly trackName = h('span', { class: 'name', text: 'No audio' });
  private readonly trackTime = h('span', { text: '' });
  private readonly seek = h('input', {
    attrs: { type: 'range', min: '0', max: '1', step: '0.001', 'aria-label': 'Position' },
  });
  private readonly presetSelect = h('select', { attrs: { 'aria-label': 'Preset' } });
  private readonly presetName = h('input', {
    attrs: { type: 'text', placeholder: 'Preset name', maxlength: '40' },
  });
  private readonly recordButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private seeking = false;
  private frame = 0;

  constructor(
    private readonly audio: AudioEngine,
    private readonly presets: PresetManager,
    actions: HeaderActions,
  ) {
    const source = (kind: Exclude<SourceKind, 'none'>, label: string, title: string): HTMLButtonElement => {
      const b = button(label, () => actions.selectSource(kind), '', title);
      this.sourceButtons.set(kind, b);
      return b;
    };

    this.playButton = button('Play', () => audio.toggle(), '', 'Space');
    this.recordButton = button('Record', () => actions.toggleRecording(), 'danger', 'Record the live output in real time');
    this.deleteButton = button('Delete', () => actions.deletePreset(this.presetSelect.value));

    this.seek.addEventListener('pointerdown', () => (this.seeking = true));
    this.seek.addEventListener('change', () => {
      this.seeking = false;
      audio.seek(Number(this.seek.value) * audio.state.duration);
    });
    this.presetSelect.addEventListener('change', () => {
      actions.applyPreset(this.presetSelect.value);
      this.syncPresetButtons();
    });
    const save = (): void => {
      const name = this.presetName.value.trim();
      if (!name) {
        this.presetName.focus();
        return;
      }
      actions.savePreset(name);
      this.presetName.value = '';
    };
    this.presetName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save();
    });

    this.element = h('div', { class: 'panel-head' }, [
      h('div', { class: 'brand' }, ['VISUALIZER', h('small', { text: 'H hides this panel' })]),
      h('div', { class: 'button-row' }, [
        source('demo', 'Demo', 'Built-in 174 BPM loop'),
        source('file', 'File', 'Play an audio file'),
        source('mic', 'Input', 'Microphone or line input'),
        source('system', 'System', 'Capture what the computer is playing'),
      ]),
      h('div', { class: 'track' }, [this.playButton, this.trackName, this.seek, this.trackTime]),
      h('div', { class: 'button-row' }, [
        button('Export video', () => actions.openExport(), 'primary', 'E'),
        this.recordButton,
        button('Fullscreen', () => actions.toggleFullscreen(), '', 'F'),
      ]),
      h('div', { class: 'button-row' }, [
        this.presetSelect,
        button('Random', () => actions.randomize(), '', 'R'),
      ]),
      h('div', { class: 'button-row' }, [
        this.presetName,
        button('Save', save, '', 'Save the current look under this name'),
        this.deleteButton,
      ]),
      h('div', { class: 'button-row' }, [
        button('Import preset', () => actions.importPreset(), '', 'Load a look from a file'),
        button('Export preset', () => actions.exportPreset(), '', 'Save the current look as a file'),
      ]),
    ]);

    audio.subscribe((state) => this.syncAudio(state));
    this.syncAudio(audio.state);
    this.syncPresets();
  }

  /** Rebuilds the preset list. `selected` becomes the current entry. */
  syncPresets(selected?: string): void {
    const current = selected ?? this.presetSelect.value;
    const all = this.presets.all;
    this.presetSelect.replaceChildren(
      h('option', { text: 'Presets', attrs: { value: '' } }),
      h(
        'optgroup',
        { attrs: { label: 'Built in' } },
        all.filter((p) => p.builtIn).map((p) => h('option', { text: p.name, attrs: { value: p.id } })),
      ),
      h(
        'optgroup',
        { attrs: { label: 'Yours' } },
        all.filter((p) => !p.builtIn).map((p) => h('option', { text: p.name, attrs: { value: p.id } })),
      ),
    );
    this.presetSelect.value = all.some((p) => p.id === current) ? current : '';
    this.syncPresetButtons();
  }

  set recording(value: boolean) {
    this.recordButton.classList.toggle('active', value);
    this.recordButton.textContent = value ? 'Stop' : 'Record';
  }

  /** Moves the position indicator. Called every frame, acts a few times per second. */
  tick(): void {
    if (this.frame++ % 10 !== 0) return;
    const state = this.audio.state;
    if (state.duration > 0) {
      if (!this.seeking) this.seek.value = String(state.position / state.duration);
      this.trackTime.textContent = `${formatTime(state.position)} / ${formatTime(state.duration)}`;
    }
  }

  private syncPresetButtons(): void {
    const preset = this.presets.find(this.presetSelect.value);
    this.deleteButton.disabled = !preset || preset.builtIn;
  }

  private syncAudio(state: EngineState): void {
    for (const [kind, b] of this.sourceButtons) b.classList.toggle('active', kind === state.kind);
    const isTrack = state.duration > 0;
    this.playButton.disabled = !isTrack;
    this.playButton.textContent = state.playing && isTrack ? 'Pause' : 'Play';
    this.seek.disabled = !isTrack;
    this.trackName.textContent = state.kind === 'none' ? 'No audio' : state.label;
    this.trackName.title = state.label;
    if (!isTrack) {
      this.trackTime.textContent = state.kind === 'none' ? '' : 'live';
      this.seek.value = '0';
    }
  }
}
