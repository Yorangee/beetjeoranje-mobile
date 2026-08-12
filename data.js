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
const BRAINDUMP_KEY = 'beetjeoranje-dashboard-braindump-v1';

let sharedSyncFileId = null;
let sharedData = null; // { [key]: stringValue, ... } — precies zoals cloudSyncSnapshotFromLocalStorage() op desktop
let sharedDataLoaded = false;
let sharedDataPushTimer = null;

function pad2(n) { return String(n).padStart(2, '0'); }

// Zoekt ALLE bestanden met deze naam in de sync-map (desktop maakt bij elke push een
// NIEUW bestand aan i.p.v. het bestaande te overschrijven — zie cloudSyncPush() in het
// desktop-dashboard), en pakt het meest recente op createdTime. Zo blijft mobiel exact
// consistent met hoe desktop dit al deed, ook als er meerdere back-upbestanden staan.
// supportsAllDrives + includeItemsFromAllDrives: zonder deze twee parameters negeert de
// Drive v3 API stilletjes alles wat in een Gedeelde Drive (Shared Drive) staat i.p.v.
// "Mijn Drive" — geen foutmelding, gewoon een lege resultatenlijst. Dit was de oorzaak
// van "facturen niet gevonden": de Facturen-map staat kennelijk in een Gedeelde Drive.
const DRIVE_ALL_DRIVES_PARAMS = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

async function driveFindLatestSyncFile() {
  const q = encodeURIComponent(`name='${DRIVE_SYNC_FILE_NAME}' and '${DRIVE_SYNC_FOLDER_ID}' in parents and trashed=false`);
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + encodeURIComponent('files(id,name,createdTime)') + '&orderBy=createdTime desc&pageSize=5&' + DRIVE_ALL_DRIVES_PARAMS, {
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
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + googleAccessToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
    body
  });
  if (!res.ok) throw new Error('Drive-bestand aanmaken mislukt (' + res.status + ')');
  return res.json();
}

async function driveReadFileRaw(fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true', {
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

// Zelfde opschoning als desktop: verboden tags/event-attributen eruit, maar verder de
// opmaak (bold/italic/underline/kleur/lettergrootte) intact laten.
function sanitizeHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('script,style,iframe,object,embed').forEach((el) => el.remove());
  tmp.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name) || attr.name === 'srcdoc') el.removeAttribute(attr.name);
    });
  });
  return tmp.innerHTML;
}

// Zet losse URL's in de tekst om in klikbare links — zelfde aanpak als desktop
// (loopt over de DOM i.p.v. ruwe regex op HTML, zodat bestaande links niet geraakt worden).
const NOTE_URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
function linkifyNode(node) {
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent;
      NOTE_URL_PATTERN.lastIndex = 0;
      if (!NOTE_URL_PATTERN.test(text)) return;
      NOTE_URL_PATTERN.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIndex = 0, match;
      while ((match = NOTE_URL_PATTERN.exec(text))) {
        if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        let url = match[1];
        let trail = '';
        while (url && /[).,;:!?]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
        if (!url) { frag.appendChild(document.createTextNode(match[0])); lastIndex = match.index + match[0].length; continue; }
        const href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
        const a = document.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.textContent = url;
        frag.appendChild(a);
        if (trail) frag.appendChild(document.createTextNode(trail));
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      node.replaceChild(frag, child);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.tagName === 'A' || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
      linkifyNode(child);
    }
  });
}
function linkifyPlainUrls(html) {
  if (!html) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  linkifyNode(tmp);
  return tmp.innerHTML;
}

let editingNoteId = null;
let noteSavedRange = null;

function openNoteEditor(id) {
  const notes = getNotes();
  const note = id ? notes.find((n) => n.id === id) : null;
  editingNoteId = id || null;

  const cats = getNoteCategories();
  const sel = document.getElementById('noteCategorySelect');
  sel.innerHTML = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  document.getElementById('noteTitleInput').value = note ? (note.title || '') : '';
  sel.value = note ? (note.category || cats[0]) : cats[0];
  document.getElementById('noteBodyInput').innerHTML = note ? (note.contentHTML || '') : '';
  document.getElementById('noteDeleteBtn').style.display = note ? '' : 'none';
  document.getElementById('noteEditorOverlay').classList.remove('hidden');
  const popover = document.getElementById('rteColorPopover');
  if (popover) popover.classList.add('hidden');
  const scroll = document.getElementById('notePageScroll');
  if (scroll) scroll.scrollTop = 0;
}

function closeNoteEditor() {
  document.getElementById('noteEditorOverlay').classList.add('hidden');
  editingNoteId = null;
  noteSavedRange = null;
  const popover = document.getElementById('rteColorPopover');
  if (popover) popover.classList.add('hidden');
}

