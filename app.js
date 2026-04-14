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

/** Get the pocket target for a ball at a specific CB position. */
function getPocketTarget(ballNum, posKey) {
  const entry = POCKET_TARGETS[ballNum];
  if (!entry) return null;
  const clean = posKey ? posKey.replace(/:.*/, '') : null;
  if (clean && entry[clean]) return entry[clean];
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
  const pk = POCKET_COORDS[getPocketTarget(ballNum, posKey)];
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
  const pk = POCKET_COORDS[getPocketTarget(ballNum, posKey)];
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

// ── State ───────────────────────────────────────────

const state = {
  selectedBall: 1,
  selectedPosition: null,    // coordKey string, e.g. "2,1"
  currentInput: '2',
  freshInput: true,           // true = first digit replaces default
  shotType: 'cut',
  direction: 'L',            // 'L' or 'R' — only matters for dual positions
};

// ── Persistence ─────────────────────────────────────

const STORAGE_KEY = 'poolDrillData';
const CONFIG_KEY = 'poolDrillConfig';

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { posLabels: {}, posSkipped: {} };
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function getPosLabel(ballNum, posKey) {
  const cfg = loadConfig();
  const k = ballNum + ':' + posKey;
  return (cfg.posLabels && cfg.posLabels[k]) || '';
}

function setPosLabel(ballNum, posKey, label) {
  const cfg = loadConfig();
  if (!cfg.posLabels) cfg.posLabels = {};
  const k = ballNum + ':' + posKey;
  if (label) cfg.posLabels[k] = label;
  else delete cfg.posLabels[k];
  saveConfig(cfg);
}

function isPosSkipped(ballNum, posKey) {
  const cfg = loadConfig();
  const k = ballNum + ':' + posKey;
  return !!(cfg.posSkipped && cfg.posSkipped[k]);
}

function setPosSkipped(ballNum, posKey, skipped) {
  const cfg = loadConfig();
  if (!cfg.posSkipped) cfg.posSkipped = {};
  const k = ballNum + ':' + posKey;
  if (skipped) cfg.posSkipped[k] = true;
  else delete cfg.posSkipped[k];
  saveConfig(cfg);
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore corrupt data */ }
  return null;
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getAppData() {
  let data = loadData();
  if (!data || !data.sessions || data.sessions.length === 0) {
    const session = createSession();
    data = { sessions: [session], activeSessionId: session.id };
    saveData(data);
  }
  if (!data.activeSessionId || !data.sessions.find((s) => s.id === data.activeSessionId)) {
    data.activeSessionId = data.sessions[0].id;
    saveData(data);
  }
  return data;
}

function createSession() {
  const now = new Date();
  return {
    id: now.toISOString(),
    label: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    data: {},
  };
}

function getActiveSession() {
  const data = getAppData();
  return data.sessions.find((s) => s.id === data.activeSessionId);
}

function saveEntry(ballNum, posKey, attempts, type, direction) {
  const data = getAppData();
  const session = data.sessions.find((s) => s.id === data.activeSessionId);
  const ballKey = 'ball' + ballNum;
  if (!session.data[ballKey]) session.data[ballKey] = {};
  const effectiveKey = direction ? posKey + ':' + direction : posKey;
  const prev = session.data[ballKey][effectiveKey];
  session.data[ballKey][effectiveKey] = { attempts, type, note: (prev && prev.note) || '' };
  saveData(data);
}

function saveNote(ballNum, posKey, note, direction) {
  const data = getAppData();
  const session = data.sessions.find((s) => s.id === data.activeSessionId);
  const ballKey = 'ball' + ballNum;
  if (!session.data[ballKey]) session.data[ballKey] = {};
  const effectiveKey = direction ? posKey + ':' + direction : posKey;
  if (!session.data[ballKey][effectiveKey]) {
    session.data[ballKey][effectiveKey] = { attempts: 0, type: 'cut', note };
  } else {
    session.data[ballKey][effectiveKey].note = note;
  }
  saveData(data);
}

function getEntry(ballNum, posKey, direction) {
  const session = getActiveSession();
  const ballKey = 'ball' + ballNum;
  const effectiveKey = direction ? posKey + ':' + direction : posKey;
  return session.data[ballKey] ? session.data[ballKey][effectiveKey] : null;
}

function getBallTotal(ballNum) {
  const session = getActiveSession();
  const ballKey = 'ball' + ballNum;
  const positions = session.data[ballKey];
  if (!positions) return 0;
  return Object.values(positions).reduce((sum, e) => sum + (e.attempts || 0), 0);
}

function getBallFilledCount(ballNum) {
  const session = getActiveSession();
  const ballKey = 'ball' + ballNum;
  const positions = session.data[ballKey];
  if (!positions) return 0;
  return Object.keys(positions).length;
}

function getSessionTotal() {
  const session = getActiveSession();
  let total = 0;
  for (const ballKey of Object.keys(session.data)) {
    for (const entry of Object.values(session.data[ballKey])) {
      total += entry.attempts || 0;
    }
  }
  return total;
}

function getSessionFilledCount() {
  const session = getActiveSession();
  let count = 0;
  for (const ballKey of Object.keys(session.data)) {
    count += Object.keys(session.data[ballKey]).length;
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
  const targetPocketId = getPocketTarget(state.selectedBall, state.selectedPosition);
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

    // Note indicator
    const hasNote = isDual
      ? ((getEntry(state.selectedBall, key, 'L') || {}).note || (getEntry(state.selectedBall, key, 'R') || {}).note)
      : (hasData && getEntry(state.selectedBall, key) && getEntry(state.selectedBall, key).note);
    if (hasNote && !isSelected) {
      svg += `<text x="${x + 9}" y="${y - 7}" text-anchor="middle" font-size="7" style="pointer-events:none">📝</text>`;
    }

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
  const angle = getCutAngle(b, pk);
  const dir = getCutDirection(b, pk);
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
    btn.className = `ball-pill ball-${b}${b === state.selectedBall ? ' selected' : ''}`;
    btn.textContent = b;
    btn.setAttribute('aria-label', `Ball ${b}`);
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

  // Note input
  const noteInput = document.getElementById('note-input');
  if (noteInput) {
    noteInput.value = (entry && entry.note) || '';
  }
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
  const data = getAppData();
  const select = document.getElementById('session-select');
  select.innerHTML = '';
  // Show newest first
  const sorted = [...data.sessions].sort((a, b) => b.id.localeCompare(a.id));
  for (const s of sorted) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === data.activeSessionId) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderAll() {
  ensureValidPosition();
  applyShotType();
  renderBallSelector();
  renderDisplay();
  renderDirToggle();
  renderTotals();
  renderSessionSelector();
  renderTableDiagram();
  renderShotInfo();
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

  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
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

function newSession() {
  const data = getAppData();
  const session = createSession();
  data.sessions.push(session);
  data.activeSessionId = session.id;
  saveData(data);
  state.selectedBall = 1;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  state.shotType = 'cut';
  renderAll();
  showToast('New session started');
}

function resetSession() {
  if (!confirm('Clear all data in the current session?')) return;
  const data = getAppData();
  const session = data.sessions.find((s) => s.id === data.activeSessionId);
  session.data = {};
  saveData(data);
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
  showToast('Session cleared');
}

function deleteSession() {
  const data = getAppData();
  if (data.sessions.length <= 1) {
    showToast('Cannot delete only session');
    return;
  }
  if (!confirm('Delete this session permanently?')) return;
  data.sessions = data.sessions.filter((s) => s.id !== data.activeSessionId);
  data.activeSessionId = data.sessions[0].id;
  saveData(data);
  state.selectedBall = 1;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
  showToast('Session deleted');
}

function switchSession(id) {
  const data = getAppData();
  data.activeSessionId = id;
  saveData(data);
  state.selectedBall = 1;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
}

function resetAll() {
  if (!confirm('Delete ALL sessions and stats? This cannot be undone.')) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CONFIG_KEY);
  state.selectedBall = 1;
  state.selectedPosition = null;
  state.currentInput = '2';
  state.freshInput = true;
  renderAll();
  showToast('All data cleared');
}

function exportData() {
  const data = getAppData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pool-drill-data.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported');
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

  // Note input — save on blur / Enter
  const noteInput = document.getElementById('note-input');
  function commitNote() {
    const isDual = isDualPosition(state.selectedBall, state.selectedPosition);
    const dir = isDual ? state.direction : null;
    saveNote(state.selectedBall, state.selectedPosition, noteInput.value, dir);
    renderTableDiagram();
  }
  noteInput.addEventListener('change', commitNote);
  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { noteInput.blur(); }
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

  document.getElementById('session-select').addEventListener('change', (e) => {
    switchSession(e.target.value);
  });

  resumeProgression();
  renderAll();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPositionConfigs();
  if (document.getElementById('btn-save')) init();
});
