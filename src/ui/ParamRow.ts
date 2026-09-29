import type { ParamStore } from '../params/ParamStore';
import { MOD_SOURCES, type FloatDef, type IntDef, type ModSourceId, type ParamDef } from '../params/types';
import { h, syncRangeFill } from '../util/dom';

/** A generated control for one parameter. */
export interface ParamRow {
  path: string;
  elements: HTMLElement[];
  /** Re-reads the stored value, after a preset load or an external change. */
  refresh(): void;
  /** Moves the live modulation marker. Called every few frames. */
  tick(): void;
}

function decimals(def: FloatDef | IntDef): number {
  if (def.type === 'int') return 0;
  const step = def.step ?? 0.01;
  return Math.max(0, Math.min(4, Math.ceil(-Math.log10(step))));
}

function sourceShort(id: ModSourceId): string {
  return MOD_SOURCES.find((s) => s.id === id)?.short ?? '';
}

function numberRow(params: ParamStore, path: string, def: FloatDef | IntDef): ParamRow {
  const digits = decimals(def);
  const step = def.type === 'int' ? 1 : (def.step ?? 0.01);
  const range = def.max - def.min;

  const slider = h('input', {
    attrs: { type: 'range', min: String(def.min), max: String(def.max), step: String(step) },
  });
  const value = h('input', {
    class: 'row-value',
    attrs: { type: 'number', min: String(def.min), max: String(def.max), step: String(step) },
  });
  slider.dataset.path = path;
  const marker = h('div', { class: 'mod-marker' });
  const label = h('label', {
    class: 'row-label',
    text: def.label,
    title: `${def.hint ? `${def.hint}\n` : ''}Double-click to reset`,
  });
  const modButton = h('button', {
    class: 'mod-btn',
    attrs: { type: 'button' },
    title: 'Audio modulation',
  });
  const row = h('div', { class: 'row' }, [
    label,
    h('div', { class: 'slider' }, [slider, marker]),
    value,
    params.canModulate(path) ? modButton : h('span'),
  ]);

  // --- modulation editor -------------------------------------------------------------------
  const sourceSelect = h(
    'select',
    {},
    MOD_SOURCES.map((s) => h('option', { text: s.label, attrs: { value: s.id } })),
  );
  const amount = h('input', { attrs: { type: 'range', min: '-1', max: '1', step: '0.01' } });
  const amountText = h('span');
  const editor = h('div', { class: 'mod-editor' }, [sourceSelect, amount, amountText]);
  editor.hidden = true;

  const writeMod = (): void => {
    const source = sourceSelect.value as ModSourceId;
    let depth = Number(amount.value);
    // Choosing a source with zero depth would do nothing, so start with a useful amount.
    if (source !== 'none' && depth === 0) depth = 0.25;
    params.setMod(path, source === 'none' ? null : { source, amount: depth });
  };

  const refresh = (): void => {
    const stored = params.get(path) as number;
    slider.value = String(stored);
    syncRangeFill(slider);
    if (document.activeElement !== value) value.value = stored.toFixed(digits);
    const mod = params.getMod(path);
    row.classList.toggle('modulated', mod !== null);
    modButton.textContent = mod ? sourceShort(mod.source) : '~';
    sourceSelect.value = mod?.source ?? 'none';
    amount.value = String(mod?.amount ?? 0);
    syncRangeFill(amount);
    amountText.textContent = (mod?.amount ?? 0).toFixed(2);
  };

  slider.addEventListener('input', () => params.set(path, Number(slider.value)));
  value.addEventListener('change', () => {
    params.set(path, Number(value.value));
    refresh();
  });
  label.addEventListener('dblclick', () => params.reset(path));
  modButton.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
  });
  sourceSelect.addEventListener('change', writeMod);
  amount.addEventListener('input', writeMod);

  refresh();
  return {
    path,
    elements: [row, editor],
    refresh,
    tick() {
      if (!params.getMod(path)) return;
      const position = range > 0 ? (params.num(path) - def.min) / range : 0;
      marker.style.setProperty('--mod', position.toFixed(3));
    },
  };
}

function simpleRow(params: ParamStore, path: string, def: ParamDef, control: HTMLElement, refresh: () => void): ParamRow {
  const label = h('label', {
    class: 'row-label',
    text: def.label,
    title: `${def.hint ? `${def.hint}\n` : ''}Double-click to reset`,
  });
  label.addEventListener('dblclick', () => params.reset(path));
  control.dataset.path = path;
  refresh();
  return {
    path,
    elements: [h('div', { class: 'row wide' }, [label, control])],
    refresh,
    tick() {},
  };
}

/** Builds the control that matches the parameter type. */
export function createParamRow(params: ParamStore, path: string): ParamRow {
  const def = params.def(path);
  switch (def.type) {
    case 'float':
    case 'int':
      return numberRow(params, path, def);
    case 'bool': {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.addEventListener('change', () => params.set(path, box.checked));
      return simpleRow(params, path, def, box, () => {
        box.checked = params.bool(path);
      });
    }
    case 'select': {
      const select = h(
        'select',
        {},
        def.options.map((o) => h('option', { text: o.label, attrs: { value: o.value } })),
      );
      select.addEventListener('change', () => params.set(path, select.value));
      return simpleRow(params, path, def, select, () => {
        select.value = params.str(path);
      });
    }
    case 'color': {
      const input = h('input', { attrs: { type: 'color' } });
      input.addEventListener('input', () => params.set(path, input.value));
      return simpleRow(params, path, def, input, () => {
        input.value = params.str(path);
      });
    }
  }
}
