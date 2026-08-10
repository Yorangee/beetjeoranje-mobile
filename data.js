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
const WEIGHT_LOG_KEY = 'beetjeoranje-dashboard-weight-log-v1';
const NUTRITION_PLAN_KEY = 'beetjeoranje-dashboard-nutrition-plan-v1';
const BTW_STATUS_KEY = 'beetjeoranje-dashboard-btw-status-v1';
const ANNUAL_INCOME_KEY = 'beetjeoranje-dashboard-annual-income-v1';
const INVOICE_STATUS_KEY = 'beetjeoranje-dashboard-invoice-status-v1';
const CAR_APK_KEY = 'beetjeoranje-dashboard-car-apk-v1';
const CAR_VISITS_KEY = 'beetjeoranje-dashboard-car-visits-v1';
const CAR_DOC_REFS_KEY = 'beetjeoranje-dashboard-car-doc-refs-v1';

let sharedSyncFileId = null;
let sharedData = null; // { [key]: stringValue, ... } — precies zoals cloudSyncSnapshotFromLocalStorage() op desktop
let sharedDataLoaded = false;
let sharedDataPushTimer = null;

function pad2(n) { return String(n).padStart(2, '0'); }

// Zoekt ALLE bestanden met deze naam in de sync-map (desktop maakt bij elke push een
// NIEUW bestand aan i.p.v. het bestaande te overschrijven — zie cloudSyncPush() in het
// desktop-dashboard), en pakt het meest recente op createdTime. Zo blijft mobiel exact
// consistent met hoe desktop dit al deed, ook als er meerdere back-upbestanden staan.
async function driveFindLatestSyncFile() {
  const q = encodeURIComponent(`name='${DRIVE_SYNC_FILE_NAME}' and '${DRIVE_SYNC_FOLDER_ID}' in parents and trashed=false`);
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + encodeURIComponent('files(id,name,createdTime)') + '&orderBy=createdTime desc&pageSize=5', {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) throw new Error('Drive-bestand zoeken mislukt (' + res.status + ')');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveCreateSyncFile(payloadObj) {
  const metadata = { name: DRIVE_SYNC_FILE_NAME, parents: [DRIVE_SYNC_FOLDER_ID], mimeType: 'application/json' };
  const boundary = 'beetjeoranje-boundary';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payloadObj)}\r\n` +
    `--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + googleAccessToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body
  });
  if (!res.ok) throw new Error('Drive-bestand aanmaken mislukt (' + res.status + ')');
  return res.json();
}

async function driveReadFileRaw(fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) throw new Error('Drive-bestand lezen mislukt (' + res.status + ')');
  return res.json();
}

