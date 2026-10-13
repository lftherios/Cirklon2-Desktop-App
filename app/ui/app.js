/* Cirklon2 Desktop App — frontend. All state lives here; the Rust core does
   parsing, validation, chart import and file I/O via IPC. */
'use strict';

const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const dlg = window.__TAURI__ ? window.__TAURI__.dialog : null;

// ---------------------------------------------------------------- state

const state = {
  library: { instruments: [] },
  sidecar: {},
  path: null,
  selected: 0,
  tab: 'setup',
  filter: '',
  ccFilter: '',
  dirty: false,
};

//undo/redo: whole-document snapshots, taken by checkpoint() before every edit
const edits = { undo: [], redo: [] };
const HISTORY_LIMIT = 100;

//re-rendering drops focus: an edit names the selector that should hold it afterwards
let focusAfterRender = null;
//which instrument + tab the panel last drew, so a redraw of the same view keeps its scroll
let panelView = '';
//what's being dragged, { kind: 'slot' | 'inst', from }. drags never leave this
//window, so a variable is simpler than sniffing dataTransfer during dragover
let drag = null;

// ---------------------------------------------------------------- constants

const NAME_MAX = 9;
const SLOTS = 180;
const IS_MAC = /Mac/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const NOTES = ['C ', 'C#', 'D ', 'D#', 'E ', 'F ', 'F#', 'G ', 'G#', 'A ', 'A#', 'B '];
const CONTROLS = [
  ['pgm', 'pgm', 'Sends a MIDI program change to pick a patch from the track. 0–127.'],
  ['quant', 'quant%', 'Live quantise for CK patterns — pulls playback onto the grid set by tbase, in tandem with Swing. On P3 patterns it scales step delays instead (100% = no delay). 0–100%.'],
  ['note-pct', 'note%', 'Stretches or squeezes pitch — transposes each note in proportion to its distance from the centre note (noteC, default C 4). 0–255%.'],
  ['note-c', 'noteC', 'Centre note for note% scaling. C 0–G 10.'],
  ['velo-pct', 'velo%', 'Expands or compresses dynamics — scales each velocity by its distance from the centre velocity (veloC). 0–255%.'],
  ['velo-c', 'veloC', 'Centre velocity for velo% scaling. 1–127.'],
  ['leng-pct', 'leng%', 'Scales note lengths. 0–2000%.'],
  ['tbase', 'tbase', 'Sets the grid spacing quant% snaps to, overriding the pattern default.'],
  ['xpos', 'xpos', 'Transposes in semitones. −12 to +12.'],
  ['octave', 'octave', 'Transposes in octaves. −4 to +4.'],
  ['knob1', 'knob1', 'The knob1 value read by knob mask and grab events in P3 patterns. 0–127.'],
  ['knob2', 'knob2', 'The knob2 value read by knob mask and grab events in P3 patterns. 0–127.'],
  ['fts-r', 'fts-R', "Root note for this track's own force-to-scale, applied separately from scene FTS. C–B."],
  ['fts-s', 'fts-S', "Scale for this track's force-to-scale — 'all' passes every note, same as scene FTS off."],
  ['reich', 'reich', "Steve Reich phasing — lengthens or shortens a CK pattern's loop by up to ±12 ticks so the track slowly drifts against the others."],
];
const PORTS = ['MIDI 1', 'MIDI 2', 'MIDI 3', 'MIDI 4', 'MIDI 5',
  'USB 1', 'USB 2', 'USB 3', 'USB 4', 'USB 5', 'USB 6'];
//[field, label, why, CKI key, inverted]. the two bank options read positively here,
//as on the hardware (CC0=bankM, CC32=bankL), but the file stores the negative
const FLAGS = [
  ['multi', 'Multi-timbral', 'Show a channel picker per track instead of defining this synth once per channel.', 'multi'],
  ['no_xpose', 'Ignore transpose', "Scene transpose won't shift this instrument — right for drums and clips.", 'no_xpose'],
  ['no_fts', 'Ignore force-to-scale', "FTS never re-pitches this instrument's notes.", 'no_fts'],
  ['no_thru', 'No edit-track thru', "Don't soft-thru incoming MIDI when this sits on the edit track.", 'no_thru'],
  ['no_bank_m', 'CC 0 = bank MSB', 'Send CC 0 as bank select with program changes, for synths with more than 128 patches. Untick if this synth uses CC 0 as an ordinary controller.', 'no_bankM', true],
  ['no_bank_l', 'CC 32 = bank LSB', 'The same for CC 32, the low half of bank select.', 'no_bankL', true],
  ['show_note_nums', 'Show note numbers', 'Pattern editors display 36 instead of C 2 — kinder to samplers.', 'show_note_nums'],
  ['presend_pgm', 'Pre-send program changes', 'Fire stored programs ahead of the scene switch, for slow groove-boxes.', 'presend_pgm'],
];

// ---------------------------------------------------------------- helpers

function noteName(id) {
  const oct = Math.floor(id / 12);
  return NOTES[((id % 12) + 12) % 12] + (oct === 10 ? 'X' : oct);
}
function controlLabel(kebab) {
  const found = CONTROLS.find(c => c[0] === kebab);
  return found ? found[1] : kebab;
}
function controlHelp(kebab) {
  const found = CONTROLS.find(c => c[0] === kebab);
  return found ? found[2] : '';
}
function portName(port) { return PORTS[port - 1] || 'port ' + port; }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function cur() { return state.library.instruments[state.selected] || null; }
function meta(name) {
  if (!state.sidecar[name]) state.sidecar[name] = { notes: '', cc_meta: {} };
  if (!state.sidecar[name].cc_meta) state.sidecar[name].cc_meta = {};
  return state.sidecar[name];
}
function renameMeta(oldName, newName) {
  if (oldName === newName || !state.sidecar[oldName]) return;
  state.sidecar[newName] = state.sidecar[oldName];
  delete state.sidecar[oldName];
}
//hardware names are nine characters: the counter has to fit inside that budget
function uniqueName(base) {
  const taken = new Set(state.library.instruments.map(i => i.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ' ' + n;
    const name = base.slice(0, NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!taken.has(name)) return name;
  }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
//opts.undo adds an Undo button, opts.error keeps it up long enough to read
function toast(msg, opts = {}) {
  const t = document.getElementById('toast');
  t.innerHTML = '';
  t.appendChild(el(`<span>${esc(msg)}</span>`));
  if (opts.undo) {
    const b = el('<button>Undo</button>');
    b.onclick = () => { t.classList.remove('show'); undo(); };
    t.appendChild(b);
  }
  t.className = 'show' + (opts.error ? ' err' : '') + (opts.undo ? ' undoable' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), opts.undo || opts.error ? 6000 : 2600);
}
function slotDesc(tv) {
  if (tv.kind === 'MidiCc') return tv.label || ('cc' + tv.cc);
  return controlLabel(tv.control);
}
//'cc:74' or 'tc:pgm' - one id space for everything a slot can hold
function valueId(tv) { return tv.kind === 'MidiCc' ? 'cc:' + tv.cc : 'tc:' + tv.control; }
function slotHolding(inst, id) {
  const hit = Object.entries(inst.track_values).find(([, tv]) => valueId(tv) === id);
  return hit ? +hit[0] : 0;
}

// ---------------------------------------------------------------- history

function snapshot() {
  //selection and tab ride along so undo lands where the edit was made
  return JSON.stringify({ library: state.library, sidecar: state.sidecar, path: state.path, selected: state.selected, tab: state.tab });
}
function setDirty(dirty) {
  if (state.dirty !== dirty) {
    state.dirty = dirty;
    if (invoke) invoke('set_dirty', { dirty });
  }
  renderChrome();
}
//call before every edit: the edit becomes undoable and the library unsaved
function checkpoint() {
  edits.undo.push(snapshot());
  if (edits.undo.length > HISTORY_LIMIT) edits.undo.shift();
  edits.redo.length = 0;
  //a toast's Undo button would now undo this newer edit instead of its own
  const t = document.getElementById('toast');
  if (t.classList.contains('undoable')) t.classList.remove('show');
  setDirty(true);
}
function timeTravel(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  Object.assign(state, JSON.parse(from.pop()));
  setDirty(state.library.instruments.length > 0);
  renderAll();
}
function undo() { timeTravel(edits.undo, edits.redo); }
function redo() { timeTravel(edits.redo, edits.undo); }

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderRail();
  const has = state.library.instruments.length > 0;
  document.getElementById('welcome').style.display = has ? 'none' : '';
  document.getElementById('editor').style.display = has ? 'flex' : 'none';
  renderChrome();
  if (has) { renderHead(); renderTabs(); renderPanel(); }
}

