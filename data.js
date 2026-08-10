// ================= GEDEELDE DATA (budget + notities) =================
// Leest en schrijft HETZELFDE JSON-bestand op Google Drive dat het desktop-dashboard
// gebruikt ("beetjeoranje-dashboard-data.json" in de map "BeetjeOranje-Dashboard-Sync"),
// zodat budget en notities op beide apparaten identiek blijven. Elke waarde in dat
// bestand is zelf een string (exact zoals localStorage.getItem() die teruggeeft op
// desktop) — dus altijd JSON.parse/stringify per losse sleutel.
const DRIVE_SYNC_FILE_NAME = 'beetjeoranje-dashboard-data.json';
const DRIVE_SYNC_FOLDER_ID = '12xOuxd1MKRhLCxWrGLa_nvmTk3S6y9y1';

const BUDGET_KEY = 'beetjeoranje-dashboard-budget-v1';
const NOTES_LIST_KEY = 'beetjeoranje-dashboard-notes-list-v1';
const NOTE_CATEGORIES_KEY = 'beetjeoranje-dashboard-note-categories-v1';

let sharedSyncFileId = null;
let sharedData = null; // { [key]: stringValue, ... } — ruwe snapshot zoals op Drive staat
let sharedDataLoaded = false;
let sharedDataPushTimer = null;

function pad2(n) { return String(n).padStart(2, '0'); }

async function driveFindSyncFile() {
  const q = encodeURIComponent(`name='${DRIVE_SYNC_FILE_NAME}' and '${DRIVE_SYNC_FOLDER_ID}' in parents and trashed=false`);
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + encodeURIComponent('files(id,name,modifiedTime)') + '&orderBy=modifiedTime desc', {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) throw new Error('Drive-bestand zoeken mislukt (' + res.status + ')');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveCreateSyncFile(initialObj) {
  const metadata = { name: DRIVE_SYNC_FILE_NAME, parents: [DRIVE_SYNC_FOLDER_ID], mimeType: 'application/json' };
  const boundary = 'beetjeoranje-boundary';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(initialObj)}\r\n` +
    `--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + googleAccessToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body
  });
  if (!res.ok) throw new Error('Drive-bestand aanmaken mislukt (' + res.status + ')');
  return res.json();
}

async function driveReadSyncFile(fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) throw new Error('Drive-bestand lezen mislukt (' + res.status + ')');
  return res.json();
}

async function driveWriteSyncFile(fileId, obj) {
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + googleAccessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
  if (!res.ok) throw new Error('Drive-bestand opslaan mislukt (' + res.status + ')');
  return res.json();
}

// Haalt het gedeelde bestand op (één keer, daarna blijft het in het geheugen totdat er
// iets gewijzigd wordt). Maakt het bestand aan als het nog niet bestaat.
async function ensureSharedData() {
  if (sharedDataLoaded) return sharedData;
  const found = await driveFindSyncFile();
  if (found) {
    sharedSyncFileId = found.id;
    sharedData = await driveReadSyncFile(found.id);
  } else {
    sharedData = {};
    const created = await driveCreateSyncFile(sharedData);
    sharedSyncFileId = created.id;
  }
  sharedDataLoaded = true;
  return sharedData;
}