// Haalt het gedeelde bestand op (één keer per sessie). Het bestand op Drive is gewrapt
// als { savedAt, data: {...} } — net als het desktop-dashboard schrijft — dus altijd
// via .data ontpakken (met een fallback op het platte object voor de zeldzame oude vorm).
async function ensureSharedData() {
  if (sharedDataLoaded) return sharedData;
  const found = await driveFindLatestSyncFile();
  if (found) {
    const raw = await driveReadFileRaw(found.id);
    sharedData = (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') ? raw.data : (raw || {});
  } else {
    sharedData = {};
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
// toetsaanslag een Drive-schrijfactie triggert. Schrijft — net als desktop — altijd een
// NIEUW bestand weg (create_file, geen PATCH) met dezelfde { savedAt, data } envelop.
function schedulePushSharedData() {
  if (sharedDataPushTimer) clearTimeout(sharedDataPushTimer);
  sharedDataPushTimer = setTimeout(() => {
    if (!sharedData) return;
    const payload = { savedAt: new Date().toISOString(), data: sharedData };
    driveCreateSyncFile(payload).catch((e) => {
      console.error(e);
      showDebug('Drive-opslaan-fout', e.message || String(e));
    });
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
// Zelfde structuur als desktop: monthData = { incomes:[{id,label,amount}],
// items:{vast:[{id,label,amount,paid?,categoryId?}], vrij:[...], sparen:[...]},
// categories:{vast:[{id,name,color,icon}], vrij:[...]} }.
const BUDGET_ENVELOPE_LABELS = { vast: 'Vaste lasten', vrij: 'Vrije uitgaven', sparen: 'Spaargeld' };
const BUDGET_PCT = { vast: 0.5, vrij: 0.4, sparen: 0.1 };
const eurFmt = (n) => '€ ' + (Math.round((n || 0) * 100) / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function budgetMonthKeyFor(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }

function getBudgetData() { return getSharedKey(BUDGET_KEY, {}); }
function saveBudgetData(data) { setSharedKey(BUDGET_KEY, data); }

function getBudgetMonth(key) {
  const data = getBudgetData();
  const m = data[key] || { incomes: [], items: { vast: [], vrij: [], sparen: [] } };
  if (!m.items) m.items = { vast: [], vrij: [], sparen: [] };
  ['vast', 'vrij', 'sparen'].forEach((c) => { if (!m.items[c]) m.items[c] = []; });
  if (!m.categories || typeof m.categories !== 'object') m.categories = { vast: [], vrij: [] };
  ['vast', 'vrij'].forEach((c) => { if (!Array.isArray(m.categories[c])) m.categories[c] = []; });
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

function budgetItemRowHtml(cat, it) {
  const paid = !!it.paid;
  const checkHtml = cat === 'vast'
    ? `<input type="checkbox" class="budget-item-check" data-cat="${cat}" data-id="${esc(it.id)}"${paid ? ' checked' : ''}>`
    : '';
  return `
    <div class="budget-item-row${cat === 'vast' && paid ? ' paid' : ''}">
      ${checkHtml}
      <span class="budget-item-label">${esc(it.label)}</span>
      <span class="budget-item-amt">${eurFmt(it.amount)}</span>
      <span class="budget-item-del" data-cat="${cat}" data-id="${esc(it.id)}">✕</span>
    </div>`;
}

function budgetEnvelopeBodyHtml(cat, monthData) {
  const items = monthData.items[cat] || [];
  if (cat === 'sparen') {
    return items.length
      ? items.map((it) => budgetItemRowHtml(cat, it)).join('')
      : '<div class="empty" style="padding:4px 0;">Nog niets toegevoegd.</div>';
  }
  const categories = monthData.categories[cat] || [];
  const catIds = new Set(categories.map((c) => c.id));
  const groupsHtml = categories.map((c) => {
    const catItems = items.filter((it) => it.categoryId === c.id);
    if (!catItems.length) return '';
    return `<div class="budget-cat-label" style="color:${esc(c.color || 'var(--orange-dark)')}">${esc(c.name)}</div>` +
      catItems.map((it) => budgetItemRowHtml(cat, it)).join('');
  }).join('');
  const uncategorized = items.filter((it) => !it.categoryId || !catIds.has(it.categoryId));
  const uncatHtml = uncategorized.length ? uncategorized.map((it) => budgetItemRowHtml(cat, it)).join('') : '';
  const html = groupsHtml + uncatHtml;
  return html || '<div class="empty" style="padding:4px 0;">Nog niets toegevoegd.</div>';
}

function renderBudgetView() {
  renderBudgetMonthLabel();
  const el = document.getElementById('budgetBody');
  const monthData = getBudgetMonth(budgetActiveMonthKey);
  const income = budgetIncomeTotal(monthData);

  const envelopeHtml = ['vast', 'vrij', 'sparen'].map((cat) => {
    const total = budgetEnvelopeTotal(monthData, cat);
    const target = income * BUDGET_PCT[cat];
    const pct = target > 0 ? Math.min(100, (total / target) * 100) : (total > 0 ? 100 : 0);
    const over = target > 0 && total > target + 0.001;
    return `
      <div class="budget-envelope">
        <div class="budget-envelope-head">
          <span>${esc(BUDGET_ENVELOPE_LABELS[cat])} <span class="budget-envelope-pct">${Math.round(BUDGET_PCT[cat] * 100)}%</span></span>
          <span class="${over ? 'over' : ''}">${eurFmt(total)} <span class="budget-envelope-target">/ ${eurFmt(target)}</span></span>
        </div>
        <div class="budget-progress-track"><div class="budget-progress-fill${over ? ' over' : ''}" style="width:${pct}%"></div></div>
        ${budgetEnvelopeBodyHtml(cat, monthData)}
        <button type="button" class="budget-add-link" data-cat="${cat}">+ item toevoegen</button>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="budget-income-row"><span>Inkomsten</span><span>${eurFmt(income)}</span></div>
    ${envelopeHtml}
  `;

  el.querySelectorAll('.budget-add-link').forEach((btn) => {
    btn.addEventListener('click', () => openBudgetItemModal(btn.getAttribute('data-cat')));
  });
  el.querySelectorAll('.budget-item-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const cat = cb.getAttribute('data-cat');
      const id = cb.getAttribute('data-id');
      const monthData2 = getBudgetMonth(budgetActiveMonthKey);
      const item = (monthData2.items[cat] || []).find((it) => it.id === id);
      if (!item) return;
      item.paid = cb.checked;
      saveBudgetMonth(budgetActiveMonthKey, monthData2);
      renderBudgetView();
    });
  });
  el.querySelectorAll('.budget-item-del').forEach((del) => {
    del.addEventListener('click', () => {
      const cat = del.getAttribute('data-cat');
      const id = del.getAttribute('data-id');
      const monthData2 = getBudgetMonth(budgetActiveMonthKey);
      monthData2.items[cat] = (monthData2.items[cat] || []).filter((it) => it.id !== id);
      saveBudgetMonth(budgetActiveMonthKey, monthData2);
      renderBudgetView();
    });
  });
}

// Dit modaal wordt hergebruikt voor zowel budget-items als jaarinkomen-posten
// (zelfde velden: omschrijving + bedrag) — data-mode op de overlay bepaalt waar het
// bewaard wordt zodra er op "Toevoegen" wordt getikt.
let budgetModalCat = 'vast';
function openBudgetItemModal(cat) {
  budgetModalCat = cat;
  document.getElementById('budgetItemLabelInput').value = '';
  document.getElementById('budgetItemAmountInput').value = '';
  document.getElementById('budgetItemModalTitle').textContent = 'Item toevoegen — ' + BUDGET_ENVELOPE_LABELS[cat];
  document.getElementById('budgetItemOverlay').setAttribute('data-mode', 'budget');
  document.getElementById('budgetItemOverlay').classList.remove('hidden');
}
function closeBudgetItemModal() {
  document.getElementById('budgetItemOverlay').classList.add('hidden');
}
function saveBudgetItemFromModal() {
  const label = document.getElementById('budgetItemLabelInput').value.trim();
  const amount = parseFloat((document.getElementById('budgetItemAmountInput').value || '').replace(',', '.'));
  if (!label || !amount || isNaN(amount) || amount <= 0) return;
  const mode = document.getElementById('budgetItemOverlay').getAttribute('data-mode') || 'budget';

  if (mode === 'income') {
    const monthsArr = getAnnualIncomeYear(annualIncomeActiveYear);
    monthsArr[incomeModalMonth].push({ id: genId('ai'), label, amount: Math.round(amount * 100) / 100 });
    saveAnnualIncomeYear(annualIncomeActiveYear, monthsArr);
    closeBudgetItemModal();
    renderIncomeBody();
    return;
  }

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

// ================= SPORT: GEWICHT ================
function getWeekMondayYmd(d) {
  const date = new Date(d);
  const day = date.getDay(); // 0=zo..6=za
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return ymd(monday);
}
const MONTH_NAMES_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function getWeightLog() { return getSharedKey(WEIGHT_LOG_KEY, []); }
function saveWeightLog(log) { setSharedKey(WEIGHT_LOG_KEY, log); }

async function loadSportView() {
  const el = document.getElementById('weightBody');
  el.innerHTML = '<div class="loading">Even ophalen…</div>';
  try {
    await ensureSharedData();
    renderWeightBody();
    loadNutritionPlan();
    renderNutritionBody();
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

function renderWeightBody() {
  const el = document.getElementById('weightBody');
  const log = getWeightLog();
  const currentWeek = getWeekMondayYmd(new Date());
  const already = log.some((e) => e.week === currentWeek);

  const addRowHtml = already
    ? '<div class="empty" style="padding-bottom:10px;">Deze week is je gewicht al ingevuld.</div>'
    : `<div class="weight-add-row">
        <input type="number" step="0.1" inputmode="decimal" id="weightInput" placeholder="Gewicht deze week (kg)">
        <button type="button" id="weightAddBtn">Opslaan</button>
      </div>`;

  const sorted = log.slice().sort((a, b) => b.week.localeCompare(a.week));
  const rowsHtml = sorted.length
    ? sorted.map((entry, i) => {
        const prev = sorted[i + 1];
        const d = new Date(entry.week + 'T00:00:00');
        const dateLabel = d.getDate() + ' ' + MONTH_NAMES_NL[d.getMonth()] + ' ' + d.getFullYear();
        let diffHtml = '<span class="w-diff">—</span>';
        if (prev) {
          const diff = entry.weight - prev.weight;
          const cls = diff < 0 ? 'down' : (diff > 0 ? 'up' : '');
          diffHtml = `<span class="w-diff ${cls}">${(diff > 0 ? '+' : '') + diff.toFixed(1)} kg</span>`;
        }
        return `<div class="weight-row" data-week="${esc(entry.week)}">
          <span class="w-date">${esc(dateLabel)}</span>
          <span class="w-amt">${entry.weight.toFixed(1)} kg</span>
          ${diffHtml}
          <span class="w-del" data-week="${esc(entry.week)}">✕</span>
        </div>`;
      }).join('')
    : '<div class="empty">Nog geen gewicht ingevuld.</div>';

  el.innerHTML = addRowHtml + rowsHtml;

  const addBtn = document.getElementById('weightAddBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const input = document.getElementById('weightInput');
      const value = parseFloat((input.value || '').replace(',', '.'));
      if (!value || isNaN(value) || value <= 0) return;
      const log2 = getWeightLog();
      if (log2.some((e) => e.week === currentWeek)) { renderWeightBody(); return; }
      log2.push({ week: currentWeek, weight: Math.round(value * 10) / 10, loggedAt: new Date().toISOString() });
      saveWeightLog(log2);
      renderWeightBody();
    });
  }
  el.querySelectorAll('.w-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('Deze meting verwijderen?')) return;
      saveWeightLog(getWeightLog().filter((x) => x.week !== btn.getAttribute('data-week')));
      renderWeightBody();
    });
  });
}

// ================= SPORT: VOEDINGSSCHEMA (boek) =================
const NUTRITION_SECTION_DEFS = [
  { key: 'ontbijt', emoji: '', label: 'Ontbijt' },
  { key: 'tussendoor1', emoji: '☕', label: 'Tussendoor' },
  { key: 'lunch', emoji: '🥪', label: 'Lunch' },
  { key: 'tussendoor2', emoji: '🥜', label: 'Tussendoor' },
  { key: 'avondeten', emoji: '🍽️', label: 'Avondeten' },
  { key: 'avondsnack', emoji: '🥣', label: 'Avondsnack' }
];

function emptyNutritionSection(defaultTime) { return { time: defaultTime || '', dish: '', items: [], macro: '' }; }

function defaultNutritionDay(label) {
  return {
    id: 'day-' + Math.random().toString(36).slice(2, 9),
    label,
    sections: {
      ontbijt: emptyNutritionSection('07:30'),
      tussendoor1: emptyNutritionSection('10:00'),
      lunch: emptyNutritionSection('12:30'),
      tussendoor2: emptyNutritionSection('15:00'),
      avondeten: emptyNutritionSection('18:00'),
      avondsnack: emptyNutritionSection('20:30 - 21:00')
    }
  };
}

let nutritionPlan = [];
let nutritionActiveIndex = 0;

function loadNutritionPlan() {
  const raw = getSharedKey(NUTRITION_PLAN_KEY, null);
  nutritionPlan = (Array.isArray(raw) && raw.length > 0) ? raw : [defaultNutritionDay('Dag 1')];
}
function saveNutritionPlan() { setSharedKey(NUTRITION_PLAN_KEY, nutritionPlan); }

function nutritionSectionHtml(day, def) {
  const s = day.sections[def.key] || emptyNutritionSection('');
  const itemsHtml = (s.items || []).map((txt, idx) => `
    <li class="nutri-item">
      <input type="text" class="nutri-item-input" data-section="${def.key}" data-idx="${idx}" value="${esc(txt)}" placeholder="Ingrediënt…">
      <span class="nutri-item-del" data-section="${def.key}" data-idx="${idx}">×</span>
    </li>`).join('');
  return `
    <div class="nutri-section">
      <div class="nutri-section-head">
        ${def.emoji ? `<span>${def.emoji}</span>` : ''}
        <span class="nutri-section-title">${esc(def.label)}</span>
        <input type="text" class="nutri-section-time" data-section="${def.key}" data-field="time" value="${esc(s.time || '')}" placeholder="tijd">
      </div>
      <input type="text" class="nutri-section-dish" data-section="${def.key}" data-field="dish" value="${esc(s.dish || '')}" placeholder="Naam gerecht (optioneel)">
      <ul class="nutri-item-list">${itemsHtml}</ul>
      <button type="button" class="nutri-item-add" data-section="${def.key}">+ item</button>
      <input type="text" class="nutri-section-macro" data-section="${def.key}" data-field="macro" value="${esc(s.macro || '')}" placeholder="≈ … kcal | ±… g eiwit">
    </div>`;
}

function renderNutritionBody() {
  if (nutritionPlan.length === 0) loadNutritionPlan();
  if (nutritionActiveIndex < 0) nutritionActiveIndex = nutritionPlan.length - 1;
  if (nutritionActiveIndex >= nutritionPlan.length) nutritionActiveIndex = 0;
  const day = nutritionPlan[nutritionActiveIndex];

  const labelEl = document.getElementById('nutriBookLabel');
  if (labelEl) labelEl.textContent = day.label || `Dag ${nutritionActiveIndex + 1}`;

  const bodyEl = document.getElementById('nutriBody');
  if (bodyEl) bodyEl.innerHTML = NUTRITION_SECTION_DEFS.map((def) => nutritionSectionHtml(day, def)).join('');

  wireNutritionInputs();
}

function wireNutritionInputs() {
  const day = nutritionPlan[nutritionActiveIndex];
  document.querySelectorAll('.nutri-section-time, .nutri-section-dish, .nutri-section-macro').forEach((inp) => {
    inp.addEventListener('input', () => {
      const key = inp.getAttribute('data-section');
      const field = inp.getAttribute('data-field');
      if (!day.sections[key]) day.sections[key] = emptyNutritionSection('');
      day.sections[key][field] = inp.value;
      saveNutritionPlan();
    });
  });
  document.querySelectorAll('.nutri-item-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const key = inp.getAttribute('data-section');
      const idx = parseInt(inp.getAttribute('data-idx'), 10);
      if (day.sections[key] && day.sections[key].items) {
        day.sections[key].items[idx] = inp.value;
        saveNutritionPlan();
      }
    });
  });
  document.querySelectorAll('.nutri-item-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-section');
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (day.sections[key] && day.sections[key].items) {
        day.sections[key].items.splice(idx, 1);
        saveNutritionPlan();
        renderNutritionBody();
      }
    });
  });
  document.querySelectorAll('.nutri-item-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-section');
      if (!day.sections[key]) day.sections[key] = emptyNutritionSection('');
      if (!day.sections[key].items) day.sections[key].items = [];
      day.sections[key].items.push('');
      saveNutritionPlan();
      renderNutritionBody();
    });
  });
}

