// ================= APP =================

// ---------- iOS-bounce-fix voor "toegevoegd aan beginscherm" ----------
// CSS `overscroll-behavior` (zie style.css) voorkomt de rubber-band-bounce prima in een
// gewone Safari-tab, maar WebKit negeert dat helaas nog steeds in een standalone
// "toegevoegd aan beginscherm"-app — daar bounct de native WebView zelf nog gewoon door,
// wat het witte vlak bovenin/onderin laat zien bij snel vegen. Dit vangt dat handmatig af:
// een touchmove buiten een scrollbare container (of tegen de rand ervan, in de richting
// van de veeg) wordt geblokkeerd, terwijl normaal scrollen bínnen bijv. <main> of een
// modal gewoon blijft werken.
(function preventIosStandaloneBounce() {
  function findScrollableY(el) {
    let node = el;
    while (node && node !== document.documentElement && node !== document.body) {
      const cs = window.getComputedStyle(node);
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
      node = node.parentElement;
    }
    return null;
  }

  let startY = 0;
  let scrollEl = null;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { scrollEl = null; return; }
    startY = e.touches[0].clientY;
    scrollEl = findScrollableY(e.target);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return; // pinch/zoom en andere multi-touch met rust laten
    const deltaY = e.touches[0].clientY - startY;
    if (!scrollEl) { e.preventDefault(); return; }
    const atTop = scrollEl.scrollTop <= 0;
    const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop <= scrollEl.clientHeight + 1;
    if ((deltaY > 0 && atTop) || (deltaY < 0 && atBottom)) e.preventDefault();
  }, { passive: false });
})();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Zichtbare foutmeldingen (i.p.v. alleen in de onzichtbare console) ----------
function showDebug(label, detail) {
  const el = document.getElementById('debugBanner');
  if (!el) return;
  const time = new Date().toLocaleTimeString('nl-NL');
  const line = `[${time}] ${label}: ${detail}`;
  el.textContent = el.textContent ? (el.textContent + '\n' + line) : line;
  el.style.display = 'block';
}

window.addEventListener('error', (e) => {
  showDebug('JS-fout', (e.message || 'onbekend') + ' (' + (e.filename || '') + ':' + (e.lineno || '') + ')');
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  showDebug('Onverwerkte fout', (reason && reason.message) ? reason.message : String(reason));
});

// ---------- Service worker + update-melding ----------
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('service-worker.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          document.getElementById('updateBanner').classList.add('show');
        }
      });
    });
  }).catch((e) => console.error('service worker registratie mislukt', e));

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  document.getElementById('updateReloadBtn').addEventListener('click', () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg && reg.waiting) reg.waiting.postMessage('skipWaiting');
    });
  });
}

// ---------- Begroeting bovenaan "Algemeen" (vervangt de statische "Vandaag"-titel) ----------
function renderGreeting() {
  const eyebrowEl = document.getElementById('heroEyebrow');
  const nameEl = document.getElementById('heroName');
  if (!eyebrowEl || !nameEl) return;
  const h = new Date().getHours();
  const part = h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
  eyebrowEl.textContent = part + ',';
  nameEl.textContent = 'Yoran';
}