function renderChrome() {
  const has = state.library.instruments.length > 0;
  const crumb = document.getElementById('crumb');
  //folder + file: enough to tell the SD card from a backup without eliding the name
  const file = state.path ? state.path.split(/[\\/]/).slice(-2).join('/') : (has ? 'not exported yet' : 'no file loaded');
  crumb.innerHTML = esc(file) + (state.dirty ? '<span class="unsaved">unsaved changes</span>' : '');
  crumb.title = state.path || '';
  document.getElementById('btnUndo').disabled = !edits.undo.length;
  document.getElementById('btnRedo').disabled = !edits.redo.length;
  document.getElementById('btnPrepare').disabled = !has;
}

function renderRail() {
  const list = document.getElementById('railList');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const reorderable = !state.filter && state.library.instruments.length > 1;
  state.library.instruments.forEach((inst, i) => {
    if (state.filter && !inst.name.toLowerCase().includes(state.filter)) return;
    const sel = i === state.selected;
    const btn = el(`<button class="inst${sel ? ' sel' : ''}"${sel ? ' aria-current="true"' : ''}${reorderable ? ' draggable="true"' : ''}
      title="${esc(portName(inst.midi_port))} · channel ${inst.midi_channel}">
      <span class="nm">${esc(inst.name || 'unnamed')}</span>
      <span class="pc">${inst.midi_port}.${inst.midi_channel}</span></button>`);
    btn.dataset.i = i;
    btn.onclick = () => selectInstrument(i);
    btn.ondragstart = e => {
      drag = { kind: 'inst', from: i };
      e.dataTransfer.setData('text/plain', inst.name);
      e.dataTransfer.effectAllowed = 'move';
    };
    btn.ondragend = () => { drag = null; };
    btn.ondragover = e => {
      if (!drag || drag.kind !== 'inst') return;
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('dropbefore');
    };
    btn.ondragleave = () => btn.classList.remove('dropbefore');
    btn.ondrop = e => {
      e.preventDefault();
      e.stopPropagation();
      if (drag && drag.kind === 'inst') moveInstrument(drag.from, drag.from < i ? i - 1 : i);
    };
    list.appendChild(btn);
  });
  if (state.filter && !list.children.length) {
    list.appendChild(el(`<div class="rail-empty">No instrument matches “${esc(state.filter)}”.</div>`));
  }
  //rebuilding resets the scroll: put it back, then make sure the selection is on screen
  list.scrollTop = scroll;
  const sel = list.querySelector('.inst.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function renderHead() {
  const inst = cur();
  document.getElementById('instName').textContent = inst.name || 'unnamed';
  const n = inst.name.length;
  document.getElementById('nameBudget').innerHTML =
    `name <b class="${n > NAME_MAX ? 'over' : ''}">${n} / ${NAME_MAX}</b>`;
  document.getElementById('instSub').textContent =
    `${portName(inst.midi_port)} · ch ${inst.midi_channel} · ${inst.default_pattern} default`;
}

function renderTabs() {
  const inst = cur();
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  const defs = [
    ['setup', 'Setup', ''],
    ['cc', 'CC Map', Object.keys(inst.cc_defs).length || ''],
    ['tv', 'Track Values', Object.keys(inst.track_values).length ? `${Object.keys(inst.track_values).length}/${SLOTS}` : ''],
    ['rows', 'Note Rows', Object.keys(inst.note_rows).length || ''],
  ];
  for (const [id, label, cnt] of defs) {
    const on = state.tab === id;
    const b = el(`<button class="tab${on ? ' on' : ''}" role="tab" aria-selected="${on}">${label}${cnt ? `<span class="cnt">${cnt}</span>` : ''}</button>`);
    b.onclick = () => { state.tab = id; renderPanel(); renderTabs(); };
    tabs.appendChild(b);
  }
}

function renderPanel() {
  const p = document.getElementById('panel');
  const view = state.selected + ':' + state.tab;
  const scroll = view === panelView ? p.scrollTop : 0;
  panelView = view;
  p.innerHTML = '';
  ({ setup: renderSetup, cc: renderCcMap, tv: renderTrackValues, rows: renderNoteRows })[state.tab](p);
  p.scrollTop = scroll;
  const target = focusAfterRender && p.querySelector(focusAfterRender);
  focusAfterRender = null;
  if (target) {
    target.focus();
    if (target.select) target.select();
    target.scrollIntoView({ block: 'nearest' });
  }
}

// ---- setup

function renderSetup(p) {
  const inst = cur();
  const grid = el('<div class="fgrid"></div>');
  //the row is the <label>, so clicking its text lands in the control
  const frow = (label, control, hint) =>
    el(`<label class="frow"><span class="fl">${label}</span>${control}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`);

  const identity = el(`<div class="fgroup"><h3>Identity</h3></div>`);
  const nameRow = frow('Name', `<input id="fName" maxlength="${NAME_MAX}" value="${esc(inst.name)}" spellcheck="false">`, `${NAME_MAX} characters max`);
  nameRow.querySelector('input').onchange = e => {
    const oldName = inst.name;
    const newName = e.target.value.trim() || oldName;
    if (newName !== oldName) {
      if (state.library.instruments.some(o => o !== inst && o.name === newName)) {
        toast(`An instrument named “${newName}” already exists`, { error: true });
        e.target.value = oldName;
        return;
      }
      checkpoint();
      inst.name = newName;
      renameMeta(oldName, newName);
    }
    renderAll();
  };
  identity.appendChild(nameRow);

  const noteOpts = ['<option value="">off — follow scene root</option>'];
  for (let id = 0; id <= 127; id++) noteOpts.push(`<option value="${id}">${noteName(id)}</option>`);
  const noteRow = frow('Default note', `<select>${noteOpts.join('')}</select>`);
  noteRow.querySelector('select').value = inst.default_note ?? '';
  noteRow.querySelector('select').onchange = e => {
    checkpoint();
    inst.default_note = e.target.value === '' ? null : +e.target.value;
  };
  identity.appendChild(noteRow);

  const patRow = frow('Default pattern', `<select>
    <option value="P3">P3 — step</option><option value="CK">CK — realtime</option>
    <option value="Sel">Sel — ask each time</option></select>`);
  patRow.querySelector('select').value = inst.default_pattern;
  patRow.querySelector('select').onchange = e => { checkpoint(); inst.default_pattern = e.target.value; renderHead(); };
  identity.appendChild(patRow);
  grid.appendChild(identity);

  const routing = el(`<div class="fgroup"><h3>Routing</h3></div>`);
  //imported files can carry ports and channels the editor doesn't know: show them rather than a blank
  const portOpts = PORTS.map((n, i) => `<option value="${i + 1}">${n}</option>`);
  if (!PORTS[inst.midi_port - 1]) portOpts.push(`<option value="${inst.midi_port}">port ${inst.midi_port} — unverified</option>`);
  const portRow = frow('Port', `<select>${portOpts.join('')}</select>`);
  portRow.querySelector('select').value = inst.midi_port;
  portRow.querySelector('select').onchange = e => { checkpoint(); inst.midi_port = +e.target.value; renderHead(); renderRail(); };
  routing.appendChild(portRow);

  const chanOpts = Array.from({ length: 16 }, (_, i) => `<option>${i + 1}</option>`);
  if (inst.midi_channel < 1 || inst.midi_channel > 16) chanOpts.push(`<option value="${inst.midi_channel}">${inst.midi_channel} — doesn't exist</option>`);
  const chanRow = frow('Channel', `<select>${chanOpts.join('')}</select>`);
  chanRow.querySelector('select').value = inst.midi_channel;
  chanRow.querySelector('select').onchange = e => {
    checkpoint();
    inst.midi_channel = +e.target.value;
    renderHead(); renderRail(); showSpread();
  };
  routing.appendChild(chanRow);

  const spreadRow = frow('Poly spread', `<select>
    <option value="0">off</option>${Array.from({ length: 15 }, (_, i) => `<option value="${i + 2}">${i + 2} voices</option>`).join('')}
    </select>`, '&nbsp;');
  const spreadHint = spreadRow.querySelector('.hint');
  //say which channels the spread lands on - and that it won't fit - while it's being chosen
  const showSpread = () => {
    const top = inst.midi_channel + inst.poly_spread - 1;
    const over = inst.poly_spread >= 2 && top > 16;
    spreadHint.textContent = inst.poly_spread < 2 ? 'spreads up from the base channel'
      : over ? `needs channels ${inst.midi_channel}–${top}, and there are only 16`
        : `uses channels ${inst.midi_channel}–${top}`;
    spreadHint.classList.toggle('bad', over);
  };
  spreadRow.querySelector('select').value = inst.poly_spread;
  spreadRow.querySelector('select').onchange = e => { checkpoint(); inst.poly_spread = +e.target.value; showSpread(); };
  showSpread();
  routing.appendChild(spreadRow);
  grid.appendChild(routing);

  const behaviour = el(`<div class="fgroup wide"><h3>Behaviour</h3></div>`);
  for (const [field, label, why, key, inverted] of FLAGS) {
    const row = el(`<label class="flagrow"><input type="checkbox"${inst[field] !== !!inverted ? ' checked' : ''}>
      <span class="ft"><b>${label}</b><span class="why">${why}</span></span>
      <span class="key">${key}: ${inst[field]}</span></label>`);
    row.querySelector('input').onchange = e => {
      checkpoint();
      inst[field] = e.target.checked !== !!inverted;
      row.querySelector('.key').textContent = `${key}: ${inst[field]}`;
    };
    behaviour.appendChild(row);
  }
  grid.appendChild(behaviour);

  const notesGroup = el(`<div class="fgroup wide"><h3>Instrument notes <span style="text-transform:none;letter-spacing:0">· kept in the .ckix sidecar, never sent to hardware</span></h3></div>`);
  const notesArea = el(`<textarea style="width:100%;min-height:56px;font-family:var(--f-body)" aria-label="Instrument notes" placeholder="Patch sheet, wiring, anything worth remembering…"></textarea>`);
  notesArea.value = meta(inst.name).notes || '';
  notesArea.onchange = e => { checkpoint(); meta(inst.name).notes = e.target.value; };
  notesGroup.appendChild(notesArea);
  grid.appendChild(notesGroup);

  p.appendChild(grid);
}

// ---- cc map

//slots carry their own copy of a CC's label: the ones still matching follow the edit
function setCcLabel(inst, cc, label) {
  const def = inst.cc_defs[cc];
  for (const tv of Object.values(inst.track_values)) {
    if (tv.kind === 'MidiCc' && tv.cc === cc && (tv.label || '') === def.label) tv.label = label || null;
  }
  def.label = label;
}

//the def, its sidecar entry and any slot holding it all move to the new number
function renumberCc(inst, from, to) {
  inst.cc_defs[to] = { ...inst.cc_defs[from], cc: to };
  delete inst.cc_defs[from];
  const ccMeta = meta(inst.name).cc_meta;
  if (ccMeta[from]) { ccMeta[to] = ccMeta[from]; delete ccMeta[from]; }
  for (const tv of Object.values(inst.track_values)) {
    if (tv.kind === 'MidiCc' && tv.cc === from) tv.cc = to;
  }
}

function renderCcMap(p) {
  const inst = cur();
  const bar = el(`<div class="toolbar">
    <input id="ccFilter" placeholder="Filter by name, number, label…" spellcheck="false" aria-label="Filter CCs">
    <button id="btnChart">Paste from chart…</button>
    <button id="btnAddCc">+ Add CC</button></div>`);
  p.appendChild(bar);
  bar.querySelector('#btnChart').onclick = openChartModal;
  bar.querySelector('#btnAddCc').onclick = () => {
    //CC 0 is bank select on most synths, so it's the last number to hand out
    const cc = [...Array(127).keys()].map(n => n + 1).concat(0).find(n => !inst.cc_defs[n]);
    if (cc === undefined) { toast('All 128 CCs are already defined.'); return; }
    checkpoint();
    inst.cc_defs[cc] = { cc, label: '', min: 0, max: 127, start: 0 };
    state.ccFilter = '';
    focusAfterRender = `tr[data-cc="${cc}"] .ccn`;
    renderTabs(); renderPanel();
  };

  if (!Object.keys(inst.cc_defs).length) {
    bar.querySelector('#ccFilter').remove();
    p.appendChild(el(`<div class="empty-state"><h2>No CCs yet</h2>
      <p>Paste rows straight from the synth's MIDI implementation chart —
      labels are abbreviated to the hardware's six characters for you.</p></div>`));
    return;
  }

  const table = el(`<table class="cc"><thead><tr>
    <th>CC</th><th title="Kept in the .ckix sidecar, never sent to hardware">Full name</th>
    <th title="Six characters — what the Cirklon shows">Label</th><th>Min</th><th>Max</th><th>Start</th>
    <th title="Kept in the .ckix sidecar, never sent to hardware">Notes</th><th></th>
    </tr></thead><tbody></tbody></table>`);
  const tbody = table.querySelector('tbody');

  const render = () => {
    tbody.innerHTML = '';
    const filter = state.ccFilter.trim().toLowerCase();
    const ccMeta = meta(inst.name).cc_meta;
    const keys = Object.keys(inst.cc_defs).map(Number).sort((a, b) => a - b);
    for (const cc of keys) {
      const def = inst.cc_defs[cc];
      const m = ccMeta[cc] || {};
      const hay = `${cc} ${m.name || ''} ${def.label}`.toLowerCase();
      if (filter && !hay.includes(filter)) continue;

      const tr = el(`<tr data-cc="${cc}">
        <td><input class="num ccn" value="${cc}" inputmode="numeric" aria-label="CC number"></td>
        <td><input class="full" value="${esc(m.name || '')}" placeholder="full name" spellcheck="false" aria-label="Full name of CC ${cc}"></td>
        <td><input class="lbl" maxlength="6" value="${esc(def.label)}" spellcheck="false" aria-label="Label of CC ${cc}"></td>
        <td><input class="num" value="${def.min}" inputmode="numeric" aria-label="Minimum of CC ${cc}"></td>
        <td><input class="num" value="${def.max}" inputmode="numeric" aria-label="Maximum of CC ${cc}"></td>
        <td><input class="num" value="${def.start}" inputmode="numeric" aria-label="Start value of CC ${cc}"></td>
        <td><input class="desc" value="${esc(m.desc || '')}" placeholder="notes" spellcheck="false" aria-label="Notes on CC ${cc}"></td>
        <td><button class="quiet danger" title="Delete CC ${cc}" aria-label="Delete CC ${cc}">×</button></td></tr>`);

      const [ccn, full, lbl, min, max, start, desc] = tr.querySelectorAll('input');
      ccn.onchange = e => {
        const to = /^\d+$/.test(e.target.value.trim()) ? +e.target.value : NaN;
        const problem = Number.isNaN(to) || to > 127 ? 'CC numbers run 0–127.'
          : to !== cc && inst.cc_defs[to] ? `CC ${to} is already defined.` : '';
        if (problem || to === cc) {
          if (problem) toast(problem, { error: true });
          e.target.value = cc;
          return;
        }
        checkpoint();
        renumberCc(inst, cc, to);
        focusAfterRender = `tr[data-cc="${to}"] .full`;
        renderPanel();
      };
      full.onchange = async e => {
        checkpoint();
        const cm = ccMeta[cc] || (ccMeta[cc] = {});
        cm.name = e.target.value;
        if (!def.label && invoke && e.target.value) {
          setCcLabel(inst, cc, await invoke('suggest_label', { name: e.target.value }));
          lbl.value = def.label;
        }
      };
      lbl.onchange = e => { checkpoint(); setCcLabel(inst, cc, e.target.value); };
      const num = (input, apply) => { input.onchange = e => {
        const v = parseInt(e.target.value, 10);
        if (!Number.isNaN(v)) { checkpoint(); apply(Math.max(0, Math.min(127, v))); }
        //cross-clamps can move any of the three - re-sync them all
        min.value = def.min; max.value = def.max; start.value = def.start;
      }; };
      num(min, v => { def.min = Math.min(v, def.max); def.start = Math.max(def.start, def.min); });
      num(max, v => { def.max = Math.max(v, def.min); def.start = Math.min(def.start, def.max); });
      num(start, v => { def.start = Math.max(def.min, Math.min(def.max, v)); });
      desc.onchange = e => { checkpoint(); (ccMeta[cc] || (ccMeta[cc] = {})).desc = e.target.value; };
      tr.querySelector('button').onclick = () => {
        checkpoint();
        delete inst.cc_defs[cc];
        delete ccMeta[cc];
        renderTabs(); renderPanel();
        toast(`Deleted CC ${cc}${m.name || def.label ? ' — ' + (m.name || def.label) : ''}`, { undo: true });
      };
      tbody.appendChild(tr);
    }
    if (!tbody.children.length) {
      tbody.appendChild(el(`<tr><td colspan="8" class="nomatch">No CC matches “${esc(state.ccFilter.trim())}”.</td></tr>`));
    }
  };

  const filter = bar.querySelector('#ccFilter');
  filter.value = state.ccFilter;
  filter.oninput = e => { state.ccFilter = e.target.value; render(); };
  render();
  p.appendChild(table);
}

// ---- track values

function moveSlot(inst, from, to) {
  const slots = inst.track_values;
  if (from === to || !slots[from] || to < 1 || to > SLOTS) return;
  checkpoint();
  const displaced = slots[to];
  slots[to] = slots[from];
  if (displaced) slots[from] = displaced; else delete slots[from];
  focusAfterRender = `[data-slot="${to}"]`;
  renderTabs(); renderPanel();
}

function clearSlot(inst, slot) {
  if (!inst.track_values[slot]) return;
  checkpoint();
  delete inst.track_values[slot];
  focusAfterRender = `[data-slot="${slot}"]`;
  renderTabs(); renderPanel();
}

//keyboard parity with the mouse: arrows walk the grid, alt+arrows carry the slot along
function slotKey(e, inst, slot) {
  if (e.target !== e.currentTarget) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -6, ArrowDown: 6 }[e.key];
  if (step) {
    e.preventDefault();
    if (e.altKey) moveSlot(inst, slot, slot + step);
    else {
      const next = document.querySelector(`[data-slot="${slot + step}"]`);
      if (next) next.focus();
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    clearSlot(inst, slot);
  } else if ((e.key === 'Enter' || e.key === ' ') && e.currentTarget.tagName !== 'BUTTON') {
    //empty slots are real buttons and click themselves
    e.preventDefault();
    openSlotPicker(slot);
  }
}

function buildSlotCell(inst, slot) {
  const tv = inst.track_values[slot];
  let cell;
  if (tv) {
    const isCc = tv.kind === 'MidiCc';
    const m = isCc ? (meta(inst.name).cc_meta[tv.cc] || {}) : {};
    const tip = isCc ? [m.name, m.desc].filter(Boolean).join(' — ') : controlHelp(tv.control);
    cell = el(`<div class="slot${isCc ? '' : ' tc'}" draggable="true" tabindex="0" role="button"
      aria-label="Slot ${slot}: ${isCc ? 'CC ' + tv.cc + ' ' : ''}${esc(slotDesc(tv))}"${tip ? ` title="${esc(tip)}"` : ''}>
      <div class="scc">${isCc ? 'CC ' + tv.cc : 'track'}</div>
      <div class="slb">${esc(slotDesc(tv))}</div>
      <button class="x" title="Clear slot" tabindex="-1" aria-hidden="true">×</button></div>`);
    cell.querySelector('.x').onclick = e => { e.stopPropagation(); clearSlot(inst, slot); };
    cell.ondragstart = e => {
      drag = { kind: 'slot', from: slot };
      e.dataTransfer.setData('text/plain', String(slot));
      e.dataTransfer.effectAllowed = 'move';
    };
    cell.ondragend = () => { drag = null; };
  } else {
    cell = el(`<button class="slot empty" aria-label="Fill slot ${slot}">+</button>`);
  }
  cell.dataset.slot = slot;
  cell.onclick = () => openSlotPicker(slot);
  cell.onkeydown = e => slotKey(e, inst, slot);
  cell.ondragover = e => {
    if (!drag || drag.kind !== 'slot') return;
    e.preventDefault();
    cell.classList.add('dragover');
  };
  cell.ondragleave = () => cell.classList.remove('dragover');
  cell.ondrop = e => {
    e.preventDefault();
    if (drag && drag.kind === 'slot') moveSlot(inst, drag.from, slot);
  };
  return cell;
}

//fills from the first empty row down, so rows arranged by hand stay as they are
function placeUnplaced(inst, unplaced) {
  const used = Object.keys(inst.track_values).map(Number);
  let slot = used.length ? Math.ceil(Math.max(...used) / 6) * 6 + 1 : 1;
  const fits = unplaced.slice(0, Math.max(0, SLOTS - slot + 1));
  if (!fits.length) { toast('No empty rows left — clear some slots first.', { error: true }); return; }
  checkpoint();
  for (const cc of fits) {
    inst.track_values[slot++] = { kind: 'MidiCc', cc, label: inst.cc_defs[cc].label || null };
  }
  renderTabs(); renderPanel();
  const left = unplaced.length - fits.length;
  toast(`Placed ${plural(fits.length, 'CC')}` + (left ? ` — ${left} more won't fit` : ''), { undo: true });
}

function renderTrackValues(p) {
  const inst = cur();
  const used = Object.keys(inst.track_values).map(Number);
  const maxRow = used.length ? Math.ceil(Math.max(...used) / 6) : 0;
  const showRows = Math.min(maxRow + 1, SLOTS / 6);
  const unplaced = Object.keys(inst.cc_defs).map(Number).sort((a, b) => a - b)
    .filter(cc => !slotHolding(inst, 'cc:' + cc));

  const head = el(`<div class="tv-head"><span class="hint">
    Rows of six — the same six slots above six encoders the Cirklon shows.
    Click a slot to fill or change it; drag one onto another (or Alt+arrow keys) to move or swap.</span></div>`);
  if (unplaced.length) {
    const b = el(`<button title="Adds every CC from the CC Map that isn't in a slot yet, starting on the next empty row">Place ${plural(unplaced.length, 'unplaced CC')}</button>`);
    b.onclick = () => placeUnplaced(inst, unplaced);
    head.appendChild(b);
  }
  p.appendChild(head);

  for (let row = 0; row < showRows; row++) {
    const rowEl = el(`<div class="tv-row"><div class="tv-row-head">Row ${row + 1}<span>slots ${row * 6 + 1}–${row * 6 + 6}</span></div><div class="slotrow"></div></div>`);
    const slotRow = rowEl.querySelector('.slotrow');
    for (let col = 0; col < 6; col++) {
      slotRow.appendChild(buildSlotCell(inst, row * 6 + col + 1));
    }
    p.appendChild(rowEl);
  }
}

function openSlotPicker(slot) {
  const inst = cur();
  const current = inst.track_values[slot];
  const ccMeta = meta(inst.name).cc_meta;
  const ccs = Object.keys(inst.cc_defs).map(Number).sort((a, b) => a - b);
  const options = [
    ...ccs.map(cc => ({ id: 'cc:' + cc, group: 'From the CC map', tag: 'CC ' + cc,
      label: inst.cc_defs[cc].label || 'unlabeled', detail: (ccMeta[cc] || {}).name || '' })),
    ...CONTROLS.map(([id, label, help]) => ({ id: 'tc:' + id, group: 'Track controls', tag: 'track', label, detail: help })),
  ];

  const m = openModal(current ? `Change slot ${slot}` : `Fill slot ${slot}`, `
    <input id="pickFilter" placeholder="Search CCs and track controls…" spellcheck="false" aria-label="Search">
    <div class="picklist" role="listbox"></div>
    ${ccs.length ? '' : '<p class="hint">No CCs here yet — define them on the CC Map tab and they show up in this list.</p>'}`,
    current ? [['Clear slot', 'danger', () => { closeModal(); clearSlot(inst, slot); }]] : []);
  const filter = m.querySelector('#pickFilter');
  const list = m.querySelector('.picklist');

  const pick = (option, at) => {
    closeModal();
    if (at === slot) return;
    checkpoint();
    //a value lives in one slot: picking a placed one brings it here, and whatever was here takes its place
    const arriving = at ? inst.track_values[at] : null;
    if (at && current) inst.track_values[at] = current;
    else if (at) delete inst.track_values[at];
    const cc = +option.id.slice(3);
    inst.track_values[slot] = arriving || (option.id.startsWith('tc:')
      ? { kind: 'Control', control: option.id.slice(3) }
      : { kind: 'MidiCc', cc, label: inst.cc_defs[cc].label || null });
    focusAfterRender = `[data-slot="${slot}"]`;
    renderTabs(); renderPanel();
  };

  const render = () => {
    const q = filter.value.trim().toLowerCase();
    list.innerHTML = '';
    let group = null;
    for (const o of options) {
      if (q && !`${o.tag} ${o.label} ${o.detail}`.toLowerCase().includes(q)) continue;
      if (o.group !== group) {
        group = o.group;
        list.appendChild(el(`<div class="pickgroup">${group}</div>`));
      }
      const at = slotHolding(inst, o.id);
      const where = !at ? '' : at === slot ? 'here now' : `in slot ${at} — ${current ? 'swaps' : 'moves here'}`;
      const b = el(`<button class="pick${o.id.startsWith('tc:') ? ' tc' : ''}${at === slot ? ' cur' : ''}" role="option" aria-selected="${at === slot}">
        <span class="ptag">${esc(o.tag)}</span><span class="plb">${esc(o.label)}</span>
        <span class="pdt">${esc(o.detail)}</span>${where ? `<span class="pat">${where}</span>` : ''}</button>`);
      b.onclick = () => pick(o, at);
      list.appendChild(b);
    }
    if (!list.querySelector('.pick')) list.appendChild(el(`<div class="pickgroup">Nothing matches “${esc(filter.value.trim())}”.</div>`));
  };

  filter.oninput = render;
  //enter takes the top match; arrows walk the list
  m.onkeydown = e => {
    const picks = [...list.querySelectorAll('.pick')];
    const at = picks.indexOf(document.activeElement);
    if (e.key === 'Enter' && e.target === filter && picks.length) { e.preventDefault(); picks[0].click(); }
    else if (e.key === 'ArrowDown' && picks[at + 1]) { e.preventDefault(); picks[at + 1].focus(); }
    else if (e.key === 'ArrowUp' && at >= 0) { e.preventDefault(); (picks[at - 1] || filter).focus(); }
  };
  render();
}

// ---- note rows

function renderNoteRows(p) {
  const inst = cur();
  const keys = Object.keys(inst.note_rows).map(Number).sort((a, b) => a - b);

  if (keys.length) {
    const grid = el('<div class="nr-grid"></div>');
    for (const id of keys) {
      const row = inst.note_rows[id];
      const cell = el(`<div class="nr" data-note="${id}"><div class="dn">${noteName(id)}</div>
        <button class="pin${row.always_show ? ' on' : ''}" title="Always show in empty patterns" aria-pressed="${!!row.always_show}">PIN</button>
        <input class="dl" maxlength="6" value="${esc(row.label)}" placeholder="label" spellcheck="false" aria-label="Label for ${noteName(id)}">
        <button class="x" title="Remove row" aria-label="Remove ${noteName(id)}">×</button></div>`);
      cell.querySelector('.dl').onchange = e => { checkpoint(); row.label = e.target.value; };
      cell.querySelector('.pin').onclick = () => {
        checkpoint();
        row.always_show = !row.always_show;
        focusAfterRender = `.nr[data-note="${id}"] .pin`;
        renderPanel();
      };
      cell.querySelector('.x').onclick = () => {
        checkpoint();
        delete inst.note_rows[id];
        renderTabs(); renderPanel();
        toast(`Removed ${noteName(id)}${row.label ? ' — ' + row.label : ''}`, { undo: true });
      };
      grid.appendChild(cell);
    }
    p.appendChild(grid);
  } else {
    p.appendChild(el(`<div class="empty-state"><h2>No note rows</h2>
      <p>Note rows name the sounds a drum machine maps to keys and pin favourites
      to the drum grid. Melodic synths usually don't need them.</p></div>`));
  }

  const noteOpts = [];
  for (let id = 0; id <= 127; id++) noteOpts.push(`<option value="${id}">${noteName(id)}</option>`);
  const add = el(`<div class="nr-add"><select id="nrNote" aria-label="Note">${noteOpts.join('')}</select>
    <input id="nrLabel" maxlength="6" placeholder="label" style="width:90px" spellcheck="false" aria-label="Label">
    <button id="nrAdd">+ Add row</button><span class="hint">Enter adds and moves to the next note</span></div>`);
  const noteSel = add.querySelector('#nrNote');
  const labelInput = add.querySelector('#nrLabel');
  noteSel.value = keys.length ? Math.min(Math.max(...keys) + 1, 127) : 36;
  const addRow = () => {
    const id = +noteSel.value;
    if (inst.note_rows[id]) {
      toast(`${noteName(id)} already has a row — edit its label above.`, { error: true });
      return;
    }
    checkpoint();
    inst.note_rows[id] = { note_id: id, label: labelInput.value, always_show: false };
    focusAfterRender = '#nrLabel';
    renderTabs(); renderPanel();
  };
  add.querySelector('#nrAdd').onclick = addRow;
  labelInput.onkeydown = e => { if (e.key === 'Enter') addRow(); };
  p.appendChild(add);
}

// ---------------------------------------------------------------- modals

function openModal(title, bodyHtml, buttons, wide) {
  const overlay = el(`<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1"${wide ? ' style="width:760px"' : ''}>
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot"><span class="status"></span><span class="spacer"></span></div>
  </div></div>`);
  overlay.querySelector('.x').onclick = closeModal;
  overlay.onclick = e => { if (e.target === overlay) closeModal(); };
  const foot = overlay.querySelector('.modal-foot');
  for (const [label, cls, fn] of buttons || []) {
    const b = el(`<button class="${cls || ''}">${esc(label)}</button>`);
    b.onclick = fn;
    foot.appendChild(b);
  }
  if (!foot.querySelector('button')) foot.remove();
  //focus moves into the dialog and goes back to whatever opened it on close
  overlay._opener = document.activeElement;
  document.getElementById('modals').appendChild(overlay);
  (overlay.querySelector('.modal-body input, .modal-body textarea') || overlay.querySelector('.modal')).focus();
  return overlay;
}
//modals stack: closing removes only the topmost, so Preview can sit over Prepare
function closeModal() {
  const top = document.getElementById('modals').lastElementChild;
  if (!top) return;
  top.remove();
  if (top._opener && top._opener.isConnected) top._opener.focus();
}
//tab cycles inside the topmost modal instead of wandering into the page behind it
function trapFocus(e, top) {
  const stops = [...top.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(n => !n.disabled);
  if (!stops.length) return;
  const first = stops[0], last = stops[stops.length - 1];
  const active = document.activeElement;
  if (!top.contains(active) || active === (e.shiftKey ? first : last) || active === top.querySelector('.modal')) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

// ---- chart import

function applyChartRange(def, e) {
  const clamp = v => Math.max(0, Math.min(127, v));
  if (e.min != null && e.max != null) {
    def.min = clamp(Math.min(e.min, e.max));
    def.max = clamp(Math.max(e.min, e.max));
  } else if (e.min != null) {
    def.min = Math.min(clamp(e.min), def.max);
  } else if (e.max != null) {
    def.max = Math.max(clamp(e.max), def.min);
  }
  def.start = Math.max(def.min, Math.min(def.max, e.start != null ? e.start : def.start));
}

async function mergeChartEntry(inst, ccMeta, e) {
  const isNew = !inst.cc_defs[e.cc];
  const def = inst.cc_defs[e.cc] || (inst.cc_defs[e.cc] = { cc: e.cc, label: '', min: 0, max: 127, start: 0 });
  if (e.name && (isNew || !def.label)) setCcLabel(inst, e.cc, await invoke('suggest_label', { name: e.name }));
  applyChartRange(def, e);
  if (e.name) (ccMeta[e.cc] || (ccMeta[e.cc] = {})).name = e.name;
  return isNew;
}

function importSummary(added, updated) {
  return updated
    ? `Added ${added} CCs, updated ${updated} from chart`
    : `Added ${plural(added, 'CC')} from chart`;
}

function openChartModal() {
  const m = openModal('Paste from chart',
    `<p class="hint" style="color:var(--dim);margin-top:0">One CC per line:
     <span class="mono">&lt;cc&gt; &lt;full name&gt; [min-max] [start]</span> — or table rows
     <span class="mono">cc | name | range | start</span> (tabs from a spreadsheet work too).</p>
     <p class="hint" style="margin-top:0">
     The number leads: <span class="mono">19</span>, <span class="mono">74:</span>,
     <span class="mono">CC 5</span>, <span class="mono">cc# 9</span>.
     Ranges: <span class="mono">0-127</span>, <span class="mono">0..127</span>, <span class="mono">(0-3)</span>;
     a start value may follow a range: <span class="mono">(0-3) 3</span>.
     Lines without a leading CC number are skipped — paste the whole manual page if you like.
     Full names go to the sidecar; six-character labels are abbreviated for you.</p>
     <textarea class="chart" spellcheck="false" aria-label="Chart rows" placeholder="19 Filter Cutoff 0-127&#10;109 Filter Pole Select (0-3) 3&#10;74: Cutoff&#10;CC 21 | Filter Resonance | 0-127 | 64"></textarea>`,
    [['Import', 'primary', async () => {
      const entries = await invoke('parse_chart', { text: textarea.value });
      if (!entries.length) { toast('No CC lines found — rows need a leading CC number.', { error: true }); return; }
      const inst = cur();
      const ccMeta = meta(inst.name).cc_meta;
      checkpoint();
      let added = 0, updated = 0;
      for (const e of entries) {
        if (await mergeChartEntry(inst, ccMeta, e)) added++; else updated++;
      }
      closeModal();
      state.tab = 'cc';
      state.ccFilter = '';
      renderAll();
      toast(importSummary(added, updated), { undo: true });
    }]]);

  //say what the paste will do before it's committed
  const textarea = m.querySelector('textarea');
  const status = m.querySelector('.status');
  let pending;
  textarea.oninput = () => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const entries = await invoke('parse_chart', { text: textarea.value });
      const updates = entries.filter(e => cur().cc_defs[e.cc]).length;
      status.textContent = entries.length
        ? `${plural(entries.length, 'CC line')} recognised` + (updates ? ` — ${updates} update existing CCs` : '')
        : textarea.value.trim() ? 'No CC lines recognised yet' : '';
      status.className = 'status' + (entries.length ? ' ok' : '');
    }, 200);
  };
}