function saveNoteFromEditor() {
  const title = document.getElementById('noteTitleInput').value.trim();
  const category = document.getElementById('noteCategorySelect').value;
  const bodyEl = document.getElementById('noteBodyInput');
  const contentHTML = linkifyPlainUrls(sanitizeHtml(bodyEl.innerHTML));
  const plain = htmlToPlainText(contentHTML);
  if (!title && !plain) { closeNoteEditor(); return; }

  const notes = getNotes();
  const now = Date.now();
  if (editingNoteId) {
    const idx = notes.findIndex((n) => n.id === editingNoteId);
    if (idx !== -1) {
      notes[idx].title = title;
      notes[idx].category = category;
      notes[idx].contentHTML = contentHTML;
      notes[idx].content = plain;
      notes[idx].updatedAt = now;
    }
  } else {
    notes.unshift({ id: genId('n'), title, category, contentHTML, content: plain, createdAt: now, updatedAt: now });
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

// ---------- Rich-text-opmaakbalk ----------
// Gebruikt document.execCommand — verouderd maar nog overal (incl. mobiele browsers)
// ondersteund, en precies wat het desktop-dashboard ook gebruikt, zodat de opgeslagen
// HTML tussen beide versies compatibel blijft.
const TEXT_COLOR_PRESETS = ['#2B2016', '#9A3B26', '#C8622A', '#B8860B', '#3F7D4F', '#2E6E8E', '#4A5FBE', '#7C3FA0', '#B23A73', '#6B6B6B'];

function setupRichTextToolbar() {
  const body = document.getElementById('noteBodyInput');
  const scrollWrap = document.getElementById('notePageScroll');

  function saveSel() {
    const sel = window.getSelection();
    if (sel.rangeCount && body.contains(sel.anchorNode)) noteSavedRange = sel.getRangeAt(0).cloneRange();
  }
  function restoreSel() {
    body.focus();
    if (noteSavedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(noteSavedRange);
    }
  }
  body.addEventListener('mouseup', saveSel);
  body.addEventListener('keyup', saveSel);
  body.addEventListener('touchend', saveSel);
  body.addEventListener('focus', saveSel);

  function doCommand(command) {
    restoreSel();
    document.execCommand(command, false, null);
    saveSel();
  }

  document.getElementById('rteBoldBtn').addEventListener('click', () => doCommand('bold'));
  document.getElementById('rteItalicBtn').addEventListener('click', () => doCommand('italic'));
  document.getElementById('rteUnderlineBtn').addEventListener('click', () => doCommand('underline'));

  document.getElementById('rteSizeSelect').addEventListener('change', (e) => {
    restoreSel();
    document.execCommand('fontSize', false, e.target.value);
    saveSel();
  });

  // Tekstkleur: verfemmertje met voorgedefinieerde kleuren + "Aangepast" als fallback
  // (zelfde presets als op desktop, zodat notities er overal hetzelfde uitzien).
  const colorBtn = document.getElementById('rteColorBtn');
  const colorInput = document.getElementById('rteColorInput');
  const colorPopover = document.getElementById('rteColorPopover');
  const swatchesEl = document.getElementById('rteColorSwatches');
  swatchesEl.innerHTML = TEXT_COLOR_PRESETS.map((c) =>
    `<button type="button" class="rte-color-swatch" style="background:${c}" data-color="${c}" title="${c}"></button>`
  ).join('');
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveSel();
    colorPopover.classList.toggle('hidden');
  });
  swatchesEl.addEventListener('click', (e) => {
    const sw = e.target.closest('.rte-color-swatch');
    if (!sw) return;
    restoreSel();
    document.execCommand('foreColor', false, sw.getAttribute('data-color'));
    saveSel();
    colorPopover.classList.add('hidden');
  });
  colorInput.addEventListener('input', (e) => {
    restoreSel();
    document.execCommand('foreColor', false, e.target.value);
    saveSel();
  });
  colorInput.addEventListener('change', () => colorPopover.classList.add('hidden'));
  document.addEventListener('click', (e) => {
    if (!colorPopover.classList.contains('hidden') && !e.target.closest('.rte-color-wrap')) {
      colorPopover.classList.add('hidden');
    }
  });

  // Geselecteerde tekst moet met Backspace/Delete verdwijnen — sommige mobiele
  // browsers doen dit niet altijd betrouwbaar via het standaard contenteditable-gedrag.
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return;
    e.preventDefault();
    range.deleteContents();
  });

  // Klikken op lege ruimte onder de tekst zet de cursor aan het einde — maar nooit als
  // er net een selectie is gemaakt (anders verdwijnt de selectie meteen weer).
  if (scrollWrap) {
    scrollWrap.addEventListener('click', (e) => {
      if (e.target !== scrollWrap) return;
      const existingSel = window.getSelection();
      if (existingSel && !existingSel.isCollapsed) return;
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      existingSel.removeAllRanges();
      existingSel.addRange(range);
    });
  }
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
    const collapsed = !!c.collapsed;
    const total = catItems.reduce((s, it) => s + it.amount, 0);
    return `
      <div class="budget-cat-group" data-cat-id="${esc(c.id)}" data-cat="${cat}">
        <div class="budget-cat-head" style="color:${esc(c.color || 'var(--orange-dark)')}">
          <span class="budget-cat-toggle${collapsed ? ' collapsed' : ''}" data-cat="${cat}" data-cat-id="${esc(c.id)}">▾</span>
          <span class="budget-cat-name">${esc(c.name)}</span>
          <span class="budget-cat-total">${eurFmt(total)}</span>
        </div>
        <div class="budget-cat-items${collapsed ? ' collapsed' : ''}">${catItems.map((it) => budgetItemRowHtml(cat, it)).join('')}</div>
      </div>`;
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
  el.querySelectorAll('.budget-cat-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const cat = toggle.getAttribute('data-cat');
      const catId = toggle.getAttribute('data-cat-id');
      const monthData2 = getBudgetMonth(budgetActiveMonthKey);
      const category = (monthData2.categories[cat] || []).find((c) => c.id === catId);
      if (!category) return;
      category.collapsed = !category.collapsed;
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
  renderWeightChart(log);

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
  const isSameYear = now.getFullYear() === annualIncomeActiveYear;
  const monthsHtml = monthsArr.map((items, idx) => {
    const isCurrent = isSameYear && idx === now.getMonth();
    const isPast = annualIncomeActiveYear < now.getFullYear() || (isSameYear && idx < now.getMonth());
    const itemsHtml = items.length
      ? items.map((it) => `<div class="income-item-row"><span>${esc(it.label)}</span><span>${eurFmt(it.amount)}</span></div>`).join('')
      : '';
    return `<div class="income-month">
      <div class="income-month-head" style="${isCurrent ? 'text-decoration:underline;' : ''}">
        <span>${esc(MONTH_NAMES_NL[idx])}${isCurrent ? ' (nu)' : ''}</span>
        <span class="income-month-total${isPast ? ' past' : ''}">${eurFmt(annualIncomeMonthTotal(items))}</span>
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

// ================= ZZP: FACTUREN (Drive-map met PDF's, net als desktop) =================
// Desktop leest facturen niet uit het gedeelde JSON-bestand maar leest ze live uit een
// Drive-map vol PDF's (submap per kwartaal) en parseert bestandsnaam + PDF-inhoud met
// regex. Mobiel doet exact hetzelfde via de Drive v3 REST API, met pdf.js (lazy geladen
// vanaf een CDN, alleen wanneer deze kaart daadwerkelijk geopend wordt) voor de
// tekst-extractie uit de PDF's zelf.
const FACTUREN_FOLDER_ID = '1hkIVdq-x2gQ_CXlVDhlExXsSaa6q9cNV';
// Bewust een oudere, zeer breed geteste pdf.js-versie (3.11.174 — de laatste vóór pdf.js
// overstapte op ES-module-only builds) i.p.v. de nieuwste. De nieuwste versie (6.x) bleek
// op dit toestel te struikelen binnen getTextContent() zelf (TypeError diep in pdf.js'
// eigen minified code, dus geen cross-origin/worker-probleem maar een compatibiliteits-
// probleem met een nieuwere JS-taalfeature). Deze klassieke (niet-module) build gebruikt
// een gewoon <script>-tag en een gewone (niet-module) worker, wat veel minder kans geeft
// op dit soort incompatibiliteit met oudere mobiele browsers.
const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsLibPromise = null;
function loadScriptTag(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('script laden mislukt: ' + src));
    document.head.appendChild(script);
  });
}
function ensurePdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      if (!window.pdfjsLib) {
        await loadScriptTag(PDFJS_BASE + 'pdf.min.js');
      }
      if (!window.pdfjsLib) throw new Error('pdfjsLib niet gevonden na laden van pdf.min.js');
      // De worker cross-origin (CDN-domein i.p.v. het domein van de app) laten laden
      // faalt op sommige mobiele browsers stilletjes — de workercode zelf ophalen en als
      // same-origin blob-URL aanbieden omzeilt dat.
      const workerRes = await fetch(PDFJS_BASE + 'pdf.worker.min.js');
      if (!workerRes.ok) throw new Error('pdf.js-worker ophalen mislukt (' + workerRes.status + ')');
      const workerBlob = await workerRes.blob();
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);
      return window.pdfjsLib;
    })().catch((e) => {
      // Bij mislukken de cache leeggooien, zodat een volgende poging (nogmaals op
      // "Ververs" tikken) écht opnieuw probeert i.p.v. voor altijd dezelfde mislukte
      // poging terug te geven.
      pdfjsLibPromise = null;
      throw e;
    });
  }
  return pdfjsLibPromise;
}

async function driveListChildren(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=' + encodeURIComponent('files(id,name,mimeType)') + '&pageSize=200&' + DRIVE_ALL_DRIVES_PARAMS, {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) {
    let detail = '';
    try { const body = await res.json(); detail = body && body.error && body.error.message ? ' — ' + body.error.message : ''; } catch (e) { /* geen JSON-body */ }
    throw new Error('Drive-map ophalen mislukt (' + res.status + ')' + detail);
  }
  const data = await res.json();
  return data.files || [];
}

// Geeft zo veel mogelijk diagnostische info terug over een fout — Safari's generieke
// "undefined is not a function" alleen zegt niets, maar de stacktrace (als die er is)
// verraadt meestal wél in welke functie het misging.
function describeError(e, stage) {
  const base = (e && e.name ? e.name + ': ' : '') + ((e && e.message) ? e.message : String(e));
  const stack = (e && e.stack) ? ' | stack: ' + String(e.stack).replace(/\s+/g, ' ').slice(0, 220) : '';
  return '[' + stage + '] ' + base + stack;
}

async function extractPdfText(fileId, fileName) {
  let buf;
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true', {
      headers: { Authorization: 'Bearer ' + googleAccessToken }
    });
    if (!res.ok) throw new Error('PDF ophalen mislukt (' + res.status + ')');
    buf = await res.arrayBuffer();
  } catch (e) { throw new Error(describeError(e, 'ophalen ' + fileName)); }

  let pdfjsLib;
  try {
    pdfjsLib = await ensurePdfJs();
  } catch (e) { throw new Error(describeError(e, 'pdf.js laden')); }

  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (e) { throw new Error(describeError(e, 'getDocument ' + fileName)); }

  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 2); i++) {
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += pdfTextItemsToString(content.items) + '\n';
    } catch (e) { throw new Error(describeError(e, 'pagina ' + i + ' lezen ' + fileName)); }
  }
  return text;
}

// Tekst-items van pdf.js gewoon met een spatie aan elkaar plakken (zoals eerst) knipt
// getallen soms stuk: sommige PDF-generators (vooral facturen met keurig uitgelijnde
// bedragen) plaatsen elk cijfer als los tekst-"item" op zijn eigen positie. Een simpele
// join(' ') zet dan bijvoorbeeld "605" om in "6 0 5", waarna de bedrag-regex alleen het
// eerste cijfer meepakt. Deze functie voegt alleen een spatie toe als er ook echt een
// merkbaar gat tussen twee items zit (nieuw woord/kolom), anders plakt hij ze aan elkaar.
function pdfTextItemsToString(items) {
  let out = '';
  let prev = null;
  for (const item of items) {
    const tf = item.transform || [1, 0, 0, 1, 0, 0];
    const x = tf[4], y = tf[5];
    if (prev) {
      const sameLine = Math.abs(y - prev.y) < 2;
      if (!sameLine) {
        out += '\n';
      } else {
        const gap = x - prev.endX;
        const threshold = (item.height || prev.height || 10) * 0.22;
        if (gap > threshold) out += ' ';
      }
    }
    out += item.str;
    prev = { y, endX: x + (item.width || 0), height: item.height };
  }
  return out;
}

// Bedragen tolerant parsen: haalt eerst alle spaties (en eventuele overgebleven
// niet-cijfer-tekens) weg voordat de duizend-/decimaalscheiding wordt ontward — vangt
// nog resterende gevallen op waarin cijfers per ongeluk uit elkaar gehaald werden.
function parseAmount(str) {
  if (!str) return 0;
  const noSpaces = String(str).replace(/\s+/g, '');
  const cleaned = noSpaces.replace(/\./g, '').replace(',', '.');
  const v = parseFloat(cleaned);
  return isNaN(v) ? 0 : v;
}
function extractYear(str) {
  const m = String(str || '').match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

// Zelfde regex-logica als parseInvoice() op desktop: bestandsnaam heeft voorrang voor
// factuurnummer/klant, de rest (datum, bedragen) komt altijd uit de PDF-tekst.
function parseInvoiceMobile(file, quarterLabel, text) {
  const title = file.name || '';
  const fnMatch = title.match(/Factuur_(.+?)_(.+)\.pdf$/i);
  const invoiceNumber = fnMatch ? fnMatch[1] : ((text.match(/Factuurnummer:\s*([\w-]+)/i) || [])[1] || '—');
  const client = fnMatch ? fnMatch[2].replace(/_/g, ' ').trim() : ((text.match(/Factuur voor:\s*([^\n]+)/i) || [])[1] || 'Onbekend');
  const dateMatch = text.match(/(?:Factuurdatum|Datum):\s*([\d./-]+)/i);
  const exclMatch = text.match(/Totaal\s*excl\.?\s*BTW:?\s*€?\s*([\d.,]+)/i);
  const btwMatch = text.match(/BTW\s*\d{1,2}%:?\s*€?\s*([\d.,]+)/i);
  const totalMatch = text.match(/\bTotaal:\s*€?\s*([\d.,]+)/i);

  const excl = parseAmount(exclMatch && exclMatch[1]);
  const btw = parseAmount(btwMatch && btwMatch[1]);
  const total = totalMatch ? parseAmount(totalMatch[1]) : (excl + btw);

  let qLabel = quarterLabel || '';
  const qm = qLabel.match(/Kwartaal\s*(\d)/i);
  if (qm) qLabel = 'Q' + qm[1];

  const dateStr = (dateMatch && dateMatch[1]) || '—';
  const year = extractYear(dateStr) || extractYear(quarterLabel) || extractYear(title) || String(new Date().getFullYear());

  return { id: file.id, fileName: title, invoiceNumber, client, date: dateStr, year, excl, btw, total, quarter: qLabel };
}

// Simpele concurrency-pool zodat niet alle PDF's tegelijk (kan traag/zwaar zijn op
// mobiel netwerk) maar ook niet strikt na elkaar (te langzaam) worden opgehaald.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(runOne));
  return results;
}

let financeInvoicesCache = [];
let financeLoaded = false;
let financeLoading = false;
let financeActiveYear = String(new Date().getFullYear());
let financeActiveQuarter = 'all';
let financeChart = null;

async function loadInvoicesFromDrive() {
  if (financeLoading) return;
  financeLoading = true;
  const el = document.getElementById('finBody');
  el.className = '';
  el.innerHTML = '<div class="fin-progress">Facturen-map inlezen…</div>';
  try {
    // Zorgt dat het gedeelde Drive-bestand al geladen is voordat we straks eventueel de
    // betaald-status van een factuur opslaan — anders zou setSharedKey() bij een nog lege
    // sharedData per ongeluk al je andere data (notities/budget/etc.) overschrijven.
    await ensureSharedData();
    const rootChildren = await driveListChildren(FACTUREN_FOLDER_ID);
    const subfolders = rootChildren.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    const rootPdfs = rootChildren.filter((f) => f.mimeType === 'application/pdf').map((f) => ({ file: f, quarterLabel: '' }));
    const perFolder = await Promise.all(subfolders.map(async (folder) => {
      const files = (await driveListChildren(folder.id)).filter((f) => f.mimeType === 'application/pdf');
      return files.map((f) => ({ file: f, quarterLabel: folder.name }));
    }));
    const allPdfs = rootPdfs.concat(perFolder.flat());

    // Diagnose-info: als er niets gevonden wordt, helpt dit om te zien of de map zelf al
    // leeg teruggegeven wordt (rechten/verkeerde map) of dat er wel submappen zijn maar
    // zonder PDF's erin.
    if (allPdfs.length === 0) {
      showDebug('Facturen', `Map-inhoud: ${rootChildren.length} item(s) direct in de map, waarvan ${subfolders.length} submap(pen). Geen PDF's gevonden.`);
    }

    if (allPdfs.length === 0) {
      financeInvoicesCache = [];
      financeLoaded = true;
      renderFinanceYearTabs();
      renderFinanceQuarterTabs();
      renderFinanceBody();
      renderOpenInvoicesBody();
      financeLoading = false;
      return;
    }

    // pdf.js apart en vooraf laden (i.p.v. pas bij de eerste PDF) zodat een mislukte
    // library-load een duidelijke, aparte foutmelding geeft i.p.v. dat elke PDF los
    // "gewoon" faalt en je alleen "geen facturen gevonden" te zien krijgt.
    try {
      await ensurePdfJs();
    } catch (e) {
      console.error('pdf.js laden mislukt', e);
      showDebug('Facturen: pdf.js laden mislukt', (e && e.message) ? e.message : String(e));
      el.innerHTML = '<div class="error">Kon de PDF-leesbibliotheek niet laden: ' + esc((e && e.message) ? e.message : String(e)) + '</div>';
      financeLoading = false;
      return;
    }

    let done = 0;
    let firstError = null;
    const invoices = await runWithConcurrency(allPdfs, 4, async ({ file, quarterLabel }) => {
      try {
        const text = await extractPdfText(file.id, file.name);
        done++;
        el.innerHTML = `<div class="fin-progress">Facturen verwerken… (${done}/${allPdfs.length})</div>`;
        return parseInvoiceMobile(file, quarterLabel, text);
      } catch (e) {
        done++;
        console.error('kon factuur niet lezen', file.name, e);
        if (!firstError) firstError = { name: file.name, message: (e && e.message) ? e.message : String(e) };
        return null;
      }
    });

    financeInvoicesCache = invoices.filter(Boolean);
    financeLoaded = true;

    // Als er wél PDF's gevonden werden maar GEEN ervan gelezen kon worden, is
    // "geen facturen gevonden" misleidend — toon dan de echte fout.
    if (financeInvoicesCache.length === 0 && firstError) {
      showDebug('Facturen: PDF lezen mislukt', `${firstError.name}: ${firstError.message}`);
      el.className = '';
      el.innerHTML = `<div class="error">Kon ${allPdfs.length} PDF('s) niet lezen. Eerste fout (${esc(firstError.name)}): ${esc(firstError.message)}</div>`;
      renderFinanceYearTabs();
      renderFinanceQuarterTabs();
      renderOpenInvoicesBody();
      financeLoading = false;
      return;
    }

    renderFinanceYearTabs();
    renderFinanceQuarterTabs();
    renderFinanceBody();
    renderOpenInvoicesBody();
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    showDebug('Facturen-fout', e.message || String(e));
  }
  financeLoading = false;
}