function getSharedKey(key, fallback) {
  try {
    const raw = sharedData ? sharedData[key] : null;
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}

function setSharedKey(key, value) {
  if (!sharedData) sharedData = {};
  sharedData[key] = JSON.stringify(value);
  schedulePushSharedData();
}

// Debounce zodat snel achter elkaar wijzigen (bijv. tijdens typen) niet bij elke
// toetsaanslag een Drive-schrijfactie triggert.
function schedulePushSharedData() {
  if (sharedDataPushTimer) clearTimeout(sharedDataPushTimer);
  sharedDataPushTimer = setTimeout(() => {
    if (sharedSyncFileId && sharedData) {
      driveWriteSyncFile(sharedSyncFileId, sharedData).catch((e) => {
        console.error(e);
        showDebug('Drive-opslaan-fout', e.message || String(e));
      });
    }
  }, 1500);
}

// ---------- Notities ----------
function getNotes() { return getSharedKey(NOTES_LIST_KEY, []); }
function saveNotes(list) { setSharedKey(NOTES_LIST_KEY, list); }
function getNoteCategories() {
  const cats = getSharedKey(NOTE_CATEGORIES_KEY, ['Algemeen']);
  return Array.isArray(cats) && cats.length ? cats : ['Algemeen'];
}

function genId(prefix) { return prefix + Date.now() + Math.random().toString(36).slice(2, 7); }

async function loadNotesView() {
  const el = document.getElementById('notesList');
  el.innerHTML = '<div class="loading">Notities ophalen…</div>';
  try {
    await ensureSharedData();
    renderNotesView();
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

function renderNotesView() {
  const el = document.getElementById('notesList');
  const notes = getNotes().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (notes.length === 0) { el.innerHTML = '<div class="empty">Nog geen notities. Tik op + om er een toe te voegen.</div>'; return; }
  el.innerHTML = notes.map((n) => `
    <div class="note-row" data-id="${esc(n.id)}">
      <div class="note-row-title">${esc(n.title || '(geen titel)')}</div>
      <div class="note-row-meta">${esc(n.category || 'Algemeen')} · ${formatNoteDate(n.updatedAt)}</div>
      <div class="note-row-preview">${esc(htmlToPlainText(n.contentHTML || '')).slice(0, 90)}</div>
    </div>`).join('');
  el.querySelectorAll('.note-row').forEach((row) => {
    row.addEventListener('click', () => openNoteEditor(row.getAttribute('data-id')));
  });
}

function formatNoteDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}
function htmlToPlainText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
}
function linkify(text) {
  return esc(text).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

let editingNoteId = null;

function openNoteEditor(id) {
  const notes = getNotes();
  const note = id ? notes.find((n) => n.id === id) : null;
  editingNoteId = id || null;

  const cats = getNoteCategories();
  const sel = document.getElementById('noteCategorySelect');
  sel.innerHTML = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  document.getElementById('noteTitleInput').value = note ? (note.title || '') : '';
  sel.value = note ? (note.category || cats[0]) : cats[0];
  document.getElementById('noteBodyInput').value = note ? htmlToPlainText(note.contentHTML || '') : '';
  document.getElementById('noteDeleteBtn').style.display = note ? '' : 'none';
  document.getElementById('noteEditorOverlay').classList.remove('hidden');
}

function closeNoteEditor() {
  document.getElementById('noteEditorOverlay').classList.add('hidden');
  editingNoteId = null;
}

function saveNoteFromEditor() {
  const title = document.getElementById('noteTitleInput').value.trim();
  const category = document.getElementById('noteCategorySelect').value;
  const bodyText = document.getElementById('noteBodyInput').value;
  if (!title && !bodyText.trim()) { closeNoteEditor(); return; }

  const notes = getNotes();
  const now = Date.now();
  if (editingNoteId) {
    const idx = notes.findIndex((n) => n.id === editingNoteId);
    if (idx !== -1) {
      notes[idx].title = title;
      notes[idx].category = category;
      notes[idx].contentHTML = linkify(bodyText);
      notes[idx].updatedAt = now;
    }
  } else {
    notes.unshift({ id: genId('n'), title, category, contentHTML: linkify(bodyText), createdAt: now, updatedAt: now });
  }
  saveNotes(notes);
  closeNoteEditor();
  renderNotesView();
}

function deleteNoteFromEditor() {
  if (!editingNoteId) return;
  if (!confirm('Deze notitie verwijderen?')) return;
  const notes = getNotes().filter((n) => n.id !== editingNoteId);
  saveNotes(notes);
  closeNoteEditor();
  renderNotesView();
}

// ---------- Budget ----------
const BUDGET_ENVELOPE_LABELS = { vast: 'Vaste lasten', vrij: 'Vrije uitgaven', sparen: 'Spaargeld' };

function budgetMonthKeyFor(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }

function getBudgetData() { return getSharedKey(BUDGET_KEY, {}); }
function saveBudgetData(data) { setSharedKey(BUDGET_KEY, data); }

function getBudgetMonth(key) {
  const data = getBudgetData();
  const m = data[key] || { incomes: [], items: { vast: [], vrij: [], sparen: [] } };
  if (!m.items) m.items = { vast: [], vrij: [], sparen: [] };
  ['vast', 'vrij', 'sparen'].forEach((c) => { if (!m.items[c]) m.items[c] = []; });
  if (!Array.isArray(m.incomes)) m.incomes = [];
  return m;
}
function saveBudgetMonth(key, monthData) {
  const data = getBudgetData();
  data[key] = monthData;
  saveBudgetData(data);
}
function budgetIncomeTotal(monthData) {
  return (monthData.incomes || []).reduce((s, i) => s + i.amount, 0);
}
function budgetEnvelopeTotal(monthData, cat) {
  return (monthData.items[cat] || []).reduce((s, i) => s + i.amount, 0);
}

let budgetActiveMonthKey = budgetMonthKeyFor(new Date());

async function loadBudgetView() {
  const el = document.getElementById('budgetBody');
  el.innerHTML = '<div class="loading">Budget ophalen…</div>';
  try {
    await ensureSharedData();
    renderBudgetView();
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

function renderBudgetMonthLabel() {
  const [y, m] = budgetActiveMonthKey.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
  document.getElementById('budgetMonthLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);
}

function renderBudgetView() {
  renderBudgetMonthLabel();
  const el = document.getElementById('budgetBody');
  const monthData = getBudgetMonth(budgetActiveMonthKey);
  const income = budgetIncomeTotal(monthData);

  const envelopeHtml = ['vast', 'vrij', 'sparen'].map((cat) => {
    const total = budgetEnvelopeTotal(monthData, cat);
    const items = monthData.items[cat] || [];
    const itemsHtml = items.length
      ? items.map((it) => `<div class="budget-item-row"><span>${esc(it.label)}</span><span>€ ${it.amount.toFixed(2)}</span></div>`).join('')
      : '<div class="empty" style="padding:4px 0;">Nog niets toegevoegd.</div>';
    return `
      <div class="budget-envelope">
        <div class="budget-envelope-head">
          <span>${esc(BUDGET_ENVELOPE_LABELS[cat])}</span>
          <span>€ ${total.toFixed(2)}</span>
        </div>
        ${itemsHtml}
        <button type="button" class="budget-add-link" data-cat="${cat}">+ item toevoegen</button>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-income-row"><span>Inkomsten</span><span>€ ${income.toFixed(2)}</span></div>
    ${envelopeHtml}
  `;

  el.querySelectorAll('.budget-add-link').forEach((btn) => {
    btn.addEventListener('click', () => openBudgetItemModal(btn.getAttribute('data-cat')));
  });
}

let budgetModalCat = 'vast';
function openBudgetItemModal(cat) {
  budgetModalCat = cat;
  document.getElementById('budgetItemLabelInput').value = '';
  document.getElementById('budgetItemAmountInput').value = '';
  document.getElementById('budgetItemModalTitle').textContent = 'Item toevoegen — ' + BUDGET_ENVELOPE_LABELS[cat];
  document.getElementById('budgetItemOverlay').classList.remove('hidden');
}
function closeBudgetItemModal() {
  document.getElementById('budgetItemOverlay').classList.add('hidden');
}
function saveBudgetItemFromModal() {
  const label = document.getElementById('budgetItemLabelInput').value.trim();
  const amount = parseFloat((document.getElementById('budgetItemAmountInput').value || '').replace(',', '.'));
  if (!label || !amount || isNaN(amount) || amount <= 0) return;
  const monthData = getBudgetMonth(budgetActiveMonthKey);
  monthData.items[budgetModalCat].push({ id: genId('b'), label, amount: Math.round(amount * 100) / 100 });
  saveBudgetMonth(budgetActiveMonthKey, monthData);
  closeBudgetItemModal();
  renderBudgetView();
}

function shiftBudgetMonth(delta) {
  const [y, m] = budgetActiveMonthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  budgetActiveMonthKey = budgetMonthKeyFor(d);
  renderBudgetView();
}
