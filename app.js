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
    });
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
  const closeSettingsAndRefresh = () => {
    overlay.classList.add('hidden');
    refreshGoogleStatus();
    loadAgenda();
    loadTasks();
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
    showDebug('Agenda', 'opgehaald, ' + events.length + ' item(s)');
  } catch (e) {
    console.error(e);
    el.innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    showDebug('Agenda-fout', e.message || String(e));
  }
}

// ---------- Taken (rechtstreeks Todoist REST API) ----------
async function fetchTodoistTasks() {
  const token = getTodoistToken();
  const res = await fetch('https://api.todoist.com/rest/v2/tasks?filter=' + encodeURIComponent('today | overdue'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Taken ophalen mislukt (' + res.status + ')');
  return res.json();
}

async function completeTodoistTask(id) {
  const token = getTodoistToken();
  await fetch('https://api.todoist.com/rest/v2/tasks/' + id + '/close', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token }
  });
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
    showDebug('Taken', 'opgehaald, ' + tasks.length + ' item(s)');
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
  setupServiceWorker();
  setupNav();
  setupSettings();
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