function renderFinanceYearTabs() {
  const el = document.getElementById('finYearTabs');
  const years = Array.from(new Set(financeInvoicesCache.map((i) => i.year))).sort();
  if (!years.includes(financeActiveYear) && years.length) financeActiveYear = years[years.length - 1];
  el.innerHTML = years.map((y) => `<button type="button" class="fin-tab${y === financeActiveYear ? ' active' : ''}" data-year="${esc(y)}">${esc(y)}</button>`).join('');
  el.querySelectorAll('.fin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      financeActiveYear = btn.getAttribute('data-year');
      renderFinanceYearTabs();
      renderFinanceQuarterTabs();
      renderFinanceBody();
    });
  });
}

function renderFinanceQuarterTabs() {
  const el = document.getElementById('finQuarterTabs');
  const options = [['all', 'Alle kwartalen'], ['Q1', 'Q1'], ['Q2', 'Q2'], ['Q3', 'Q3'], ['Q4', 'Q4']];
  el.innerHTML = options.map(([q, label]) => `<button type="button" class="fin-tab${q === financeActiveQuarter ? ' active' : ''}" data-q="${q}">${esc(label)}</button>`).join('');
  el.querySelectorAll('.fin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      financeActiveQuarter = btn.getAttribute('data-q');
      renderFinanceQuarterTabs();
      renderFinanceBody();
    });
  });
}