function shiftNutritionDay(delta) {
  nutritionActiveIndex += delta;
  if (nutritionActiveIndex < 0) nutritionActiveIndex = nutritionPlan.length - 1;
  if (nutritionActiveIndex >= nutritionPlan.length) nutritionActiveIndex = 0;
  renderNutritionBody();
}
function addNutritionDay() {
  nutritionPlan.push(defaultNutritionDay(`Dag ${nutritionPlan.length + 1}`));
  nutritionActiveIndex = nutritionPlan.length - 1;
  saveNutritionPlan();
  renderNutritionBody();
}

// ================= ZZP: BTW =================
function getBtwDeadline(year, quarter) {
  switch (quarter) {
    case 1: return new Date(year, 3, 30);
    case 2: return new Date(year, 6, 31);
    case 3: return new Date(year, 9, 31);
    case 4: return new Date(year + 1, 0, 31);
    default: return null;
  }
}
function btwQuarterKey(year, quarter) { return year + '-Q' + quarter; }
function getBtwStatus() { return getSharedKey(BTW_STATUS_KEY, {}); }
function saveBtwStatus(s) { setSharedKey(BTW_STATUS_KEY, s); }

async function loadZzpView() {
  const btwEl = document.getElementById('btwBody');
  const incomeEl = document.getElementById('incomeBody');
  btwEl.innerHTML = '<div class="loading">Even ophalen…</div>';
  incomeEl.innerHTML = '<div class="loading">Even ophalen…</div>';
  try {
    await ensureSharedData();
    renderBtwBody();
    renderIncomeBody();
  } catch (e) {
    console.error(e);
    btwEl.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

function renderBtwBody() {
  const el = document.getElementById('btwBody');
  const now = new Date();
  const year = now.getFullYear();
  const status = getBtwStatus();
  const rows = [];
  for (let y = year - 1; y <= year + 1; y++) {
    for (let q = 1; q <= 4; q++) {
      const deadline = getBtwDeadline(y, q);
      const key = btwQuarterKey(y, q);
      const daysUntil = Math.round((deadline - now) / 86400000);
      if (daysUntil < -60 || daysUntil > 120) continue;
      rows.push({ y, q, deadline, key, daysUntil, done: !!status[key] });
    }
  }
  rows.sort((a, b) => a.daysUntil - b.daysUntil);
  el.innerHTML = rows.map((r) => {
    const label = r.deadline.getDate() + ' ' + MONTH_NAMES_NL[r.deadline.getMonth()] + ' ' + r.deadline.getFullYear();
    return `<div class="btw-row">
      <span>Kwartaal ${r.q} (${r.y})<div class="btw-deadline">deadline ${esc(label)}</div></span>
      <button type="button" class="btw-status-btn${r.done ? ' done' : ''}" data-key="${r.key}">${r.done ? 'Gedaan ✓' : 'Markeer gedaan'}</button>
    </div>`;
  }).join('') || '<div class="empty">Niets op dit moment.</div>';

  el.querySelectorAll('.btw-status-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      const s = getBtwStatus();
      s[key] = !s[key];
      if (!s[key]) delete s[key];
      saveBtwStatus(s);
      renderBtwBody();
    });
  });
}

