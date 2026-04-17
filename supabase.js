/* =====================================================
   Pool Drill Tracker — supabase.js (Data Layer)
   ===================================================== */

const SUPABASE_URL = 'https://quowhtoqgwlrdeglqddb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1b3dodG9xZ3dscmRlZ2xxZGRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNzk1MTcsImV4cCI6MjA5MTk1NTUxN30.diMVQk323aEE8JC0qYHc9S0VA7COXUZhsJm9CHmYcBc';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ───────────────────────────────────────────
let _userId = null;
let _online = navigator.onLine;

window.addEventListener('online', () => { _online = true; syncFromLocal(); });
window.addEventListener('offline', () => { _online = false; });

// ── Auth ────────────────────────────────────────────

async function dbInit() {
  // Try restoring existing session first
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    _userId = session.user.id;
  } else {
    // Anonymous sign-in
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) {
      console.warn('Supabase anon auth failed, offline mode:', error.message);
      _userId = null;
      return;
    }
    _userId = data.user.id;
  }
  // Migrate any localStorage data into Supabase
  await migrateLocalData();
}

// ── Sessions ────────────────────────────────────────

async function dbCreateSession(drillType, label) {
  const id = crypto.randomUUID();
  const row = { id, user_id: _userId, drill_type: drillType, label, created_at: new Date().toISOString() };
  if (_userId && _online) {
    const { error } = await sb.from('sessions').insert(row);
    if (error) console.warn('dbCreateSession remote fail:', error.message);
  }
  // Always save locally
  _localSaveSession(row);
  return row;
}

async function dbGetSessions(drillType) {
  if (_userId && _online) {
    const { data, error } = await sb.from('sessions')
      .select('*')
      .eq('user_id', _userId)
      .eq('drill_type', drillType)
      .order('created_at', { ascending: false });
    if (!error && data) {
      _localCacheSessions(data, drillType);
      return data;
    }
  }
  return _localGetSessions(drillType);
}

async function dbGetAllSessions() {
  if (_userId && _online) {
    const { data, error } = await sb.from('sessions')
      .select('*')
      .eq('user_id', _userId)
      .order('created_at', { ascending: false });
    if (!error && data) {
      _localCacheAllSessions(data);
      return data;
    }
  }
  return _localGetAllSessions();
}

async function dbDeleteSession(sessionId) {
  if (_userId && _online) {
    await sb.from('drill_entries').delete().eq('session_id', sessionId);
    await sb.from('sessions').delete().eq('id', sessionId);
  }
  _localDeleteSession(sessionId);
}

// ── Drill Entries ───────────────────────────────────

async function dbSaveEntry(sessionId, drillKey, attempts, shotType, note) {
  if (_userId && _online) {
    // Upsert: if entry for this session+key exists, update it
    const { data: existing } = await sb.from('drill_entries')
      .select('id')
      .eq('session_id', sessionId)
      .eq('drill_key', drillKey)
      .maybeSingle();
    if (existing) {
      await sb.from('drill_entries').update({ attempts, shot_type: shotType, note: note || '' })
        .eq('id', existing.id);
    } else {
      await sb.from('drill_entries').insert({
        session_id: sessionId,
        user_id: _userId,
        drill_key: drillKey,
        attempts,
        shot_type: shotType,
        note: note || ''
      });
    }
  }
  _localSaveEntry(sessionId, drillKey, attempts, shotType, note);
}

async function dbGetEntries(sessionId) {
  if (_userId && _online) {
    const { data, error } = await sb.from('drill_entries')
      .select('*')
      .eq('session_id', sessionId);
    if (!error && data) {
      _localCacheEntries(sessionId, data);
      return data;
    }
  }
  return _localGetEntries(sessionId);
}

/** Get the last N attempts for a specific drill key across all sessions. */
async function dbGetHistory(drillKey, limit) {
  if (_userId && _online) {
    const { data, error } = await sb.from('drill_entries')
      .select('attempts, created_at')
      .eq('user_id', _userId)
      .eq('drill_key', drillKey)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && data) return data;
  }
  return _localGetHistory(drillKey, limit);
}