function renderFinanceBody() {
  const el = document.getElementById('finBody');
  el.className = '';
  if (financeInvoicesCache.length === 0) {
    el.innerHTML = '<div class="empty">Geen facturen gevonden in de Facturen-map.</div>';
    renderFinanceTrendChart();
    return;
  }
  const invoices = financeInvoicesCache
    .filter((i) => i.year === financeActiveYear)
    .filter((i) => financeActiveQuarter === 'all' || i.quarter === financeActiveQuarter)
    .sort((a, b) => (a.quarter + a.invoiceNumber).localeCompare(b.quarter + b.invoiceNumber));

  if (invoices.length === 0) {
    el.innerHTML = `<div class="empty">Geen facturen voor ${esc(financeActiveYear)}${financeActiveQuarter === 'all' ? '' : ' ' + esc(financeActiveQuarter)}.</div>`;
    renderFinanceTrendChart();
    return;
  }

  const omzetExcl = invoices.reduce((s, i) => s + i.excl, 0);
  const btwTotal = invoices.reduce((s, i) => s + i.btw, 0);
  const reservering = omzetExcl * 0.3;
  const zvw = omzetExcl * 0.05;
  const netto = omzetExcl - reservering - zvw;

  const statsHtml = `
    <div class="fin-stat-row">
      <div class="fin-stat fin-stat-omzet"><div class="fin-stat-label">Omzet excl. btw</div><div class="fin-stat-value">${eurFmt(omzetExcl)}</div></div>
      <div class="fin-stat fin-stat-btw"><div class="fin-stat-label">Btw af te dragen</div><div class="fin-stat-value">${eurFmt(btwTotal)}</div></div>
      <div class="fin-stat fin-stat-reservering"><div class="fin-stat-label">Reservering 30%</div><div class="fin-stat-value">${eurFmt(reservering)}</div></div>
      <div class="fin-stat fin-stat-netto"><div class="fin-stat-label">Netto over</div><div class="fin-stat-value">${eurFmt(netto)}</div></div>
    </div>`;

  const rowsHtml = invoices.map((i) => `
    <div class="fin-invoice-row">
      <span class="fi-client">${esc(i.client)}<span class="fi-nr">#${esc(i.invoiceNumber)} · ${esc(i.quarter)}</span></span>
      <span class="fi-amt">${eurFmt(i.total)}</span>
    </div>`).join('');

  el.innerHTML = statsHtml + rowsHtml;
  renderFinanceTrendChart();
}

