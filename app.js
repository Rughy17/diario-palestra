'use strict';

/* =========================================================
   Diario palestra: logica dell'app
   I dati vengono salvati sul dispositivo (IndexedDB) e
   sincronizzati con Supabase quando c'è connessione.
   ========================================================= */

const CFG = window.APP_CONFIG || {};
const TABLES = ['exercises', 'routines', 'workouts', 'sets'];
const PLATES = ['--red', '--blue', '--yellow', '--green'];

const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');

const store = Object.fromEntries(TABLES.map(t => [t, new Map()]));
let meta = { lastSync: null, userId: null, email: null, settings: { rest: 90, step: 2.5 } };
let sb = null;
let session = null;
let view = 'workout';
const ui = { inputs: {}, expanded: null, progressEx: null, editing: null, loginError: '', pendingRender: false };

let syncState = 'idle';
let syncing = false, syncAgain = false, syncTimer = null;

/* ---------- Utilità ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 });
const fmt = n => nf.format(Number(n) || 0);
const fmtIn = n => String(Math.round(Number(n) * 100) / 100).replace('.', ',');
const parseNum = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const nowIso = () => new Date().toISOString();
const parseTs = s => Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
const dfMonth = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });
const dfWeekday = new Intl.DateTimeFormat('it-IT', { weekday: 'short' });
const dfDay = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const dfTime = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const dfShort = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });
const e1rm = (w, r) => (r <= 1 ? w : w * (1 + r / 30));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Archivio locale (IndexedDB) ---------- */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('diario-palestra', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const out = fn(t.objectStore('kv'));
      t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => { s.put(v, k); }),
    clear: () => tx('readwrite', s => { s.clear(); }),
  };
})();

let saveTimer = null;
const dirtyTables = new Set();
function persist(t) {
  if (t) dirtyTables.add(t);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}
async function flush() {
  clearTimeout(saveTimer);
  const ts = [...dirtyTables]; dirtyTables.clear();
  try {
    for (const t of ts) await idb.set(t, [...store[t].values()]);
    await idb.set('meta', meta);
  } catch (e) { console.error(e); toast('Salvataggio sul dispositivo non riuscito'); }
}
async function loadLocal() {
  try {
    const m = await idb.get('meta');
    if (m) meta = { ...meta, ...m, settings: { ...meta.settings, ...(m.settings || {}) } };
    for (const t of TABLES) {
      const rows = await idb.get(t);
      if (rows) for (const r of rows) store[t].set(r.id, r);
    }
  } catch (e) { console.error(e); toast('Impossibile leggere i dati salvati sul dispositivo'); }
}
async function resetLocal() {
  for (const t of TABLES) store[t].clear();
  meta = { lastSync: null, userId: null, email: null, settings: meta.settings };
  ui.inputs = {}; ui.editing = null; ui.expanded = null; ui.progressEx = null;
  await idb.clear();
}

/* ---------- Scrittura dati ---------- */
function put(t, rec) {
  const r = { ...rec, _dirty: true };
  store[t].set(r.id, r);
  persist(t);
  scheduleSync();
  return r;
}
function softDelete(t, id) {
  const r = store[t].get(id);
  if (r) put(t, { ...r, deleted: true });
}

/* ---------- Lettura dati ---------- */
const alive = t => [...store[t].values()].filter(r => !r.deleted);
const exName = id => store.exercises.get(id)?.name || 'Esercizio';
const exercisesSorted = () => alive('exercises').sort((a, b) => a.name.localeCompare(b.name, 'it'));
const routinesSorted = () => alive('routines').sort((a, b) => a.name.localeCompare(b.name, 'it'));
function activeWorkout() {
  return alive('workouts').filter(w => !w.ended_at)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] || null;
}
function setsOf(wid) {
  return alive('sets').filter(s => s.workout_id === wid)
    .sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
}
function workoutTitle(w) {
  return (w.routine_id && store.routines.get(w.routine_id)?.name) || 'Allenamento libero';
}
function workoutPlan(w) {
  const plan = (w.plan || []).map(p => ({ ...p }));
  const ids = new Set(plan.map(p => p.exercise_id));
  for (const s of setsOf(w.id)) {
    if (!ids.has(s.exercise_id)) { ids.add(s.exercise_id); plan.push({ exercise_id: s.exercise_id }); }
  }
  return plan;
}
function lastSession(exId, excludeWid) {
  let best = null;
  for (const s of store.sets.values()) {
    if (s.deleted || s.exercise_id !== exId || s.workout_id === excludeWid) continue;
    const w = store.workouts.get(s.workout_id);
    if (!w || w.deleted) continue;
    if (!best || w.started_at > best.started_at) best = w;
  }
  return best ? setsOf(best.id).filter(s => s.exercise_id === exId) : null;
}
function sessionsFor(exId) {
  const by = new Map();
  for (const s of store.sets.values()) {
    if (s.deleted || s.exercise_id !== exId) continue;
    const w = store.workouts.get(s.workout_id);
    if (!w || w.deleted) continue;
    if (!by.has(w.id)) by.set(w.id, { w, sets: [] });
    by.get(w.id).sets.push(s);
  }
  return [...by.values()].map(o => {
    o.sets.sort((a, b) => a.position - b.position);
    o.best = Math.max(...o.sets.map(s => e1rm(s.weight, s.reps)));
    o.maxW = Math.max(...o.sets.map(s => s.weight));
    o.vol = o.sets.reduce((a, s) => a + s.weight * s.reps, 0);
    return o;
  }).sort((a, b) => a.w.started_at.localeCompare(b.w.started_at));
}

