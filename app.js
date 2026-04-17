/* =====================================================
   Pool Drill Tracker — app.js
   ===================================================== */

// ── Geometry ────────────────────────────────────────

/** Ball positions: ball number → {col, row} on the 4×3 grid (column-first). */
const BALL_POSITIONS = {};
(() => {
  let n = 1;
  for (let col = 1; col <= 4; col++) {
    for (let row = 1; row <= 3; row++) {
      BALL_POSITIONS[n] = { col, row };
      n++;
    }
  }
})();

/** Full 14-spot perimeter path (clockwise) on the 6×3 sub-grid. */
const PERIMETER_PATH = [
  { col: 1, row: 1 },
  { col: 2, row: 1 },
  { col: 3, row: 1 },
  { col: 4, row: 1 },
  { col: 5, row: 1 },
  { col: 6, row: 1 },
  { col: 6, row: 2 },
  { col: 6, row: 3 },
  { col: 5, row: 3 },
  { col: 4, row: 3 },
  { col: 3, row: 3 },
  { col: 2, row: 3 },
  { col: 1, row: 3 },
  { col: 1, row: 2 },
];

function coordKey(c) { return c.col + ',' + c.row; }
function sameCoord(a, b) { return a.col === b.col && a.row === b.row; }

/** Per-ball position exclusions — loaded from excluded-positions.yaml */
let EXCLUDED_POSITIONS = {};

function filterExcluded(ballNum, positions) {
  const excl = EXCLUDED_POSITIONS[ballNum];
  let result = excl ? positions.filter((p) => !excl.has(coordKey(p))) : positions;
  // Also filter user-skipped positions
  return result.filter((p) => !isPosSkipped(ballNum, coordKey(p)));
}

/** Dual positions: same angle, two directions → track L and R separately.
    Loaded from dual-positions.yaml */
let DUAL_POSITIONS = {};

/** Bank positions: ball → Set of CB positions that are bank shots.
    Everything else is cut. Loaded from bank-positions.yaml */
let BANK_POSITIONS = {};

/** Pocket target per ball (with optional per-CB-position overrides) — loaded from pocket-targets.yaml */
let POCKET_TARGETS = {};

/** The 6 pocket positions on the table grid. */
const POCKET_COORDS = {
  BL: { col: 0, row: 0 },
  TL: { col: 0, row: 4 },
  BS: { col: 4, row: 0 },
  TS: { col: 4, row: 4 },
  BR: { col: 8, row: 0 },
  TR: { col: 8, row: 4 },
};

/**
 * Parse a YAML config file of the form:
 *   ballNumber: ["col,row", ...]
 * Duplicate ball keys are merged into one Set.
 */
function parsePositionYaml(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(\d+):\s*\[(.*)\]$/);
    if (!m) continue;
    const ball = parseInt(m[1], 10);
    const items = m[2].match(/"([^"]+)"/g);
    if (!result[ball]) result[ball] = new Set();
    if (items) items.forEach(s => result[ball].add(s.replace(/"/g, '')));
  }
  return result;
}

/**
 * Parse pocket-targets.yaml:
 *   ballNumber: PocketID              (default pocket for ball)
 *   ballNumber@col,row: PocketID      (override for specific CB position)
 */
function parsePocketYaml(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Position-specific override with dual pockets: 5@6,2: [TL, TR]  (L→TL, R→TR)
    const mod = trimmed.match(/^(\d+)@(\d+,\d+):\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]$/);
    if (mod) {
      const ball = parseInt(mod[1], 10);
      if (!result[ball]) result[ball] = {};
      result[ball][mod[2]] = { L: mod[3], R: mod[4] };
      continue;
    }
    // Position-specific override: 2@6,2: TL
    const mo = trimmed.match(/^(\d+)@(\d+,\d+):\s*(\w+)$/);
    if (mo) {
      const ball = parseInt(mo[1], 10);
      if (!result[ball]) result[ball] = {};
      result[ball][mo[2]] = mo[3];
      continue;
    }
    // Default: 2: BL
    const md = trimmed.match(/^(\d+):\s*(\w+)$/);
    if (!md) continue;
    const ball = parseInt(md[1], 10);
    if (!result[ball]) result[ball] = {};
    result[ball]._default = md[2];
  }
  return result;
}

/** Get the pocket target for a ball at a specific CB position.
 *  direction: 'L' or 'R' for dual positions with [L, R] pocket pairs. */
function getPocketTarget(ballNum, posKey, direction) {
  const entry = POCKET_TARGETS[ballNum];
  if (!entry) return null;
  const clean = posKey ? posKey.replace(/:.*/, '') : null;
  if (clean && entry[clean]) {
    const val = entry[clean];
    if (typeof val === 'object') {
      return (direction && val[direction]) || val.L;
    }
    return val;
  }
  return entry._default || null;
}

async function loadPositionConfigs() {
  try {
    const [bankText, dualText, exclText, pocketText] = await Promise.all([
      fetch('./bank-positions.yaml').then(r => r.ok ? r.text() : ''),
      fetch('./dual-positions.yaml').then(r => r.ok ? r.text() : ''),
      fetch('./excluded-positions.yaml').then(r => r.ok ? r.text() : ''),
      fetch('./pocket-targets.yaml').then(r => r.ok ? r.text() : ''),
    ]);
    BANK_POSITIONS = parsePositionYaml(bankText);
    DUAL_POSITIONS = parsePositionYaml(dualText);
    EXCLUDED_POSITIONS = parsePositionYaml(exclText);
    POCKET_TARGETS = parsePocketYaml(pocketText);
  } catch (e) {
    console.warn('Failed to load position configs:', e);
  }
}

function getShotType(ballNum, posKey) {
  const clean = posKey.replace(/:.*/, '');
  return BANK_POSITIONS[ballNum] && BANK_POSITIONS[ballNum].has(clean) ? 'bank' : 'cut';
}

function isDualPosition(ballNum, posKey) {
  return DUAL_POSITIONS[ballNum] && DUAL_POSITIONS[ballNum].has(posKey);
}

/** Cut angle in degrees between CB→OB aim line and OB→Pocket target line. */
function getCutAngle(ballNum, posKey) {
  const bp = BALL_POSITIONS[ballNum];
  const parts = posKey.replace(/:.*/, '').split(',');
  const cc = parseInt(parts[0], 10), cr = parseInt(parts[1], 10);
  const dirMatch = posKey.match(/:([LR])$/);
  const pk = POCKET_COORDS[getPocketTarget(ballNum, posKey, dirMatch ? dirMatch[1] : null)];
  if (!pk) return null;
  const tx = pk.col - bp.col, ty = pk.row - bp.row;
  const ax = bp.col - cc, ay = bp.row - cr;
  const tLen = Math.sqrt(tx * tx + ty * ty);
  const aLen = Math.sqrt(ax * ax + ay * ay);
  if (tLen === 0 || aLen === 0) return 0;
  const cosA = Math.max(-1, Math.min(1, (tx * ax + ty * ay) / (tLen * aLen)));
  return Math.acos(cosA) * 180 / Math.PI;
}

/** Returns 'left', 'right', or 'straight' based on which side of the
 *  OB→Pocket line the cue ball is on. */
function getCutDirection(ballNum, posKey) {
  const bp = BALL_POSITIONS[ballNum];
  const parts = posKey.replace(/:.*/, '').split(',');
  const cc = parseInt(parts[0], 10), cr = parseInt(parts[1], 10);
  const dirMatch = posKey.match(/:([LR])$/);
  const pk = POCKET_COORDS[getPocketTarget(ballNum, posKey, dirMatch ? dirMatch[1] : null)];
  if (!pk) return null;
  const tx = pk.col - bp.col, ty = pk.row - bp.row;
  const ax = bp.col - cc, ay = bp.row - cr;
  const cross = ax * ty - ay * tx;
  if (Math.abs(cross) < 0.001) return 'straight';
  return cross > 0 ? 'left' : 'right';
}

function isPositionComplete(ballNum, posKey) {
  if (isDualPosition(ballNum, posKey)) {
    return !!getEntry(ballNum, posKey, 'L') && !!getEntry(ballNum, posKey, 'R');
  }
  return !!getEntry(ballNum, posKey);
}

function isInteriorBall(ballNum) {
  const p = BALL_POSITIONS[ballNum];
  return !PERIMETER_PATH.some((pp) => sameCoord(pp, p));
}

/**
 * Get ordered cue-ball positions for a given ball.
 * Starts from the next clockwise perimeter spot after the ball position.
 * Skips the ball's own spot if it's on the perimeter.
 */
function getCuePositions(ballNum) {
  const ballPos = BALL_POSITIONS[ballNum];
  const interior = isInteriorBall(ballNum);

  if (interior) {
    // Find closest perimeter spot clockwise (use first spot after the ball column)
    // Start from the perimeter spot that is "next clockwise" relative to where the ball projects.
    // Simple approach: find the first perimeter spot where col > ballPos.col on the bottom row,
    // or just start from the spot directly below the ball.
    const below = { col: ballPos.col, row: 1 };
    let startIdx = PERIMETER_PATH.findIndex((p) => sameCoord(p, below));
    if (startIdx === -1) startIdx = 0;
    // Rotate perimeter starting from the next spot
    startIdx = (startIdx + 1) % PERIMETER_PATH.length;
    const result = [];
    for (let i = 0; i < PERIMETER_PATH.length; i++) {
      result.push(PERIMETER_PATH[(startIdx + i) % PERIMETER_PATH.length]);
    }
    return filterExcluded(ballNum, result);
  }

  // Ball is on perimeter — find its index, start from next, skip its own spot
  const ballIdx = PERIMETER_PATH.findIndex((p) => sameCoord(p, ballPos));
  const result = [];
  for (let i = 1; i < PERIMETER_PATH.length; i++) {
    result.push(PERIMETER_PATH[(ballIdx + i) % PERIMETER_PATH.length]);
  }
  return filterExcluded(ballNum, result);
}

// ── Pool ball colors ────────────────────────────────

const BALL_COLORS = {
  1:  { fill: '#f5c518', text: '#111',  stripe: false },
  2:  { fill: '#1a5fb4', text: '#fff',  stripe: false },
  3:  { fill: '#c01c28', text: '#fff',  stripe: false },
  4:  { fill: '#613583', text: '#fff',  stripe: false },
  5:  { fill: '#e66100', text: '#fff',  stripe: false },
  6:  { fill: '#26a269', text: '#fff',  stripe: false },
  7:  { fill: '#7b2d26', text: '#fff',  stripe: false },
  8:  { fill: '#222',    text: '#fff',  stripe: false },
  9:  { fill: '#f5c518', text: '#111',  stripe: true  },
  10: { fill: '#1a5fb4', text: '#fff',  stripe: true  },
  11: { fill: '#c01c28', text: '#fff',  stripe: true  },
  12: { fill: '#613583', text: '#fff',  stripe: true  },
};

// ── Drill Types ─────────────────────────────────────

const DRILL_TYPES = {
  positions: { label: 'Positions', icon: '🎯' },
  mightyx:   { label: 'Mighty X',  icon: '✖️' },
  wagon:     { label: 'Wagon Wheel', icon: '☸️' },
};

// ── Mighty X Constants ──────────────────────────────

const MX_SIDES = ['left', 'right'];
const MX_SHOTS = ['follow', 'draw', 'stop'];
const MX_SHOT_COLORS = { follow: '#6ee7a0', draw: '#e8a23a', stop: '#7aa2f7' };
const MX_SHOT_LABELS = { follow: 'Follow', draw: 'Draw', stop: 'Stop' };

// Diagonal positions (5 diamond-crossing points between corner pockets, cols 2-6)
// "left" = TL→BR diagonal: row = 4 - col*0.5
// "right" = BL→TR diagonal: row = col*0.5
const MX_DIAG_POS = {
  left:  [{ col: 2, row: 3 }, { col: 3, row: 2.5 }, { col: 4, row: 2 }, { col: 5, row: 1.5 }, { col: 6, row: 1 }],
  right: [{ col: 2, row: 1 }, { col: 3, row: 1.5 }, { col: 4, row: 2 }, { col: 5, row: 2.5 }, { col: 6, row: 3 }],
};
// Target pocket for each diagonal (the pocket the OB is nearest to)
const MX_DIAG_POCKET = {
  left:  { col: 0, row: 4 }, // TL pocket
  right: { col: 0, row: 0 }, // BL pocket
};
// All OB/CB combos — every pair where OB is closer to pocket than CB (0-based indices)
const MX_COMBOS = [
  { ob: 0, cb: 1, label: '1→2' },
  { ob: 0, cb: 2, label: '1→3' },
  { ob: 0, cb: 3, label: '1→4' },
  { ob: 0, cb: 4, label: '1→5' },
  { ob: 1, cb: 2, label: '2→3' },
  { ob: 1, cb: 3, label: '2→4' },
  { ob: 1, cb: 4, label: '2→5' },
  { ob: 2, cb: 3, label: '3→4' },
  { ob: 2, cb: 4, label: '3→5' },
  { ob: 3, cb: 4, label: '4→5' },
];
const MX_LEVELS = MX_COMBOS.map((_, i) => i + 1);
const MX_COMBO_LABELS = Object.fromEntries(MX_COMBOS.map((c, i) => [i + 1, c.label]));

