// ================= APP =================

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

// ---------- Tab-navigatie ----------
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-nav');
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.getAttribute('data-view') === target));
      // Budget en notities staan in het gedeelde Drive-bestand — pas ophalen zodra de
      // gebruiker daadwerkelijk naar dat tabblad gaat (en niet steeds opnieuw als het al
      // eerder geladen is, om onnodige Drive-verzoeken te voorkomen).
      if (target === 'budget') { if (!isGoogleSignedIn()) { document.getElementById('budgetBody').innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om je budget te zien.</div>'; } else if (!sharedDataLoaded) { loadBudgetView(); } else { renderBudgetView(); } }
      if (target === 'notities') { if (!isGoogleSignedIn()) { document.getElementById('notesList').innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om je notities te zien.</div>'; } else if (!sharedDataLoaded) { loadNotesView(); } else { renderNotesView(); } }
      if (target === 'sport') { if (!isGoogleSignedIn()) { document.getElementById('weightBody').innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om Sport te zien.</div>'; } else if (!sharedDataLoaded) { loadSportView(); } else { renderWeightBody(); loadNutritionPlan(); renderNutritionBody(); } }
      if (target === 'zzp') { if (!isGoogleSignedIn()) { document.getElementById('btwBody').innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om ZZP te zien.</div>'; } else if (!sharedDataLoaded) { loadZzpView(); } else { renderBtwBody(); renderIncomeBody(); } }
      if (target === 'auto') { if (!isGoogleSignedIn()) { document.getElementById('apkBody').innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om Auto te zien.</div>'; } else if (!sharedDataLoaded) { loadAutoView(); } else { renderApkBody(); renderCarVisitsBody(); } }
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
}

// ---------- Auto: knoppen ----------
function setupAuto() {
  document.getElementById('carVisitAddBtn').addEventListener('click', openCarVisitModal);
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
  const closeSettingsAndRefresh = () => {
    overlay.classList.add('hidden');
    refreshGoogleStatus();
    loadAgenda();
    loadTasks();
    const activeView = document.querySelector('.view.active');
    const activeName = activeView ? activeView.getAttribute('data-view') : null;
    if (activeName === 'budget' && isGoogleSignedIn()) loadBudgetView();
    if (activeName === 'notities' && isGoogleSignedIn()) loadNotesView();
    if (activeName === 'sport' && isGoogleSignedIn()) loadSportView();
    if (activeName === 'zzp' && isGoogleSignedIn()) loadZzpView();
    if (activeName === 'auto' && isGoogleSignedIn()) loadAutoView();
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

async function fetchCalendarList() {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
    headers: { Authorization: 'Bearer ' + googleAccessToken }
  });
  if (!res.ok) throw new Error('Agendalijst ophalen mislukt (' + res.status + ')');
  const data = await res.json();
  return (data.items || []).filter((c) => c.selected !== false);
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
  const perCalendar = await Promise.all(calendars.map(async (cal) => {
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(cal.id) + '/events?' + params.toString(), {
        headers: { Authorization: 'Bearer ' + googleAccessToken }
      });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.items || []).map((e) => Object.assign({}, e, { __calendarId: cal.id }));
    } catch (e) {
      console.error('events ophalen mislukt voor', cal.id, e);
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
  return events.filter((e) => {
    if (e.start && e.start.date) return true; // hele dag
    if (e.start && e.start.dateTime) {
      const end = e.end && e.end.dateTime ? new Date(e.end.dateTime) : new Date(e.start.dateTime);
      return end >= now;
    }
    return false;
  });
}

function renderAgendaList(events) {
  const el = document.getElementById('agendaList');
  if (events.length === 0) { el.innerHTML = '<div class="empty">Niets meer gepland voor vandaag.</div>'; return; }
  el.innerHTML = events.map((ev) => {
    const timeLabel = ev.start.date ? 'hele dag' : new Date(ev.start.dateTime).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return `<div class="agenda-item"><span class="t">${esc(timeLabel)}</span><span class="s">${esc(ev.summary || '(geen titel)')}</span></div>`;
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
  if (!isGoogleSignedIn()) { el.innerHTML = '<div class="empty">Log in met Google via instellingen (⚙) om je agenda te zien.</div>'; return; }
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
async function fetchTodoistTasks() {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/api/v1/tasks?filter=' + encodeURIComponent('today | overdue'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok) {
    let detail = '';
    try { const body = await res.json(); detail = body && body.error ? ' — ' + body.error : ''; } catch (e) { /* geen JSON-body */ }
    throw new Error('Taken ophalen mislukt (' + res.status + ')' + detail);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.results || []);
}

async function completeTodoistTask(id) {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/api/v1/tasks/' + id + '/close', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Afvinken mislukt (' + res.status + ')');
}

function renderTaskList(tasks) {
  const el = document.getElementById('taskList');
  if (tasks.length === 0) { el.innerHTML = '<div class="empty">Geen openstaande taken voor vandaag.</div>'; return; }
  el.innerHTML = tasks.map((t) => `
    <div class="task-row" data-id="${esc(t.id)}">
      <button type="button" class="task-check" data-id="${esc(t.id)}" title="Afvinken"></button>
      <span class="txt">${esc(t.content)}</span>
      <span class="due">${t.due ? esc(t.due.date) : ''}</span>
    </div>`).join('');

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
}

async function loadTasks() {
  const el = document.getElementById('taskList');
  if (!isTodoistConfigured()) { el.innerHTML = '<div class="empty">Voeg je Todoist-token toe via instellingen (⚙).</div>'; return; }
  el.innerHTML = '<div class="loading">Taken ophalen…</div>';
  try {
    const tasks = await fetchTodoistTasks();
    lastLoadedTasks = tasks;
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
function bootGoogleAuthWhenReady() {
  const ready = () => (window.google && google.accounts && google.accounts.oauth2);
  const start = () => initGoogleAuth(() => { refreshGoogleStatus(); loadAgenda(); });

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

  setupServiceWorker();
  setupNav();
  setupSettings();
  setupBudgetNav();
  setupNotes();
  setupSport();
  setupZzp();
  setupAuto();
  bootGoogleAuthWhenReady();
  loadAgenda();
  loadTasks();
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
    refreshGoogleStatus();
    loadAgenda();
  }
});