// ---------- Hamburger-menu: zij-drawer met de tabbladen (i.p.v. de onderbalk) ----------
function openNavDrawer() {
  const overlay = document.getElementById('navDrawerOverlay');
  const drawer = document.getElementById('navDrawer');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => drawer.classList.add('open'));
}
function closeNavDrawer() {
  const overlay = document.getElementById('navDrawerOverlay');
  const drawer = document.getElementById('navDrawer');
  drawer.classList.remove('open');
  setTimeout(() => overlay.classList.add('hidden'), 220);
}
function setupNavDrawer() {
  document.getElementById('hamburgerBtn').addEventListener('click', openNavDrawer);
  document.getElementById('navDrawerCloseBtn').addEventListener('click', closeNavDrawer);
  document.getElementById('navDrawerOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeNavDrawer(); });
  // Drawer sluit vanzelf na het kiezen van een tabblad — de tab-wissel zelf gebeurt via
  // de bestaande '.nav-btn'-click-handler hieronder in setupNav(), deze luisteraar komt
  // daar gewoon bovenop.
  document.querySelectorAll('.nav-drawer-btn').forEach((btn) => btn.addEventListener('click', closeNavDrawer));
}

// ---------- Tab-navigatie ----------
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.getAttribute('data-nav');
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.getAttribute('data-view') === target));

      // Al eerder geladen deze sessie: meteen uit de cache renderen, geen netwerk/token nodig.
      if (sharedDataLoaded) {
        if (target === 'algemeen') renderNotesView();
        if (target === 'budget') renderBudgetView();
        if (target === 'sport') { renderWeightBody(); loadNutritionPlan(); renderNutritionBody(); }
        if (target === 'zzp') { renderBtwBody(); renderIncomeBody(); }
        if (target === 'auto') { renderApkBody(); renderCarVisitsBody(); }
        return;
      }

      // Nog niet geladen: eerst zorgen voor een geldig token (probeert stilletjes te
      // vernieuwen als het verlopen is, i.p.v. meteen "log in" te tonen — zie auth.js).
      const signedIn = await ensureFreshGoogleToken();
      if (!signedIn) {
        const emptyMsgByTarget = {
          budget: ['budgetBody', 'je budget'],
          sport: ['weightBody', 'Sport'],
          zzp: ['btwBody', 'ZZP'],
          auto: ['apkBody', 'Auto']
        };
        const cfg = emptyMsgByTarget[target];
        if (cfg) document.getElementById(cfg[0]).innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om ' + cfg[1] + ' te zien.</div>';
        return;
      }
      if (target === 'algemeen') loadNotesView();
      if (target === 'budget') loadBudgetView();
      if (target === 'sport') loadSportView();
      if (target === 'zzp') loadZzpView();
      if (target === 'auto') loadAutoView();
    });
  });
}

