/* =====================================================
   Pool Drill Tracker — stats.js (Stats Page)
   ===================================================== */

const REQUIRED_MAKES = 2;
const TRENDING_COUNT = 5;

let statsView = 'session'; // 'session' | 'trending' | 'history'
let statsDrillType = 'positions'; // current drill type filter

function cbDistance(ballNum, posKey) {
  const bp = BALL_POSITIONS[ballNum];
  const parts = posKey.replace(/:.*/, '').split(',');
  const cc = parseInt(parts[0], 10), cr = parseInt(parts[1], 10);
  return Math.sqrt(Math.pow(cc - bp.col, 2) + Math.pow(cr - bp.row, 2));
}

function cbRail(posKey) {
  const parts = posKey.replace(/:.*/, '').split(',');
  const c = parseInt(parts[0], 10), r = parseInt(parts[1], 10);
  if (r === 1) return 'Bottom';
  if (r === 3) return 'Top';
  if (c === 1) return 'Left';
  if (c === 6) return 'Right';
  return 'Other';
}

function hitPct(attempts) {
  return attempts > 0 ? (REQUIRED_MAKES / attempts * 100) : 0;
}

function wwStatLabel(pos) {
  if (pos.row === 4) return `T${pos.col}`;
  if (pos.row === 0) return `B${pos.col}`;
  if (pos.col === 0) return `L${pos.row}`;
  if (pos.col === 8) return `R${pos.row}`;
  return `${pos.col},${pos.row}`;
}

function pctClass(pct) {
  if (pct >= 80) return 'pct-good';
  if (pct >= 50) return 'pct-ok';
  return 'pct-bad';
}

/** Merge multiple sessions into one with averaged attempts per position. */
function mergeSessionsData(sessions) {
  const merged = { data: {} };
  const counts = {};
  for (const session of sessions) {
    for (let b = 1; b <= 12; b++) {
      const ballKey = 'ball' + b;
      const entries = session.data[ballKey] || {};
      for (const [k, e] of Object.entries(entries)) {
        if (!e.attempts || e.attempts <= 0) continue;
        if (!merged.data[ballKey]) merged.data[ballKey] = {};
        if (!counts[ballKey]) counts[ballKey] = {};
        if (!merged.data[ballKey][k]) {
          merged.data[ballKey][k] = { attempts: 0, type: e.type || 'cut', note: '' };
          counts[ballKey][k] = 0;
        }
        merged.data[ballKey][k].attempts += e.attempts;
        counts[ballKey][k]++;
      }
    }
  }
  for (const ballKey of Object.keys(merged.data)) {
    for (const k of Object.keys(merged.data[ballKey])) {
      merged.data[ballKey][k].attempts = merged.data[ballKey][k].attempts / counts[ballKey][k];
    }
  }
  return merged;
}

/** Get sessions for the current view. */
function getViewSessions() {
  const data = getAppData();
  const typed = data.sessions.filter(s => (s.drillType || 'positions') === statsDrillType);
  const sorted = [...typed].sort((a, b) => b.id.localeCompare(a.id));
  if (statsView === 'trending') return sorted.slice(0, TRENDING_COUNT);
  if (statsView === 'history') return sorted;
  // Session view — use active if it matches, otherwise most recent of type
  const active = data.sessions.find(s => s.id === data.activeSessionId);
  if (active && (active.drillType || 'positions') === statsDrillType) return [active];
  return sorted.length > 0 ? [sorted[0]] : [{ data: {} }];
}

/** Get the effective data object for the current view. */
function getViewData() {
  const sessions = getViewSessions();
  if (statsView === 'session') return sessions[0];
  return mergeSessionsData(sessions);
}