const MX_TOTAL = MX_SIDES.length * MX_LEVELS.length * MX_SHOTS.length;
function mxKey(side, level, shot) { return `${side}-${level}-${shot}`; }

// ── Wagon Wheel Constants ───────────────────────────

// 23 diamond positions clockwise (pockets included; TS pocket excluded — OB lives there)
const WW_POSITIONS = [
  { col: 5, row: 4 }, { col: 6, row: 4 }, { col: 7, row: 4 },  // top rail right
  { col: 8, row: 4 },                                            // TR pocket
  { col: 8, row: 3 }, { col: 8, row: 2 }, { col: 8, row: 1 },  // right rail
  { col: 8, row: 0 },                                            // BR pocket
  { col: 7, row: 0 }, { col: 6, row: 0 }, { col: 5, row: 0 },  // bottom rail right
  { col: 4, row: 0 },                                            // BS pocket (pos 12)
  { col: 3, row: 0 }, { col: 2, row: 0 }, { col: 1, row: 0 },  // bottom rail left
  { col: 0, row: 0 },                                            // BL pocket
  { col: 0, row: 1 }, { col: 0, row: 2 }, { col: 0, row: 3 },  // left rail
  { col: 0, row: 4 },                                            // TL pocket
  { col: 1, row: 4 }, { col: 2, row: 4 }, { col: 3, row: 4 },  // top rail left
];
// Back-compat alias for stats.js
const WW_ALL_DIAMONDS = WW_POSITIONS;

const WW_TOTAL = WW_POSITIONS.length; // 23

function wwKey(pos) { return `ww-${pos.col}-${pos.row}`; }

// All 24 diamond positions clockwise from TL (used by variant filtering)
const ALL_24_DIAMONDS = [
  { col: 0, row: 4 }, { col: 1, row: 4 }, { col: 2, row: 4 }, { col: 3, row: 4 },
  { col: 4, row: 4 }, { col: 5, row: 4 }, { col: 6, row: 4 }, { col: 7, row: 4 },
  { col: 8, row: 4 },                                            // top rail
  { col: 8, row: 3 }, { col: 8, row: 2 }, { col: 8, row: 1 },  // right rail
  { col: 8, row: 0 }, { col: 7, row: 0 }, { col: 6, row: 0 }, { col: 5, row: 0 },
  { col: 4, row: 0 }, { col: 3, row: 0 }, { col: 2, row: 0 }, { col: 1, row: 0 },
  { col: 0, row: 0 },                                            // bottom rail
  { col: 0, row: 1 }, { col: 0, row: 2 }, { col: 0, row: 3 },  // left rail
];

// Wagon Wheel variant configurations
// End rail = short rail (col 0 / col 8), OB 1 diamond from corner
// Side rail = long rail (row 4 / row 0), OB 2 diamonds from corner
const WW_CONFIGS = {
  center: {
    label: 'Center', exclude: new Set(['4,4']),
    keyPrefix: 'ww', drillType: 'wagon',
    ob: { col: 4, row: 3 }, pocket: { col: 4, row: 4 }, pocketLabel: 'Top Side',
  },
  'endRail-left': {
    label: 'End Rail L', exclude: new Set(['0,4', '0,3', '0,2']),
    keyPrefix: 'wwel', drillType: 'wagon-el',
    ob: { col: 0, row: 3 }, pocket: { col: 0, row: 4 }, pocketLabel: 'Top Left',
  },
  'endRail-right': {
    label: 'End Rail R', exclude: new Set(['8,4', '8,3', '8,2']),
    keyPrefix: 'wwer', drillType: 'wagon-er',
    ob: { col: 8, row: 3 }, pocket: { col: 8, row: 4 }, pocketLabel: 'Top Right',
  },
  'sideRail-left': {
    label: 'Side Rail L', exclude: new Set(['0,4', '1,4', '2,4', '3,4']),
    keyPrefix: 'wwsl', drillType: 'wagon-sl',
    ob: { col: 2, row: 4 }, pocket: { col: 0, row: 4 }, pocketLabel: 'Top Left',
  },
  'sideRail-right': {
    label: 'Side Rail R', exclude: new Set(['8,4', '7,4', '6,4', '5,4']),
    keyPrefix: 'wwsr', drillType: 'wagon-sr',
    ob: { col: 6, row: 4 }, pocket: { col: 8, row: 4 }, pocketLabel: 'Top Right',
  },
};

const _wwPosCache = {};
function getWWConfigKey() {
  if (state.wagonVariant === 'center') return 'center';
  return `${state.wagonVariant}-${state.wagonSide}`;
}
function getWWConfig() { return WW_CONFIGS[getWWConfigKey()]; }

function getActiveWWPositions() {
  const key = getWWConfigKey();
  if (key === 'center') return WW_POSITIONS; // exact backward compat
  if (!_wwPosCache[key]) {
    const cfg = WW_CONFIGS[key];
    _wwPosCache[key] = ALL_24_DIAMONDS.filter(p => !cfg.exclude.has(`${p.col},${p.row}`));
  }
  return _wwPosCache[key];
}

function getActiveWWTotal() { return getActiveWWPositions().length; }
function activeWWKey(pos) { return `${getWWConfig().keyPrefix}-${pos.col}-${pos.row}`; }

// Compound drill type for session tracking (includes variant info)
function activeDrillType() {
  if (state.drillType !== 'wagon' || state.wagonVariant === 'center') return state.drillType;
  const v = state.wagonVariant === 'endRail' ? 'e' : 's';
  return `wagon-${v}${state.wagonSide[0]}`;
}

// Shot setup based on active variant
function wwShotSetup(posIdx) {
  const cfg = getWWConfig();
  const positions = getActiveWWPositions();
  const pos = positions[posIdx];
  const target = cfg.pocket;
  const ob = cfg.ob;
  let cb;
  if (state.wagonVariant === 'center') {
    if (pos.col === 4 && pos.row === 0) {
      cb = { col: 4, row: 1.5 };
    } else {
      cb = { col: pos.col > 4 ? 3.5 : 4.5, row: 2 };
    }
  } else if (state.wagonVariant === 'endRail') {
    // OB on short rail (end rail), 1 diamond from corner
    cb = state.wagonSide === 'left' ? { col: 1.5, row: 1.5 } : { col: 6.5, row: 1.5 };
  } else {
    // OB on long rail (side rail), 2 diamonds from corner
    cb = state.wagonSide === 'left' ? { col: 2.5, row: 2.5 } : { col: 5.5, row: 2.5 };
  }
  return { target, ob, cb };
}

// ── State ───────────────────────────────────────────

const state = {
  drillType: 'positions',     // 'positions' | 'mightyx' | 'wagon'
  selectedBall: 1,
  selectedPosition: null,    // coordKey string, e.g. "2,1"
  currentInput: '2',
  freshInput: true,           // true = first digit replaces default
  shotType: 'cut',
  direction: 'L',            // 'L' or 'R' — only matters for dual positions
  posMode: 'weighted',        // 'seq' | 'rand' | 'weighted'
  // Mighty X state
  mxSide: 'left',
  mxLevel: 1,
  mxShot: 'follow',
  mxMode: 'weighted',         // 'seq' | 'rand' | 'weighted'
  // Wagon Wheel state
  wagonSpoke: 0,             // index into active WW positions
  wagonMode: 'weighted',      // 'seq' | 'rand' | 'weighted'
  wagonVariant: 'center',    // 'center' | 'endRail' | 'sideRail'
  wagonSide: 'left',         // 'left' | 'right' (for endRail/sideRail)
};

// ── Persistence (Supabase + in-memory cache) ───────

const MASTERED_CYCLE_SKIP = 3;   // mastered shots skip this many cycles
const ROLLING_AVG_COUNT = 10;    // rolling average window size

const _cache = {
  sessions: [],          // All session objects {id, label, drill_type, created_at}
  entries: {},           // sessionId → { drillKey: {attempts, type, note} }
  config: { posLabels: {}, posSkipped: {} },
};

function activeSessionId() {
  return getActiveSessionId(activeDrillType());
}

function activeSession() {
  const sid = activeSessionId();
  return _cache.sessions.find(s => s.id === sid);
}

function activeEntries() {
  return _cache.entries[activeSessionId()] || {};
}