// ---------- Budget: maand wisselen ----------
function setupBudgetNav() {
  document.getElementById('budgetPrevBtn').addEventListener('click', () => shiftBudgetMonth(-1));
  document.getElementById('budgetNextBtn').addEventListener('click', () => shiftBudgetMonth(1));
  document.getElementById('budgetItemCloseBtn').addEventListener('click', closeBudgetItemModal);
  document.getElementById('budgetItemOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeBudgetItemModal(); });
  document.getElementById('budgetItemSaveBtn').addEventListener('click', saveBudgetItemFromModal);
}

// ---------- Notities: knoppen ----------
function setupNotes() {
  document.getElementById('noteAddBtn').addEventListener('click', () => openNoteEditor(null));
  document.getElementById('noteEditorCloseBtn').addEventListener('click', closeNoteEditor);
  document.getElementById('noteEditorOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeNoteEditor(); });
  document.getElementById('noteSaveBtn').addEventListener('click', saveNoteFromEditor);
  document.getElementById('noteDeleteBtn').addEventListener('click', deleteNoteFromEditor);
  setupRichTextToolbar();
}

// ---------- Sport: knoppen ----------
function setupSport() {
  document.getElementById('nutriPrevBtn').addEventListener('click', () => shiftNutritionDay(-1));
  document.getElementById('nutriNextBtn').addEventListener('click', () => shiftNutritionDay(1));
  document.getElementById('nutriAddDayBtn').addEventListener('click', addNutritionDay);
}

// ---------- ZZP: knoppen ----------
function setupZzp() {
  document.getElementById('incomePrevYearBtn').addEventListener('click', () => shiftIncomeYear(-1));
  document.getElementById('incomeNextYearBtn').addEventListener('click', () => shiftIncomeYear(1));
  document.getElementById('financeRefreshBtn').addEventListener('click', async () => {
    const signedIn = await ensureFreshGoogleToken();
    if (!signedIn) { alert('Log eerst in met Google via instellingen.'); return; }
    loadInvoicesFromDrive();
  });
}

// ---------- Auto: knoppen ----------
function setupAuto() {
  document.getElementById('carVisitAddBtn').addEventListener('click', openCarVisitModal);
  document.getElementById('carManualOpenBtn').addEventListener('click', openManualViewer);
  document.getElementById('manualViewerCloseBtn').addEventListener('click', closeManualViewer);
  document.getElementById('manualViewerOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeManualViewer(); });
  document.getElementById('manualPrevBtn').addEventListener('click', manualPrevPage);
  document.getElementById('manualNextBtn').addEventListener('click', manualNextPage);
}

// ---------- Brain dump: knoppen ----------
function setupBrainDump() {
  document.getElementById('braindumpTrigger').addEventListener('click', openBrainDumpPanel);
  document.getElementById('braindumpCloseBtn').addEventListener('click', closeBrainDumpPanel);
  document.getElementById('braindumpOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeBrainDumpPanel(); });
  document.getElementById('braindumpAddBtn').addEventListener('click', addBrainDumpEntry);
  document.getElementById('braindumpInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addBrainDumpEntry(); }
  });
}

// ---------- Instellingen-paneel ----------
function refreshGoogleStatus() {
  const dot = document.getElementById('googleDot');
  const text = document.getElementById('googleStatusText');
  const signedIn = isGoogleSignedIn();
  dot.classList.toggle('ok', signedIn);
  text.textContent = 'Google: ' + (signedIn ? 'ingelogd' : 'niet ingelogd');
  document.getElementById('googleSignInBtn').textContent = signedIn ? 'Opnieuw inloggen' : 'Inloggen met Google';
}

function setupSettings() {
  const overlay = document.getElementById('settingsOverlay');
  document.getElementById('settingsBtn').addEventListener('click', () => {
    refreshGoogleStatus();
    document.getElementById('todoistTokenInput').value = getTodoistToken();
    overlay.classList.remove('hidden');
  });
  // Bij het sluiten van instellingen altijd de agenda/taken opnieuw proberen te laden —
  // vangnet voor het geval de inlog-popup op mobiel zelf niet netjes heeft teruggemeld
  // dat het gelukt is (dat gebeurt soms met popup-gebaseerde flows in mobiele browsers).
  const closeSettingsAndRefresh = async () => {
    overlay.classList.add('hidden');
    refreshGoogleStatus();
    const signedIn = await ensureFreshGoogleToken();
    refreshGoogleStatus();
    loadAgenda();
    loadTasks();
    loadNotesIfSignedIn();
    const activeView = document.querySelector('.view.active');
    const activeName = activeView ? activeView.getAttribute('data-view') : null;
    if (activeName === 'budget' && signedIn) loadBudgetView();
    if (activeName === 'sport' && signedIn) loadSportView();
    if (activeName === 'zzp' && signedIn) loadZzpView();
    if (activeName === 'auto' && signedIn) loadAutoView();
  };
  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsAndRefresh);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettingsAndRefresh(); });

  document.getElementById('googleSignInBtn').addEventListener('click', () => {
    signInGoogle();
  });

  document.getElementById('todoistSaveBtn').addEventListener('click', () => {
    saveTodoistToken(document.getElementById('todoistTokenInput').value);
    overlay.classList.add('hidden');
    loadTasks();
  });
}

