// ================= AUTH =================
// Google: client-side OAuth via Google Identity Services (PKCE, geen secret nodig).
// De Client ID hieronder is GEEN geheim — die mag gewoon in de broncode staan.
// Vul 'm in zodra je 'm in Google Cloud Console hebt aangemaakt (zie instructies).
const GOOGLE_CLIENT_ID = '231727894798-cm9i00jeanqn796k02rhrm80e71p3vq8.apps.googleusercontent.com';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive'
].join(' ');

const GOOGLE_TOKEN_SESSION_KEY = 'beetjeoranje-mobile-google-token';
const TODOIST_TOKEN_KEY = 'beetjeoranje-mobile-todoist-token';

let googleTokenClient = null;
let googleAccessToken = null;
let googleTokenExpiresAt = 0;

function isGoogleConfigured() {
  return GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('VUL_HIER');
}

// Token (en verloopmoment) kort bewaren zodat een pagina-herlaad niet meteen
// weer een inlogscherm toont — token-flow tokens zijn sowieso maar ~1 uur geldig.
function loadStoredGoogleToken() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(GOOGLE_TOKEN_SESSION_KEY));
    if (raw && raw.token && raw.expiresAt > Date.now()) {
      googleAccessToken = raw.token;
      googleTokenExpiresAt = raw.expiresAt;
    }
  } catch (e) { /* negeren */ }
}

function storeGoogleToken(token, expiresInSec) {
  googleAccessToken = token;
  googleTokenExpiresAt = Date.now() + (expiresInSec * 1000) - 30000; // 30s marge
  sessionStorage.setItem(GOOGLE_TOKEN_SESSION_KEY, JSON.stringify({ token, expiresAt: googleTokenExpiresAt }));
}

function isGoogleSignedIn() {
  return !!googleAccessToken && Date.now() < googleTokenExpiresAt;
}

function initGoogleAuth(onTokenReady) {
  if (!isGoogleConfigured()) return;
  loadStoredGoogleToken();
  googleTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: (resp) => {
      if (resp && resp.access_token) {
        storeGoogleToken(resp.access_token, resp.expires_in || 3600);
        if (onTokenReady) onTokenReady();
      }
    }
  });
}

// Vraagt (indien nodig) een nieuw token op. Toont bij een verlopen sessie stilletjes
// (zonder popup) een nieuw scherm als dat kan, anders vraagt het gewoon opnieuw.
function signInGoogle() {
  if (!googleTokenClient) { alert('Vul eerst je Google Client ID in auth.js in.'); return; }
  googleTokenClient.requestAccessToken({ prompt: 'consent' });
}

function ensureGoogleToken(onReady) {
  if (isGoogleSignedIn()) { onReady(); return; }
  if (!googleTokenClient) return;
  googleTokenClient.callback = (resp) => {
    if (resp && resp.access_token) {
      storeGoogleToken(resp.access_token, resp.expires_in || 3600);
      onReady();
    }
  };
  googleTokenClient.requestAccessToken({ prompt: '' }); // probeer stil te verversen
}

// ---------- Todoist ----------
function getTodoistToken() {
  return localStorage.getItem(TODOIST_TOKEN_KEY) || '';
}
function saveTodoistToken(token) {
  localStorage.setItem(TODOIST_TOKEN_KEY, token.trim());
}
function isTodoistConfigured() {
  return !!getTodoistToken();
}