function sessionsForType(drillType) {
  return _cache.sessions
    .filter(s => s.drill_type === drillType)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Drill key helpers
function posDrillKey(ballNum, posKey, direction) {
  const effectiveKey = direction ? posKey + ':' + direction : posKey;
  return `pos-${ballNum}-${effectiveKey}`;
}

// Load all data into _cache on startup
let _appDataLoaded = false;
// All session drill_types including wagon variants
const ALL_SESSION_TYPES = ['positions', 'mightyx', 'wagon', 'wagon-el', 'wagon-er', 'wagon-sl', 'wagon-sr'];

async function loadAppData() {
  if (_appDataLoaded) return;
  _appDataLoaded = true;
  await dbInit();
  // Push any local-only data to Supabase before fetching
  await syncFromLocal();
  _cache.config = await dbGetConfig();
  _cache.sessions = await dbGetAllSessions();

  for (const dt of ALL_SESSION_TYPES) {
    let sid = getActiveSessionId(dt);
    const typed = _cache.sessions.filter(s => s.drill_type === dt);
    if (!sid || !typed.find(s => s.id === sid)) {
      if (typed.length > 0) {
        sid = typed[0].id;
      } else if (['positions', 'mightyx', 'wagon'].includes(dt)) {
        // Only auto-create sessions for base types; variants are created on demand
        const now = new Date();
        const row = await dbCreateSession(dt, now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
        _cache.sessions.push(row);
        sid = row.id;
      } else {
        continue; // Skip variant types with no sessions yet
      }
      setActiveSessionId(dt, sid);
    }
    // Load entries for ALL sessions of this type (needed for weighted mode history)
    for (const s of typed) {
      if (_cache.entries[s.id]) continue;
      const entries = await dbGetEntries(s.id);
      _cache.entries[s.id] = {};
      for (const e of entries) {
        _cache.entries[s.id][e.drill_key] = { attempts: e.attempts, type: e.shot_type || '', note: e.note || '' };
      }
    }
  }
}

// ── Config ──────────────────────────────────────────

function getPosLabel(ballNum, posKey) {
  const k = ballNum + ':' + posKey;
  return (_cache.config.posLabels && _cache.config.posLabels[k]) || '';
}

function setPosLabel(ballNum, posKey, label) {
  if (!_cache.config.posLabels) _cache.config.posLabels = {};
  const k = ballNum + ':' + posKey;
  if (label) _cache.config.posLabels[k] = label;
  else delete _cache.config.posLabels[k];
  dbSaveConfig(_cache.config);
}

function isPosSkipped(ballNum, posKey) {
  const k = ballNum + ':' + posKey;
  return !!(_cache.config.posSkipped && _cache.config.posSkipped[k]);
}

function setPosSkipped(ballNum, posKey, skipped) {
  if (!_cache.config.posSkipped) _cache.config.posSkipped = {};
  const k = ballNum + ':' + posKey;
  if (skipped) _cache.config.posSkipped[k] = true;
  else delete _cache.config.posSkipped[k];
  dbSaveConfig(_cache.config);
}

// ── Positions Data ──────────────────────────────────

function getEntry(ballNum, posKey, direction) {
  const key = posDrillKey(ballNum, posKey, direction);
  return activeEntries()[key] || null;
}

function saveEntry(ballNum, posKey, attempts, type, direction) {
  const key = posDrillKey(ballNum, posKey, direction);
  const sid = activeSessionId();
  if (!_cache.entries[sid]) _cache.entries[sid] = {};
  const prev = _cache.entries[sid][key];
  _cache.entries[sid][key] = { attempts, type, note: (prev && prev.note) || '' };
  dbSaveEntry(sid, key, attempts, type, (prev && prev.note) || '');
}

function saveNote(ballNum, posKey, note, direction) {
  const key = posDrillKey(ballNum, posKey, direction);
  const sid = activeSessionId();
  if (!_cache.entries[sid]) _cache.entries[sid] = {};
  const prev = _cache.entries[sid][key];
  if (!prev) {
    _cache.entries[sid][key] = { attempts: 0, type: 'cut', note };
  } else {
    _cache.entries[sid][key] = { ...prev, note };
  }
  dbSaveEntry(sid, key, prev ? prev.attempts : 0, prev ? prev.type : 'cut', note);
}

function getBallTotal(ballNum) {
  const entries = activeEntries();
  const prefix = `pos-${ballNum}-`;
  let total = 0;
  for (const [k, e] of Object.entries(entries)) {
    if (k.startsWith(prefix) && e.attempts) total += e.attempts;
  }
  return total;
}

function getBallFilledCount(ballNum) {
  const entries = activeEntries();
  const prefix = `pos-${ballNum}-`;
  let count = 0;
  for (const k of Object.keys(entries)) {
    if (k.startsWith(prefix) && entries[k].attempts >= 2) count++;
  }
  return count;
}

function getSessionTotal() {
  const entries = activeEntries();
  let total = 0;
  for (const e of Object.values(entries)) {
    if (e.attempts) total += e.attempts;
  }
  return total;
}

function getSessionFilledCount() {
  const entries = activeEntries();
  let count = 0;
  for (const e of Object.values(entries)) {
    if (e.attempts >= 2) count++;
  }
  return count;
}

function getTotalPositionCount() {
  let count = 0;
  for (let b = 1; b <= 12; b++) {
    const positions = getCuePositions(b);
    for (const p of positions) {
      count += isDualPosition(b, coordKey(p)) ? 2 : 1;
    }
  }
  return count;
}

// ── Cycle Progress ──────────────────────────────────

function isBallComplete(ballNum) {
  const positions = getCuePositions(ballNum);
  return positions.every(p => isPositionComplete(ballNum, coordKey(p)));
}

function isCycleComplete() {
  for (let b = 1; b <= 12; b++) {
    if (!isBallComplete(b)) return false;
  }
  return true;
}

function getCycleProgress() {
  let done = 0;
  for (let b = 1; b <= 12; b++) {
    if (isBallComplete(b)) done++;
  }
  return { done, total: 12 };
}

// ── Mighty X Data Functions ─────────────────────────

function getMxEntry(key) {
  return activeEntries()[key] || null;
}

function saveMxEntry(key, attempts) {
  const sid = activeSessionId();
  if (!_cache.entries[sid]) _cache.entries[sid] = {};
  const prev = _cache.entries[sid][key];
  _cache.entries[sid][key] = { attempts, type: '', note: (prev && prev.note) || '' };
  dbSaveEntry(sid, key, attempts, '', (prev && prev.note) || '');
}

function saveMxNote(key, note) {
  const sid = activeSessionId();
  if (!_cache.entries[sid]) _cache.entries[sid] = {};
  const prev = _cache.entries[sid][key];
  if (!prev) _cache.entries[sid][key] = { attempts: 0, type: '', note };
  else _cache.entries[sid][key] = { ...prev, note };
  dbSaveEntry(sid, key, prev ? prev.attempts : 0, '', note);
}

function isMxEntryComplete(key) {
  const entry = getMxEntry(key);
  return entry && entry.attempts >= 2;
}

function isMxCycleComplete() {
  for (const side of MX_SIDES)
    for (const level of MX_LEVELS)
      for (const shot of MX_SHOTS)
        if (!isMxEntryComplete(mxKey(side, level, shot))) return false;
  return true;
}

function getMxCycleProgress() {
  let done = 0;
  for (const side of MX_SIDES)
    for (const level of MX_LEVELS)
      for (const shot of MX_SHOTS)
        if (isMxEntryComplete(mxKey(side, level, shot))) done++;
  return { done, total: MX_TOTAL };
}

function getMxSessionTotal() {
  const entries = activeEntries();
  let total = 0;
  for (const [key, e] of Object.entries(entries)) {
    if (key.match(/^(left|right)-\d+-/) && e.attempts) total += e.attempts;
  }
  return total;
}

function mxCurrentKey() {
  return mxKey(state.mxSide, state.mxLevel, state.mxShot);
}

function mxResumeProgression() {
  for (const side of MX_SIDES) {
    for (const level of MX_LEVELS) {
      for (const shot of MX_SHOTS) {
        if (!isMxEntryComplete(mxKey(side, level, shot))) {
          state.mxSide = side;
          state.mxLevel = level;
          state.mxShot = shot;
          return;
        }
      }
    }
  }
}

// ── Wagon Wheel Data Functions ──────────────────────

function getWagonEntry(idx) {
  const pos = getActiveWWPositions()[idx];
  return activeEntries()[activeWWKey(pos)] || null;
}

function saveWagonEntry(idx, attempts) {
  const pos = getActiveWWPositions()[idx];
  const key = activeWWKey(pos);
  const sid = activeSessionId();
  if (!_cache.entries[sid]) _cache.entries[sid] = {};
  const prev = _cache.entries[sid][key];
  _cache.entries[sid][key] = { attempts, type: '', note: (prev && prev.note) || '' };
  dbSaveEntry(sid, key, attempts, '', (prev && prev.note) || '');
}

function isWagonSpokeComplete(idx) {
  const entry = getWagonEntry(idx);
  return entry && entry.attempts >= 2;
}

function isWagonCycleComplete() {
  const total = getActiveWWTotal();
  for (let i = 0; i < total; i++) {
    if (!isWagonSpokeComplete(i)) return false;
  }
  return true;
}

function getWagonCycleProgress() {
  const total = getActiveWWTotal();
  let done = 0;
  for (let i = 0; i < total; i++) {
    if (isWagonSpokeComplete(i)) done++;
  }
  return { done, total };
}

function getWagonSessionTotal() {
  const entries = activeEntries();
  const positions = getActiveWWPositions();
  let total = 0;
  for (let i = 0; i < positions.length; i++) {
    const entry = entries[activeWWKey(positions[i])];
    if (entry && entry.attempts) total += entry.attempts;
  }
  return total;
}

function wagonResumeProgression() {
  const total = getActiveWWTotal();
  for (let i = 0; i < total; i++) {
    if (!isWagonSpokeComplete(i)) {
      state.wagonSpoke = i;
      return;
    }
  }
}

// ── Weighted Random Helpers ─────────────────────────

/** Get rolling average for a drill key across all cached sessions. */
function getLocalRollingAvg(drillKey, n) {
  const allSessions = sessionsForType(activeDrillType());
  const results = [];
  for (const s of allSessions) {
    if (results.length >= n) break;
    const entries = _cache.entries[s.id];
    if (!entries) continue;
    const e = entries[drillKey];
    if (e && e.attempts >= 2) results.push(e.attempts);
  }
  if (results.length === 0) return null;
  return results.reduce((a, b) => a + b, 0) / results.length;
}

/** Check if a drill key is mastered (last attempt === 2, within last N cycles). */
function isMastered(drillKey) {
  const allSessions = sessionsForType(activeDrillType());
  // Find the most recent session that has this key
  for (let i = 0; i < allSessions.length; i++) {
    const entries = _cache.entries[allSessions[i].id];
    if (!entries) continue;
    const e = entries[drillKey];
    if (e && e.attempts >= 2) {
      // Found the most recent attempt
      if (e.attempts === 2 && i < MASTERED_CYCLE_SKIP) return true;
      return false;
    }
  }
  return false;
}

/** Compute weight for a drill key. */
function getDrillWeight(drillKey) {
  const avg = getLocalRollingAvg(drillKey, ROLLING_AVG_COUNT);
  if (avg === null) return 100; // never attempted
  if (isMastered(drillKey)) return 0; // mastered, skip
  return avg; // rolling average as weight
}

/** Weighted random selection from array of {item, weight}. */
function weightedPick(items) {
  const eligible = items.filter(i => i.weight > 0);
  if (eligible.length === 0) return null;
  const totalWeight = eligible.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * totalWeight;
  for (const i of eligible) {
    r -= i.weight;
    if (r <= 0) return i.item;
  }
  return eligible[eligible.length - 1].item;
}

function wagonPickRandom() {
  const total = getActiveWWTotal();
  const incomplete = [];
  for (let i = 0; i < total; i++) {
    if (!isWagonSpokeComplete(i)) incomplete.push(i);
  }
  if (incomplete.length === 0) return;
  state.wagonSpoke = incomplete[Math.floor(Math.random() * incomplete.length)];
}

function wagonPickWeighted() {
  const positions = getActiveWWPositions();
  const items = [];
  for (let i = 0; i < positions.length; i++) {
    if (isWagonSpokeComplete(i)) continue;
    const key = activeWWKey(positions[i]);
    items.push({ item: i, weight: getDrillWeight(key) });
  }
  const pick = weightedPick(items);
  if (pick !== null) state.wagonSpoke = pick;
  else wagonPickRandom();
}

// ── MX Random Mode ──────────────────────────────────

function mxPickRandom() {
  const incomplete = [];
  for (const side of MX_SIDES) {
    for (const level of MX_LEVELS) {
      for (const shot of MX_SHOTS) {
        if (!isMxEntryComplete(mxKey(side, level, shot))) incomplete.push({ side, level, shot });
      }
    }
  }
  if (incomplete.length === 0) return;
  const pick = incomplete[Math.floor(Math.random() * incomplete.length)];
  state.mxSide = pick.side;
  state.mxLevel = pick.level;
  state.mxShot = pick.shot;
}

function mxPickWeighted() {
  const items = [];
  for (const side of MX_SIDES) {
    for (const level of MX_LEVELS) {
      for (const shot of MX_SHOTS) {
        const key = mxKey(side, level, shot);
        if (isMxEntryComplete(key)) continue;
        items.push({ item: { side, level, shot }, weight: getDrillWeight(key) });
      }
    }
  }
  const pick = weightedPick(items);
  if (pick) { state.mxSide = pick.side; state.mxLevel = pick.level; state.mxShot = pick.shot; }
  else mxPickRandom();
}

// ── Positions Random Mode ───────────────────────────

function posPickRandom() {
  const incomplete = [];
  for (let b = 1; b <= 12; b++) {
    const positions = getCuePositions(b);
    for (const p of positions) {
      const key = coordKey(p);
      if (!isPositionComplete(b, key)) {
        incomplete.push({ ball: b, key });
      }
    }
  }
  if (incomplete.length === 0) return;
  const pick = incomplete[Math.floor(Math.random() * incomplete.length)];
  state.selectedBall = pick.ball;
  state.selectedPosition = pick.key;
  if (isDualPosition(pick.ball, pick.key)) {
    state.direction = !getEntry(pick.ball, pick.key, 'L') ? 'L' : 'R';
  }
}

function posPickWeighted() {
  const items = [];
  for (let b = 1; b <= 12; b++) {
    const positions = getCuePositions(b);
    for (const p of positions) {
      const key = coordKey(p);
      if (isPositionComplete(b, key)) continue;
      // For dual positions, weight by both sides combined
      const isDual = isDualPosition(b, key);
      if (isDual) {
        const keyL = posDrillKey(b, key, 'L');
        const keyR = posDrillKey(b, key, 'R');
        const wL = getEntry(b, key, 'L') ? 0 : getDrillWeight(keyL);
        const wR = getEntry(b, key, 'R') ? 0 : getDrillWeight(keyR);
        const w = Math.max(wL, wR);
        if (w > 0) items.push({ item: { ball: b, key }, weight: w });
      } else {
        const dk = posDrillKey(b, key, null);
        const w = getDrillWeight(dk);
        if (w > 0) items.push({ item: { ball: b, key }, weight: w });
      }
    }
  }
  const pick = weightedPick(items);
  if (pick) {
    state.selectedBall = pick.ball;
    state.selectedPosition = pick.key;
    if (isDualPosition(pick.ball, pick.key)) {
      state.direction = !getEntry(pick.ball, pick.key, 'L') ? 'L' : 'R';
    }
  } else {
    posPickRandom();
  }
}

// ── SVG Table Diagram ───────────────────────────────

function renderTableDiagram() {
  const container = document.getElementById('table-diagram');

  // 5×9 grid (pockets count as diamond positions)
  // Cols 0-8 along the long axis, Rows 0-4 across the short axis
  // Pockets at: (0,0),(0,4),(4,0),(4,4),(8,0),(8,4)
  // Drill coords (col 1-7, row 1-3) map to grid (1-7, 1-3)
  const margin = 14;
  const railW = 10;
  const pocketR = 8;
  const dSpaceX = 46;  // horizontal spacing between diamond positions
  const dSpaceY = 46;  // vertical spacing between diamond positions
  const gridCols = 8;   // 0-8 = 9 positions, 8 intervals
  const gridRows = 4;   // 0-4 = 5 positions, 4 intervals

  const innerW = gridCols * dSpaceX;
  const innerH = gridRows * dSpaceY;
  const totalW = innerW + 2 * railW + 2 * margin;
  const totalH = innerH + 2 * railW + 2 * margin;

  const ox = margin + railW;  // origin X for grid col 0
  const oy = margin + railW + innerH; // origin Y — row 0 at bottom

  function dx(col) { return ox + col * dSpaceX; }
  function dy(row) { return oy - row * dSpaceY; }

  let svg = `<svg class="table-svg" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">`;

  // Table felt (wood border with subtle gradient)
  svg += `<defs><linearGradient id="rail-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5d4037"/><stop offset="100%" stop-color="#4a3228"/></linearGradient></defs>`;
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="10" fill="url(#rail-grad)"/>`;

  // Playing surface
  svg += `<rect x="${ox}" y="${margin + railW}" width="${innerW}" height="${innerH}" rx="2" fill="#2a7a35"/>`;

  // Rails (border)
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="10" fill="none" stroke="#3e2723" stroke-width="2"/>`;

  // Pockets (dark circles with subtle inset)
  const pockets = [[0,0],[0,4],[4,0],[4,4],[8,0],[8,4]];
  for (const [c, r] of pockets) {
    svg += `<circle cx="${dx(c)}" cy="${dy(r)}" r="${pocketR}" fill="#0a0a0a"/>`;
    svg += `<circle cx="${dx(c)}" cy="${dy(r)}" r="${pocketR - 2}" fill="none" stroke="#1a1a1a" stroke-width="1"/>`;
  }

  // Highlight the target pocket for the selected ball (position-specific if selected)
  const targetPocketId = getPocketTarget(state.selectedBall, state.selectedPosition, state.direction || null);
  const targetPocket = POCKET_COORDS[targetPocketId];
  if (targetPocket) {
    const bp = BALL_POSITIONS[state.selectedBall];
    // Dashed aim line from OB to target pocket
    svg += `<line x1="${dx(bp.col)}" y1="${dy(bp.row)}" x2="${dx(targetPocket.col)}" y2="${dy(targetPocket.row)}" stroke="rgba(110,231,160,0.25)" stroke-width="1" stroke-dasharray="3,3"/>`;
    svg += `<circle cx="${dx(targetPocket.col)}" cy="${dy(targetPocket.row)}" r="${pocketR + 4}" fill="none" stroke="#6ee7a0" stroke-width="2" stroke-opacity="0.7"/>`;
    svg += `<text x="${dx(targetPocket.col)}" y="${dy(targetPocket.row) - pocketR - 4}" text-anchor="middle" font-size="7" font-weight="600" font-family="Inter,system-ui,sans-serif" fill="rgba(110,231,160,0.7)" style="pointer-events:none">${targetPocketId}</text>`;
  }

  // Drill zone boundary (between drill col 6 and col 7, i.e. grid col 6.5)
  const zoneX = dx(6) + dSpaceX / 2;
  svg += `<line x1="${zoneX}" y1="${margin + railW + 2}" x2="${zoneX}" y2="${margin + railW + innerH - 2}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4,4"/>`;

  // Diamond markers on rails (skip pocket positions)
  const pocketSet = new Set(pockets.map(([c, r]) => c + ',' + r));
  for (let c = 0; c <= 8; c++) {
    if (!pocketSet.has(c + ',4')) {
      svg += `<circle cx="${dx(c)}" cy="${margin + 4}" r="2" fill="#8d6e63"/>`;
    }
    if (!pocketSet.has(c + ',0')) {
      svg += `<circle cx="${dx(c)}" cy="${margin + 2 * railW + innerH - 4}" r="2" fill="#8d6e63"/>`;
    }
  }
  for (let r = 0; r <= 4; r++) {
    if (!pocketSet.has('0,' + r)) {
      svg += `<circle cx="${margin + 4}" cy="${dy(r)}" r="2" fill="#8d6e63"/>`;
    }
    if (!pocketSet.has('8,' + r)) {
      svg += `<circle cx="${margin + 2 * railW + innerW - 4}" cy="${dy(r)}" r="2" fill="#8d6e63"/>`;
    }
  }

  // Dimmed grid dots in column 7 area (outside drill zone)
  for (let r = 1; r <= 3; r++) {
    svg += `<circle cx="${dx(7)}" cy="${dy(r)}" r="3" fill="#ffffff15"/>`;
  }

  // Cue positions (perimeter spots)
  const cuePositions = getCuePositions(state.selectedBall);
  const cueKeys = new Set(cuePositions.map(coordKey));
  const selectedPosCoord = state.selectedPosition;

  for (const pos of PERIMETER_PATH) {
    const key = coordKey(pos);
    const x = dx(pos.col);
    const y = dy(pos.row);
    const isSelected = key === selectedPosCoord;
    const inDrill = cueKeys.has(key);

    if (!inDrill) continue;

    // Determine marker state for dual and non-dual positions
    const isDual = isDualPosition(state.selectedBall, key);
    let hasData, isBank, bothFilled, displayAttempts;
    if (isDual) {
      const entryL = getEntry(state.selectedBall, key, 'L');
      const entryR = getEntry(state.selectedBall, key, 'R');
      hasData = !!entryL || !!entryR;
      bothFilled = !!entryL && !!entryR;
      isBank = (entryL && entryL.type === 'bank') || (entryR && entryR.type === 'bank');
      displayAttempts = (entryL ? entryL.attempts : 0) + (entryR ? entryR.attempts : 0);
    } else {
      const entry = getEntry(state.selectedBall, key);
      hasData = !!entry;
      bothFilled = hasData;
      isBank = hasData && entry.type === 'bank';
      displayAttempts = hasData ? entry.attempts : 0;
    }

    // Cue position marker — bank shots get orange, cuts get green
    let markerFill;
    if (isSelected) markerFill = '#ffffffdd';
    else if (hasData && !bothFilled) markerFill = isDual ? 'rgba(255,255,255,0.5)' : (isBank ? '#e8a23a' : '#6ee7a0');
    else if (hasData && isBank) markerFill = '#e8a23a';
    else if (hasData) markerFill = '#6ee7a0';
    else markerFill = 'rgba(255,255,255,0.25)';

    svg += `<circle cx="${x}" cy="${y}" r="${isSelected ? 13 : 10}" fill="${markerFill}" stroke="${isSelected ? '#fff' : 'none'}" stroke-width="${isSelected ? 2 : 0}" data-cue="${key}" class="cue-marker" style="cursor:pointer"/>`;

    // Note indicator removed

    if (hasData && !isSelected) {
      svg += `<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="9" font-weight="700" font-family="Inter,system-ui,sans-serif" fill="#0f0f1a" data-cue="${key}" style="cursor:pointer;pointer-events:none">${displayAttempts}</text>`;
    }
    if (isSelected) {
      svg += `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="10" font-weight="700" font-family="Inter,system-ui,sans-serif" fill="#0f0f1a" style="pointer-events:none">▶</text>`;
    }
    // Dual indicator dot
    if (isDual && !isSelected) {
      svg += `<circle cx="${x}" cy="${y + 12}" r="2" fill="rgba(255,255,255,0.4)"/>`;
      svg += `<circle cx="${x + 5}" cy="${y + 12}" r="2" fill="rgba(255,255,255,0.4)"/>`;
    }
    // Position label
    const posLabel = getPosLabel(state.selectedBall, key);
    if (posLabel && !isSelected) {
      svg += `<text x="${x}" y="${y + (isDual ? 19 : 15)}" text-anchor="middle" font-size="5.5" font-weight="500" font-family="Inter,system-ui,sans-serif" fill="rgba(255,255,255,0.35)" style="pointer-events:none">${posLabel.length > 8 ? posLabel.slice(0, 8) + '…' : posLabel}</text>`;
    }
  }

  // Selected object ball only
  {
    const b = state.selectedBall;
    const p = BALL_POSITIONS[b];
    const x = dx(p.col);
    const y = dy(p.row);
    const c = BALL_COLORS[b];
    const r = 14;

    svg += `<circle cx="${x}" cy="${y}" r="${r + 5}" fill="none" stroke="rgba(110,231,160,0.4)" stroke-width="2.5"/>`;

    if (c.stripe) {
      svg += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c.fill}"/>`;
      svg += `<rect x="${x - r}" y="${y - 3}" width="${r * 2}" height="6" fill="#fff" clip-path="circle(${r}px at ${x}px ${y}px)"/>`;
      svg += `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#fff" stroke-width="2.5"/>`;
    } else {
      svg += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c.fill}" stroke="#fff" stroke-width="2.5"/>`;
    }

    svg += `<text x="${x}" y="${y + 4.5}" text-anchor="middle" font-size="13" font-weight="700" font-family="Inter,system-ui,sans-serif" fill="${c.text}" style="pointer-events:none">${b}</text>`;
  }

  svg += `</svg>`;
  container.innerHTML = svg;

  // Attach click + long-press handlers for cue position markers
  let longPressTimer = null;
  let longPressed = false;
  container.querySelectorAll('.cue-marker').forEach((el) => {
    const handler = (startEvt) => {
      const key = el.getAttribute('data-cue');
      if (!key) return;
      longPressed = false;
      longPressTimer = setTimeout(() => {
        longPressed = true;
        showPosPopover(state.selectedBall, key);
      }, 500);
      const endHandler = (e) => {
        clearTimeout(longPressTimer);
        el.removeEventListener('pointerup', endHandler);
        el.removeEventListener('pointercancel', endHandler);
        if (!longPressed) selectPosition(key);
      };
      el.addEventListener('pointerup', endHandler);
      el.addEventListener('pointercancel', endHandler);
    };
    el.addEventListener('pointerdown', handler);
  });
}