/* ---------- Sincronizzazione con Supabase ---------- */
const SYNC_LABELS = {
  idle: 'Tutto sincronizzato',
  syncing: 'Sincronizzazione in corso',
  pending: 'Modifiche in attesa di sincronizzazione',
  offline: 'Offline: i dati restano salvati sul dispositivo',
  error: 'Sincronizzazione non riuscita, riprovo più tardi',
  auth: 'Accedi di nuovo per sincronizzare',
};
const hasDirty = () => TABLES.some(t => [...store[t].values()].some(r => r._dirty));
function currentSyncState() {
  if (syncState === 'idle' && hasDirty()) return 'pending';
  return syncState;
}
function updateSyncDot() {
  const el = $('#sync'); const st = currentSyncState();
  el.dataset.state = st;
  el.setAttribute('aria-label', SYNC_LABELS[st]);
  el.title = SYNC_LABELS[st];
}
function scheduleSync(delay = 1200) {
  clearTimeout(syncTimer);
  updateSyncDot();
  syncTimer = setTimeout(sync, delay);
}
function toRow(r) {
  const { _dirty, updated_at, ...row } = r;
  row.user_id = session.user.id;
  return row;
}
function normalize(t, row) {
  if (t === 'sets') { row.weight = Number(row.weight); row.reps = Number(row.reps); }
  return row;
}
async function pullTable(t, since) {
  let from = 0, max = null, changed = false;
  for (;;) {
    let q = sb.from(t).select('*').order('updated_at', { ascending: true }).order('id').range(from, from + 999);
    if (since) q = q.gt('updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    for (const row of data) {
      const loc = store[t].get(row.id);
      if (!loc || !loc._dirty) {
        if (!loc || loc.updated_at !== row.updated_at) changed = true;
        store[t].set(row.id, normalize(t, row));
      }
      if (!max || parseTs(row.updated_at) > parseTs(max)) max = row.updated_at;
    }
    if (data.length) persist(t);
    if (data.length < 1000) break;
    from += 1000;
  }
  return { max, changed };
}
async function sync() {
  if (!sb) return;
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { syncState = 'offline'; updateSyncDot(); return; }
  syncing = true;
  try {
    if (!session) {
      const { data } = await sb.auth.getSession();
      session = data.session;
    }
    if (!session) { syncState = 'auth'; return; }
    syncState = 'syncing'; updateSyncDot();

    // 1. invia le modifiche fatte su questo dispositivo
    for (const t of TABLES) {
      const dirty = [...store[t].values()].filter(r => r._dirty);
      for (let i = 0; i < dirty.length; i += 500) {
        const chunk = dirty.slice(i, i + 500);
        const { error } = await sb.from(t).upsert(chunk.map(toRow));
        if (error) throw error;
        for (const r of chunk) if (store[t].get(r.id) === r) store[t].set(r.id, { ...r, _dirty: false });
      }
      if (dirty.length) persist(t);
    }

    // 2. scarica le modifiche fatte altrove
    const since = meta.lastSync ? new Date(parseTs(meta.lastSync) - 10000).toISOString() : null;
    let max = meta.lastSync, changed = false;
    for (const t of TABLES) {
      const r = await pullTable(t, since);
      if (r.max && (!max || parseTs(r.max) > parseTs(max))) max = r.max;
      changed = changed || r.changed;
    }
    meta.lastSync = max;
    persist();
    syncState = 'idle';
    if (changed) safeRender();
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || '');
    if (e?.status === 401 || /jwt|token|auth/i.test(msg)) syncState = 'auth';
    else syncState = navigator.onLine ? 'error' : 'offline';
  } finally {
    syncing = false;
    updateSyncDot();
    if (view === 'settings') safeRender();
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

/* ---------- Accesso ---------- */
async function login(email, password) {
  if (!navigator.onLine) { ui.loginError = 'Serve una connessione a internet per accedere.'; render(); return; }
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    ui.loginError = /invalid/i.test(error.message) ? 'Email o password non corretti.' : `Accesso non riuscito: ${error.message}`;
    render(); return;
  }
  session = data.session;
  if (meta.userId && meta.userId !== data.user.id) await resetLocal();
  meta.userId = data.user.id;
  meta.email = data.user.email;
  persist();
  ui.loginError = '';
  view = 'workout';
  syncState = 'idle';
  render();
  sync();
}
async function logout() {
  const warn = hasDirty()
    ? 'Ci sono modifiche non ancora sincronizzate: uscendo andranno perse. Uscire comunque?'
    : 'Uscire dall\'account su questo dispositivo?';
  if (!confirm(warn)) return;
  try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { console.error(e); }
  session = null;
  await resetLocal();
  stopTimer();
  view = 'workout';
  render();
}