function renderFinanceTrendChart() {
  const wrap = document.getElementById('finTrendWrap');
  const canvas = document.getElementById('finTrendCanvas');
  if (typeof Chart === 'undefined' || financeInvoicesCache.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const buckets = {};
  financeInvoicesCache.forEach((inv) => {
    const key = inv.year + '-' + inv.quarter;
    if (!buckets[key]) buckets[key] = { year: inv.year, quarter: inv.quarter, total: 0 };
    buckets[key].total += inv.excl;
  });
  const sorted = Object.values(buckets).sort((a, b) => (a.year + a.quarter).localeCompare(b.year + b.quarter));
  const labels = sorted.map((b) => b.quarter + ' ’' + String(b.year).slice(2));
  const values = sorted.map((b) => Math.round(b.total));

  if (financeChart) { financeChart.data.labels = labels; financeChart.data.datasets[0].data = values; financeChart.update(); return; }
  financeChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Omzet excl. btw', data: values, borderColor: '#E08A3C', backgroundColor: 'rgba(224,138,60,0.15)', borderWidth: 3, pointRadius: 3, pointBackgroundColor: '#C85A1D', tension: 0.3, fill: true }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => '€' + v } }, x: { grid: { display: false } } } }
  });
}

function getInvoiceStatusMap() { return getSharedKey(INVOICE_STATUS_KEY, {}); }
function saveInvoiceStatusMap(m) { setSharedKey(INVOICE_STATUS_KEY, m); }