// ── UI Rendering ────────────────────────────────────

function angleName(deg) {
  if (deg >= 90) return 'Backcut';
  if (deg >= 70) return 'Thin';
  if (deg >= 50) return '¼ Ball';
  if (deg >= 30) return '½ Ball';
  if (deg >= 15) return '¾ Ball';
  return 'Full';
}

function renderShotInfo() {
  const el = document.getElementById('shot-info');
  if (!el) return;
  const b = state.selectedBall;
  const pk = state.selectedPosition;
  if (!pk) { el.textContent = ''; return; }
  const type = getShotType(b, pk);
  if (type === 'bank') {
    el.innerHTML = '<span class="shot-info-bank">Bank Shot</span>';
    return;
  }
  const isDual = isDualPosition(b, pk);
  const fullKey = isDual && state.direction ? pk + ':' + state.direction : pk;
  const angle = getCutAngle(b, fullKey);
  const dir = getCutDirection(b, fullKey);
  if (angle === null) { el.textContent = ''; return; }
  const dirLabel = dir === 'left' ? 'Left' : dir === 'right' ? 'Right' : 'Straight';
  const name = angleName(angle);
  el.innerHTML = `<span class="shot-info-dir">${dirLabel}</span> <span class="shot-info-name">${name}</span> <span class="shot-info-deg">${Math.round(angle)}°</span>`;
}

function renderBallSelector() {
  const row = document.getElementById('ball-row');
  row.innerHTML = '';
  for (let b = 1; b <= 12; b++) {
    const btn = document.createElement('button');
    const complete = isBallComplete(b);
    let cls = `ball-pill ball-${b}`;
    if (b === state.selectedBall) cls += ' selected';
    if (complete) cls += ' completed';
    btn.className = cls;
    btn.innerHTML = complete ? '&#10003;' : String(b);
    btn.setAttribute('aria-label', `Ball ${b}${complete ? ' (complete)' : ''}`);
    btn.addEventListener('click', () => selectBall(b));
    row.appendChild(btn);
  }
}

function ensureValidPosition() {
  const positions = getCuePositions(state.selectedBall);
  if (!state.selectedPosition || !positions.some((p) => coordKey(p) === state.selectedPosition)) {
    state.selectedPosition = coordKey(positions[0]);
  }
}