/* ---------- Timer di recupero ---------- */
let timer = null, timerInt = null, audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio non disponibile */ }
}
function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((o, i) => {
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.frequency.value = i === 2 ? 1175 : 880;
    g.gain.setValueAtTime(0.0001, t + o);
    g.gain.exponentialRampToValueAtTime(0.35, t + o + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o + 0.18);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t + o); osc.stop(t + o + 0.2);
  });
}
function startTimer(sec) {
  unlockAudio();
  timer = { end: Date.now() + sec * 1000, total: sec * 1000, done: false };
  clearInterval(timerInt);
  timerInt = setInterval(tick, 250);
  tick();
}
function stopTimer() {
  timer = null; clearInterval(timerInt); tick();
}
function tick() {
  const el = $('#timer');
  if (!timer) { el.hidden = true; el.classList.remove('done'); document.body.classList.remove('has-timer'); return; }
  el.hidden = false; document.body.classList.add('has-timer');
  const left = timer.end - Date.now();
  if (left <= 0) {
    if (!timer.done) {
      timer.done = true; timer.doneAt = Date.now();
      try { navigator.vibrate?.([250, 120, 250, 120, 400]); } catch { /* */ }
      beep();
    }
    el.classList.add('done');
    $('#timer-text').textContent = 'Via!';
    $('#timer-sub').textContent = 'recupero finito';
    el.style.setProperty('--p', 0);
    if (Date.now() - timer.doneAt > 8000) stopTimer();
    return;
  }
  el.classList.remove('done');
  const s = Math.ceil(left / 1000);
  $('#timer-text').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('#timer-sub').textContent = 'recupero';
  el.style.setProperty('--p', Math.min(1, left / timer.total).toFixed(3));
}
function timerAdd(d) {
  if (!timer) return;
  if (timer.done) { if (d > 0) startTimer(d); return; }
  timer.end = Math.max(Date.now(), timer.end + d * 1000);
  timer.total = Math.max(timer.total, timer.end - Date.now());
  tick();
}

/* ---------- Schermo sempre acceso durante l'allenamento ---------- */
let wakeLock = null;
async function updateWakeLock() {
  const want = !!activeWorkout() && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* non supportato o negato */ }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {}); wakeLock = null;
  }
}

/* ---------- Render ---------- */
function isTyping() {
  const a = document.activeElement;
  return !!a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}
function safeRender() {
  if (isTyping()) { ui.pendingRender = true; return; }
  render();
}
function render() {
  ui.pendingRender = false;
  const loggedIn = !!(session || meta.userId);
  const showLogin = !loggedIn || view === 'login';
  document.body.classList.toggle('logged-out', showLogin);
  if (showLogin) { main.innerHTML = viewLogin(); return; }
  const views = { workout: viewWorkout, history: viewHistory, progress: viewProgress, routines: viewRoutines, settings: viewSettings };
  main.innerHTML = (views[view] || viewWorkout)();
  document.querySelectorAll('.tab').forEach(b => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    if (b.dataset.view === 'workout') b.classList.toggle('live', !!activeWorkout());
  });
  updateSyncDot();
  updateWakeLock();
}