// ---- prepare / preflight / export

async function openPrepare() {
  if (!state.library.instruments.length) return;
  let scopeAll = true;
  let findings = [];

  const m = openModal('Prepare for Cirklon', '<div id="prepBody"></div>', [
    ['Preview', '', () => openPreview()],
    ['Apply all fixes', '', () => applyFixes(findings.filter(f => f.fix).map(f => f.fix))],
    ['Export', 'primary', () => doExport()],
  ], true);
  const [, fixAllBtn, exportBtn] = m.querySelectorAll('.modal-foot button');
  const scoped = () => (scopeAll ? state.library : { instruments: [cur()] });

  async function applyFixes(fixes) {
    if (!fixes.length) return;
    const names = state.library.instruments.map(i => i.name);
    const library = await invoke('apply_fixes', { library: state.library, fixes });
    checkpoint();
    state.library = library;
    //a name fix renames the instrument: its sidecar entry follows
    library.instruments.forEach((inst, i) => renameMeta(names[i], inst.name));
    renderAll();
    await refresh();
  }

  async function refresh() {
    //validate exactly what will be exported; a lone instrument sits at index 0
    //in its own export, so point its findings and fixes back at the library
    findings = await invoke('validate_library', { library: scoped() });
    if (!scopeAll) {
      for (const f of findings) {
        f.index = state.selected;
        if (f.fix) f.fix.instrument = state.selected;
      }
    }
    const body = m.querySelector('#prepBody');
    body.innerHTML = '';

    if (state.library.instruments.length > 1) {
      const scope = el(`<div class="scope"><span class="lb">Export:</span>
        <button class="${scopeAll ? 'on' : ''}" aria-pressed="${scopeAll}">All ${state.library.instruments.length} instruments</button>
        <button class="${scopeAll ? '' : 'on'}" aria-pressed="${!scopeAll}">Only “${esc(cur().name)}”</button></div>`);
      const [all, one] = scope.querySelectorAll('button');
      all.onclick = () => { scopeAll = true; refresh(); };
      one.onclick = () => { scopeAll = false; refresh(); };
      body.appendChild(scope);
    }

    if (!findings.length) {
      body.appendChild(el(`<div class="check fixed"><span class="sig"></span>
        <span class="cb"><span class="h">Everything passes.</span><br>
        <span class="d">Nothing here the hardware would trip over.</span></span></div>`));
    }
    for (const f of findings) {
      const row = el(`<div class="check ${f.severity}"><span class="sig" title="${f.severity}"></span>
        <span class="cb"><span class="h">${f.instrument ? esc(f.instrument) + ' — ' : ''}${esc(f.title)}</span><br>
        <span class="d">${esc(f.detail)}</span></span>
        <button class="quiet" title="Close this and open where the problem is">Show</button></div>`);
      row.querySelector('button').onclick = () => {
        closeModal();
        state.selected = f.index;
        state.tab = f.area;
        state.ccFilter = '';
        renderAll();
      };
      if (f.fix) {
        const b = el(`<button>${esc(f.fix_label || 'Fix')}</button>`);
        b.onclick = () => applyFixes([f.fix]);
        row.appendChild(b);
      }
      body.appendChild(row);
    }

    const count = severity => findings.filter(f => f.severity === severity).length;
    const errs = count('error'), warns = count('warning'), fixable = findings.filter(f => f.fix).length;
    const status = m.querySelector('.status');
    status.textContent = errs ? `${plural(errs, 'error')} to fix before export`
      : warns ? `Ready to export — ${plural(warns, 'warning')} will ship as ${warns === 1 ? 'it is' : 'they are'}`
        : 'Ready to export';
    status.className = 'status ' + (errs ? 'err' : 'ok');
    fixAllBtn.textContent = fixable > 1 ? `Apply all ${fixable} fixes` : 'Apply all fixes';
    fixAllBtn.disabled = !fixable;
    exportBtn.disabled = errs > 0;
  }

  async function doExport() {
    const library = scoped();
    //a whole-library export goes back where it came from unless told otherwise
    const defaultPath = scopeAll && state.path ? state.path
      : (scopeAll && library.instruments.length > 1 ? 'LIBRARY' : cur().name.replace(/\s+/g, '').toUpperCase()) + '.CKI';
    const path = await dlg.save({
      title: 'Export CKI',
      defaultPath,
      filters: [{ name: 'Cirklon instruments', extensions: ['CKI', 'cki'] }],
    });
    if (!path) return;
    let result;
    try {
      result = await invoke('save_library', { path, library, sidecar: state.sidecar });
    } catch (err) {
      toast(String(err), { error: true });
      return; //modal stays open so the user can retry another path
    }
    closeModal();
    if (scopeAll) { state.path = result.cki_path; setDirty(false); }
    renderAll();
    toast(`Exported ${plural(library.instruments.length, 'instrument')}` +
      (result.ckix_path ? ' + sidecar notes' : ''));
  }

  await refresh();
}