function computeStats(session) {
  const balls = {};
  let totalAttempts = 0, totalSlots = 0;
  let best = null, worst = null;
  let bestPos = null, worstPos = null;
  const byType = { cut: { sum: 0, count: 0 }, bank: { sum: 0, count: 0 } };
  const byDist = { short: { sum: 0, count: 0 }, mid: { sum: 0, count: 0 }, long: { sum: 0, count: 0 } };
  const byRail = {};
  const byAngle = { full: { sum: 0, count: 0 }, three_q: { sum: 0, count: 0 }, half: { sum: 0, count: 0 }, quarter: { sum: 0, count: 0 }, thin: { sum: 0, count: 0 }, back: { sum: 0, count: 0 } };
  const byCutDir = { left: { sum: 0, count: 0 }, right: { sum: 0, count: 0 }, straight: { sum: 0, count: 0 } };
  const allPositions = [];

  for (let b = 1; b <= 12; b++) {
    const ballKey = 'ball' + b;
    const entries = session.data[ballKey] || {};
    const vals = [];
    for (const [k, e] of Object.entries(entries)) {
      if (!e.attempts || e.attempts <= 0) continue;
      const a = e.attempts;
      const pct = hitPct(a);
      const dist = cbDistance(b, k);
      const rail = cbRail(k);
      const type = e.type || 'cut';
      vals.push({ key: k, attempts: a, type, pct, dist, rail, note: e.note || '' });

      if (byType[type]) { byType[type].sum += a; byType[type].count++; }

      // Only compute cut angle/direction for non-bank shots
      if (type !== 'bank') {
        const angle = getCutAngle(b, k);
        const dir = getCutDirection(b, k);
        if (angle !== null) {
          const aBucket = angle >= 90 ? 'back' : angle >= 70 ? 'thin' : angle >= 50 ? 'quarter' : angle >= 30 ? 'half' : angle >= 15 ? 'three_q' : 'full';
          byAngle[aBucket].sum += a; byAngle[aBucket].count++;
        }
        if (dir && byCutDir[dir]) { byCutDir[dir].sum += a; byCutDir[dir].count++; }
      }

      const bucket = dist <= 1.5 ? 'short' : dist <= 3.5 ? 'mid' : 'long';
      byDist[bucket].sum += a;
      byDist[bucket].count++;

      if (!byRail[rail]) byRail[rail] = { sum: 0, count: 0 };
      byRail[rail].sum += a;
      byRail[rail].count++;

      allPositions.push({ ball: b, key: k, attempts: a, type, pct, dist, rail });
    }

    const filled = vals.length;
    const sum = vals.reduce((s, v) => s + v.attempts, 0);
    const avg = filled > 0 ? sum / filled : 0;
    const avgPct = filled > 0 ? vals.reduce((s, v) => s + v.pct, 0) / filled : 0;
    balls[b] = { filled, sum, avg, avgPct, positions: vals };
    totalAttempts += sum;
    totalSlots += filled;

    if (filled > 0) {
      if (!best || avg < best.avg) best = { ball: b, avg };
      if (!worst || avg > worst.avg) worst = { ball: b, avg };
    }
    for (const v of vals) {
      if (!bestPos || v.attempts < bestPos.attempts) bestPos = { ball: b, key: v.key, attempts: v.attempts };
      if (!worstPos || v.attempts > worstPos.attempts) worstPos = { ball: b, key: v.key, attempts: v.attempts };
    }
  }

  const sessionAvg = totalSlots > 0 ? totalAttempts / totalSlots : 0;
  const sessionPct = totalSlots > 0 ? allPositions.reduce((s, p) => s + p.pct, 0) / totalSlots : 0;

  return {
    balls, totalAttempts, totalSlots,
    sessionAvg, sessionPct,
    best, worst, bestPos, worstPos,
    byType, byDist, byRail, byAngle, byCutDir, allPositions,
  };
}

let expandedBall = null;

/**
 * Render a mini SVG table for a ball showing OB position and
 * hit percentages at each CB position. Green=cut, orange=bank.
 */