function renderDisplay() {
  const numEl = document.getElementById('attempt-number');
  const hint = document.getElementById('saved-hint');
  const display = document.getElementById('attempt-display');
  numEl.textContent = state.currentInput;

  // Bank mode border on display
  display.classList.toggle('bank-mode', state.shotType === 'bank');

  const isDual = isDualPosition(state.selectedBall, state.selectedPosition);
  const entry = isDual
    ? getEntry(state.selectedBall, state.selectedPosition, state.direction)
    : getEntry(state.selectedBall, state.selectedPosition);

  if (entry && entry.attempts) {
    hint.textContent = '';
    hint.className = 'saved-hint';
  } else {
    hint.textContent = isDual ? `${state.direction}: —` : '';
    hint.className = 'saved-hint';
  }

  // Note input removed
}

function applyShotType() {
  state.shotType = getShotType(state.selectedBall, state.selectedPosition);
  const display = document.getElementById('attempt-display');
  display.classList.toggle('bank-mode', state.shotType === 'bank');
  const badge = document.getElementById('shot-type-badge');
  if (badge) {
    badge.textContent = state.shotType;
    badge.classList.toggle('bank-badge', state.shotType === 'bank');
  }
}

function renderDirToggle() {
  const toggle = document.getElementById('dir-toggle');
  const isDual = isDualPosition(state.selectedBall, state.selectedPosition);
  toggle.style.display = isDual ? 'flex' : 'none';
  if (!isDual) return;
  const btnL = document.getElementById('btn-dir-l');
  const btnR = document.getElementById('btn-dir-r');
  btnL.classList.toggle('dir-active', state.direction === 'L');
  btnR.classList.toggle('dir-active', state.direction === 'R');
}

function renderTotals() {
  const positions = getCuePositions(state.selectedBall);
  let posCount = 0;
  for (const p of positions) {
    posCount += isDualPosition(state.selectedBall, coordKey(p)) ? 2 : 1;
  }
  const ballFilled = getBallFilledCount(state.selectedBall);
  const ballTotal = getBallTotal(state.selectedBall);
  const sessionFilled = getSessionFilledCount();
  const sessionTotal = getSessionTotal();

  // Legacy totals (hidden)
  const el = (id) => document.getElementById(id);
  if (el('ball-total-label')) el('ball-total-label').textContent = `Ball ${state.selectedBall}`;
  if (el('ball-total-value')) el('ball-total-value').textContent = ballTotal;
  if (el('ball-total-sub'))   el('ball-total-sub').textContent = `${ballFilled}/${posCount} positions`;
  if (el('session-total-value')) el('session-total-value').textContent = sessionTotal;
  if (el('session-total-sub'))   el('session-total-sub').textContent = `${sessionFilled}/${getTotalPositionCount()} total`;

  // Inline totals
  if (el('ball-total-label2')) el('ball-total-label2').textContent = `Ball ${state.selectedBall}`;
  if (el('ball-total-value2')) el('ball-total-value2').textContent = ballTotal;
  if (el('ball-total-sub2'))   el('ball-total-sub2').textContent = `${ballFilled}/${posCount}`;
  if (el('session-total-value2')) el('session-total-value2').textContent = sessionTotal;
  if (el('session-total-sub2'))   el('session-total-sub2').textContent = `${sessionFilled}/${getTotalPositionCount()}`;
}

function renderSessionSelector() {
  const select = document.getElementById('session-select');
  select.innerHTML = '';
  const sorted = sessionsForType(activeDrillType());
  const sid = activeSessionId();
  for (const s of sorted) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === sid) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderDrillTypeTabs() {
  const container = document.getElementById('drill-type-tabs');
  if (!container) return;
  container.innerHTML = '';
  for (const [key, info] of Object.entries(DRILL_TYPES)) {
    const btn = document.createElement('button');
    btn.className = 'drill-type-tab' + (key === state.drillType ? ' active' : '');
    btn.dataset.type = key;
    btn.innerHTML = `${info.icon} ${info.label}`;
    btn.addEventListener('click', () => switchDrillType(key));
    container.appendChild(btn);
  }
}

function switchDrillType(type) {
  if (type === state.drillType) return;
  state.drillType = type;
  state.currentInput = '2';
  state.freshInput = true;
  if (type === 'positions') {
    state.selectedBall = 1;
    state.selectedPosition = null;
    resumeProgression();
  } else if (type === 'mightyx') {
    mxResumeProgression();
  } else if (type === 'wagon') {
    ensureWagonSession().then(() => {
      wagonResumeProgression();
      renderAll();
    });
    return;
  }
  renderAll();
}