// ---- hardware preview

function openPreview() {
  const inst = cur();
  const rows = [];
  for (let row = 0; row < SLOTS / 6; row++) {
    const cells = [];
    let any = false;
    for (let col = 0; col < 6; col++) {
      const tv = inst.track_values[row * 6 + col + 1];
      if (tv) { any = true; cells.push(slotDesc(tv).slice(0, 6)); } else cells.push(null);
    }
    if (any) rows.push({ hw: row + 1, cells });
  }
  let idx = 0;

  const m = openModal('On-hardware preview', `
    <div class="hw"><div class="hw-head"><span>TRACK · <b>${esc(inst.name)}</b></span><span id="hwInd"></span></div>
    <div class="hw-row" id="hwRow"></div>
    <div class="hw-nav"><button id="hwPrev">&lt; row</button><button id="hwNext">row &gt;</button>
    <span class="rowind">turn the ROW encoder on hardware</span></div></div>
    <p class="hint">Character-true: six labels above six encoders, populated rows only — exactly what the Cirklon draws.</p>`,
    [], true);

  const render = () => {
    const rowEl = m.querySelector('#hwRow');
    rowEl.innerHTML = '';
    const row = rows[idx];
    m.querySelector('#hwInd').textContent = row ? `row ${idx + 1} / ${rows.length} (hw row ${row.hw})` : 'no track values yet';
    (row ? row.cells : Array(6).fill(null)).forEach(c => {
      rowEl.appendChild(el(c
        ? `<div class="hw-slot"><div class="l">${esc(c)}</div><div class="v">— — —</div></div>`
        : `<div class="hw-slot blank"><div class="l">······</div><div class="v">&nbsp;</div></div>`));
    });
  };
  m.querySelector('#hwPrev').onclick = () => { if (rows.length > 1) { idx = (idx - 1 + rows.length) % rows.length; render(); } };
  m.querySelector('#hwNext').onclick = () => { if (rows.length > 1) { idx = (idx + 1) % rows.length; render(); } };
  render();
}