// ---------- Agenda (rechtstreeks Google Calendar API) ----------
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Zelfde uitsluiting als op de desktop-versie: deze agenda's worden nergens getoond
// (agenda, briefing). Matching is hoofdletter- én leesteken-ongevoelig, dus "UM!W" matcht
// ook gewoon "umw" — zie EXCLUDED_CALENDAR_NAMES in het desktop-dashboard.
const EXCLUDED_CALENDAR_NAMES = ['umw werkagenda', 'planning yoran'];
function normalizeCalName(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function matchesExcludedName(name) {
  return EXCLUDED_CALENDAR_NAMES.some((excluded) => {
    const keywords = normalizeCalName(excluded).split(/\s+/).filter(Boolean);
    return keywords.every((k) => name.includes(k));
  });
}
function isExcludedCalendar(cal) {
  const candidates = [cal.summary, cal.summaryOverride, cal.id, cal.description].filter(Boolean).map(normalizeCalName);
  return candidates.some(matchesExcludedName);
}

async function fetchCalendarList() {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) throw new Error('Agendalijst ophalen mislukt (' + res.status + ')');
  const data = await res.json();
  const all = (data.items || []).filter((c) => c.selected !== false);
  const kept = all.filter((c) => !isExcludedCalendar(c));

  // Veiligheidsklep: als de uitsluitfilter (UM!W Werkagenda / Planning Yoran) per ongeluk
  // ÁLLE agenda's zou wegfilteren — bijv. omdat een agenda-naam net iets anders is dan
  // verwacht en toch op de trefwoorden matcht — val dan terug op de volledige lijst i.p.v.
  // een helemaal lege agenda te tonen. Beter een agenda te veel dan alles kwijt.
  if (kept.length === 0 && all.length > 0) {
    showDebug('Agenda-filter', 'Uitsluiten van UM!W Werkagenda/Planning Yoran zou alle ' + all.length + ' agenda\'s wegfilteren — filter genegeerd. Gevonden agenda\'s: ' + all.map((c) => c.summary || c.id).join(', '));
    return all;
  }
  const excluded = all.filter((c) => isExcludedCalendar(c));
  if (excluded.length) showDebug('Agenda-filter', 'Genegeerd: ' + excluded.map((c) => c.summary || c.id).join(', '));
  return kept;
}

async function fetchTodayEvents() {
  const now = new Date();
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
  const params = new URLSearchParams({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50'
  });

  // Net als op de desktop-versie: over ál je agenda's zoeken, niet alleen de hoofdagenda.
  const calendars = await fetchCalendarList();
  const diag = [];
  const perCalendar = await Promise.all(calendars.map(async (cal) => {
    const label = cal.summary || cal.id;
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal.id) + '/events?' + params.toString(), {
        headers: { Authorization: 'Bearer ' + googleAccessToken }
      });
      if (!res.ok) { diag.push(label + ': HTTP ' + res.status); return []; }
      const data = await res.json();
      const items = data.items || [];
      diag.push(label + ': ' + items.length + ' item(s)');
      return items.map((e) => Object.assign({}, e, { __calendarId: cal.id }));
    } catch (e) {
      console.error('events ophalen mislukt voor', cal.id, e);
      diag.push(label + ': fout — ' + (e.message || e));
      return [];
    }
  }));

  const events = perCalendar.flat().filter((e) => e.status !== 'cancelled');
  events.sort((a, b) => {
    const aKey = (a.start && a.start.dateTime) ? new Date(a.start.dateTime).getTime() : -1;
    const bKey = (b.start && b.start.dateTime) ? new Date(b.start.dateTime).getTime() : -1;
    return aKey - bKey;
  });

  // Alleen afspraken die nog moeten komen (of nog bezig zijn) — net als op de desktop-versie.
  const upcoming = events.filter((e) => {
    if (e.start && e.start.date) return true; // hele dag
    if (e.start && e.start.dateTime) {
      const end = e.end && e.end.dateTime ? new Date(e.end.dateTime) : new Date(e.start.dateTime);
      return end >= now;
    }
    return false;
  });

  // Alleen loggen als er verder niks te zien is — dan is dit precies de info die nodig is
  // om te zien waar het misgaat: geen agenda's gevonden, een agenda die een HTTP-fout geeft,
  // of agenda's die simpelweg 0 afspraken voor vandaag hebben.
  if (upcoming.length === 0) {
    showDebug('Agenda-diagnose', calendars.length + ' agenda(\'s) doorzocht: ' + (diag.length ? diag.join(' | ') : 'geen'));
  }

  return upcoming;
}

function renderAgendaList(events) {
  const el = document.getElementById('agendaList');
  if (events.length === 0) { el.innerHTML = '<div class="empty">Niets meer gepland voor vandaag.</div>'; return; }
  el.innerHTML = events.map((ev) => {
    const timeLabel = ev.start.date ? 'Hele dag' : new Date(ev.start.dateTime).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return `<div class="agenda-card"><span class="agenda-card-time">${esc(timeLabel)}</span><span class="agenda-card-title">${esc(ev.summary || '(geen titel)')}</span></div>`;
  }).join('');
}