/** Get rolling average of last N attempts for a drill key. */
async function dbGetRollingAvg(drillKey, n) {
  const history = await dbGetHistory(drillKey, n);
  if (history.length === 0) return null;
  const sum = history.reduce((s, h) => s + h.attempts, 0);
  return sum / history.length;
}

// ── User Config ─────────────────────────────────────

async function dbGetConfig() {
  if (_userId && _online) {
    const { data } = await sb.from('user_config')
      .select('*')
      .eq('user_id', _userId)
      .maybeSingle();
    if (data) {
      _localSaveConfig(data);
      return { posLabels: data.pos_labels || {}, posSkipped: data.pos_skipped || {} };
    }
  }
  return _localGetConfig();
}

async function dbSaveConfig(cfg) {
  if (_userId && _online) {
    await sb.from('user_config').upsert({
      user_id: _userId,
      pos_labels: cfg.posLabels || {},
      pos_skipped: cfg.posSkipped || {}
    });
  }
  _localSaveConfigObj(cfg);
}

// ── Local Storage Helpers (offline cache) ───────────

const LS_SESSIONS = 'pdt_sessions';
const LS_ENTRIES_PREFIX = 'pdt_entries_';
const LS_CONFIG = 'pdt_config';
const LS_ACTIVE = 'pdt_active_session';

function _lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function _lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function _localSaveSession(row) {
  const all = _lsGet(LS_SESSIONS, []);
  const idx = all.findIndex(s => s.id === row.id);
  if (idx >= 0) all[idx] = row; else all.push(row);
  _lsSet(LS_SESSIONS, all);
}

function _localCacheSessions(rows, drillType) {
  const all = _lsGet(LS_SESSIONS, []);
  // Remove old entries of this type, replace with fresh
  const other = all.filter(s => s.drill_type !== drillType);
  _lsSet(LS_SESSIONS, [...other, ...rows]);
}

function _localCacheAllSessions(rows) {
  _lsSet(LS_SESSIONS, rows);
}