// Ensure a session exists for the current wagon variant
async function ensureWagonSession() {
  const dt = activeDrillType();
  let sid = getActiveSessionId(dt);
  const typed = _cache.sessions.filter(s => s.drill_type === dt);
  if (!sid || !typed.find(s => s.id === sid)) {
    if (typed.length > 0) {
      sid = typed[0].id;
    } else {
      const now = new Date();
      const row = await dbCreateSession(dt, now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
      _cache.sessions.push(row);
      _cache.entries[row.id] = {};
      sid = row.id;
    }
    setActiveSessionId(dt, sid);
  }
  // Load entries for all sessions of this variant type
  for (const s of typed) {
    if (_cache.entries[s.id]) continue;
    const entries = await dbGetEntries(s.id);
    _cache.entries[s.id] = {};
    for (const e of entries) {
      _cache.entries[s.id][e.drill_key] = { attempts: e.attempts, type: e.shot_type || '', note: e.note || '' };
    }
  }
}

async function switchWagonVariant(variant, side) {
  state.wagonVariant = variant;
  if (side) state.wagonSide = side;
  state.wagonSpoke = 0;
  state.currentInput = '2';
  state.freshInput = true;
  await ensureWagonSession();
  wagonResumeProgression();
  renderAll();
}

function updateDrillVisibility() {
  const isPositions = state.drillType === 'positions';
  const positionsContent = document.getElementById('positions-content');
  const otherContent = document.getElementById('other-drill-content');
  if (positionsContent) positionsContent.style.display = isPositions ? '' : 'none';
  if (otherContent) otherContent.style.display = isPositions ? 'none' : '';
  const cycleBar = document.getElementById('cycle-bar');
  if (cycleBar) cycleBar.style.display = isPositions ? '' : 'none';
}

function renderCycleProgress() {
  const dotsEl = document.getElementById('cycle-dots');
  const countEl = document.getElementById('cycle-count');
  if (!dotsEl || !countEl) return;
  const { done } = getCycleProgress();
  dotsEl.innerHTML = '';
  for (let b = 1; b <= 12; b++) {
    const dot = document.createElement('span');
    dot.className = 'cycle-dot' + (isBallComplete(b) ? ' done' : '');
    dot.textContent = b;
    dotsEl.appendChild(dot);
  }
  countEl.textContent = `${done} / 12`;
}

function showCycleComplete() {
  const modal = document.getElementById('cycle-modal');
  const backdrop = document.getElementById('cycle-modal-backdrop');
  if (!modal || !backdrop) return;
  const statsEl = document.getElementById('cycle-modal-stats');
  const total = getSessionTotal();
  const filled = getSessionFilledCount();
  if (statsEl) statsEl.textContent = `${filled} positions \u00B7 ${total} total attempts`;
  modal.style.display = 'flex';
  backdrop.style.display = 'block';
}

function hideCycleModal() {
  const modal = document.getElementById('cycle-modal');
  const backdrop = document.getElementById('cycle-modal-backdrop');
  if (modal) modal.style.display = 'none';
  if (backdrop) backdrop.style.display = 'none';
}

async function startNewCycle() {
  hideCycleModal();
  const now = new Date();
  const dt = activeDrillType();
  const row = await dbCreateSession(dt, now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  _cache.sessions.push(row);
  _cache.entries[row.id] = {};
  setActiveSessionId(dt, row.id);
  state.currentInput = '2';
  state.freshInput = true;
  if (state.drillType === 'positions') {
    state.selectedBall = 1;
    state.selectedPosition = null;
    state.shotType = 'cut';
    resumeProgression();
  } else if (state.drillType === 'mightyx') {
    state.mxSide = 'left'; state.mxLevel = 1; state.mxShot = 'follow';
  } else if (state.drillType === 'wagon') {
    state.wagonSpoke = 0;
  }
  renderAll();
  showToast('New cycle started');
}

function renderAll() {
  renderDrillTypeTabs();
  renderSessionSelector();
  updateDrillVisibility();

  if (state.drillType === 'positions') {
    ensureValidPosition();
    applyShotType();
    renderBallSelector();
    renderDisplay();
    renderDirToggle();
    renderTotals();
    renderCycleProgress();
    renderTableDiagram();
    renderShotInfo();
  } else if (state.drillType === 'mightyx') {
    renderMightyX();
  } else if (state.drillType === 'wagon') {
    renderWagonWheel();
  }
}

// ── Actions ─────────────────────────────────────────

function selectBall(b) {
  state.selectedBall = b;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  ensureValidPosition();
  renderAll();
}

function selectPosition(key) {
  state.selectedPosition = key;
  state.currentInput = '2';
  state.freshInput = true;
  state.shotType = getShotType(state.selectedBall, key);
  // Set direction for dual positions
  if (isDualPosition(state.selectedBall, key)) {
    // Default to L, or R if L is already filled
    state.direction = getEntry(state.selectedBall, key, 'L') && !getEntry(state.selectedBall, key, 'R') ? 'R' : 'L';
  } else {
    state.direction = 'L';
  }
  applyShotType();
  renderDisplay();
  renderDirToggle();
  renderTableDiagram();
  renderShotInfo();
}

function pressDigit(d) {
  if (state.freshInput) {
    state.currentInput = String(d);
    state.freshInput = false;
  } else if (state.currentInput.length < 3) {
    state.currentInput += String(d);
  }
  renderDisplay();
}

function pressBackspace() {
  if (state.currentInput.length <= 1) {
    state.currentInput = '2';
    state.freshInput = true;
  } else {
    state.currentInput = state.currentInput.slice(0, -1);
  }
  renderDisplay();
}

function pressSave() {
  const attempts = parseInt(state.currentInput, 10);
  if (isNaN(attempts) || attempts < 2) {
    showToast('Minimum 2 attempts');
    return;
  }

  const isDual = isDualPosition(state.selectedBall, state.selectedPosition);
  const dir = isDual ? state.direction : null;
  const existing = getEntry(state.selectedBall, state.selectedPosition, dir);
  saveEntry(state.selectedBall, state.selectedPosition, attempts, state.shotType, dir);

  // Flash
  const display = document.getElementById('attempt-display');
  display.classList.add('flash');
  setTimeout(() => display.classList.remove('flash'), 400);

  // For dual positions, switch to other direction if unfilled
  if (isDual) {
    const otherDir = state.direction === 'L' ? 'R' : 'L';
    if (!getEntry(state.selectedBall, state.selectedPosition, otherDir)) {
      state.direction = otherDir;
      state.currentInput = '2';
      state.freshInput = true;
      renderAll();
      return;
    }
  }

  // Auto-advance based on mode
  if (state.posMode === 'weighted') {
    posPickWeighted();
  } else if (state.posMode === 'rand') {
    posPickRandom();
  } else {
    // Auto-advance to next unfilled position (from start of sequence)
    const positions = getCuePositions(state.selectedBall);
    let advanced = false;
    for (let i = 0; i < positions.length; i++) {
      const nextKey = coordKey(positions[i]);
      if (!isPositionComplete(state.selectedBall, nextKey)) {
        state.selectedPosition = nextKey;
        if (isDualPosition(state.selectedBall, nextKey)) {
          state.direction = !getEntry(state.selectedBall, nextKey, 'L') ? 'L' : 'R';
        }
        advanced = true;
        break;
      }
    }

    // All positions filled for this ball — advance to next ball
    if (!advanced) {
      for (let i = 1; i <= 12; i++) {
        const nextBall = ((state.selectedBall - 1 + i) % 12) + 1;
        const nextPositions = getCuePositions(nextBall);
        const unfilled = nextPositions.find((p) => !isPositionComplete(nextBall, coordKey(p)));
        if (unfilled) {
          state.selectedBall = nextBall;
          state.selectedPosition = coordKey(unfilled);
          if (isDualPosition(nextBall, coordKey(unfilled))) {
            state.direction = !getEntry(nextBall, coordKey(unfilled), 'L') ? 'L' : 'R';
          }
          break;
        }
      }
    }
  }

  state.currentInput = '2';
  state.freshInput = true;
  renderAll();

  // Check if entire cycle is now complete
  if (isCycleComplete()) {
    showCycleComplete();
  }
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1500);
}

function showPosPopover(ballNum, posKey) {
  const popover = document.getElementById('pos-popover');
  const backdrop = document.getElementById('pos-popover-backdrop');
  const title = document.getElementById('pos-popover-title');
  const labelInput = document.getElementById('pos-label-input');
  const skipCheck = document.getElementById('pos-skip-check');

  title.textContent = `Ball ${ballNum} — Position ${posKey}`;
  labelInput.value = getPosLabel(ballNum, posKey);
  skipCheck.checked = isPosSkipped(ballNum, posKey);

  popover.style.display = 'flex';
  backdrop.style.display = 'block';

  const close = () => {
    setPosLabel(ballNum, posKey, labelInput.value.trim());
    const wasSkipped = isPosSkipped(ballNum, posKey);
    setPosSkipped(ballNum, posKey, skipCheck.checked);
    popover.style.display = 'none';
    backdrop.style.display = 'none';
    if (wasSkipped !== skipCheck.checked) {
      ensureValidPosition();
    }
    renderAll();
  };

  document.getElementById('pos-popover-close').onclick = close;
  backdrop.onclick = close;
}

// ── Session Management ──────────────────────────────

async function newSession() {
  if (state.drillType === 'positions' && !isCycleComplete()) {
    const { done } = getCycleProgress();
    if (!confirm(`Current cycle has ${done}/12 drills complete. Start a new cycle anyway? (Current progress will be kept in history.)`)) return;
  } else if (state.drillType === 'mightyx' && !isMxCycleComplete()) {
    const { done } = getMxCycleProgress();
    if (!confirm(`Current cycle has ${done}/${MX_TOTAL} entries complete. Start a new cycle anyway?`)) return;
  } else if (state.drillType === 'wagon' && !isWagonCycleComplete()) {
    const { done, total } = getWagonCycleProgress();
    if (!confirm(`Current cycle has ${done}/${total} positions complete. Start a new cycle anyway?`)) return;
  }
  const now = new Date();
  const row = await dbCreateSession(state.drillType, now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
  _cache.sessions.push(row);
  _cache.entries[row.id] = {};
  setActiveSessionId(state.drillType, row.id);
  state.currentInput = '2';
  state.freshInput = true;
  if (state.drillType === 'positions') {
    state.selectedBall = 1;
    state.selectedPosition = null;
    state.shotType = 'cut';
    resumeProgression();
  } else if (state.drillType === 'mightyx') {
    state.mxSide = 'left'; state.mxLevel = 1; state.mxShot = 'follow';
  } else if (state.drillType === 'wagon') {
    state.wagonSpoke = 0;
  }
  renderAll();
  showToast('New cycle started');
}

async function resetSession() {
  if (!confirm('Clear all data in the current session?')) return;
  const sid = activeSessionId();
  // Delete all entries for this session remotely
  if (_userId && _online) {
    await sb.from('drill_entries').delete().eq('session_id', sid);
  }
  _cache.entries[sid] = {};
  localStorage.removeItem(LS_ENTRIES_PREFIX + sid);
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
  showToast('Session cleared');
}

async function deleteSession() {
  const dt = activeDrillType();
  const typed = sessionsForType(dt);
  if (typed.length <= 1) {
    showToast('Cannot delete only session');
    return;
  }
  if (!confirm('Delete this session permanently?')) return;
  const sid = activeSessionId();
  await dbDeleteSession(sid);
  _cache.sessions = _cache.sessions.filter(s => s.id !== sid);
  delete _cache.entries[sid];
  const remaining = sessionsForType(dt);
  setActiveSessionId(dt, remaining[0].id);
  // Load entries for new active session
  if (!_cache.entries[remaining[0].id]) {
    const entries = await dbGetEntries(remaining[0].id);
    _cache.entries[remaining[0].id] = {};
    for (const e of entries) {
      _cache.entries[remaining[0].id][e.drill_key] = { attempts: e.attempts, type: e.shot_type || '', note: e.note || '' };
    }
  }
  state.selectedBall = 1;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
  showToast('Session deleted');
}

async function switchSession(id) {
  setActiveSessionId(activeDrillType(), id);
  if (!_cache.entries[id]) {
    const entries = await dbGetEntries(id);
    _cache.entries[id] = {};
    for (const e of entries) {
      _cache.entries[id][e.drill_key] = { attempts: e.attempts, type: e.shot_type || '', note: e.note || '' };
    }
  }
  state.currentInput = '2';
  state.freshInput = true;
  if (state.drillType === 'positions') {
    state.selectedBall = 1;
    state.selectedPosition = null;
    resumeProgression();
  } else if (state.drillType === 'mightyx') {
    mxResumeProgression();
  } else if (state.drillType === 'wagon') {
    wagonResumeProgression();
  }
  renderAll();
}

async function resetAll() {
  if (!confirm('Delete ALL sessions and stats? This cannot be undone.')) return;
  // Delete all remote data
  if (_userId && _online) {
    await sb.from('drill_entries').delete().eq('user_id', _userId);
    await sb.from('sessions').delete().eq('user_id', _userId);
    await sb.from('user_config').delete().eq('user_id', _userId);
  }
  // Clear local cache
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('pdt_')) localStorage.removeItem(key);
  }
  localStorage.removeItem('poolDrillData');
  localStorage.removeItem('poolDrillConfig');
  _cache.sessions = [];
  _cache.entries = {};
  _cache.config = { posLabels: {}, posSkipped: {} };
  // Re-create default sessions
  for (const dt of ['positions', 'mightyx', 'wagon']) {
    const now = new Date();
    const row = await dbCreateSession(dt, now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
    _cache.sessions.push(row);
    _cache.entries[row.id] = {};
    setActiveSessionId(dt, row.id);
  }
  state.selectedBall = 1;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
  showToast('All data cleared');
}

function exportData() {
  const exportObj = { sessions: _cache.sessions, entries: _cache.entries, config: _cache.config };
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pool-drill-data.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported');
}

// ── Mighty X Rendering ──────────────────────────────

function renderMxTableSvg() {
  const margin = 14, railW = 10, dSpaceX = 46, dSpaceY = 46;
  const gridCols = 8, gridRows = 4;
  const innerW = gridCols * dSpaceX, innerH = gridRows * dSpaceY;
  const totalW = innerW + 2 * railW + 2 * margin;
  const totalH = innerH + 2 * railW + 2 * margin;
  const ox = margin + railW, oy = margin + railW + innerH;
  function dx(col) { return ox + col * dSpaceX; }
  function dy(row) { return oy - row * dSpaceY; }

  let svg = `<svg class="table-svg" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs><linearGradient id="mx-rail" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5d4037"/><stop offset="100%" stop-color="#4a3228"/></linearGradient></defs>`;
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="10" fill="url(#mx-rail)"/>`;
  svg += `<rect x="${ox}" y="${margin + railW}" width="${innerW}" height="${innerH}" rx="2" fill="#2a7a35"/>`;
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="10" fill="none" stroke="#3e2723" stroke-width="2"/>`;

  // Pockets
  const pockets = [[0,0],[0,4],[4,0],[4,4],[8,0],[8,4]];
  const pocketSet = new Set(pockets.map(([c, r]) => c + ',' + r));
  for (const [c, r] of pockets) {
    svg += `<circle cx="${dx(c)}" cy="${dy(r)}" r="8" fill="#0a0a0a"/>`;
  }

  // Diamond markers on rails (skip pocket positions)
  for (let c = 0; c <= 8; c++) {
    if (!pocketSet.has(c + ',4')) svg += `<circle cx="${dx(c)}" cy="${margin + 4}" r="2" fill="#8d6e63"/>`;
    if (!pocketSet.has(c + ',0')) svg += `<circle cx="${dx(c)}" cy="${margin + 2 * railW + innerH - 4}" r="2" fill="#8d6e63"/>`;
  }
  for (let r = 0; r <= 4; r++) {
    if (!pocketSet.has('0,' + r)) svg += `<circle cx="${margin + 4}" cy="${dy(r)}" r="2" fill="#8d6e63"/>`;
    if (!pocketSet.has('8,' + r)) svg += `<circle cx="${margin + 2 * railW + innerW - 4}" cy="${dy(r)}" r="2" fill="#8d6e63"/>`;
  }

  const side = state.mxSide;
  const isLeft = side === 'left';

  // X diagonal lines — highlight active diagonal
  // "left" = TL↔BR, "right" = BL↔TR
  svg += `<line x1="${dx(0.3)}" y1="${dy(3.85)}" x2="${dx(7.7)}" y2="${dy(0.15)}" stroke="rgba(255,255,255,${isLeft ? '0.15' : '0.05'})" stroke-width="${isLeft ? '2' : '1.5'}" stroke-dasharray="6,4"/>`;
  svg += `<line x1="${dx(0.3)}" y1="${dy(0.15)}" x2="${dx(7.7)}" y2="${dy(3.85)}" stroke="rgba(255,255,255,${!isLeft ? '0.15' : '0.05'})" stroke-width="${!isLeft ? '2' : '1.5'}" stroke-dasharray="6,4"/>`;

  const diagPos = MX_DIAG_POS[side];
  const otherPos = MX_DIAG_POS[side === 'left' ? 'right' : 'left'];
  const combo = MX_COMBOS[state.mxLevel - 1];

  // Dimmed position dots for inactive diagonal
  for (const pos of otherPos) {
    svg += `<circle cx="${dx(pos.col)}" cy="${dy(pos.row)}" r="4" fill="rgba(255,255,255,0.06)"/>`;
  }

  // All position markers on active diagonal (dimmed)
  for (let i = 0; i < diagPos.length; i++) {
    const pos = diagPos[i];
    const isOb = i === combo.ob;
    const isCb = i === combo.cb;
    if (!isOb && !isCb) {
      svg += `<circle cx="${dx(pos.col)}" cy="${dy(pos.row)}" r="4" fill="rgba(255,255,255,0.12)"/>`;
    }
  }

  // OB — red ball at current combo's OB position
  const obPos = diagPos[combo.ob];
  const obX = dx(obPos.col), obY = dy(obPos.row);
  svg += `<circle cx="${obX}" cy="${obY}" r="8" fill="#e53935" stroke="#b71c1c" stroke-width="1.5"/>`;
  svg += `<ellipse cx="${obX - 2}" cy="${obY - 2}" rx="3" ry="2" fill="rgba(255,255,255,0.3)" transform="rotate(-30 ${obX - 2} ${obY - 2})"/>`;

  // CB — white ball at current combo's CB position
  const cbPos = diagPos[combo.cb];
  const cbX = dx(cbPos.col), cbY = dy(cbPos.row);
  svg += `<circle cx="${cbX}" cy="${cbY}" r="8" fill="#f5f5f5" stroke="#fff" stroke-width="1.5"/>`;
  svg += `<ellipse cx="${cbX - 2}" cy="${cbY - 2}" rx="3" ry="2" fill="rgba(255,255,255,0.6)" transform="rotate(-30 ${cbX - 2} ${cbY - 2})"/>`;

  // Arrow from CB toward OB to show shot direction
  const midX = (obX + cbX) / 2, midY = (obY + cbY) / 2;
  svg += `<line x1="${cbX}" y1="${cbY}" x2="${midX}" y2="${midY}" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" marker-end="none"/>`;

  // Target pocket indicator
  const pkt = MX_DIAG_POCKET[side];
  svg += `<circle cx="${dx(pkt.col)}" cy="${dy(pkt.row)}" r="8" fill="none" stroke="#e53935" stroke-width="2" stroke-dasharray="3,2"/>`;

  svg += '</svg>';
  return svg;
}

function renderMightyX() {
  const container = document.getElementById('other-drill-content');
  if (!container) return;
  const currentKey = mxCurrentKey();
  const entry = getMxEntry(currentKey);
  const { done } = getMxCycleProgress();

  let html = `<div class="drill-layout">`;

  // Left: Table diagram
  html += `<div class="drill-left">`;
  html += `<div class="table-container">${renderMxTableSvg()}</div>`;
  // Current entry info
  html += `<div class="drill-info">`;
  const comboInfo = MX_COMBOS[state.mxLevel - 1];
  html += `<span style="color:${state.mxSide === 'left' ? '#7aa2f7' : '#e8a23a'}">${state.mxSide === 'left' ? '↘ TL→BR' : '↗ BL→TR'}</span>`;
  html += ` · OB${comboInfo.ob + 1} → CB${comboInfo.cb + 1} · `;
  html += `<span style="color:${MX_SHOT_COLORS[state.mxShot]}">${MX_SHOT_LABELS[state.mxShot]}</span>`;
  html += `</div>`;
  html += `</div>`;

  // Right: Controls
  html += `<div class="drill-right">`;

  // Diagonal selector
  html += `<div class="drill-selector"><div class="selector-label">Diagonal</div><div class="drill-toggle">`;
  for (const side of MX_SIDES) {
    html += `<button class="drill-toggle-btn ${side === state.mxSide ? 'active' : ''}" data-mx-side="${side}">${side === 'left' ? '↘ TL→BR' : '↗ BL→TR'}</button>`;
  }
  html += `</div></div>`;

  // Position combo selector (compact grid for 10 combos)
  html += `<div class="drill-selector"><div class="selector-label">OB → CB Position</div><div class="drill-toggle mx-combo-grid">`;
  for (const level of MX_LEVELS) {
    const allDone = MX_SHOTS.every(s => isMxEntryComplete(mxKey(state.mxSide, level, s)));
    html += `<button class="drill-toggle-btn mx-combo-btn ${level === state.mxLevel ? 'active' : ''} ${allDone ? 'done' : ''}" data-mx-level="${level}">${MX_COMBO_LABELS[level]}</button>`;
  }
  html += `</div></div>`;

  // Shot type selector
  html += `<div class="drill-selector"><div class="selector-label">Shot Type</div><div class="drill-toggle">`;
  for (const shot of MX_SHOTS) {
    const k = mxKey(state.mxSide, state.mxLevel, shot);
    const complete = isMxEntryComplete(k);
    html += `<button class="drill-toggle-btn mx-shot-btn ${shot === state.mxShot ? 'active' : ''} ${complete ? 'done' : ''}" data-mx-shot="${shot}" style="--shot-color:${MX_SHOT_COLORS[shot]}">${MX_SHOT_LABELS[shot]}</button>`;
  }
  html += `</div></div>`;

  // Mode toggle (Sequential / Random / Weighted)
  html += `<div class="drill-selector"><div class="drill-toggle">`;
  html += `<button class="drill-toggle-btn ${state.mxMode === 'seq' ? 'active' : ''}" data-mx-mode="seq">Sequential</button>`;
  html += `<button class="drill-toggle-btn ${state.mxMode === 'rand' ? 'active' : ''}" data-mx-mode="rand">🎲 Random</button>`;
  html += `<button class="drill-toggle-btn ${state.mxMode === 'weighted' ? 'active' : ''}" data-mx-mode="weighted">⚖️ Weighted</button>`;
  html += `</div></div>`;

  // Input row
  html += `<div class="input-row">`;
  html += `<div class="attempt-display" id="drill-attempt-display"><span class="attempt-number" id="drill-attempt-number">${state.currentInput}</span></div>`;
  html += `<div class="totals-col">`;
  html += `<div class="stat-card"><div class="stat-label">Entry</div><div class="stat-value" style="color:${MX_SHOT_COLORS[state.mxShot]}">${entry && entry.attempts ? entry.attempts : '—'}</div><div class="stat-sub">${MX_SHOT_LABELS[state.mxShot]}</div></div>`;
  html += `<div class="stat-card"><div class="stat-label">Cycle</div><div class="stat-value">${done}</div><div class="stat-sub">${done}/${MX_TOTAL}</div></div>`;
  html += `</div></div>`;

  // Numpad
  html += `<div class="numpad">`;
  for (let d = 1; d <= 9; d++) html += `<button class="numpad-btn num-digit" data-digit="${d}">${d}</button>`;
  html += `<button class="numpad-btn num-backspace" data-action="backspace">⌫</button>`;
  html += `<button class="numpad-btn num-digit" data-digit="0">0</button>`;
  html += `<button class="numpad-btn num-save" data-action="save">Save</button>`;
  html += `</div>`;
  html += `</div>`; // drill-right

  // Compact cycle progress bar (60 entries is too many for dots)
  const pct = MX_TOTAL > 0 ? (done / MX_TOTAL * 100) : 0;
  html += `<div class="drill-progress mx-progress">`;
  html += `<div class="mx-progress-bar"><div class="mx-progress-fill" style="width:${pct}%"></div></div>`;
  html += `<div class="cycle-count">${done} / ${MX_TOTAL}</div>`;
  html += `</div>`;

  html += `</div>`; // drill-layout
  container.innerHTML = html;
  attachDrillHandlers('mx');
}

// ── Wagon Wheel Rendering ───────────────────────────

function renderWagonTableSvg() {
  const margin = 14, railW = 10, dSpaceX = 46, dSpaceY = 46;
  const gridCols = 8, gridRows = 4;
  const innerW = gridCols * dSpaceX, innerH = gridRows * dSpaceY;
  const totalW = innerW + 2 * railW + 2 * margin;
  const totalH = innerH + 2 * railW + 2 * margin;
  const ox = margin + railW, oy = margin + railW + innerH;
  function dx(col) { return ox + col * dSpaceX; }
  function dy(row) { return oy - row * dSpaceY; }

  let svg = `<svg class="table-svg" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs><linearGradient id="ww-rail" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5d4037"/><stop offset="100%" stop-color="#4a3228"/></linearGradient></defs>`;
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="10" fill="url(#ww-rail)"/>`;
  svg += `<rect x="${ox}" y="${margin + railW}" width="${innerW}" height="${innerH}" rx="2" fill="#2a7a35"/>`;
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="10" fill="none" stroke="#3e2723" stroke-width="2"/>`;

  // Pockets
  const pockets = [[0,0],[0,4],[4,0],[4,4],[8,0],[8,4]];
  const pocketSet = new Set(pockets.map(([c, r]) => c + ',' + r));
  for (const [c, r] of pockets) {
    svg += `<circle cx="${dx(c)}" cy="${dy(r)}" r="8" fill="#0a0a0a"/>`;
  }

  // Diamond markers on rails (skip pocket positions)
  for (let c = 0; c <= 8; c++) {
    if (!pocketSet.has(c + ',4')) svg += `<circle cx="${dx(c)}" cy="${margin + 4}" r="2" fill="#8d6e63"/>`;
    if (!pocketSet.has(c + ',0')) svg += `<circle cx="${dx(c)}" cy="${margin + 2 * railW + innerH - 4}" r="2" fill="#8d6e63"/>`;
  }
  for (let r = 0; r <= 4; r++) {
    if (!pocketSet.has('0,' + r)) svg += `<circle cx="${margin + 4}" cy="${dy(r)}" r="2" fill="#8d6e63"/>`;
    if (!pocketSet.has('8,' + r)) svg += `<circle cx="${margin + 2 * railW + innerW - 4}" cy="${dy(r)}" r="2" fill="#8d6e63"/>`;
  }

  const currentPos = getActiveWWPositions()[state.wagonSpoke];
  const setup = wwShotSetup(state.wagonSpoke);

  // Highlight target pocket
  svg += `<circle cx="${dx(setup.target.col)}" cy="${dy(setup.target.row)}" r="12" fill="none" stroke="#6ee7a0" stroke-width="2.5" stroke-opacity="0.7"/>`;

  // Dashed aim line: CB → OB → pocket
  svg += `<line x1="${dx(setup.cb.col)}" y1="${dy(setup.cb.row)}" x2="${dx(setup.ob.col)}" y2="${dy(setup.ob.row)}" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="3,3"/>`;
  svg += `<line x1="${dx(setup.ob.col)}" y1="${dy(setup.ob.row)}" x2="${dx(setup.target.col)}" y2="${dy(setup.target.row)}" stroke="rgba(110,231,160,0.3)" stroke-width="1" stroke-dasharray="3,3"/>`;

  // OB (red ball) one diamond from pocket on rail
  svg += `<circle cx="${dx(setup.ob.col)}" cy="${dy(setup.ob.row)}" r="7" fill="#e53935" stroke="#b71c1c" stroke-width="1"/>`;
  svg += `<ellipse cx="${dx(setup.ob.col) - 1.5}" cy="${dy(setup.ob.row) - 1.5}" rx="2" ry="1.5" fill="rgba(255,255,255,0.3)" transform="rotate(-30 ${dx(setup.ob.col) - 1.5} ${dy(setup.ob.row) - 1.5})"/>`;

  // CB (white ball) near center
  svg += `<circle cx="${dx(setup.cb.col)}" cy="${dy(setup.cb.row)}" r="7" fill="#f5f5f5" stroke="#bbb" stroke-width="1"/>`;
  svg += `<ellipse cx="${dx(setup.cb.col) - 1.5}" cy="${dy(setup.cb.row) - 1.5}" rx="2" ry="1.5" fill="rgba(255,255,255,0.6)" transform="rotate(-30 ${dx(setup.cb.col) - 1.5} ${dy(setup.cb.row) - 1.5})"/>`;

  // All position markers
  const positions = getActiveWWPositions();
  const wwTotal = getActiveWWTotal();
  for (let i = 0; i < wwTotal; i++) {
    const pos = positions[i];
    const sx = dx(pos.col), sy = dy(pos.row);
    const complete = isWagonSpokeComplete(i);
    const isCurrent = i === state.wagonSpoke;

    // Skip drawing position marker if it overlaps with OB
    if (pos.col === setup.ob.col && pos.row === setup.ob.row && !isCurrent) continue;

    const r = isCurrent ? 13 : 10;
    let fill;
    if (isCurrent) fill = '#ffffffdd';
    else if (complete) fill = '#6ee7a0';
    else fill = 'rgba(255,255,255,0.2)';

    svg += `<circle cx="${sx}" cy="${sy}" r="${r}" fill="${fill}" ${isCurrent ? 'stroke="#fff" stroke-width="2"' : ''} data-spoke="${i}" class="spoke-marker" style="cursor:pointer"/>`;

    const entry = getWagonEntry(i);
    if (complete && !isCurrent) {
      svg += `<text x="${sx}" y="${sy + 3}" text-anchor="middle" font-size="9" font-weight="700" fill="#0a0a0a" style="pointer-events:none">${entry ? entry.attempts : '✓'}</text>`;
    } else if (isCurrent) {
      svg += `<text x="${sx}" y="${sy + 4}" text-anchor="middle" font-size="10" font-weight="700" fill="#0a0a0a" style="pointer-events:none">▶</text>`;
    } else {
      svg += `<text x="${sx}" y="${sy + 3}" text-anchor="middle" font-size="7" font-weight="600" fill="rgba(255,255,255,0.5)" style="pointer-events:none">${i + 1}</text>`;
    }
  }

  svg += '</svg>';
  return svg;
}

function wwPosLabel(pos) {
  if (pos.row === 4) return `T${pos.col}`;
  if (pos.row === 0) return `B${pos.col}`;
  if (pos.col === 0) return `L${pos.row}`;
  if (pos.col === 8) return `R${pos.row}`;
  return `${pos.col},${pos.row}`;
}

function renderWagonWheel() {
  const container = document.getElementById('other-drill-content');
  if (!container) return;
  const positions = getActiveWWPositions();
  const wwTotal = getActiveWWTotal();
  const entry = getWagonEntry(state.wagonSpoke);
  const currentPos = positions[state.wagonSpoke] || positions[0];
  const { done, total } = getWagonCycleProgress();
  const cfg = getWWConfig();

  let html = `<div class="drill-layout">`;

  // Left: Table diagram
  html += `<div class="drill-left">`;
  html += `<div class="table-container" id="wagon-table-container">${renderWagonTableSvg()}</div>`;
  html += `<div class="drill-info">`;
  html += `Position <strong>${state.wagonSpoke + 1}</strong>/${total} · ${wwPosLabel(currentPos)}`;
  html += ` → <span style="color:#6ee7a0">${cfg.pocketLabel} Pocket</span>`;
  html += `</div>`;
  html += `</div>`;

  // Right: Controls
  html += `<div class="drill-right">`;

  // Variant selector: Center / End Rail / Side Rail
  html += `<div class="drill-selector"><div class="drill-toggle ww-variant-toggle">`;
  html += `<button class="drill-toggle-btn ${state.wagonVariant === 'center' ? 'active' : ''}" data-ww-variant="center">Center</button>`;
  html += `<button class="drill-toggle-btn ${state.wagonVariant === 'endRail' ? 'active' : ''}" data-ww-variant="endRail">End Rail</button>`;
  html += `<button class="drill-toggle-btn ${state.wagonVariant === 'sideRail' ? 'active' : ''}" data-ww-variant="sideRail">Side Rail</button>`;
  html += `</div></div>`;

  // Side selector (only for endRail/sideRail)
  if (state.wagonVariant !== 'center') {
    html += `<div class="drill-selector"><div class="drill-toggle ww-side-toggle">`;
    html += `<button class="drill-toggle-btn ${state.wagonSide === 'left' ? 'active' : ''}" data-ww-side="left">← Left</button>`;
    html += `<button class="drill-toggle-btn ${state.wagonSide === 'right' ? 'active' : ''}" data-ww-side="right">Right →</button>`;
    html += `</div></div>`;
  }

  // Position selector grid
  const gridCols = wwTotal <= 20 ? 7 : 8;
  html += `<div class="drill-selector"><div class="selector-label">Position</div><div class="wagon-spoke-grid" style="grid-template-columns: repeat(${gridCols}, 1fr)">`;
  for (let i = 0; i < wwTotal; i++) {
    const complete = isWagonSpokeComplete(i);
    html += `<button class="wagon-spoke-btn ${i === state.wagonSpoke ? 'selected' : ''} ${complete ? 'done' : ''}" data-spoke="${i}">${complete ? '✓' : i + 1}</button>`;
  }
  html += `</div></div>`;

  // Mode toggle (Sequential / Random / Weighted)
  html += `<div class="drill-selector"><div class="drill-toggle">`;
  html += `<button class="drill-toggle-btn ${state.wagonMode === 'seq' ? 'active' : ''}" data-wagon-mode="seq">Sequential</button>`;
  html += `<button class="drill-toggle-btn ${state.wagonMode === 'rand' ? 'active' : ''}" data-wagon-mode="rand">🎲 Random</button>`;
  html += `<button class="drill-toggle-btn ${state.wagonMode === 'weighted' ? 'active' : ''}" data-wagon-mode="weighted">⚖️ Weighted</button>`;
  html += `</div></div>`;

  // Input row
  html += `<div class="input-row">`;
  html += `<div class="attempt-display" id="drill-attempt-display"><span class="attempt-number" id="drill-attempt-number">${state.currentInput}</span></div>`;
  html += `<div class="totals-col">`;
  html += `<div class="stat-card"><div class="stat-label">Pos ${state.wagonSpoke + 1}</div><div class="stat-value">${entry && entry.attempts ? entry.attempts : '—'}</div><div class="stat-sub">${wwPosLabel(currentPos)}</div></div>`;
  html += `<div class="stat-card"><div class="stat-label">Cycle</div><div class="stat-value">${done}</div><div class="stat-sub">${done}/${total}</div></div>`;
  html += `</div></div>`;

  // Numpad
  html += `<div class="numpad">`;
  for (let d = 1; d <= 9; d++) html += `<button class="numpad-btn num-digit" data-digit="${d}">${d}</button>`;
  html += `<button class="numpad-btn num-backspace" data-action="backspace">⌫</button>`;
  html += `<button class="numpad-btn num-digit" data-digit="0">0</button>`;
  html += `<button class="numpad-btn num-save" data-action="save">Save</button>`;
  html += `</div>`;
  html += `</div>`; // drill-right

  // Cycle progress bar
  const pct = total > 0 ? (done / total * 100) : 0;
  html += `<div class="drill-progress mx-progress">`;
  html += `<div class="mx-progress-bar"><div class="mx-progress-fill" style="width:${pct}%"></div></div>`;
  html += `<div class="cycle-count">${done} / ${total}</div>`;
  html += `</div>`;

  html += `</div>`; // drill-layout
  container.innerHTML = html;

  // Attach spoke click handlers on SVG
  const tableContainer = document.getElementById('wagon-table-container');
  if (tableContainer) {
    tableContainer.querySelectorAll('.spoke-marker').forEach(el => {
      el.addEventListener('click', () => {
        state.wagonSpoke = parseInt(el.getAttribute('data-spoke'));
        state.currentInput = '2'; state.freshInput = true;
        renderAll();
      });
    });
  }

  attachDrillHandlers('wagon');
}

// ── Shared Drill Handlers ───────────────────────────

function escAttr(s) { return s.replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function attachDrillHandlers(type) {
  const container = document.getElementById('other-drill-content');
  if (!container) return;

  // MX-specific selectors
  if (type === 'mx') {
    container.querySelectorAll('[data-mx-side]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.mxSide = btn.dataset.mxSide;
        state.currentInput = '2'; state.freshInput = true;
        renderAll();
      });
    });
    container.querySelectorAll('[data-mx-level]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.mxLevel = parseInt(btn.dataset.mxLevel);
        state.currentInput = '2'; state.freshInput = true;
        renderAll();
      });
    });
    container.querySelectorAll('[data-mx-shot]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.mxShot = btn.dataset.mxShot;
        state.currentInput = '2'; state.freshInput = true;
        renderAll();
      });
    });
    container.querySelectorAll('[data-mx-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.mxMode = btn.dataset.mxMode;
        renderAll();
      });
    });
  }

  // Wagon-specific selectors
  if (type === 'wagon') {
    container.querySelectorAll('[data-spoke]').forEach(btn => {
      if (btn.classList.contains('spoke-marker')) return; // SVG handled separately
      btn.addEventListener('click', () => {
        state.wagonSpoke = parseInt(btn.dataset.spoke);
        state.currentInput = '2'; state.freshInput = true;
        renderAll();
      });
    });
    container.querySelectorAll('[data-wagon-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.wagonMode = btn.dataset.wagonMode;
        renderAll();
      });
    });
    container.querySelectorAll('[data-ww-variant]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.wwVariant;
        if (v === state.wagonVariant) return;
        switchWagonVariant(v, v === 'center' ? null : state.wagonSide);
      });
    });
    container.querySelectorAll('[data-ww-side]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = btn.dataset.wwSide;
        if (s === state.wagonSide) return;
        switchWagonVariant(state.wagonVariant, s);
      });
    });
  }

  // Numpad digits
  container.querySelectorAll('[data-digit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = parseInt(btn.dataset.digit);
      if (state.freshInput) { state.currentInput = String(d); state.freshInput = false; }
      else if (state.currentInput.length < 3) { state.currentInput += String(d); }
      const numEl = document.getElementById('drill-attempt-number');
      if (numEl) numEl.textContent = state.currentInput;
    });
  });

  // Backspace
  const bsBtn = container.querySelector('[data-action="backspace"]');
  if (bsBtn) bsBtn.addEventListener('click', () => {
    if (state.currentInput.length <= 1) { state.currentInput = '2'; state.freshInput = true; }
    else { state.currentInput = state.currentInput.slice(0, -1); }
    const numEl = document.getElementById('drill-attempt-number');
    if (numEl) numEl.textContent = state.currentInput;
  });

  // Save
  const saveBtn = container.querySelector('[data-action="save"]');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    if (type === 'mx') pressSaveMx();
    else if (type === 'wagon') pressSaveWagon();
  });
}

