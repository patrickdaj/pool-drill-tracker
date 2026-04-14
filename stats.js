/* =====================================================
   Pool Drill Tracker — stats.js (Stats Page)
   ===================================================== */

const REQUIRED_MAKES = 2;

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

function pctClass(pct) {
  if (pct >= 80) return 'pct-good';
  if (pct >= 50) return 'pct-ok';
  return 'pct-bad';
}

function computeStats(session) {
  const balls = {};
  let totalAttempts = 0, totalSlots = 0;
  let best = null, worst = null;
  let bestPos = null, worstPos = null;
  const byType = { cut: { sum: 0, count: 0 }, bank: { sum: 0, count: 0 } };
  const byDist = { short: { sum: 0, count: 0 }, mid: { sum: 0, count: 0 }, long: { sum: 0, count: 0 } };
  const byRail = {};
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
    byType, byDist, byRail, allPositions,
  };
}

let expandedBall = null;

function renderStats() {
  const session = getActiveSession();
  const s = computeStats(session);

  // Session overview
  const sg = document.getElementById('stats-session-grid');
  sg.innerHTML = `
    <div class="stats-item"><div class="stats-item-value">${s.sessionPct.toFixed(0)}%</div><div class="stats-item-label">Hit Rate</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.sessionAvg.toFixed(1)}</div><div class="stats-item-label">Avg Attempts</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.totalSlots}/${getTotalPositionCount()}</div><div class="stats-item-label">Filled</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.best ? s.best.ball : '-'}</div><div class="stats-item-label">Best Ball (${s.best ? s.best.avg.toFixed(1) : '-'})</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.worst ? s.worst.ball : '-'}</div><div class="stats-item-label">Worst Ball (${s.worst ? s.worst.avg.toFixed(1) : '-'})</div></div>
    <div class="stats-item"><div class="stats-item-value">${s.totalAttempts}</div><div class="stats-item-label">Total Attempts</div></div>
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

  // Per-ball breakdown with expandable detail
  const bl = document.getElementById('stats-ball-list');
  let ballHtml = '';
  for (let b = 1; b <= 12; b++) {
    const bs = s.balls[b];
    const posCount = getCuePositions(b).length;
    const pct = posCount > 0 ? Math.round((bs.filled / posCount) * 100) : 0;
    const isExpanded = expandedBall === b;
    ballHtml += `<div class="stats-ball-row" data-stats-ball="${b}">
      <span class="stats-ball-num">B${b}</span>
      <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${pct}%"></div></div>
      <span class="stats-ball-avg">${bs.filled > 0 ? bs.avg.toFixed(1) : '-'}</span>
      <span class="stats-ball-pct">${bs.filled > 0 ? bs.avgPct.toFixed(0) + '%' : '-'}</span>
      <span class="stats-ball-count">${bs.filled}/${posCount}</span>
    </div>`;
    if (isExpanded && bs.positions.length > 0) {
      ballHtml += '<div class="stats-ball-detail">';
      const sorted = [...bs.positions].sort((a, b) => a.key.localeCompare(b.key));
      for (const p of sorted) {
        const label = getPosLabel(b, p.key.replace(/:.*/, ''));
        const pctVal = p.pct;
        ballHtml += `<div class="stats-pos-row">
          <span class="stats-pos-key">${p.key}</span>
          <span class="stats-pos-label">${label}</span>
          <span class="stats-pos-type type-${p.type}">${p.type}</span>
          <span class="stats-pos-attempts">${p.attempts}</span>
          <span class="stats-pos-pct ${pctClass(pctVal)}">${pctVal.toFixed(0)}%</span>
        </div>`;
      }
      ballHtml += '</div>';
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

  // Trends vs previous session
  const data = getAppData();
  const sorted = [...data.sessions].sort((a, b) => b.id.localeCompare(a.id));
  const currentIdx = sorted.findIndex((ses) => ses.id === session.id);
  const trendsSection = document.getElementById('stats-trends-section');
  if (currentIdx >= 0 && currentIdx < sorted.length - 1) {
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

// Session switcher for stats page
function renderSessionSelector() {
  const select = document.getElementById('session-select');
  if (!select) return;
  const data = getAppData();
  select.innerHTML = '';
  const sorted = [...data.sessions].sort((a, b) => b.id.localeCompare(a.id));
  for (const s of sorted) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === data.activeSessionId) opt.selected = true;
    select.appendChild(opt);
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
  renderSessionSelector();
  renderStats();

  document.getElementById('session-select').addEventListener('change', (e) => {
    switchSession(e.target.value);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPositionConfigs();
  initStats();
});