function _localGetSessions(drillType) {
  return _lsGet(LS_SESSIONS, [])
    .filter(s => s.drill_type === drillType)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function _localGetAllSessions() {
  return _lsGet(LS_SESSIONS, []).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function _localDeleteSession(id) {
  const all = _lsGet(LS_SESSIONS, []).filter(s => s.id !== id);
  _lsSet(LS_SESSIONS, all);
  localStorage.removeItem(LS_ENTRIES_PREFIX + id);
}

function _localSaveEntry(sessionId, drillKey, attempts, shotType, note) {
  const entries = _lsGet(LS_ENTRIES_PREFIX + sessionId, []);
  const idx = entries.findIndex(e => e.drill_key === drillKey);
  const row = { drill_key: drillKey, attempts, shot_type: shotType, note: note || '', created_at: new Date().toISOString() };
  if (idx >= 0) entries[idx] = { ...entries[idx], ...row }; else entries.push(row);
  _lsSet(LS_ENTRIES_PREFIX + sessionId, entries);
}

function _localCacheEntries(sessionId, rows) {
  _lsSet(LS_ENTRIES_PREFIX + sessionId, rows);
}

function _localGetEntries(sessionId) {
  return _lsGet(LS_ENTRIES_PREFIX + sessionId, []);
}

function _localGetHistory(drillKey, limit) {
  // Scan all sessions for this key, sorted by date desc
  const allSessions = _lsGet(LS_SESSIONS, []).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const results = [];
  for (const s of allSessions) {
    if (results.length >= limit) break;
    const entries = _lsGet(LS_ENTRIES_PREFIX + s.id, []);
    const match = entries.find(e => e.drill_key === drillKey);
    if (match && match.attempts >= 2) {
      results.push({ attempts: match.attempts, created_at: match.created_at || s.created_at });
    }
  }
  return results;
}

function _localGetConfig() {
  return _lsGet(LS_CONFIG, { posLabels: {}, posSkipped: {} });
}

function _localSaveConfig(data) {
  _lsSet(LS_CONFIG, { posLabels: data.pos_labels || {}, posSkipped: data.pos_skipped || {} });
}

function _localSaveConfigObj(cfg) {
  _lsSet(LS_CONFIG, cfg);
}

// Active session tracking per drill type
function getActiveSessionId(drillType) {
  const map = _lsGet(LS_ACTIVE, {});
  return map[drillType] || null;
}

function setActiveSessionId(drillType, sessionId) {
  const map = _lsGet(LS_ACTIVE, {});
  map[drillType] = sessionId;
  _lsSet(LS_ACTIVE, map);
}

// ── Migration from old localStorage format ──────────

async function migrateLocalData() {
  const LEGACY_KEY = 'poolDrillData';
  const LEGACY_CONFIG = 'poolDrillConfig';
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;

  let legacy;
  try { legacy = JSON.parse(raw); } catch { return; }
  if (!legacy.sessions || legacy.sessions.length === 0) return;

  console.log(`Migrating ${legacy.sessions.length} legacy sessions to Supabase...`);

  for (const ls of legacy.sessions) {
    const drillType = ls.drillType || 'positions';
    const sessionRow = await dbCreateSession(drillType, ls.label || 'Migrated');

    // Flatten entries from old format to new flat key format
    if (drillType === 'positions') {
      for (const [ballKey, positions] of Object.entries(ls.data || {})) {
        const ballNum = ballKey.replace('ball', '');
        for (const [posKey, entry] of Object.entries(positions)) {
          if (entry && entry.attempts >= 2) {
            const drillKey = `pos-${ballNum}-${posKey}`;
            await dbSaveEntry(sessionRow.id, drillKey, entry.attempts, entry.type || 'cut', entry.note || '');
          }
        }
      }
    } else {
      // MX and WW: keys are already flat in session.data
      for (const [key, entry] of Object.entries(ls.data || {})) {
        if (entry && entry.attempts >= 2) {
          await dbSaveEntry(sessionRow.id, key, entry.attempts, entry.shot_type || '', entry.note || '');
        }
      }
    }

    // If this was the active session, mark it
    if (ls.id === legacy.activeSessionId) {
      setActiveSessionId(drillType, sessionRow.id);
    }
  }

  // Migrate config
  const cfgRaw = localStorage.getItem(LEGACY_CONFIG);
  if (cfgRaw) {
    try {
      const cfg = JSON.parse(cfgRaw);
      await dbSaveConfig(cfg);
    } catch { /* ignore */ }
  }

  // Remove legacy keys so migration doesn't run again
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem(LEGACY_CONFIG);
  console.log('Migration complete.');
}

// ── Sync pending local changes when coming back online ──

async function syncFromLocal() {
  if (!_userId || !_online) return;
  // Re-push all local sessions and entries to Supabase
  const sessions = _lsGet(LS_SESSIONS, []);
  for (const s of sessions) {
    const { error } = await sb.from('sessions').upsert({
      id: s.id,
      user_id: _userId,
      drill_type: s.drill_type,
      label: s.label,
      created_at: s.created_at
    });
    if (error) continue;
    const entries = _lsGet(LS_ENTRIES_PREFIX + s.id, []);
    for (const e of entries) {
      const { data: existing } = await sb.from('drill_entries')
        .select('id')
        .eq('session_id', s.id)
        .eq('drill_key', e.drill_key)
        .maybeSingle();
      if (existing) {
        await sb.from('drill_entries').update({
          attempts: e.attempts, shot_type: e.shot_type, note: e.note || ''
        }).eq('id', existing.id);
      } else {
        await sb.from('drill_entries').insert({
          session_id: s.id,
          user_id: _userId,
          drill_key: e.drill_key,
          attempts: e.attempts,
          shot_type: e.shot_type || '',
          note: e.note || ''
        });
      }
    }
  }
}