// ================= ZZP: JAAROVERZICHT INKOMEN =================
let annualIncomeActiveYear = new Date().getFullYear();

function getAnnualIncomeData() { return getSharedKey(ANNUAL_INCOME_KEY, {}); }
function saveAnnualIncomeData(data) { setSharedKey(ANNUAL_INCOME_KEY, data); }
function getAnnualIncomeYear(year) {
  const data = getAnnualIncomeData();
  const raw = data[String(year)];
  if (!Array.isArray(raw) || raw.length !== 12) return Array.from({ length: 12 }, () => []);
  return raw.map((m) => Array.isArray(m) ? m.slice() : []);
}
function saveAnnualIncomeYear(year, monthsArr) {
  const data = getAnnualIncomeData();
  data[String(year)] = monthsArr;
  saveAnnualIncomeData(data);
}
function annualIncomeMonthTotal(items) { return (items || []).reduce((s, it) => s + (typeof it.amount === 'number' ? it.amount : 0), 0); }

function renderIncomeBody() {
  document.getElementById('incomeYearLabel').textContent = String(annualIncomeActiveYear);
  const el = document.getElementById('incomeBody');
  const monthsArr = getAnnualIncomeYear(annualIncomeActiveYear);
  const yearTotal = monthsArr.reduce((s, items) => s + annualIncomeMonthTotal(items), 0);
  const now = new Date();
  const monthsHtml = monthsArr.map((items, idx) => {
    const isCurrent = now.getFullYear() === annualIncomeActiveYear && idx === now.getMonth();
    const itemsHtml = items.length
      ? items.map((it) => `<div class="income-item-row"><span>${esc(it.label)}</span><span>${eurFmt(it.amount)}</span></div>`).join('')
      : '';
    return `<div class="income-month">
      <div class="income-month-head" style="${isCurrent ? 'text-decoration:underline;' : ''}">
        <span>${esc(MONTH_NAMES_NL[idx])}${isCurrent ? ' (nu)' : ''}</span>
        <span>${eurFmt(annualIncomeMonthTotal(items))}</span>
      </div>
      ${itemsHtml}
      <button type="button" class="budget-add-link" data-month="${idx}">+ item toevoegen</button>
    </div>`;
  }).join('');

  el.innerHTML = `<div class="budget-income-row"><span>Totaal ${annualIncomeActiveYear}</span><span>${eurFmt(yearTotal)}</span></div>${monthsHtml}`;

  el.querySelectorAll('.budget-add-link').forEach((btn) => {
    btn.addEventListener('click', () => openIncomeItemModal(parseInt(btn.getAttribute('data-month'), 10)));
  });
}