function viewLogin() {
  return `<section class="login">
    <h1 class="login-title">Diario palestra</h1>
    <p class="muted">Accedi con l'utente che hai creato su Supabase. Dopo il primo accesso l'app funziona anche senza connessione.</p>
    <form id="login-form" class="stack">
      <label class="field"><span>Email</span>
        <input name="email" type="email" autocomplete="username" required value="${esc(meta.email || '')}"></label>
      <label class="field"><span>Password</span>
        <input name="password" type="password" autocomplete="current-password" required></label>
      ${ui.loginError ? `<p class="error" role="alert">${esc(ui.loginError)}</p>` : ''}
      <button class="btn btn-red" type="submit">Accedi</button>
      ${meta.userId ? `<button class="btn btn-text" type="button" data-action="nav" data-view="settings">Torna all'app</button>` : ''}
    </form>
  </section>`;
}

function viewConfigMissing() {
  document.body.classList.add('logged-out');
  main.innerHTML = `<section class="login">
    <h1 class="login-title">Quasi pronto</h1>
    <p>Apri il file <b>config.js</b> e inserisci l'URL del progetto e la chiave pubblica di Supabase, poi ricarica la pagina.</p>
  </section>`;
}

/* --- Allenamento --- */
function viewWorkout() {
  const w = activeWorkout();
  if (!w) return viewStart();
  const plan = workoutPlan(w);
  const sets = setsOf(w.id);
  const vol = sets.reduce((a, s) => a + s.weight * s.reps, 0);
  return `
    <h1 class="page-title">${esc(workoutTitle(w))}</h1>
    <p class="muted">Iniziato alle ${dfTime.format(new Date(parseTs(w.started_at)))}, ${plural(sets.length, 'serie', 'serie')}, ${fmt(vol)} kg sollevati</p>
    ${plan.length ? plan.map((item, i) => exBlock(w, item, i)).join('')
      : '<p class="empty">Aggiungi il primo esercizio per iniziare a registrare le serie.</p>'}
    <button class="btn btn-ghost btn-wide" data-action="add-ex">Aggiungi esercizio</button>
    <label class="field notes"><span>Note</span>
      <textarea data-input="notes" data-id="${w.id}" rows="3" placeholder="Come ti sei sentito, fastidi, cose da ricordare la prossima volta">${esc(w.notes || '')}</textarea>
    </label>
    <div class="wk-actions">
      <button class="btn btn-ink btn-wide" data-action="finish">Termina allenamento</button>
      <button class="btn btn-text danger" data-action="discard">Annulla allenamento</button>
    </div>`;
}

function inputFor(id, item, done, last) {
  if (!ui.inputs[id]) {
    const src = done[done.length - 1] || (last && last[0]);
    ui.inputs[id] = {
      w: src ? fmtIn(src.weight) : '',
      r: src ? String(src.reps) : (item.reps ? String(item.reps) : ''),
    };
  }
  return ui.inputs[id];
}

function stepper(id, f, label, val) {
  const what = f === 'w' ? 'il peso' : 'le ripetizioni';
  return `<div class="stepper">
    <span class="stepper-label">${label}</span>
    <div class="stepper-row">
      <button class="step" data-action="step" data-ex="${id}" data-f="${f}" data-d="-1" aria-label="Diminuisci ${what}">−</button>
      <input class="step-val" data-input="step" data-ex="${id}" data-f="${f}" inputmode="${f === 'w' ? 'decimal' : 'numeric'}"
        value="${esc(val)}" placeholder="0" aria-label="${label}" autocomplete="off" enterkeyhint="done">
      <button class="step" data-action="step" data-ex="${id}" data-f="${f}" data-d="1" aria-label="Aumenta ${what}">+</button>
    </div>
  </div>`;
}

function exBlock(w, item, i) {
  const id = item.exercise_id;
  const done = setsOf(w.id).filter(s => s.exercise_id === id);
  const last = lastSession(id, w.id);
  const inp = inputFor(id, item, done, last);
  const count = item.sets
    ? `${done.length} di ${item.sets}${item.reps ? ` × ${item.reps}` : ''}`
    : plural(done.length, 'serie', 'serie');
  return `<section class="ex plated" id="ex-${id}" style="--plate: var(${PLATES[i % 4]})">
    <div class="ex-head">
      <h2 class="ex-name">${esc(exName(id))}</h2>
      <span class="ex-count">${count}</span>
    </div>
    ${last ? `<p class="ex-last">Ultima volta: ${last.map(s => `${fmt(s.weight)}×${s.reps}`).join(', ')}</p>` : ''}
    ${done.length ? `<div class="chips">${done.map((s, k) => `
      <button class="chip" data-action="del-set" data-id="${s.id}"
        aria-label="Serie ${k + 1}: ${fmt(s.weight)} chili per ${s.reps} ripetizioni. Tocca per eliminarla">
        <b>${k + 1}</b>${fmt(s.weight)} kg × ${s.reps}</button>`).join('')}</div>` : ''}
    <div class="logger">
      ${stepper(id, 'w', 'Peso (kg)', inp.w)}
      ${stepper(id, 'r', 'Ripetizioni', inp.r)}
    </div>
    <div class="ex-foot">
      <button class="btn btn-red" data-action="save-set" data-ex="${id}">Salva serie ${done.length + 1}</button>
      ${done.length ? '' : `<button class="btn btn-text" data-action="remove-ex" data-ex="${id}">Rimuovi</button>`}
    </div>
  </section>`;
}

function viewStart() {
  const rs = routinesSorted();
  const last = alive('workouts').filter(w => w.ended_at).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  return `<section class="start">
    <h1 class="page-title">Nuovo allenamento</h1>
    ${last ? `<p class="muted">L'ultimo: ${esc(workoutTitle(last))}, ${dfDay.format(new Date(parseTs(last.started_at)))}</p>` : ''}
    ${rs.length ? `<div class="stack">${rs.map((r, i) => `
      <button class="routine-start plated" style="--plate: var(${PLATES[i % 4]})" data-action="start" data-id="${r.id}">
        <span class="rs-name">${esc(r.name)}</span>
        <span class="rs-sub">${esc(r.items.map(it => exName(it.exercise_id)).join(', ') || 'Nessun esercizio')}</span>
      </button>`).join('')}</div>`
      : '<p class="empty">Crea una scheda nella sezione Schede per avviare i tuoi allenamenti con un tocco, oppure parti da zero.</p>'}
    <button class="btn btn-ink btn-wide" data-action="start" data-id="">Inizia allenamento libero</button>
  </section>`;
}

/* --- Storico --- */
function viewHistory() {
  const ws = alive('workouts').filter(w => w.ended_at).sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (!ws.length) return `<h1 class="page-title">Storico</h1>
    <p class="empty">Qui trovi gli allenamenti conclusi. Terminane uno per vederlo comparire.</p>`;
  let html = '<h1 class="page-title">Storico</h1>', month = '';
  for (const w of ws) {
    const m = dfMonth.format(new Date(parseTs(w.started_at)));
    if (m !== month) { if (month) html += '</div>'; month = m; html += `<h2 class="month">${m}</h2><div class="hist-list">`; }
    html += histItem(w);
  }
  return html + '</div>';
}
function groupByExercise(sets) {
  const g = new Map();
  for (const s of sets) { if (!g.has(s.exercise_id)) g.set(s.exercise_id, []); g.get(s.exercise_id).push(s); }
  return [...g.entries()];
}
function histItem(w) {
  const sets = setsOf(w.id);
  const vol = sets.reduce((a, s) => a + s.weight * s.reps, 0);
  const open = ui.expanded === w.id;
  const d = new Date(parseTs(w.started_at));
  return `<article class="hist">
    <button class="hist-sum" data-action="toggle" data-id="${w.id}" aria-expanded="${open}">
      <span class="hist-date"><b>${d.getDate()}</b>${dfWeekday.format(d)}</span>
      <span>
        <span class="hist-title">${esc(workoutTitle(w))}</span>
        <span class="hist-meta">${fmtDur(parseTs(w.ended_at) - parseTs(w.started_at))}, ${plural(sets.length, 'serie', 'serie')}, ${fmt(vol)} kg</span>
      </span>
    </button>
    ${open ? `<div class="hist-body">
      ${groupByExercise(sets).map(([id, ss]) => `<div class="hist-ex">
        <h3>${esc(exName(id))}</h3>
        <p class="hist-sets">${ss.map(s => `<span>${fmt(s.weight)} × ${s.reps}</span>`).join('')}</p>
      </div>`).join('') || '<p class="muted">Nessuna serie registrata.</p>'}
      ${w.notes ? `<p class="hist-notes">${esc(w.notes)}</p>` : ''}
      <div class="row">
        <button class="btn btn-ghost btn-sm" data-action="repeat" data-id="${w.id}">Ripeti allenamento</button>
        <button class="btn btn-text danger btn-sm" data-action="del-workout" data-id="${w.id}">Elimina</button>
      </div>
    </div>` : ''}
  </article>`;
}

/* --- Progressi --- */
function viewProgress() {
  const used = new Map();
  for (const s of store.sets.values()) {
    if (s.deleted) continue;
    const w = store.workouts.get(s.workout_id);
    if (!w || w.deleted) continue;
    const cur = used.get(s.exercise_id);
    if (!cur || w.started_at > cur) used.set(s.exercise_id, w.started_at);
  }
  if (!used.size) return `<h1 class="page-title">Progressi</h1>
    <p class="empty">Registra qualche serie e qui vedrai come migliorano i tuoi carichi, esercizio per esercizio.</p>`;
  if (!ui.progressEx || !used.has(ui.progressEx)) {
    ui.progressEx = [...used.entries()].sort((a, b) => b[1].localeCompare(a[1]))[0][0];
  }
  const ids = [...used.keys()].sort((a, b) => exName(a).localeCompare(exName(b), 'it'));
  const sess = sessionsFor(ui.progressEx);
  const maxW = Math.max(...sess.map(s => s.maxW));
  const best = Math.max(...sess.map(s => s.best));
  return `<h1 class="page-title">Progressi</h1>
    <label class="field"><span>Esercizio</span>
      <select data-input="progress-ex">${ids.map(id => `<option value="${id}" ${id === ui.progressEx ? 'selected' : ''}>${esc(exName(id))}</option>`).join('')}</select>
    </label>
    <div class="stats">
      <div class="stat"><b>${fmt(maxW)}</b><span>kg, peso massimo</span></div>
      <div class="stat"><b>${fmt(Math.round(best * 10) / 10)}</b><span>kg, 1RM stimato</span></div>
      <div class="stat"><b>${sess.length}</b><span>${sess.length === 1 ? 'sessione' : 'sessioni'}</span></div>
    </div>
    <div class="chart-wrap">
      <h2>Massimale stimato nel tempo</h2>
      ${chart(sess)}
      <p class="muted small" style="margin:4px 4px 0">Calcolato con la formula di Epley dalla serie migliore di ogni sessione.</p>
    </div>
    <h2 class="month">Sessioni</h2>
    <div class="hist-list">${sess.slice().reverse().map(s => `
      <article class="hist"><div class="hist-sum" style="cursor:default">
        <span class="hist-date"><b>${new Date(parseTs(s.w.started_at)).getDate()}</b>${dfShort.format(new Date(parseTs(s.w.started_at))).replace(/^\d+\s*/, '')}</span>
        <span><span class="hist-sets">${s.sets.map(x => `<span>${fmt(x.weight)} × ${x.reps}</span>`).join('')}</span>
        <span class="hist-meta" style="margin-top:4px">1RM stimato ${fmt(Math.round(s.best * 10) / 10)} kg, volume ${fmt(s.vol)} kg</span></span>
      </div></article>`).join('')}</div>`;
}
function chart(sess) {
  const pts = sess.map(s => ({ t: parseTs(s.w.started_at), v: s.best }));
  if (pts.length < 2) return '<p class="empty small">Il grafico compare dalla seconda sessione di questo esercizio.</p>';
  const W = 340, H = 180, pl = 34, pr = 10, pt = 10, pb = 24;
  let min = Math.min(...pts.map(p => p.v)), max = Math.max(...pts.map(p => p.v));
  if (max === min) { max += 2; min -= 2; }
  const pad = (max - min) * 0.12; min -= pad; max += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = t => pl + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pl - pr);
  const y = v => pt + (1 - (v - min) / (max - min)) * (H - pt - pb);
  const grid = [0, 0.5, 1].map(k => {
    const v = min + (max - min) * k, yy = y(v).toFixed(1);
    return `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/>
      <text x="${pl - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${Math.round(v)}</text>`;
  }).join('');
  const line = pts.map(p => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const dots = pts.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="var(--surface)" stroke="var(--red)" stroke-width="2.2"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Andamento del massimale stimato">
    ${grid}
    <polyline points="${line}" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${pl}" y="${H - 6}">${dfShort.format(new Date(t0))}</text>
    <text x="${W - pr}" y="${H - 6}" text-anchor="end">${dfShort.format(new Date(t1))}</text>
  </svg>`;
}

/* --- Schede --- */
function viewRoutines() {
  if (ui.editing) return viewRoutineEditor();
  const rs = routinesSorted();
  return `<h1 class="page-title">Schede</h1>
    ${rs.length ? `<div class="stack">${rs.map((r, i) => `
      <article class="r-item plated" style="--plate: var(${PLATES[i % 4]})">
        <div class="r-item-head"><b>${esc(r.name)}</b></div>
        <p class="muted small" style="margin:2px 0 10px">${plural(r.items.length, 'esercizio', 'esercizi')}${r.items.length ? ': ' + esc(r.items.map(it => exName(it.exercise_id)).join(', ')) : ''}</p>
        <div class="row">
          <button class="btn btn-red btn-sm" data-action="start" data-id="${r.id}">Inizia</button>
          <button class="btn btn-ghost btn-sm" data-action="edit-routine" data-id="${r.id}">Modifica</button>
        </div>
      </article>`).join('')}</div>`
      : '<p class="empty">Una scheda è un elenco di esercizi con serie, ripetizioni e recupero già impostati. Creane una per partire più in fretta.</p>'}
    <button class="btn btn-ink btn-wide" data-action="new-routine">Nuova scheda</button>`;
}
function numField(i, k, label, v) {
  return `<label class="field sm"><span>${label}</span>
    <input inputmode="numeric" data-input="r-field" data-i="${i}" data-k="${k}" value="${v ?? ''}" autocomplete="off"></label>`;
}
function viewRoutineEditor() {
  const r = ui.editing;
  return `<div class="editor">
    <h1 class="page-title">${r.isNew ? 'Nuova scheda' : 'Modifica scheda'}</h1>
    <label class="field"><span>Nome</span>
      <input data-input="r-name" value="${esc(r.name)}" placeholder="Per esempio Spinta, Gambe, Full body" autocomplete="off"></label>
    <div class="stack">${r.items.map((it, i) => `
      <div class="r-item plated" style="--plate: var(${PLATES[i % 4]})">
        <div class="r-item-head"><b>${esc(exName(it.exercise_id))}</b>
          <div class="row">
            <button class="icon-btn" data-action="r-move" data-i="${i}" data-d="-1" aria-label="Sposta su" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" data-action="r-move" data-i="${i}" data-d="1" aria-label="Sposta giù" ${i === r.items.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-btn" data-action="r-del" data-i="${i}" aria-label="Rimuovi dalla scheda">✕</button>
          </div>
        </div>
        <div class="r-fields">
          ${numField(i, 'sets', 'Serie', it.sets)}
          ${numField(i, 'reps', 'Ripetizioni', it.reps)}
          ${numField(i, 'rest', 'Recupero (s)', it.rest)}
        </div>
      </div>`).join('')}</div>
    <button class="btn btn-ghost btn-wide" data-action="r-add">Aggiungi esercizio</button>
    <div class="wk-actions">
      <button class="btn btn-red btn-wide" data-action="r-save">Salva scheda</button>
      <button class="btn btn-text" data-action="r-cancel">Annulla</button>
      ${r.isNew ? '' : '<button class="btn btn-text danger" data-action="r-delete">Elimina scheda</button>'}
    </div>
  </div>`;
}

/* --- Impostazioni --- */
function viewSettings() {
  const s = meta.settings, st = currentSyncState();
  const exs = exercisesSorted();
  return `<h1 class="page-title">Impostazioni</h1>
    <section class="panel stack">
      <label class="field"><span>Recupero predefinito (secondi)</span>
        <input inputmode="numeric" data-input="set-rest" value="${s.rest}" autocomplete="off"></label>
      <label class="field"><span>Incremento del peso con + e − (kg)</span>
        <input inputmode="decimal" data-input="set-step" value="${fmtIn(s.step)}" autocomplete="off"></label>
    </section>
    <section class="panel stack">
      <h2 class="panel-title">Sincronizzazione</h2>
      <p>${SYNC_LABELS[st]}</p>
      ${meta.lastSync ? `<p class="muted small">Ultimo aggiornamento dal server: ${new Date(parseTs(meta.lastSync)).toLocaleString('it-IT')}</p>` : ''}
      ${st === 'auth' ? '<button class="btn btn-red" data-action="relogin">Accedi di nuovo</button>'
        : '<button class="btn btn-ghost" data-action="sync-now">Sincronizza ora</button>'}
    </section>
    <section class="panel">
      <h2 class="panel-title" style="margin-bottom:8px">Esercizi</h2>
      ${exs.length ? exs.map(e => `<div class="ex-row"><span>${esc(e.name)}</span>
        <span class="row" style="flex-wrap:nowrap">
          <button class="btn btn-text btn-sm" data-action="rename-ex" data-id="${e.id}">Rinomina</button>
          <button class="btn btn-text btn-sm danger" data-action="delete-ex" data-id="${e.id}">Elimina</button>
        </span></div>`).join('') : '<p class="muted">Gli esercizi che crei compariranno qui.</p>'}
    </section>
    <section class="panel stack">
      <h2 class="panel-title">Account</h2>
      <p>${esc(meta.email || '')}</p>
      <button class="btn btn-ghost" data-action="export">Esporta i dati (JSON)</button>
      <button class="btn btn-text danger" data-action="logout">Esci</button>
    </section>`;
}

/* ---------- Selettore esercizi ---------- */
function pickExercise(title = 'Aggiungi esercizio') {
  return new Promise(resolve => {
    const sheet = $('#sheet');
    let q = '';
    sheet.innerHTML = `<div class="sheet-backdrop" data-pick="close"></div>
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-head"><h2>${esc(title)}</h2><button class="btn btn-text" data-pick="close">Annulla</button></div>
        <input id="pick-q" class="pick-q" placeholder="Cerca o crea un esercizio" autocomplete="off" enterkeyhint="done">
        <div id="pick-list" class="pick-list"></div>
      </div>`;
    const draw = () => {
      const needle = q.trim().toLowerCase();
      const all = exercisesSorted();
      const list = all.filter(e => e.name.toLowerCase().includes(needle));
      const exact = all.some(e => e.name.toLowerCase() === needle);
      $('#pick-list').innerHTML =
        ((needle && !exact) ? `<button class="pick create" data-pick="new">Crea «${esc(q.trim())}»</button>` : '') +
        list.map(e => `<button class="pick" data-pick="${e.id}">${esc(e.name)}</button>`).join('') ||
        '<p class="empty small">Scrivi il nome del primo esercizio, per esempio Panca piana.</p>';
    };
    const done = v => {
      sheet.hidden = true; sheet.innerHTML = ''; sheet.onclick = null;
      document.body.classList.remove('sheet-open');
      resolve(v);
    };
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    const input = $('#pick-q');
    draw();
    setTimeout(() => input.focus(), 60);
    input.oninput = () => { q = input.value; draw(); };
    input.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); $('#pick-list [data-pick]')?.click(); }
      if (e.key === 'Escape') done(null);
    };
    sheet.onclick = e => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      const v = b.dataset.pick;
      if (v === 'close') return done(null);
      if (v === 'new') return done(put('exercises', { id: uid(), name: q.trim(), deleted: false }).id);
      done(v);
    };
  });
}

/* ---------- Azioni ---------- */
function startWorkout(routineId, plan) {
  if (activeWorkout()) { toast('Hai già un allenamento in corso'); view = 'workout'; render(); return; }
  const r = routineId ? store.routines.get(routineId) : null;
  put('workouts', {
    id: uid(), routine_id: r?.id || null, started_at: nowIso(), ended_at: null, notes: '',
    plan: plan || (r ? r.items.map(it => ({ ...it })) : []), deleted: false,
  });
  ui.inputs = {};
  view = 'workout';
  render();
  window.scrollTo(0, 0);
}

let notesPending = null, notesTimer = null;
function flushNotes() {
  clearTimeout(notesTimer);
  if (!notesPending) return;
  const w = store.workouts.get(notesPending.id);
  if (w && w.notes !== notesPending.value) put('workouts', { ...w, notes: notesPending.value });
  notesPending = null;
}

async function handleAction(b) {
  const d = b.dataset;
  switch (d.action) {
    case 'nav':
      flushNotes();
      view = d.view; render(); window.scrollTo(0, 0);
      break;

    case 'sync-info':
      toast(SYNC_LABELS[currentSyncState()]);
      if (currentSyncState() === 'auth') { view = 'settings'; render(); } else sync();
      break;
    case 'sync-now': sync(); break;
    case 'relogin': view = 'login'; render(); break;

    case 'start': startWorkout(d.id || null); break;

    case 'step': {
      const inp = ui.inputs[d.ex]; if (!inp) break;
      const delta = Number(d.d) * (d.f === 'w' ? (meta.settings.step || 2.5) : 1);
      let v = parseNum(inp[d.f]); if (!Number.isFinite(v)) v = 0;
      v = Math.max(0, Math.round((v + delta) * 100) / 100);
      inp[d.f] = d.f === 'w' ? fmtIn(v) : String(Math.round(v));
      const el = main.querySelector(`.step-val[data-ex="${d.ex}"][data-f="${d.f}"]`);
      if (el) el.value = inp[d.f];
      break;
    }

    case 'save-set': {
      const w = activeWorkout(); if (!w) break;
      const inp = ui.inputs[d.ex] || {};
      const weight = parseNum(inp.w), reps = parseInt(inp.r, 10);
      if (!(reps > 0)) { toast('Inserisci il numero di ripetizioni'); break; }
      const done = setsOf(w.id).filter(s => s.exercise_id === d.ex);
      put('sets', {
        id: uid(), workout_id: w.id, exercise_id: d.ex,
        position: done.length ? Math.max(...done.map(s => s.position)) + 1 : 0,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 0, reps,
        created_at: nowIso(), deleted: false,
      });
      const item = (w.plan || []).find(p => p.exercise_id === d.ex);
      startTimer(item?.rest || meta.settings.rest || 90);
      flushNotes();
      render();
      break;
    }

    case 'del-set': {
      const s = store.sets.get(d.id); if (!s) break;
      if (confirm(`Eliminare la serie da ${fmt(s.weight)} kg × ${s.reps}?`)) { softDelete('sets', s.id); render(); }
      break;
    }

    case 'add-ex': {
      const id = await pickExercise();
      const w = activeWorkout();
      if (!id || !w) break;
      if (workoutPlan(w).some(p => p.exercise_id === id)) { toast('Questo esercizio è già nell\'allenamento'); break; }
      flushNotes();
      put('workouts', { ...store.workouts.get(w.id), plan: [...(w.plan || []), { exercise_id: id }] });
      render();
      $(`#ex-${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }

    case 'remove-ex': {
      const w = activeWorkout(); if (!w) break;
      flushNotes();
      put('workouts', { ...store.workouts.get(w.id), plan: (w.plan || []).filter(p => p.exercise_id !== d.ex) });
      delete ui.inputs[d.ex];
      render();
      break;
    }

    case 'finish': {
      const w = activeWorkout(); if (!w) break;
      if (!setsOf(w.id).length && !confirm('Non hai registrato nessuna serie. Terminare comunque?')) break;
      flushNotes();
      put('workouts', { ...store.workouts.get(w.id), ended_at: nowIso() });
      stopTimer();
      ui.inputs = {};
      ui.expanded = w.id;
      view = 'history';
      toast('Allenamento salvato');
      render(); window.scrollTo(0, 0);
      break;
    }

    case 'discard': {
      const w = activeWorkout(); if (!w) break;
      if (!confirm('Annullare l\'allenamento? Le serie registrate verranno eliminate.')) break;
      notesPending = null;
      for (const s of setsOf(w.id)) softDelete('sets', s.id);
      softDelete('workouts', w.id);
      stopTimer();
      ui.inputs = {};
      render();
      break;
    }

    case 'timer-add': timerAdd(Number(d.d)); break;
    case 'timer-stop': stopTimer(); break;

    case 'toggle':
      ui.expanded = ui.expanded === d.id ? null : d.id;
      render();
      break;

    case 'repeat': {
      const w = store.workouts.get(d.id); if (!w) break;
      startWorkout(w.routine_id, workoutPlan(w).map(p => ({ ...p })));
      break;
    }

    case 'del-workout': {
      const w = store.workouts.get(d.id); if (!w) break;
      if (!confirm('Eliminare questo allenamento dallo storico?')) break;
      for (const s of setsOf(w.id)) softDelete('sets', s.id);
      softDelete('workouts', w.id);
      render();
      break;
    }

    /* Schede */
    case 'new-routine':
      ui.editing = { id: uid(), name: '', items: [], isNew: true };
      render(); main.querySelector('[data-input="r-name"]')?.focus();
      break;
    case 'edit-routine': {
      const r = store.routines.get(d.id); if (!r) break;
      ui.editing = { ...JSON.parse(JSON.stringify(r)), isNew: false };
      render(); window.scrollTo(0, 0);
      break;
    }
    case 'r-add': {
      const id = await pickExercise();
      if (!id || !ui.editing) break;
      ui.editing.items.push({ exercise_id: id, sets: 3, reps: 10, rest: meta.settings.rest || 90 });
      render();
      break;
    }
    case 'r-move': {
      const items = ui.editing.items, i = Number(d.i), j = i + Number(d.d);
      if (j < 0 || j >= items.length) break;
      [items[i], items[j]] = [items[j], items[i]];
      render();
      break;
    }
    case 'r-del': ui.editing.items.splice(Number(d.i), 1); render(); break;
    case 'r-cancel': ui.editing = null; render(); break;
    case 'r-save': {
      const r = ui.editing;
      if (!r.name.trim()) { toast('Dai un nome alla scheda'); main.querySelector('[data-input="r-name"]')?.focus(); break; }
      put('routines', {
        id: r.id, name: r.name.trim(), deleted: false,
        items: r.items.map(({ exercise_id, sets, reps, rest }) => ({ exercise_id, sets: sets || null, reps: reps || null, rest: rest || null })),
      });
      ui.editing = null;
      toast('Scheda salvata');
      render();
      break;
    }
    case 'r-delete':
      if (!confirm('Eliminare questa scheda? Gli allenamenti già fatti restano nello storico.')) break;
      softDelete('routines', ui.editing.id);
      ui.editing = null;
      render();
      break;

    /* Impostazioni */
    case 'rename-ex': {
      const e = store.exercises.get(d.id); if (!e) break;
      const name = prompt('Nuovo nome dell\'esercizio', e.name);
      if (name && name.trim()) { put('exercises', { ...e, name: name.trim() }); render(); }
      break;
    }
    case 'delete-ex': {
      const e = store.exercises.get(d.id); if (!e) break;
      if (!confirm(`Eliminare «${e.name}» dall'elenco? Le serie già registrate restano nello storico.`)) break;
      softDelete('exercises', e.id);
      render();
      break;
    }
    case 'export': {
      const data = Object.fromEntries(TABLES.map(t => [t, alive(t).map(({ _dirty, ...r }) => r)]));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `diario-palestra-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      break;
    }
    case 'logout': logout(); break;
  }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  handleAction(b);
});

main.addEventListener('input', e => {
  const el = e.target, d = el.dataset;
  switch (d.input) {
    case 'step':
      if (ui.inputs[d.ex]) ui.inputs[d.ex][d.f] = el.value;
      break;
    case 'notes':
      notesPending = { id: d.id, value: el.value };
      clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, 700);
      break;
    case 'r-name': if (ui.editing) ui.editing.name = el.value; break;
    case 'r-field': {
      if (!ui.editing) break;
      const n = parseInt(el.value, 10);
      ui.editing.items[Number(d.i)][d.k] = Number.isFinite(n) && n > 0 ? n : null;
      break;
    }
    case 'set-rest': {
      const n = parseInt(el.value, 10);
      if (n > 0) { meta.settings.rest = n; persist(); }
      break;
    }
    case 'set-step': {
      const n = parseNum(el.value);
      if (n > 0) { meta.settings.step = n; persist(); }
      break;
    }
  }
});

main.addEventListener('change', e => {
  if (e.target.dataset.input === 'progress-ex') { ui.progressEx = e.target.value; render(); }
});

main.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('step-val')) e.target.blur();
});

main.addEventListener('submit', e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true; btn.textContent = 'Accesso in corso';
  login(String(f.get('email')).trim(), String(f.get('password')));
});

document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (ui.pendingRender && !isTyping()) render();
  }, 80);
});

window.addEventListener('online', () => sync());
window.addEventListener('offline', () => { syncState = 'offline'; updateSyncDot(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { tick(); sync(); updateWakeLock(); }
  else { flushNotes(); flush(); }
});
window.addEventListener('pagehide', () => { flushNotes(); flush(); });
setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60000);

/* ---------- Avvio ---------- */
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
  if (!window.supabase || !CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('XXXX') || !CFG.SUPABASE_KEY || CFG.SUPABASE_KEY.startsWith('INCOLLA')) {
    viewConfigMissing();
    return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  await loadLocal();
  try {
    const { data } = await sb.auth.getSession();
    session = data.session;
  } catch (e) { console.error(e); }
  sb.auth.onAuthStateChange((event, s) => {
    session = s;
    if (event === 'TOKEN_REFRESHED' && syncState === 'auth') setTimeout(sync, 0);
  });
  render();
  if (session) sync();
  else if (meta.userId && navigator.onLine) { syncState = 'auth'; updateSyncDot(); }
}
init();