function renderBriefSummary(events, tasks) {
  const el = document.getElementById('briefSummary');
  const parts = [];
  if (events.length === 0) {
    parts.push('Er staat <strong>niets meer gepland</strong> voor de rest van vandaag.');
  } else {
    const first = events[0];
    const timeLabel = first.start.date ? 'vandaag' : new Date(first.start.dateTime).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const rest = events.length - 1;
    const restLabel = rest > 0 ? `, en daarna nog <strong>${rest} ${rest === 1 ? 'afspraak' : 'afspraken'}</strong>` : '';
    parts.push(`Je hebt vandaag nog <strong>${events.length} ${events.length === 1 ? 'afspraak' : 'afspraken'}</strong>: om <strong>${esc(timeLabel)}</strong> "${esc(first.summary || '(geen titel)')}"${restLabel}.`);
  }
  if (tasks && tasks.length > 0) {
    const names = tasks.slice(0, 3).map((t) => `<strong>${esc(t.content)}</strong>`).join(', ');
    parts.push(`Voor vandaag ${tasks.length === 1 ? 'staat er nog <strong>1 taak</strong>' : `staan er nog <strong>${tasks.length} taken</strong>`} open: ${names}.`);
  }
  el.innerHTML = `<p class="brief-narrative">${parts.join(' ')}</p>`;
}

let lastLoadedTasks = [];

async function loadAgenda() {
  const el = document.getElementById('agendaList');
  if (!isGoogleConfigured()) { el.innerHTML = '<div class="error">Vul eerst GOOGLE_CLIENT_ID in auth.js in.</div>'; return; }
  if (!isGoogleSignedIn()) el.innerHTML = '<div class="loading">Even inloggen…</div>';
  const signedIn = await ensureFreshGoogleToken();
  if (!signedIn) { el.innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om je agenda te zien.</div>'; return; }
  el.innerHTML = '<div class="loading">Agenda ophalen…</div>';
  try {
    const events = await fetchTodayEvents();
    renderAgendaList(events);
    renderBriefSummary(events, lastLoadedTasks);
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    showDebug('Agenda-fout', e.message || String(e));
  }
}

// ---------- Taken (rechtstreeks Todoist API) ----------
// Let op: Todoist heeft de oude "rest/v2"-API per februari 2026 uitgefaseerd
// ten gunste van de nieuwe samengevoegde "api/v1"-API. Lijst-endpoints geven nu
// { results: [...], next_cursor: ... } terug in plaats van rechtstreeks een array.
// Geen filter meer op alleen "vandaag/te laat" — we halen nu alle openstaande taken op
// (met paginering) zodat we zelf kunnen splitsen in Vandaag/Aankomend/Zonder datum,
// net als op de desktop-versie.
async function fetchTodoistTasks() {
  const token = getTodoistToken();
  let tasks = [];
  let cursor = null;
  for (let i = 0; i < 8; i++) {
    const url = new URL('https://api.todoist.com/api/v1/tasks');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      let detail = '';
      try { const body = await res.json(); detail = body && body.error ? ' — ' + body.error : ''; } catch (e) { /* geen JSON-body */ }
      throw new Error('Taken ophalen mislukt (' + res.status + ')' + detail);
    }
    const data = await res.json();
    const items = Array.isArray(data) ? data : (data.results || []);
    tasks = tasks.concat(items);
    cursor = Array.isArray(data) ? null : data.next_cursor;
    if (!cursor) break;
  }
  return tasks;
}

// Geeft de deadline van een taak terug als "YYYY-MM-DD" (of null zonder deadline) —
// Todoist geeft bij taken met een tijdstip erbij ook een tijd-component mee in .date.
function taskDueYmd(t) {
  if (!t || !t.due) return null;
  const raw = t.due.date || '';
  if (!raw) return null;
  return raw.includes('T') ? raw.split('T')[0] : raw;
}