function pressSaveMx() {
  const attempts = parseInt(state.currentInput, 10);
  if (isNaN(attempts) || attempts < 2) { showToast('Minimum 2 attempts'); return; }
  saveMxEntry(mxCurrentKey(), attempts);

  // Flash
  const display = document.getElementById('drill-attempt-display');
  if (display) { display.classList.add('flash'); setTimeout(() => display.classList.remove('flash'), 400); }

  // Auto-advance to next incomplete
  if (state.mxMode === 'weighted') mxPickWeighted();
  else if (state.mxMode === 'rand') mxPickRandom();
  else mxResumeProgression();
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();

  if (isMxCycleComplete()) {
    showDrillCycleComplete(`All ${MX_TOTAL} Mighty X drills finished!`, MX_TOTAL, getMxSessionTotal());
  }
}

function pressSaveWagon() {
  const attempts = parseInt(state.currentInput, 10);
  if (isNaN(attempts) || attempts < 2) { showToast('Minimum 2 attempts'); return; }
  saveWagonEntry(state.wagonSpoke, attempts);

  // Flash
  const display = document.getElementById('drill-attempt-display');
  if (display) { display.classList.add('flash'); setTimeout(() => display.classList.remove('flash'), 400); }

  // Auto-advance
  if (state.wagonMode === 'weighted') wagonPickWeighted();
  else if (state.wagonMode === 'rand') wagonPickRandom();
  else wagonResumeProgression();
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();

  const wwTotal = getActiveWWTotal();
  if (isWagonCycleComplete()) {
    const cfg = getWWConfig();
    showDrillCycleComplete(`All ${wwTotal} ${cfg.label} positions finished!`, wwTotal, getWagonSessionTotal());
  }
}