function renderMiniTable(ballNum, ballStats) {
  // Build a lookup from posKey (without direction suffix) to position data
  const posData = {};
  for (const p of ballStats.positions) {
    const baseKey = p.key.replace(/:.*/, '');
    if (!posData[baseKey]) {
      posData[baseKey] = { attempts: 0, count: 0, type: p.type };
    }
    posData[baseKey].attempts += p.attempts;
    posData[baseKey].count++;
  }
  // Average dual positions
  for (const k of Object.keys(posData)) {
    if (posData[k].count > 1) {
      posData[k].attempts = posData[k].attempts / posData[k].count;
    }
  }

  const margin = 8;
  const railW = 6;
  const sp = 30; // spacing between grid positions
  const gridCols = 8;
  const gridRows = 4;
  const innerW = gridCols * sp;
  const innerH = gridRows * sp;
  const totalW = innerW + 2 * railW + 2 * margin;
  const totalH = innerH + 2 * railW + 2 * margin;
  const ox = margin + railW;
  const oy = margin + railW + innerH;

  function dx(col) { return ox + col * sp; }
  function dy(row) { return oy - row * sp; }

  let svg = `<svg class="mini-table-svg" viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg">`;

  // Table felt
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="6" fill="#3e2723"/>`;
  svg += `<rect x="${ox}" y="${margin + railW}" width="${innerW}" height="${innerH}" rx="2" fill="#2a7a35"/>`;
  svg += `<rect x="${margin}" y="${margin}" width="${innerW + 2 * railW}" height="${innerH + 2 * railW}" rx="6" fill="none" stroke="#3e2723" stroke-width="1.5"/>`;

  // CB positions
  const cuePositions = getCuePositions(ballNum);
  const cueKeys = new Set(cuePositions.map(coordKey));

  for (const pos of PERIMETER_PATH) {
    const key = coordKey(pos);
    if (!cueKeys.has(key)) continue;
    const x = dx(pos.col);
    const y = dy(pos.row);
    const pd = posData[key];

    if (pd) {
      const pct = hitPct(pd.attempts);
      const isBank = pd.type === 'bank';
      const fill = isBank ? '#e8a23a' : '#6ee7a0';
      const fillBg = isBank ? 'rgba(232,162,58,0.2)' : 'rgba(110,231,160,0.2)';
      svg += `<circle cx="${x}" cy="${y}" r="11" fill="${fillBg}" stroke="${fill}" stroke-width="1"/>`;
      svg += `<text x="${x}" y="${y + 3}" text-anchor="middle" font-size="7" font-weight="700" font-family="Inter,system-ui,sans-serif" fill="${fill}">${Math.round(pct)}%</text>`;
    } else {
      svg += `<circle cx="${x}" cy="${y}" r="6" fill="rgba(255,255,255,0.12)"/>`;
    }
  }

  // Object ball
  const bp = BALL_POSITIONS[ballNum];
  const bx = dx(bp.col);
  const by = dy(bp.row);
  const bc = BALL_COLORS[ballNum];
  const br = 9;
  if (bc.stripe) {
    svg += `<circle cx="${bx}" cy="${by}" r="${br}" fill="${bc.fill}"/>`;
    svg += `<rect x="${bx - br}" y="${by - 2}" width="${br * 2}" height="4" fill="#fff" clip-path="circle(${br}px at ${bx}px ${by}px)"/>`;
    svg += `<circle cx="${bx}" cy="${by}" r="${br}" fill="none" stroke="#fff" stroke-width="1.5"/>`;
  } else {
    svg += `<circle cx="${bx}" cy="${by}" r="${br}" fill="${bc.fill}" stroke="#fff" stroke-width="1.5"/>`;
  }
  svg += `<text x="${bx}" y="${by + 3}" text-anchor="middle" font-size="8" font-weight="700" font-family="Inter,system-ui,sans-serif" fill="${bc.text}">${ballNum}</text>`;

  svg += '</svg>';
  return svg;
}

function renderStats() {
  if (statsDrillType === 'mightyx') return renderMxStats();
  if (statsDrillType === 'wagon') return renderWagonStats();
  renderPositionsStats();
}

function renderPositionsStats() {
  // Show positions-specific sections
  document.querySelectorAll('.stats-section').forEach(s => s.style.display = '');
  const viewData = getViewData();
  const s = computeStats(viewData);
  const viewSessions = getViewSessions();

  // Update view-dependent UI
  const sessionSelect = document.getElementById('session-select');
  const trendsSection = document.getElementById('stats-trends-section');
  const overviewTitle = document.getElementById('stats-overview-title');
  sessionSelect.style.display = statsView === 'session' ? '' : 'none';

  if (statsView === 'trending') {
    overviewTitle.textContent = `Trending — Last ${viewSessions.length} Sessions`;
  } else if (statsView === 'history') {
    overviewTitle.textContent = `History — ${viewSessions.length} Sessions`;
  } else {
    overviewTitle.textContent = 'Session Overview';
  }

  // Session overview
  const sg = document.getElementById('stats-session-grid');
  const isMulti = statsView !== 'session';
  sg.innerHTML = `
    <div class="stats-item"><div class="stats-item-value">${s.sessionPct.toFixed(0)}%</div><div class="stats-item-label">Hit Rate</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.sessionAvg.toFixed(1)}</div><div class="stats-item-label">Avg Attempts</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.totalSlots}/${getTotalPositionCount()}</div><div class="stats-item-label">${isMulti ? 'Positions Seen' : 'Filled'}</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.best ? s.best.ball : '-'}</div><div class="stats-item-label">Best Ball (${s.best ? s.best.avg.toFixed(1) : '-'})</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.worst ? s.worst.ball : '-'}</div><div class="stats-item-label">Worst Ball (${s.worst ? s.worst.avg.toFixed(1) : '-'})</div></div>
    <div class="stats-item"><div class="stats-item-value">${isMulti ? viewSessions.length : s.totalAttempts}</div><div class="stats-item-label">${isMulti ? 'Sessions' : 'Total Attempts'}</div></div>
  `;

  // By shot type
  const tg = document.getElementById('stats-type-grid');
  const cutAvg = s.byType.cut.count > 0 ? s.byType.cut.sum / s.byType.cut.count : 0;
  const cutPct = cutAvg > 0 ? hitPct(cutAvg) : 0;
  const bankAvg = s.byType.bank.count > 0 ? s.byType.bank.sum / s.byType.bank.count : 0;
  const bankPct = bankAvg > 0 ? hitPct(bankAvg) : 0;
  tg.innerHTML = `
    <div class="stats-item"><div class="stats-item-value">${cutPct.toFixed(0)}%</div><div class="stats-item-label">Cut Rate (${s.byType.cut.count})</div></div>
    <div class="stats-item"><div class="stats-item-value value-bank">${bankPct.toFixed(0)}%</div><div class="stats-item-label">Bank Rate (${s.byType.bank.count})</div></div>
    <div class="stats-item"><div class="stats-item-value">${cutAvg.toFixed(1)} / ${bankAvg.toFixed(1)}</div><div class="stats-item-label">Cut / Bank Avg</div></div>
  `;

  // By cut angle
  const ag = document.getElementById('stats-angle-grid');
  if (ag) {
    const angleHtml = (label, d) => {
      const avg = d.count > 0 ? d.sum / d.count : 0;
      const pct = avg > 0 ? hitPct(avg) : 0;
      return `<div class="stats-item"><div class="stats-item-value">${d.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${label} (${d.count})</div></div>`;
    };
    ag.innerHTML = angleHtml('Full 0-15°', s.byAngle.full)
      + angleHtml('¾ Ball 15-30°', s.byAngle.three_q)
      + angleHtml('½ Ball 30-50°', s.byAngle.half)
      + angleHtml('¼ Ball 50-70°', s.byAngle.quarter)
      + angleHtml('Thin 70-90°', s.byAngle.thin)
      + angleHtml('Backcut 90°+', s.byAngle.back);
  }

  // By cut direction
  const cg = document.getElementById('stats-cutdir-grid');
  if (cg) {
    const dirHtml = (label, d) => {
      const avg = d.count > 0 ? d.sum / d.count : 0;
      const pct = avg > 0 ? hitPct(avg) : 0;
      return `<div class="stats-item"><div class="stats-item-value">${d.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${label} (${d.count})</div></div>`;
    };
    cg.innerHTML = dirHtml('Cut Left', s.byCutDir.left)
      + dirHtml('Cut Right', s.byCutDir.right)
      + dirHtml('Straight', s.byCutDir.straight);
  }

  // By distance
  const dg = document.getElementById('stats-distance-grid');
  const distHtml = (label, d) => {
    const avg = d.count > 0 ? d.sum / d.count : 0;
    const pct = avg > 0 ? hitPct(avg) : 0;
    return `<div class="stats-item"><div class="stats-item-value">${pct.toFixed(0)}%</div><div class="stats-item-label">${label} (${d.count})<br>${avg.toFixed(1)} avg</div></div>`;
  };
  dg.innerHTML = distHtml('Short', s.byDist.short) + distHtml('Medium', s.byDist.mid) + distHtml('Long', s.byDist.long);

  // By rail
  const rg = document.getElementById('stats-rail-grid');
  let railHtml = '';
  for (const rail of ['Top', 'Bottom', 'Left', 'Right']) {
    const rd = s.byRail[rail] || { sum: 0, count: 0 };
    const avg = rd.count > 0 ? rd.sum / rd.count : 0;
    const pct = avg > 0 ? hitPct(avg) : 0;
    railHtml += `<div class="stats-item"><div class="stats-item-value">${rd.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${rail} (${rd.count})</div></div>`;
  }
  rg.innerHTML = railHtml;

  // Per-ball breakdown with mini table
  const bl = document.getElementById('stats-ball-list');
  let ballHtml = '';
  for (let b = 1; b <= 12; b++) {
    const bs = s.balls[b];
    const posCount = getCuePositions(b).length;
    const pct = posCount > 0 ? Math.round((bs.filled / posCount) * 100) : 0;
    const isExpanded = expandedBall === b;
    const pocketId = getPocketTarget(b) || '?';
    ballHtml += `<div class="stats-ball-row" data-stats-ball="${b}">
      <span class="stats-ball-num">B${b}</span>
      <span class="stats-ball-pocket">${pocketId}</span>
      <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${pct}%"></div></div>
      <span class="stats-ball-avg">${bs.filled > 0 ? bs.avg.toFixed(1) : '-'}</span>
      <span class="stats-ball-pct">${bs.filled > 0 ? bs.avgPct.toFixed(0) + '%' : '-'}</span>
      <span class="stats-ball-count">${bs.filled}/${posCount}</span>
    </div>`;
    if (isExpanded) {
      ballHtml += `<div class="stats-ball-detail">${renderMiniTable(b, bs)}</div>`;
    }
  }
  bl.innerHTML = ballHtml;

  // Attach expand/collapse handlers
  bl.querySelectorAll('.stats-ball-row').forEach((row) => {
    row.addEventListener('click', () => {
      const b = parseInt(row.dataset.statsBall, 10);
      expandedBall = expandedBall === b ? null : b;
      renderStats();
    });
  });

  // Trends vs previous session (only in session view)
  const data = getAppData();
  const sorted = [...data.sessions].sort((a, b) => b.id.localeCompare(a.id));
  const session = getActiveSession();
  const currentIdx = sorted.findIndex((ses) => ses.id === session.id);
  if (statsView === 'session' && currentIdx >= 0 && currentIdx < sorted.length - 1) {
    const prev = sorted[currentIdx + 1];
    const ps = computeStats(prev);
    trendsSection.style.display = '';
    const ttg = document.getElementById('stats-trends-grid');
    const diff = s.sessionAvg - ps.sessionAvg;
    const arrow = diff < 0 ? '↓' : diff > 0 ? '↑' : '→';
    const diffClass = diff < 0 ? 'trend-good' : diff > 0 ? 'trend-bad' : '';
    const pctDiff = s.sessionPct - ps.sessionPct;
    const pctArrow = pctDiff > 0 ? '↑' : pctDiff < 0 ? '↓' : '→';
    const pctDiffClass = pctDiff > 0 ? 'trend-good' : pctDiff < 0 ? 'trend-bad' : '';
    ttg.innerHTML = `
      <div class="stats-item"><div class="stats-item-value ${diffClass}">${arrow} ${Math.abs(diff).toFixed(1)}</div><div class="stats-item-label">Avg Change</div></div>
      <div class="stats-item"><div class="stats-item-value ${pctDiffClass}">${pctArrow} ${Math.abs(pctDiff).toFixed(0)}%</div><div class="stats-item-label">Hit Rate Change</div></div>
      <div class="stats-item"><div class="stats-item-value value-muted">${ps.sessionPct.toFixed(0)}%</div><div class="stats-item-label">Prev Hit Rate</div></div>
    `;
  } else {
    trendsSection.style.display = 'none';
  }
}

// ── Mighty X Stats ──────────────────────────────────

function computeMxStats(sessions) {
  const bySide = { left: { sum: 0, count: 0 }, right: { sum: 0, count: 0 } };
  const byLevel = {};
  for (const l of MX_LEVELS) byLevel[l] = { sum: 0, count: 0 };
  const byShot = {};
  for (const s of MX_SHOTS) byShot[s] = { sum: 0, count: 0 };
  let totalAttempts = 0, totalSlots = 0;

  for (const session of sessions) {
    for (const side of MX_SIDES) {
      for (const level of MX_LEVELS) {
        for (const shot of MX_SHOTS) {
          const entry = session.data[mxKey(side, level, shot)];
          if (entry && entry.attempts >= 2) {
            const a = entry.attempts;
            bySide[side].sum += a; bySide[side].count++;
            byLevel[level].sum += a; byLevel[level].count++;
            byShot[shot].sum += a; byShot[shot].count++;
            totalAttempts += a; totalSlots++;
          }
        }
      }
    }
  }
  const sessionAvg = totalSlots > 0 ? totalAttempts / totalSlots : 0;
  const sessionPct = totalSlots > 0 ? (REQUIRED_MAKES / sessionAvg * 100) : 0;
  return { bySide, byLevel, byShot, totalAttempts, totalSlots, sessionAvg, sessionPct };
}

function renderMxStats() {
  const sessions = getViewSessions();
  const s = computeMxStats(sessions);

  const sessionSelect = document.getElementById('session-select');
  sessionSelect.style.display = statsView === 'session' ? '' : 'none';

  const overviewTitle = document.getElementById('stats-overview-title');
  overviewTitle.textContent = statsView === 'session' ? 'Session Overview' : statsView === 'trending' ? `Trending — Last ${sessions.length}` : `History — ${sessions.length} Sessions`;

  const sg = document.getElementById('stats-session-grid');
  const isMulti = statsView !== 'session';
  sg.innerHTML = `
    <div class="stats-item"><div class="stats-item-value">${s.sessionPct.toFixed(0)}%</div><div class="stats-item-label">Hit Rate</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.sessionAvg.toFixed(1)}</div><div class="stats-item-label">Avg Attempts</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.totalSlots}/${MX_TOTAL}</div><div class="stats-item-label">${isMulti ? 'Entries Seen' : 'Filled'}</div></div>
    <div class="stats-item"><div class="stats-item-value">${isMulti ? sessions.length : s.totalAttempts}</div><div class="stats-item-label">${isMulti ? 'Sessions' : 'Total Attempts'}</div></div>
  `;

  // By Side → use type grid
  const tg = document.getElementById('stats-type-grid');
  const sideHtml = (label, d) => {
    const avg = d.count > 0 ? d.sum / d.count : 0;
    const pct = avg > 0 ? hitPct(avg) : 0;
    return `<div class="stats-item"><div class="stats-item-value">${d.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${label} (${d.count})</div></div>`;
  };
  tg.innerHTML = sideHtml('↘ TL→BR', s.bySide.left) + sideHtml('↗ BL→TR', s.bySide.right);
  tg.closest('.stats-section').querySelector('.stats-section-title').textContent = 'By Diagonal';

  // By Shot Type → use angle grid
  const ag = document.getElementById('stats-angle-grid');
  if (ag) {
    let shotHtml = '';
    for (const shot of MX_SHOTS) {
      const d = s.byShot[shot];
      const avg = d.count > 0 ? d.sum / d.count : 0;
      const pct = avg > 0 ? hitPct(avg) : 0;
      const label = shot.charAt(0).toUpperCase() + shot.slice(1);
      shotHtml += `<div class="stats-item"><div class="stats-item-value" style="color:${MX_SHOT_COLORS[shot]}">${d.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${label} (${d.count})</div></div>`;
    }
    ag.innerHTML = shotHtml;
    ag.closest('.stats-section').querySelector('.stats-section-title').textContent = 'By Shot Type';
    ag.closest('.stats-section').style.display = '';
  }

  // By Level → use distance grid
  const dg = document.getElementById('stats-distance-grid');
  let levelHtml = '';
  for (const level of MX_LEVELS) {
    const d = s.byLevel[level];
    const avg = d.count > 0 ? d.sum / d.count : 0;
    const pct = avg > 0 ? hitPct(avg) : 0;
    levelHtml += `<div class="stats-item"><div class="stats-item-value">${d.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${MX_COMBO_LABELS[level]} (${d.count})</div></div>`;
  }
  dg.innerHTML = levelHtml;
  dg.closest('.stats-section').querySelector('.stats-section-title').textContent = 'By Position';
  dg.closest('.stats-section').style.display = '';

  // Hide irrelevant sections
  const cg = document.getElementById('stats-cutdir-grid');
  if (cg) cg.closest('.stats-section').style.display = 'none';
  const rg = document.getElementById('stats-rail-grid');
  rg.closest('.stats-section').style.display = 'none';
  document.getElementById('stats-ball-list').closest('.stats-section').style.display = 'none';
  document.getElementById('stats-trends-section').style.display = 'none';
}

// ── Wagon Wheel Stats ───────────────────────────────

function computeWagonStats(sessions) {
  // Aggregate across all 18 diamond positions
  const byPos = {};
  for (const pos of WW_ALL_DIAMONDS) {
    byPos[wwKey(pos)] = { sum: 0, count: 0, pos };
  }
  let totalAttempts = 0, totalSlots = 0;

  for (const session of sessions) {
    for (const pos of WW_ALL_DIAMONDS) {
      const key = wwKey(pos);
      const entry = session.data[key];
      if (entry && entry.attempts >= 2) {
        byPos[key].sum += entry.attempts;
        byPos[key].count++;
        totalAttempts += entry.attempts;
        totalSlots++;
      }
    }
  }
  const sessionAvg = totalSlots > 0 ? totalAttempts / totalSlots : 0;
  const sessionPct = totalSlots > 0 ? (REQUIRED_MAKES / sessionAvg * 100) : 0;
  return { byPos, totalAttempts, totalSlots, sessionAvg, sessionPct };
}

function renderWagonStats() {
  const sessions = getViewSessions();
  const s = computeWagonStats(sessions);

  const sessionSelect = document.getElementById('session-select');
  sessionSelect.style.display = statsView === 'session' ? '' : 'none';

  const overviewTitle = document.getElementById('stats-overview-title');
  overviewTitle.textContent = statsView === 'session' ? 'Session Overview' : statsView === 'trending' ? `Trending — Last ${sessions.length}` : `History — ${sessions.length} Sessions`;

  const sg = document.getElementById('stats-session-grid');
  const isMulti = statsView !== 'session';
  let best = null, worst = null;
  const posEntries = Object.entries(s.byPos);
  for (const [key, d] of posEntries) {
    if (d.count > 0) {
      const avg = d.sum / d.count;
      if (!best || avg < best.avg) best = { key, pos: d.pos, avg };
      if (!worst || avg > worst.avg) worst = { key, pos: d.pos, avg };
    }
  }
  const filledCount = posEntries.filter(([_, d]) => d.count > 0).length;
  sg.innerHTML = `
    <div class="stats-item"><div class="stats-item-value">${s.sessionPct.toFixed(0)}%</div><div class="stats-item-label">Hit Rate</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.sessionAvg.toFixed(1)}</div><div class="stats-item-label">Avg Attempts</div></div>
    <div class="stats-item"><div class="stats-item-value">${filledCount}/18</div><div class="stats-item-label">${isMulti ? 'Positions Seen' : 'Filled'}</div></div>
    <div class="stats-item"><div class="stats-item-value">${best ? wwStatLabel(best.pos) : '-'}</div><div class="stats-item-label">Best (${best ? best.avg.toFixed(1) : '-'})</div></div>
    <div class="stats-item"><div class="stats-item-value">${worst ? wwStatLabel(worst.pos) : '-'}</div><div class="stats-item-label">Worst (${worst ? worst.avg.toFixed(1) : '-'})</div></div>
    <div class="stats-item"><div class="stats-item-value">${isMulti ? sessions.length : s.totalAttempts}</div><div class="stats-item-label">${isMulti ? 'Sessions' : 'Total Attempts'}</div></div>
  `;

  // Per-position breakdown → use type grid
  const tg = document.getElementById('stats-type-grid');
  let spokeHtml = '';
  for (const pos of WW_ALL_DIAMONDS) {
    const d = s.byPos[wwKey(pos)];
    const avg = d.count > 0 ? d.sum / d.count : 0;
    const pct = avg > 0 ? hitPct(avg) : 0;
    spokeHtml += `<div class="stats-item"><div class="stats-item-value">${d.count > 0 ? pct.toFixed(0) + '%' : '-'}</div><div class="stats-item-label">${wwStatLabel(pos)} (${d.count})</div></div>`;
  }
  tg.innerHTML = spokeHtml;
  tg.closest('.stats-section').querySelector('.stats-section-title').textContent = 'Per Position';

  // Hide irrelevant sections
  const ag = document.getElementById('stats-angle-grid');
  if (ag) ag.closest('.stats-section').style.display = 'none';
  const cg = document.getElementById('stats-cutdir-grid');
  if (cg) cg.closest('.stats-section').style.display = 'none';
  const dg = document.getElementById('stats-distance-grid');
  dg.closest('.stats-section').style.display = 'none';
  const rg = document.getElementById('stats-rail-grid');
  rg.closest('.stats-section').style.display = 'none';
  document.getElementById('stats-ball-list').closest('.stats-section').style.display = 'none';
  document.getElementById('stats-trends-section').style.display = 'none';
}

// Session switcher for stats page
function renderSessionSelector() {
  const select = document.getElementById('session-select');
  if (!select) return;
  const data = getAppData();
  select.innerHTML = '';
  const sorted = [...data.sessions]
    .filter(s => (s.drillType || 'positions') === statsDrillType)
    .sort((a, b) => b.id.localeCompare(a.id));
  for (const s of sorted) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === data.activeSessionId) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderStatsDrillTabs() {
  const container = document.getElementById('stats-drill-type-tabs');
  if (!container) return;
  container.innerHTML = '';
  for (const [key, info] of Object.entries(DRILL_TYPES)) {
    const btn = document.createElement('button');
    btn.className = 'drill-type-tab' + (key === statsDrillType ? ' active' : '');
    btn.innerHTML = `${info.icon} ${info.label}`;
    btn.addEventListener('click', () => {
      statsDrillType = key;
      renderStatsDrillTabs();
      renderSessionSelector();
      renderStats();
    });
    container.appendChild(btn);
  }
}

function switchSession(id) {
  const data = getAppData();
  data.activeSessionId = id;
  saveData(data);
  renderStats();
  renderSessionSelector();
}

function initStats() {
  renderStatsDrillTabs();
  renderSessionSelector();
  renderStats();

  document.getElementById('session-select').addEventListener('change', (e) => {
    switchSession(e.target.value);
  });

  // View tab switching
  document.querySelectorAll('.stats-view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      statsView = tab.dataset.view;
      document.querySelectorAll('.stats-view-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === statsView));
      renderStats();
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPositionConfigs();
  initStats();
});