const DAY_NAMES_SHORT_NL = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MONTH_NAMES_SHORT_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function formatTaskDateShort(ymdStr) {
  const d = new Date(ymdStr + 'T00:00:00');
  if (isNaN(d.getTime())) return ymdStr;
  return DAY_NAMES_SHORT_NL[d.getDay()] + ' ' + d.getDate() + ' ' + MONTH_NAMES_SHORT_NL[d.getMonth()];
}

async function completeTodoistTask(id) {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/api/v1/tasks/' + id + '/close', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Afvinken mislukt (' + res.status + ')');
}

// Bijwerken van tekst en/of deadline van een bestaande taak. `payload` mag `content`,
// `due_date` (YYYY-MM-DD) en/of `due_string: 'no date'` (om de deadline te verwijderen) bevatten.
async function updateTodoistTask(id, payload) {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/api/v1/tasks/' + id, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let detail = '';
    try { const body = await res.json(); detail = body && body.error ? ' — ' + body.error : ''; } catch (e) { /* geen JSON-body */ }
    throw new Error('Taak bijwerken mislukt (' + res.status + ')' + detail);
  }
  return res.json();
}

async function deleteTodoistTask(id) {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/api/v1/tasks/' + id, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Verwijderen mislukt (' + res.status + ')');
}