// ---------------------------------------------------------------- actions

function selectInstrument(i) {
  state.selected = i;
  state.ccFilter = '';
  renderAll();
}

async function importFile() {
  const path = await dlg.open({
    title: 'Import CKI',
    multiple: false,
    filters: [{ name: 'Cirklon instruments', extensions: ['CKI', 'cki'] }],
  });
  if (!path) return;
  let result;
  try {
    result = await invoke('load_library', { path });
  } catch (err) {
    toast(String(err), { error: true });
    return;
  }
  const incoming = result.library.instruments;
  if (!incoming.length) {
    toast('No instruments found in that file.', { error: true });
    return;
  }
  const have = new Set(state.library.instruments.map(i => i.name));
  const clashes = incoming.filter(i => have.has(i.name));
  if (!clashes.length) { await finishImport(result, incoming); return; }

  //same question the Cirklon asks when a loaded file brings a name it already has
  const names = clashes.slice(0, 8).map(i => `“${esc(i.name)}”`).join(', ') +
    (clashes.length > 8 ? ` and ${clashes.length - 8} more` : '');
  const fresh = incoming.filter(i => !have.has(i.name));
  const n = clashes.length;
  const who = n < incoming.length ? `${n} of the ${incoming.length} instruments` : n === 1 ? 'The instrument' : `All ${n} instruments`;
  const m = openModal('Already in this library', `
    <p style="margin-top:0">${who} in this file ${n === 1 ? 'shares a name with one' : 'share names with ones'} you already have: ${names}.</p>
    <p class="hint"><b>Replace</b> takes the file's version and keeps your full names and notes wherever the file has none.
    <b>Skip</b> leaves yours alone${fresh.length ? ` and imports only the ${plural(fresh.length, 'new one')}` : ''}. Either way, Undo brings everything back.</p>`,
  [
    ['Cancel', '', closeModal],
    [fresh.length ? 'Skip those' : 'Skip', '', () => { closeModal(); if (fresh.length) finishImport(result, fresh); }],
    ['Replace', 'primary', () => { closeModal(); finishImport(result, incoming); }],
  ]);
  m.querySelector('.primary').focus();
}