function renderOpenInvoicesBody() {
  const el = document.getElementById('openInvoicesBody');
  const status = getInvoiceStatusMap();
  const open = financeInvoicesCache.filter((inv) => !status[inv.id]);
  if (open.length === 0) {
    el.innerHTML = financeInvoicesCache.length ? '<div class="empty">Alles is betaald — geen openstaande facturen. 🎉</div>' : '<div class="empty">Nog niets geladen.</div>';
    return;
  }
  const today = new Date();
  const withDays = open.map((inv) => {
    const d = parseInvoiceDateObjMobile(inv.date);
    const daysOpen = d ? Math.round((today - d) / 86400000) : null;
    return { inv, daysOpen };
  }).sort((a, b) => (b.daysOpen || 0) - (a.daysOpen || 0));

  el.innerHTML = withDays.map(({ inv, daysOpen }) => {
    const cls = daysOpen === null ? '' : (daysOpen >= 60 ? 'danger' : (daysOpen >= 30 ? 'warn' : ''));
    const label = daysOpen === null ? '—' : (daysOpen + ' dag' + (daysOpen === 1 ? '' : 'en'));
    return `<div class="fin-open-row">
      <span class="fi-client">${esc(inv.client)}<span class="fi-nr">#${esc(inv.invoiceNumber)} · ${eurFmt(inv.total)}</span></span>
      <span class="fo-days ${cls}">${esc(label)}</span>
      <button type="button" class="fin-paid-btn" data-id="${esc(inv.id)}">Betaald</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.fin-paid-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = getInvoiceStatusMap();
      s[btn.getAttribute('data-id')] = true;
      saveInvoiceStatusMap(s);
      renderOpenInvoicesBody();
    });
  });
}

function parseInvoiceDateObjMobile(dateStr) {
  const s = dateStr || '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  return null;
}

// ================= SPORT: gewichtgrafiek (Chart.js) =================
let weightChart = null;
function renderWeightChart(log) {
  const wrap = document.getElementById('weightChartWrap');
  const canvas = document.getElementById('weightChartCanvas');
  if (typeof Chart === 'undefined' || log.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const sorted = log.slice().sort((a, b) => a.week.localeCompare(b.week));
  const labels = sorted.map((e) => { const d = new Date(e.week + 'T00:00:00'); return d.getDate() + ' ' + MONTH_NAMES_NL[d.getMonth()]; });
  const values = sorted.map((e) => e.weight);

  if (weightChart) { weightChart.data.labels = labels; weightChart.data.datasets[0].data = values; weightChart.update(); return; }
  weightChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Gewicht (kg)', data: values, borderColor: '#E08A3C', backgroundColor: 'rgba(224,138,60,0.15)', borderWidth: 3, pointRadius: 3, pointBackgroundColor: '#C85A1D', tension: 0.3, fill: true }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => v + ' kg' } }, x: { grid: { display: false } } } }
  });
}

// ================= BRAIN DUMP =================
// Altijd-bereikbare snelle-gedachte-opvang, net als desktop: los van welk tabblad je op
// staat. Items = {id, text, createdAt}, opgeslagen via het gedeelde Drive-bestand.
function getBrainDumpList() { return getSharedKey(BRAINDUMP_KEY, []); }
function saveBrainDumpList(list) { setSharedKey(BRAINDUMP_KEY, list); }

function braindumpTimeLabel(ts) {
  const d = new Date(ts);
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const d0 = new Date(d); d0.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today0 - d0) / 86400000);
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (diffDays === 0) return 'vandaag ' + time;
  if (diffDays === 1) return 'gisteren ' + time;
  return d.getDate() + ' ' + MONTH_NAMES_NL[d.getMonth()] + ' ' + time;
}

function renderBrainDumpBadge() {
  const badge = document.getElementById('braindumpBadge');
  if (!badge) return;
  const n = sharedDataLoaded ? getBrainDumpList().length : 0;
  if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
  else { badge.hidden = true; }
}

function renderBrainDumpList() {
  const el = document.getElementById('braindumpList');
  if (!el) return;
  const list = getBrainDumpList().slice().sort((a, b) => b.createdAt - a.createdAt);
  if (list.length === 0) {
    el.innerHTML = '<div class="braindump-empty">Nog niets neergegooid. Typ hierboven je eerste gedachte.</div>';
    renderBrainDumpBadge();
    return;
  }
  el.innerHTML = list.map((item) => `
    <div class="braindump-item" data-id="${esc(item.id)}">
      <div class="braindump-item-text">${esc(item.text)}</div>
      <div class="braindump-item-meta">${esc(braindumpTimeLabel(item.createdAt))}</div>
      <div class="braindump-item-actions">
        <button type="button" class="braindump-item-btn task" data-action="task" data-id="${esc(item.id)}">→ Taak</button>
        <button type="button" class="braindump-item-btn note" data-action="note" data-id="${esc(item.id)}">→ Notitie</button>
        <button type="button" class="braindump-item-btn del" data-action="del" data-id="${esc(item.id)}">Verwijderen</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.braindump-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (action === 'task') convertBrainDumpToTask(id);
      else if (action === 'note') convertBrainDumpToNote(id);
      else if (action === 'del') deleteBrainDumpEntry(id);
    });
  });

  renderBrainDumpBadge();
}