let incomeModalMonth = 0;
function openIncomeItemModal(monthIdx) {
  incomeModalMonth = monthIdx;
  document.getElementById('budgetItemLabelInput').value = '';
  document.getElementById('budgetItemAmountInput').value = '';
  document.getElementById('budgetItemModalTitle').textContent = 'Inkomsten toevoegen — ' + MONTH_NAMES_NL[monthIdx];
  document.getElementById('budgetItemOverlay').classList.remove('hidden');
  document.getElementById('budgetItemOverlay').setAttribute('data-mode', 'income');
}

function shiftIncomeYear(delta) {
  annualIncomeActiveYear += delta;
  renderIncomeBody();
}

// ================= AUTO =================
function getCarApkList() { return getSharedKey(CAR_APK_KEY, []); }
function saveCarApkList(list) { setSharedKey(CAR_APK_KEY, list); }
function getCarVisitsList() { return getSharedKey(CAR_VISITS_KEY, []); }
function saveCarVisitsList(list) { setSharedKey(CAR_VISITS_KEY, list); }

async function loadAutoView() {
  const apkEl = document.getElementById('apkBody');
  const visitsEl = document.getElementById('carVisitsBody');
  apkEl.innerHTML = '<div class="loading">Even ophalen…</div>';
  visitsEl.innerHTML = '<div class="loading">Even ophalen…</div>';
  try {
    await ensureSharedData();
    renderApkBody();
    renderCarVisitsBody();
  } catch (e) {
    console.error(e);
    apkEl.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

function getNextApkInfo() {
  const list = getCarApkList();
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
  const last = sorted[0];
  const lastDate = new Date(last.date + 'T00:00:00');
  const next = new Date(lastDate);
  next.setFullYear(next.getFullYear() + 1);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((next - today0) / 86400000);
  return { lastDate, nextDate: next, daysUntil };
}

function renderApkBody() {
  const el = document.getElementById('apkBody');
  const info = getNextApkInfo();
  let infoHtml = '<div class="empty">Nog geen APK-keuring ingevuld.</div>';
  if (info) {
    const label = info.nextDate.getDate() + ' ' + MONTH_NAMES_NL[info.nextDate.getMonth()] + ' ' + info.nextDate.getFullYear();
    const cls = info.daysUntil < 0 ? 'over' : (info.daysUntil <= 30 ? 'soon' : 'ok');
    const text = info.daysUntil < 0 ? ('Verlopen sinds ' + label) : ('Volgende APK: ' + label);
    infoHtml = `<span class="apk-badge ${cls}">${esc(text)}</span>`;
  }

  const list = getCarApkList().slice().sort((a, b) => b.date.localeCompare(a.date));
  const rowsHtml = list.map((e) => {
    const d = new Date(e.date + 'T00:00:00');
    const dateLabel = d.getDate() + ' ' + MONTH_NAMES_NL[d.getMonth()] + ' ’' + String(d.getFullYear()).slice(2);
    return `<div class="car-visit-row" data-id="${esc(e.id)}">
      <div class="cv-title">${dateLabel} — ${e.result === 'afgekeurd' ? 'Afgekeurd' : 'Goedgekeurd'}</div>
      <div class="cv-meta">${[e.km ? e.km + ' km' : '', e.notitie || ''].filter(Boolean).join(' · ')}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div style="margin-bottom:10px;">${infoHtml}</div>
    <div class="apk-date-row">
      <input type="date" id="apkDateInput">
      <select id="apkResultInput" style="border:1px solid var(--border-soft); border-radius:10px; padding:9px; font-family:inherit;">
        <option value="goedgekeurd">Goedgekeurd</option>
        <option value="afgekeurd">Afgekeurd</option>
      </select>
    </div>
    <button type="button" id="apkAddBtn" class="budget-add-link" style="margin:6px 0 10px;">+ keuring toevoegen</button>
    ${rowsHtml}`;

  document.getElementById('apkAddBtn').addEventListener('click', () => {
    const dateInput = document.getElementById('apkDateInput');
    const resultInput = document.getElementById('apkResultInput');
    if (!dateInput.value) return;
    const list2 = getCarApkList();
    list2.push({ id: genId('apk'), date: dateInput.value, result: resultInput.value, km: '', kosten: '', notitie: '' });
    saveCarApkList(list2);
    renderApkBody();
  });
}

function renderCarVisitsBody() {
  const el = document.getElementById('carVisitsBody');
  const list = getCarVisitsList().slice().sort((a, b) => b.date.localeCompare(a.date));
  el.innerHTML = list.length
    ? list.map((e) => {
        const d = new Date(e.date + 'T00:00:00');
        const dateLabel = d.getDate() + ' ' + MONTH_NAMES_NL[d.getMonth()] + ' ’' + String(d.getFullYear()).slice(2);
        return `<div class="car-visit-row" data-id="${esc(e.id)}">
          <div class="cv-title">${esc(e.omschrijving || 'Garagebezoek')}</div>
          <div class="cv-meta">${dateLabel}${e.garage ? ' · ' + esc(e.garage) : ''}${e.kosten ? ' · €' + esc(e.kosten) : ''}</div>
        </div>`;
      }).join('')
    : '<div class="empty">Nog geen onderhoud ingevuld.</div>';
}

function openCarVisitModal() {
  const date = prompt('Datum (JJJJ-MM-DD):', ymd(new Date()));
  if (!date) return;
  const omschrijving = prompt('Omschrijving:', '') || '';
  const garage = prompt('Garage (optioneel):', '') || '';
  const kosten = prompt('Kosten in € (optioneel):', '') || '';
  const list = getCarVisitsList();
  list.push({ id: genId('visit'), date, garage, omschrijving, km: '', kosten });
  saveCarVisitsList(list);
  renderCarVisitsBody();
}