async function finishImport(result, instruments) {
  try {
    //core owns the merge semantics: field-level, never blanks existing data.
    //merged entries come back sparse (empty fields omitted) - read via meta() and || fallbacks
    const names = new Set(instruments.map(i => i.name));
    const incoming = Object.fromEntries(Object.entries(result.sidecar).filter(([name]) => names.has(name)));
    const sidecar = await invoke('merge_sidecar', { target: state.sidecar, incoming });
    //last await is done - everything below mutates state synchronously, so a
    //failed merge leaves the library untouched and the import can be retried
    const list = state.library.instruments;
    const wasEmpty = !list.length;
    checkpoint();
    let replaced = 0, first = -1;
    for (const inst of instruments) {
      let at = list.findIndex(o => o.name === inst.name);
      if (at >= 0) { list[at] = inst; replaced++; } else at = list.push(inst) - 1;
      if (first < 0) first = at;
    }
    state.sidecar = sidecar;
    if (!state.path) state.path = result.path;
    state.selected = first;
    state.tab = 'setup';
    state.ccFilter = '';
    //a file opened into an empty library is exactly what's on disk
    if (wasEmpty) setDirty(false);
    renderAll();
    toast(`Imported ${plural(instruments.length, 'instrument')}` + (replaced ? ` — ${replaced} replaced` : ''), { undo: !wasEmpty });
  } catch (err) {
    toast(String(err), { error: true });
  }
}