// "Naar morgen verplaatsen": schuift de huidige deadline één dag op (voor een taak van
// vandaag/te laat komt dat neer op "morgen"; bij een al verzette taak schuift 'ie steeds
// een dag verder door, net als de postpone-knop op de desktop-versie).
async function postponeTask(id) {
  const t = allTasksCache.find((x) => x.id === id);
  if (!t) return;
  const cur = taskDueYmd(t);
  if (!cur) return;
  const d = new Date(cur + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  try {
    await updateTodoistTask(id, { due_date: ymd(d) });
    loadTasks();
  } catch (e) {
    console.error(e);
    alert('Verplaatsen mislukt: ' + (e.message || e));
  }
}

// ---------- Taak bewerken (modal) ----------
let editingTaskId = null;
function openTaskEditModal(t) {
  if (!t) return;
  editingTaskId = t.id;
  document.getElementById('taskEditTextInput').value = t.content || '';
  document.getElementById('taskEditDateInput').value = taskDueYmd(t) || '';
  document.getElementById('taskEditErrorField').style.display = 'none';
  document.getElementById('taskEditOverlay').classList.remove('hidden');
}
function closeTaskEditModal() {
  document.getElementById('taskEditOverlay').classList.add('hidden');
  editingTaskId = null;
}
async function saveTaskEdit() {
  if (!editingTaskId) { closeTaskEditModal(); return; }
  const errEl = document.getElementById('taskEditErrorField');
  const text = document.getElementById('taskEditTextInput').value.trim();
  const dateVal = document.getElementById('taskEditDateInput').value;
  errEl.style.display = 'none';
  if (!text) { errEl.textContent = 'Geef de taak een omschrijving.'; errEl.style.display = ''; return; }
  const btn = document.getElementById('taskEditSaveBtn');
  btn.disabled = true;
  try {
    const payload = { content: text };
    if (dateVal) payload.due_date = dateVal; else payload.due_string = 'no date';
    await updateTodoistTask(editingTaskId, payload);
    closeTaskEditModal();
    loadTasks();
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Opslaan mislukt: ' + (e.message || e);
    errEl.style.display = '';
  } finally {
    btn.disabled = false;
  }
}
async function deleteTaskFromEdit() {
  if (!editingTaskId) return;
  if (!confirm('Deze taak verwijderen?')) return;
  const id = editingTaskId;
  try {
    await deleteTodoistTask(id);
    closeTaskEditModal();
    loadTasks();
  } catch (e) {
    console.error(e);
    alert('Verwijderen mislukt: ' + (e.message || e));
  }
}
function setupTaskEdit() {
  document.getElementById('taskEditCloseBtn').addEventListener('click', closeTaskEditModal);
  document.getElementById('taskEditOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeTaskEditModal(); });
  document.getElementById('taskEditSaveBtn').addEventListener('click', saveTaskEdit);
  document.getElementById('taskEditDeleteBtn').addEventListener('click', deleteTaskFromEdit);
}

// Gebruikt voor de "→ Taak"-knop bij Brain dump: maakt direct een nieuwe taak aan in de
// Todoist Inbox (zelfde plek waar het desktop-dashboard nieuwe taken ook neerzet).
async function createTodoistTask(content) {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/api/v1/tasks', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    let detail = '';
    try { const body = await res.json(); detail = body && body.error ? ' — ' + body.error : ''; } catch (e) { /* geen JSON-body */ }
    throw new Error('Taak aanmaken mislukt (' + res.status + ')' + detail);
  }
  return res.json();
}

function taskRowHtml(t, overdue) {
  const dueYmd = taskDueYmd(t);
  return `<div class="task-tile" data-id="${esc(t.id)}">
    <div class="task-tile-top">
      <button type="button" class="task-check" data-id="${esc(t.id)}" title="Afvinken"></button>
      <button type="button" class="task-edit-btn" data-id="${esc(t.id)}" title="Bewerken">✎</button>
    </div>
    <div class="task-tile-txt">${esc(t.content)}</div>
    <div class="task-tile-foot">
      <span class="task-tile-due${overdue ? ' overdue' : ''}">${dueYmd ? esc(formatTaskDateShort(dueYmd)) : ''}</span>
      ${dueYmd ? `<button type="button" class="task-postpone-btn" data-id="${esc(t.id)}" title="Naar morgen verplaatsen">→</button>` : ''}
    </div>
  </div>`;
}

// Verdeelt taken in Vandaag (incl. te laat)/Aankomend/Zonder datum, net als op de
// desktop-versie — als kleine blokjes in een grid i.p.v. één platte lijst met rijen.
function renderTaskList(tasks) {
  const el = document.getElementById('taskList');
  const todayYmd = ymd(new Date());

  const withDue = tasks.filter((t) => taskDueYmd(t));
  const withoutDue = tasks.filter((t) => !taskDueYmd(t));
  const todayGroup = withDue.filter((t) => taskDueYmd(t) <= todayYmd).sort((a, b) => taskDueYmd(a).localeCompare(taskDueYmd(b)));
  const upcomingGroup = withDue.filter((t) => taskDueYmd(t) > todayYmd).sort((a, b) => taskDueYmd(a).localeCompare(taskDueYmd(b)));

  if (todayGroup.length === 0 && upcomingGroup.length === 0 && withoutDue.length === 0) {
    el.innerHTML = '<div class="empty">Geen openstaande taken.</div>';
    return;
  }

  let html = '<div class="task-group-title">Vandaag</div>';
  html += todayGroup.length
    ? '<div class="task-grid">' + todayGroup.map((t) => taskRowHtml(t, taskDueYmd(t) < todayYmd)).join('') + '</div>'
    : '<div class="empty">Niets voor vandaag.</div>';
  if (upcomingGroup.length) {
    html += '<div class="task-group-title">Aankomend</div>';
    html += '<div class="task-grid">' + upcomingGroup.map((t) => taskRowHtml(t, false)).join('') + '</div>';
  }
  if (withoutDue.length) {
    html += '<div class="task-group-title">Zonder datum</div>';
    html += '<div class="task-grid">' + withoutDue.map((t) => taskRowHtml(t, false)).join('') + '</div>';
  }
  el.innerHTML = html;

  el.querySelectorAll('.task-check').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      btn.closest('.task-row').style.opacity = '0.4';
      try {
        await completeTodoistTask(id);
        loadTasks();
      } catch (e) {
        console.error(e);
        btn.closest('.task-row').style.opacity = '1';
      }
    });
  });
  el.querySelectorAll('.task-postpone-btn').forEach((btn) => {
    btn.addEventListener('click', () => postponeTask(btn.getAttribute('data-id')));
  });
  el.querySelectorAll('.task-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = allTasksCache.find((x) => x.id === btn.getAttribute('data-id'));
      openTaskEditModal(t);
    });
  });
}