async function addBrainDumpEntry() {
  const input = document.getElementById('braindumpInput');
  const text = (input.value || '').trim();
  if (!text) { input.focus(); return; }
  if (!(await ensureFreshGoogleToken())) { alert('Log eerst in met Google via instellingen.'); return; }
  await ensureSharedData();
  const list = getBrainDumpList();
  list.push({ id: genId('bd'), text, createdAt: Date.now() });
  saveBrainDumpList(list);
  input.value = '';
  renderBrainDumpList();
}

function deleteBrainDumpEntry(id) {
  saveBrainDumpList(getBrainDumpList().filter((x) => x.id !== id));
  renderBrainDumpList();
}

async function convertBrainDumpToTask(id) {
  const list = getBrainDumpList();
  const item = list.find((x) => x.id === id);
  if (!item) return;
  if (!isTodoistConfigured()) { alert('Voeg eerst je Todoist-token toe via instellingen om hier een taak van te maken.'); return; }
  try {
    await createTodoistTask(item.text);
    saveBrainDumpList(list.filter((x) => x.id !== id));
    renderBrainDumpList();
    loadTasks();
  } catch (e) {
    console.error(e);
    alert('Taak aanmaken is mislukt: ' + (e.message || e));
  }
}

function convertBrainDumpToNote(id) {
  const list = getBrainDumpList();
  const item = list.find((x) => x.id === id);
  if (!item) return;
  saveBrainDumpList(list.filter((x) => x.id !== id));
  renderBrainDumpList();
  closeBrainDumpPanel();
  openNoteEditor(null);
  document.getElementById('noteBodyInput').innerHTML = '<p>' + esc(item.text).replace(/\n/g, '</p><p>') + '</p>';
}