function newInstrument() {
  checkpoint();
  state.library.instruments.push({
    name: uniqueName('New inst'), midi_port: 1, midi_channel: 1, default_note: 36, default_pattern: 'Sel',
    multi: false, poly_spread: 0, no_xpose: false, no_fts: false, no_thru: false,
    no_bank_m: false, no_bank_l: false, show_note_nums: false, presend_pgm: false,
    track_values: {}, cc_defs: {}, note_rows: {},
  });
  state.selected = state.library.instruments.length - 1;
  state.tab = 'setup';
  state.ccFilter = '';
  //straight into the name: that's the first thing a new instrument needs
  focusAfterRender = '#fName';
  renderAll();
}

function duplicateInstrument() {
  const inst = cur();
  if (!inst) return;
  checkpoint();
  const copy = JSON.parse(JSON.stringify(inst));
  copy.name = uniqueName(inst.name);
  if (state.sidecar[inst.name]) state.sidecar[copy.name] = JSON.parse(JSON.stringify(state.sidecar[inst.name]));
  state.library.instruments.splice(state.selected + 1, 0, copy);
  state.selected++;
  state.tab = 'setup';
  focusAfterRender = '#fName';
  renderAll();
  toast(`Duplicated “${inst.name}” — give the copy its own name and channel`, { undo: true });
}