let allTasksCache = [];

async function loadTasks() {
  const el = document.getElementById('taskList');
  if (!isTodoistConfigured()) { el.innerHTML = '<div class="empty">Voeg je Todoist-token toe via instellingen (⚙).</div>'; return; }
  el.innerHTML = '<div class="loading">Taken ophalen…</div>';
  try {
    const tasks = await fetchTodoistTasks();
    allTasksCache = tasks;
    const todayYmd = ymd(new Date());
    lastLoadedTasks = tasks.filter((t) => { const d = taskDueYmd(t); return d && d <= todayYmd; });
    renderTaskList(tasks);
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    showDebug('Taken-fout', e.message || String(e));
  }
}

// ---------- Google-script inladen afwachten ----------
// Het gsi/client-script staat als async/defer in index.html, en kan dus soms ná
// DOMContentLoaded pas echt klaar zijn (vooral op een tragere mobiele verbinding).
// Zonder deze check kon initGoogleAuth() te vroeg draaien en stilletjes mislukken,
// waarna de inlogknop de melding "vul eerst je Google Client ID in" toonde ook al
// stond die er allang in.
// Notities staan (net als agenda/taken) standaard op het startscherm ("Algemeen"), dus
// die moeten net als agenda/taken meteen bij het opstarten geladen worden i.p.v. pas
// bij een tab-wissel — die trigger vuurt hier niet, want de gebruiker start al op dit
// tabblad.
async function loadNotesIfSignedIn() {
  const signedIn = await ensureFreshGoogleToken();
  if (signedIn) loadNotesView().then(() => renderBrainDumpBadge());
  else document.getElementById('notesList').innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om je notities te zien.</div>';
}

function bootGoogleAuthWhenReady() {
  const ready = () => (window.google && google.accounts && google.accounts.oauth2);
  const start = () => initGoogleAuth(() => { refreshGoogleStatus(); loadAgenda(); loadNotesIfSignedIn(); });

  if (ready()) { start(); return; }

  const script = document.getElementById('gsiScript');
  if (script) script.addEventListener('load', start);

  // Extra vangnet: als het 'load'-event om wat voor reden dan ook wordt gemist,
  // blijven we een paar seconden pollen.
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    if (ready()) { clearInterval(iv); start(); }
    else if (tries > 50) { clearInterval(iv); }
  }, 100);
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', () => {
  // Eerst de eventueel bewaarde inlog terughalen — dit is een pure localStorage-lezing en
  // heeft niets nodig van Google's externe script, dus dit mag en moet als allereerste.
  loadStoredGoogleToken();

  renderGreeting();
  setupServiceWorker();
  setupNav();
  setupNavDrawer();
  setupSettings();
  setupBudgetNav();
  setupNotes();
  setupSport();
  setupZzp();
  setupAuto();
  setupBrainDump();
  setupTaskEdit();
  bootGoogleAuthWhenReady();
  loadAgenda();
  loadTasks();
  loadNotesIfSignedIn();
  document.getElementById('agendaRefreshBtn').addEventListener('click', () => {
    refreshGoogleStatus();
    loadAgenda();
  });
});

// Nog een vangnet: als de app terugkomt in beeld (bijv. na de Google-inlog-popup op
// mobiel, die soms als losse tab in plaats van echte popup opent), opnieuw checken
// of we inmiddels ingelogd zijn en de agenda dan verversen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderGreeting();
    refreshGoogleStatus();
    // loadAgenda()/loadNotesIfSignedIn() proberen bij een verlopen token nu eerst zelf
    // stilletjes te vernieuwen (ensureFreshGoogleToken) voordat ze een inlogmelding tonen —
    // dit is precies het moment (terug in beeld na een tijdje weg) waarop dat vaak nodig is.
    loadAgenda();
    loadNotesIfSignedIn();
    refreshGoogleStatus();
  }
});