function showDrillCycleComplete(text, entries, totalAttempts) {
  const modal = document.getElementById('cycle-modal');
  const backdrop = document.getElementById('cycle-modal-backdrop');
  if (!modal || !backdrop) return;
  const statsEl = document.getElementById('cycle-modal-stats');
  const textEl = modal.querySelector('.cycle-modal-text');
  if (textEl) textEl.textContent = text;
  if (statsEl) statsEl.textContent = `${entries} entries · ${totalAttempts} total attempts`;
  modal.style.display = 'flex';
  backdrop.style.display = 'block';
}

// ── Init ────────────────────────────────────────────

function resumeProgression() {
  // Find the first unfilled position across all balls (starting from ball 1)
  for (let i = 0; i < 12; i++) {
    const ball = i + 1;
    const positions = getCuePositions(ball);
    for (const p of positions) {
      const key = coordKey(p);
      if (!isPositionComplete(ball, key)) {
        state.selectedBall = ball;
        state.selectedPosition = key;
        if (isDualPosition(ball, key)) {
          state.direction = !getEntry(ball, key, 'L') ? 'L' : 'R';
        }
        return;
      }
    }
  }
  // All positions filled — stay at ball 1 pos 0
}

function init() {
  // Number pad
  document.querySelectorAll('.num-digit').forEach((btn) => {
    btn.addEventListener('click', () => pressDigit(parseInt(btn.dataset.digit, 10)));
  });
  document.getElementById('btn-backspace').addEventListener('click', pressBackspace);
  document.getElementById('btn-save').addEventListener('click', pressSave);

  // Positions mode toggle (seq / rand / weighted)
  function updatePosModeBtns() {
    document.querySelectorAll('.pos-mode-toggle .drill-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.posMode === state.posMode);
    });
  }
  document.querySelectorAll('[data-pos-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.posMode = btn.dataset.posMode;
      updatePosModeBtns();
    });
  });

  // Direction toggle (L/R for dual positions)
  document.getElementById('btn-dir-l').addEventListener('click', () => {
    state.direction = 'L';
    state.currentInput = '2';
    state.freshInput = true;
    renderDirToggle();
    renderDisplay();
  });
  document.getElementById('btn-dir-r').addEventListener('click', () => {
    state.direction = 'R';
    state.currentInput = '2';
    state.freshInput = true;
    renderDirToggle();
    renderDisplay();
  });

  // Session controls
  document.getElementById('btn-new-session').addEventListener('click', newSession);
  document.getElementById('btn-reset').addEventListener('click', resetSession);
  document.getElementById('btn-delete-session').addEventListener('click', deleteSession);
  document.getElementById('btn-reset-all').addEventListener('click', resetAll);
  document.getElementById('btn-export').addEventListener('click', exportData);

  // Cycle modal
  const btnNewCycle = document.getElementById('btn-new-cycle');
  const btnDismissCycle = document.getElementById('btn-dismiss-cycle');
  const cycleBackdrop = document.getElementById('cycle-modal-backdrop');
  if (btnNewCycle) btnNewCycle.addEventListener('click', startNewCycle);
  if (btnDismissCycle) btnDismissCycle.addEventListener('click', hideCycleModal);
  if (cycleBackdrop) cycleBackdrop.addEventListener('click', hideCycleModal);

  document.getElementById('session-select').addEventListener('change', (e) => {
    switchSession(e.target.value);
  });

  resumeProgression();
  renderAll();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPositionConfigs();
  await loadAppData();
  if (document.getElementById('btn-save')) init();

  // Swipe navigation between drill tabs
  let touchStartX = 0, touchStartY = 0;
  const SWIPE_THRESHOLD = 60;
  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const dxSwipe = e.changedTouches[0].clientX - touchStartX;
    const dySwipe = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dxSwipe) < SWIPE_THRESHOLD) return;
    if (Math.abs(dySwipe) > Math.abs(dxSwipe) * 0.6) return; // too vertical
    const types = Object.keys(DRILL_TYPES);
    const idx = types.indexOf(state.drillType);
    if (dxSwipe < 0) {
      switchDrillType(types[(idx + 1) % types.length]);
    } else {
      switchDrillType(types[(idx - 1 + types.length) % types.length]);
    }
  }, { passive: true });
});