function deleteInstrument() {
  const inst = cur();
  if (!inst) return;
  checkpoint();
  state.library.instruments.splice(state.selected, 1);
  //a duplicate-named twin (legal in an import) still needs the entry
  if (!state.library.instruments.some(o => o.name === inst.name)) delete state.sidecar[inst.name];
  state.selected = Math.max(0, Math.min(state.selected, state.library.instruments.length - 1));
  state.ccFilter = '';
  renderAll();
  toast(`Deleted “${inst.name}”`, { undo: true });
}

function moveInstrument(from, to) {
  const list = state.library.instruments;
  if (from === to || to < 0 || to >= list.length || !list[from]) return false;
  checkpoint();
  const selected = cur();
  list.splice(to, 0, list.splice(from, 1)[0]);
  state.selected = list.indexOf(selected);
  renderAll();
  return true;
}

// ---------------------------------------------------------------- boot

document.getElementById('btnImport').onclick = importFile;
document.getElementById('btnImport2').onclick = importFile;
document.getElementById('btnNew').onclick = newInstrument;
document.getElementById('btnNew2').onclick = newInstrument;
document.getElementById('btnPrepare').onclick = openPrepare;
document.getElementById('btnUndo').onclick = undo;
document.getElementById('btnRedo').onclick = redo;
document.getElementById('btnDuplicate').onclick = duplicateInstrument;
document.getElementById('btnDelete').onclick = deleteInstrument;
document.getElementById('btnUndo').title = `Undo (${MOD}Z)`;
document.getElementById('btnRedo').title = `Redo (${MOD}${IS_MAC ? '⇧Z' : 'Y'})`;
document.getElementById('btnImport').title = `Import a .CKI (${MOD}O)`;
document.getElementById('btnPrepare').title = `Check, preview and export (${MOD}E)`;
document.getElementById('btnNew').title = `New instrument (${MOD}N)`;
document.getElementById('railSearch').oninput = e => { state.filter = e.target.value.trim().toLowerCase(); renderRail(); };

//rail: arrows change instrument, alt+arrows reorder; dropping below the last one moves to the end
const railList = document.getElementById('railList');
railList.onkeydown = e => {
  const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
  const buttons = [...railList.querySelectorAll('.inst')];
  const at = buttons.indexOf(document.activeElement);
  if (!step || at < 0) return;
  e.preventDefault();
  const i = +buttons[at].dataset.i;
  let landed = i;
  if (e.altKey) {
    if (!state.filter && moveInstrument(i, i + step)) landed = i + step;
  } else if (buttons[at + step]) {
    landed = +buttons[at + step].dataset.i;
    selectInstrument(landed);
  }
  const focus = railList.querySelector(`.inst[data-i="${landed}"]`);
  if (focus) focus.focus();
};
railList.ondragover = e => { if (drag && drag.kind === 'inst') { e.preventDefault(); railList.classList.add('dropend'); } };
railList.ondragleave = () => railList.classList.remove('dropend');
railList.ondrop = e => {
  e.preventDefault();
  railList.classList.remove('dropend');
  if (drag && drag.kind === 'inst') moveInstrument(drag.from, state.library.instruments.length - 1);
};

//a text field with typing that hasn't been committed keeps its own undo;
//everything else goes to the document history
document.addEventListener('focusin', e => { e.target._committed = e.target.value; });
document.addEventListener('change', e => { e.target._committed = e.target.value; });
function hasUncommittedTyping(node) {
  return !!node && node.matches('input:not([type=checkbox]), textarea') && node.value !== node._committed;
}

document.addEventListener('keydown', e => {
  const top = document.getElementById('modals').lastElementChild;
  if (e.key === 'Escape' && top) {
    //never wipe typed chart text - a non-empty textarea needs the × button
    const textarea = top.querySelector('textarea');
    if (textarea && textarea.value.trim()) return;
    closeModal();
    return;
  }
  if (e.key === 'Tab' && top) { trapFocus(e, top); return; }
  //ctrl on a mac moves the cursor in text fields (ctrl+e, ctrl+n...), so only ⌘ counts there
  if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey || top) return;
  const key = e.key.toLowerCase();
  const act = key === 'z' && e.shiftKey || key === 'y' ? redo
    : key === 'z' ? undo
      : key === 'o' ? importFile
        : key === 'n' ? newInstrument
          : key === 'e' || key === 's' ? openPrepare : null;
  if (!act) return;
  if (hasUncommittedTyping(document.activeElement)) {
    if (act === undo || act === redo) return;
    //the shortcut is about to redraw the page: commit what's been typed first
    document.activeElement.blur();
  }
  e.preventDefault();
  act();
});

//surface any missed IPC rejection instead of dying silently in the console
window.addEventListener('unhandledrejection', e => toast(String(e.reason), { error: true }));

renderAll();