async function openBrainDumpPanel() {
  document.getElementById('braindumpOverlay').classList.remove('hidden');
  document.getElementById('braindumpList').innerHTML = '<div class="loading">Even ophalen…</div>';
  const signedIn = await ensureFreshGoogleToken();
  if (!signedIn) {
    document.getElementById('braindumpList').innerHTML = '<div class="braindump-empty">Log eerst in met Google via instellingen om je brain dump te zien.</div>';
    return;
  }
  ensureSharedData().then(renderBrainDumpList).catch((e) => {
    document.getElementById('braindumpList').innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  });
  setTimeout(() => { const el = document.getElementById('braindumpInput'); if (el) el.focus(); }, 0);
}
function closeBrainDumpPanel() {
  document.getElementById('braindumpOverlay').classList.add('hidden');
}

// ================= AUTO: HANDLEIDING (PDF-viewer) =================
// Werkt met dezelfde pdf.js-library als de facturen, maar dan om pagina's als plaatje
// te renderen i.p.v. tekst te lezen. Het PDF-bestand zelf staat gewoon als los bestand
// in dezelfde GitHub-repo (net als index.html/app.js) — geen Google Drive nodig.
const CAR_MANUAL_PDF_URL = 'manual/handleiding.pdf';
let manualPdfDoc = null;
let manualCurrentPage = 1;
let manualPdfLoadPromise = null;

function ensureManualPdfLoaded() {
  if (manualPdfDoc) return Promise.resolve(manualPdfDoc);
  if (!manualPdfLoadPromise) {
    manualPdfLoadPromise = (async () => {
      await ensurePdfJs();
      const doc = await window.pdfjsLib.getDocument(CAR_MANUAL_PDF_URL).promise;
      manualPdfDoc = doc;
      return doc;
    })().catch((e) => {
      manualPdfLoadPromise = null;
      throw e;
    });
  }
  return manualPdfLoadPromise;
}

async function renderManualPage() {
  const canvas = document.getElementById('manualViewerCanvas');
  const info = document.getElementById('manualPageInfo');
  if (!manualPdfDoc || !canvas) return;
  const page = await manualPdfDoc.getPage(manualCurrentPage);
  const baseViewport = page.getViewport({ scale: 1 });
  const wrapWidth = (canvas.parentElement && canvas.parentElement.clientWidth) || 320;
  const scale = Math.min(2.5, Math.max(0.5, wrapWidth / baseViewport.width));
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  if (info) info.textContent = 'Pagina ' + manualCurrentPage + ' / ' + manualPdfDoc.numPages;
}

async function openManualViewer() {
  const overlay = document.getElementById('manualViewerOverlay');
  const bodyEl = document.getElementById('manualViewerBody');
  const info = document.getElementById('manualPageInfo');
  overlay.classList.remove('hidden');
  if (info) info.textContent = manualPdfDoc ? '' : 'Laden…';
  try {
    await ensureManualPdfLoaded();
    if (!manualCurrentPage) manualCurrentPage = 1;
    bodyEl.innerHTML = '<canvas id="manualViewerCanvas"></canvas>';
    await renderManualPage();
  } catch (e) {
    console.error(e);
    bodyEl.innerHTML = '<div class="error">Handleiding laden mislukt: ' + esc(e.message || e) + '</div>';
    if (info) info.textContent = '';
    showDebug('Handleiding-fout', e.message || String(e));
  }
}
function closeManualViewer() {
  document.getElementById('manualViewerOverlay').classList.add('hidden');
}
function manualNextPage() {
  if (!manualPdfDoc || manualCurrentPage >= manualPdfDoc.numPages) return;
  manualCurrentPage++;
  renderManualPage();
}
function manualPrevPage() {
  if (!manualPdfDoc || manualCurrentPage <= 1) return;
  manualCurrentPage--;
  renderManualPage();
}
