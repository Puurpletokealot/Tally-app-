// Tally — application code
// Split out of the single-file build so edits stay local and one mistake
// can't silently delete unrelated features.

const firebaseConfig = {
    apiKey: "AIzaSyD6AR0RXv4ekmC0iC2KOLThkImpQ2PCnVI",
    authDomain: "tally-e74bb.firebaseapp.com",
    databaseURL: "https://tally-e74bb-default-rtdb.firebaseio.com/",
    projectId: "tally-e74bb",
    storageBucket: "tally-e74bb.firebasestorage.app",
    messagingSenderId: "175480773764",
    appId: "1:175480773764:web:38c7d9c2efab7aea5876d1"
  };

  const isConfigured = true;
  if (!isConfigured) {
    document.getElementById('setupBanner').style.display = 'block';
  }

  let db = null;
  let itemsRef = null;
  let roomCode = null;

  function normalizeRoom(s) {
    return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  function resolveRoom() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalizeRoom(params.get('store'));
    if (fromUrl) {
      localStorage.setItem('tally_room', fromUrl);
      return fromUrl;
    }
    return normalizeRoom(localStorage.getItem('tally_room'));
  }

  if (isConfigured) {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    roomCode = resolveRoom();
    if (roomCode) {
      itemsRef = db.ref('tally/rooms/' + roomCode + '/items');
    }
  }

  const NAME_KEY = 'tally_myname';
  let items = [];
  let expanded = new Set();
  let minimized = new Set();
  const moreOpen = new Set();
  let searchQuery = '';
  let sortMode = localStorage.getItem('tally_sort') || 'recent';
  let speechEnabled = localStorage.getItem('tally_speak') !== '0';
  let handsFree = false;
  let activeRecognition = null;

  // Undo keeps a short stack, not a single step — counting moves fast and one
  // step back is often not far enough.
  const UNDO_DEPTH = 8;
  const undoStack = [];

  function snapshotForUndo(label) {
    undoStack.push({
      items: JSON.parse(JSON.stringify(items)),
      label: label || '',
      at: Date.now()
    });
    while (undoStack.length > UNDO_DEPTH) undoStack.shift();
    updateUndoButton();
  }

  function updateUndoButton() {
    const btn = document.getElementById('undoBtn');
    if (btn) {
      btn.disabled = !undoStack.length;
      btn.textContent = undoStack.length > 1
        ? '\u21A9 Undo (' + undoStack.length + ')'
        : '\u21A9 Undo';
    }
    const bar = document.getElementById('undoBar');
    if (bar) bar.style.display = undoStack.length ? 'flex' : 'none';
  }

  function performUndo() {
    const prev = undoStack.pop();
    if (!prev) return;
    items = prev.items;
    allowEmptySave = true;   // undoing back to an empty list is deliberate
    render();
    saveItems();
    updateUndoButton();
    buzz(14);
    showCommandToast(prev.label ? 'Undid: ' + prev.label : 'Undone');
  }
  let myName = localStorage.getItem(NAME_KEY) || '';
  let profileId = localStorage.getItem('tally_profile_id') || null;
  let myUid = null;
  let authError = null;

/* ---------------------------------------------------------------- */

function calc(units, caseSize) {
    const cs = caseSize > 0 ? caseSize : 1;
    const cases = Math.floor(units / cs);
    const rem = units - cases * cs;
    const decimalCases = Number((units / cs).toFixed(2));
    return { cases, rem, decimalCases };
  }

  // Ring shows stock level relative to the low-stock line (full = 2x the line)
  function buildRing(item) {
    const t = lowThresholdUnits(item);
    if (t == null || t <= 0) return '<span class="ring"></span>';
    const target = t * 2;
    const pct = Math.max(0, Math.min(1, item.units / target));
    const circ = 2 * Math.PI * 9;
    const offset = circ * (1 - pct);
    const cls = item.units <= t ? 'low' : (pct < 0.75 ? 'warn' : '');
    return '<svg class="ring ' + cls + '" viewBox="0 0 24 24">' +
      '<circle class="track" cx="12" cy="12" r="9" fill="none" stroke-width="4"/>' +
      '<circle class="fill" cx="12" cy="12" r="9" fill="none" stroke-width="4" stroke-linecap="round" ' +
        'transform="rotate(-90 12 12)" stroke-dasharray="' + circ.toFixed(1) + '" ' +
        'stroke-dashoffset="' + offset.toFixed(1) + '"/>' +
    '</svg>';
  }

  function render() {
    const list = document.getElementById('itemList');
    if (!items.length) {
      // A store that HAS had items and is now empty is suspicious, not new.
      const suspicious = sawItems || localStorage.getItem('tally_had_items') === '1';
      list.innerHTML = suspicious
        ? '<div class="empty alarm">' +
            '<div class="empty-icon">\u26A0\uFE0F</div>' +
            '<h3>Your list is empty</h3>' +
            '<p>There were items here before. This can happen after a bad sync.</p>' +
            '<button type="button" class="empty-btn" id="emptyRestore">Restore from a backup</button>' +
          '</div>'
        : '<div class="empty">' +
            '<div class="empty-icon">\uD83C\uDF69</div>' +
            '<h3>Nothing here yet</h3>' +
            '<p>Add what you keep in the freezer, then count it with the buttons, your voice, or the scanner.</p>' +
            '<button type="button" class="empty-btn" id="emptyAdd">\u2795 Add your first item</button>' +
            '<button type="button" class="empty-link" id="emptyScan">or scan an order sheet</button>' +
            '<button type="button" class="empty-link" id="emptyTour">show me around</button>' +
          '</div>';
      on('emptyRestore', 'click', showSnapshots);
      on('emptyAdd', 'click', openAddItem);
      on('emptyScan', 'click', openProductionPicker);
      on('emptyTour', 'click', replayTour);
      renderCatStrip();
      return;
    }
    if (items.length) localStorage.setItem('tally_had_items', '1');
    const q = searchQuery.trim().toLowerCase();
    let visibleIdx = items.map(function (it, i) { return i; }).filter(function (i) {
      const it = items[i];
      if (q && !it.name.toLowerCase().includes(q)) return false;
      if (catFilter === '__none') { if (itemCategory(it)) return false; }
      else if (catFilter && itemCategory(it) !== catFilter) return false;
      return true;
    });

    if (sortMode === 'recent') {
      visibleIdx = visibleIdx.slice().sort(function(a, b) {
        return (items[b].touched || 0) - (items[a].touched || 0);
      });
    }

    if (!visibleIdx.length) {
      const why = catFilter && q ? 'No items in ' + escapeHtml(catFilter) + ' match "' + escapeHtml(searchQuery.trim()) + '".'
        : catFilter ? 'Nothing in ' + escapeHtml(catFilter) + ' yet.'
        : 'No items match "' + escapeHtml(searchQuery.trim()) + '".';
      list.innerHTML = '<div class="empty">' + why + '</div>';
      renderCatStrip();
      return;
    }

    list.innerHTML = visibleIdx.map(function(idx) {
      const item = items[idx];
      const c = calc(item.units, item.caseSize);
      const mode = item.mode || 'case';
      const isCase = mode === 'case';

      const primaryValue = isCase ? c.decimalCases : item.units;
      const primaryUnit = isCase ? packLabel(item, c.decimalCases) : unitLabel(item, item.units);
      const secondaryText = isCase
        ? item.units.toLocaleString() + ' total ' + unitLabel(item, item.units)
        : c.decimalCases.toLocaleString() + ' ' + packLabel(item, c.decimalCases) +
          ' (' + c.cases + ' whole + ' + c.rem + ' ' + unitLabel(item, c.rem) + ')';

      const lowT = lowThresholdUnits(item);
      const lowStock = lowT != null && item.units <= lowT;

      if (minimized.has(idx)) {
        return (
          '<div class="item-card mini' + (lowStock ? ' low-stock' : '') + '" data-idx="' + idx + '">' +
            '<span class="swipe-hint left">+1 cs</span>' +
            '<span class="swipe-hint right">&minus;1 cs</span>' +
            '<button type="button" class="mini-row" data-action="toggle-mini" data-idx="' + idx + '" aria-label="Expand ' + escapeHtml(item.name) + '">' +
              buildRing(item) +
              '<span class="mini-name">' + escapeHtml(item.name) + (item.note ? '<span class="note-dot" title="Has a note">&#128221;</span>' : '') + (lowStock ? '<span class="low-donut" title="Low stock">&#129384;</span>' : '') + '</span>' +
              '<span class="mini-count" data-count="' + idx + '">' + primaryValue.toLocaleString() + ' <span class="mini-unit">' + primaryUnit + '</span></span>' +
              '<span class="expand-btn">&#9660;</span>' +
            '</button>' +
          '</div>'
        );
      }

      const caseButtons =
        '<div class="ctrl-group">' +
          '<div class="ctrl-label">' + packOf(item).one.charAt(0).toUpperCase() + packOf(item).one.slice(1) + '</div>' +
          '<div class="ctrl-buttons">' +
            '<button class="minus" data-action="case-1" data-idx="' + idx + '">&minus;1</button>' +
            '<button class="plus" data-action="case+1" data-idx="' + idx + '">+1</button>' +
          '</div>' +
          '<div class="ctrl-buttons" style="margin-top:4px;">' +
            '<button class="minus half" data-action="half-1" data-idx="' + idx + '">&minus;&frac12;</button>' +
            '<button class="plus half" data-action="half+1" data-idx="' + idx + '">+&frac12;</button>' +
          '</div>' +
        '</div>';
      const unitButtons =
        '<div class="ctrl-group">' +
          '<div class="ctrl-label">' + unitLabel(item, 2).charAt(0).toUpperCase() + unitLabel(item, 2).slice(1) + '</div>' +
          '<div class="ctrl-buttons">' +
            '<button class="minus" data-action="unit-1" data-idx="' + idx + '">&minus;1</button>' +
            '<button class="plus" data-action="unit+1" data-idx="' + idx + '">+1</button>' +
          '</div>' +
        '</div>';

      return (
        '<div class="item-card' + (lowStock ? ' low-stock' : '') + '" data-idx="' + idx + '">' +
          '<div class="item-top">' +
            '<div class="item-head">' +
              '<div class="item-name">' + buildRing(item) + ' ' + escapeHtml(item.name) +
                (lowStock ? '<span class="low-donut" title="Low stock">&#129384;</span>' : '') + '</div>' +
              '<div class="item-sub">' +
                (itemCategory(item) ? '<span class="cat-tag">' + escapeHtml(itemCategory(item)) + '</span>' : '') +
                '<span>' + item.caseSize + ' per ' + packOf(item).one + '</span>' +
                (item.note ? '<span title="' + escapeHtml(item.note) + '">&#128221;</span>' : '') +
                (Array.isArray(item.barcodes) && item.barcodes.length ? '<span>&#9646;&#9474;&#9646;</span>' : '') +
                (isVariantItem(item) && item.lastVariant ? '<span>' + escapeHtml(item.lastVariant) + '</span>' : '') +
              '</div>' +
            '</div>' +
            '<div class="top-actions">' +
              (sortMode === 'manual'
                ? '<button class="reorder-btn" data-action="up" data-idx="' + idx + '" aria-label="Move up" ' + (idx === 0 ? 'disabled' : '') + '>&uarr;</button>' +
                  '<button class="reorder-btn" data-action="down" data-idx="' + idx + '" aria-label="Move down" ' + (idx === items.length - 1 ? 'disabled' : '') + '>&darr;</button>'
                : '') +
              '<button class="reorder-btn" data-action="toggle-mini" data-idx="' + idx + '" aria-label="Collapse">&#9650;</button>' +
            '</div>' +
          '</div>' +

          '<div class="display big">' +
            '<div class="total" data-count="' + idx + '">' + primaryValue.toLocaleString() +
              '<span class="total-unit">' + primaryUnit + '</span></div>' +
            '<div class="breakdown">' + secondaryText + '</div>' +
          '</div>' +

          '<div class="controls">' +
            (isCase ? caseButtons + unitButtons : unitButtons + caseButtons) +
          '</div>' +

          '<div class="mode-toggle small" data-idx="' + idx + '">' +
            '<button type="button" class="mode-btn ' + (isCase ? 'active' : '') + '" data-idx="' + idx + '" data-mode="case">By ' + packLabel(item, 2) + '</button>' +
            '<button type="button" class="mode-btn ' + (!isCase ? 'active' : '') + '" data-idx="' + idx + '" data-mode="unit">By ' + unitLabel(item, 2) + '</button>' +
          '</div>' +

          (burnLabel(item) ? '<div class="burn-line">&#128200; ' + burnLabel(item) + '</div>' : '') +

          '<div class="item-footer">' +
            '<button type="button" class="foot-btn hc-open" data-idx="' + idx + '">&#128400; Count</button>' +
            '<button type="button" class="foot-btn waste-btn" data-idx="' + idx + '">&#128465; Waste</button>' +
            '<button type="button" class="foot-btn more" data-action="more" data-idx="' + idx + '">&#8943;</button>' +
          '</div>' +
          (moreOpen.has(idx)
            ? '<div class="item-more">' +
                '<button type="button" class="foot-btn tray-btn" data-idx="' + idx + '">&#129384; Tray</button>' +
                '<button type="button" class="foot-btn" data-action="toggle-history" data-idx="' + idx + '">&#128220; History</button>' +
                '<button type="button" class="foot-btn edit-item" data-idx="' + idx + '">&#9881; Edit</button>' +
              '</div>'
            : '') +
          (expanded.has(idx) ? buildHistoryPanel(item, idx) : '') +
        '</div>'
      );
    }).join('');

    updateCollapseAllBtn();
    applyBump();
    renderCatStrip();
  }

  function formatRelative(ts) {
    const diffMs = Date.now() - ts;
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.round(hours / 24);
    return days + 'd ago';
  }

  // ===================== BURN RATE =====================
  // Works out how fast an item actually moves from its own history,
  // weighting recent days more and accounting for day-of-week swings.
  const DAY_MS = 86400000;

  function computeBurn(item) {
    const hist = (item && item.history) || [];
    // Waste is a loss, not a sales pace — exclude it from the forecast
    // Waste is a loss and a hand count is a correction — neither is sales pace
    const usage = hist.filter(function (h) {
      return h.delta < 0 && h.kind !== 'waste' && h.kind !== 'count';
    });
    if (usage.length < 3) return null;

    const now = Date.now();
    const firstTs = usage[0].ts;
    const spanDays = Math.max(1, (now - firstTs) / DAY_MS);
    if (spanDays < 2) return null;

    // Total used per calendar day, and per weekday
    const byDay = {};
    const byWeekday = [[], [], [], [], [], [], []];
    usage.forEach(function (h) {
      const d = new Date(h.ts);
      d.setHours(0, 0, 0, 0);
      const key = d.getTime();
      byDay[key] = (byDay[key] || 0) + Math.abs(h.delta);
    });

    Object.keys(byDay).forEach(function (k) {
      const ts = Number(k);
      byWeekday[new Date(ts).getDay()].push(byDay[ts]);
    });

    // Recency-weighted average units per day (last 28 days count most)
    let wSum = 0, w = 0;
    Object.keys(byDay).forEach(function (k) {
      const ageDays = (now - Number(k)) / DAY_MS;
      const weight = Math.exp(-ageDays / 21);
      wSum += byDay[k] * weight;
      w += weight;
    });

    const activeDays = Object.keys(byDay).length;
    // Spread across the whole span, not just days with activity
    const perDay = (wSum / Math.max(w, 0.0001)) * (activeDays / spanDays);
    if (!isFinite(perDay) || perDay <= 0) return null;

    const weekdayAvg = byWeekday.map(function (arr) {
      if (!arr.length) return null;
      return arr.reduce(function (s, v) { return s + v; }, 0) / arr.length;
    });

    // Days of stock left, walking forward through the actual weekdays ahead
    let remaining = item.units;
    let days = 0;
    const today = new Date().getDay();
    while (remaining > 0 && days < 120) {
      const wd = (today + days) % 7;
      const rate = weekdayAvg[wd] != null ? weekdayAvg[wd] : perDay;
      remaining -= rate;
      days++;
    }

    const cs = item.caseSize || 1;
    return {
      perDay: perDay,
      perDayCases: perDay / cs,
      daysLeft: remaining > 0 ? null : days,
      outDate: remaining > 0 ? null : new Date(now + days * DAY_MS),
      weekdayAvg: weekdayAvg,
      sampleDays: activeDays,
      confident: activeDays >= 5 && spanDays >= 6
    };
  }

  function burnLabel(item) {
    const b = computeBurn(item);
    if (!b) return '';
    const rate = b.perDayCases >= 0.1
      ? b.perDayCases.toFixed(1) + ' cs/day'
      : Math.round(b.perDay) + ' un/day';
    if (b.daysLeft == null) return '~' + rate;
    const when = b.daysLeft <= 1 ? 'today'
      : b.daysLeft <= 2 ? 'tomorrow'
      : 'in ' + b.daysLeft + ' days';
    return '~' + rate + ' \u00b7 out ' + when + (b.confident ? '' : ' (rough)');
  }

  function suggestOrderCases(item) {
    // Enough to cover the next week of real usage, on top of the low-stock line
    const b = computeBurn(item);
    const cs = item.caseSize || 1;
    const t = lowThresholdUnits(item);
    if (!b) {
      if (t == null) return 1;
      return Math.max(1, Math.ceil((t - item.units) / cs));
    }
    const weekNeed = b.perDay * 7;
    const floor = t != null ? t : 0;
    const need = (floor + weekNeed) - item.units;
    return Math.max(1, Math.ceil(need / cs));
  }

  function getWeekStart(ts) {
    const d = new Date(ts);
    const day = d.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + diff);
    return d.getTime();
  }

  function formatWeekLabel(weekStartTs) {
    const start = new Date(weekStartTs);
    const end = new Date(weekStartTs + 6 * 86400000);
    const opts = { month: 'short', day: 'numeric' };
    return start.toLocaleDateString('en-US', opts) + ' - ' + end.toLocaleDateString('en-US', opts);
  }

  function buildHistoryPanel(item, idx) {
    const history = item.history || [];
    if (!history.length) {
      return '<div class="history-panel"><div class="no-history">No activity logged yet for this item.</div></div>';
    }

    const recent = history.slice(-6).reverse();
    const recentHtml = recent.map(function(h) {
      const verb = h.kind === 'waste' ? 'wasted'
        : h.kind === 'count' ? 'hand counted'
        : (h.delta > 0 ? 'added' : 'removed');
      const vtag = h.variant ? ' <span class="role-tag">' + escapeHtml(h.variant) + '</span>' : '';
      return '<div class="history-entry"><span>' + verb + ' ' + Math.abs(h.delta).toLocaleString() + ' units' + vtag + '</span>' +
        '<span class="who">' + escapeHtml(h.actor || 'someone') +
        (h.role ? ' (' + escapeHtml(h.role) + ')' : '') +
        ' &middot; ' + formatRelative(h.ts) + '</span></div>';
    }).join('');

    const weekMap = {};
    history.forEach(function(h) {
      const wk = getWeekStart(h.ts);
      if (!weekMap[wk]) weekMap[wk] = { bought: 0, used: 0, wasted: 0 };
      if (h.kind === 'count') return;
      if (h.delta > 0) weekMap[wk].bought += h.delta;
      else if (h.kind === 'waste') weekMap[wk].wasted += Math.abs(h.delta);
      else weekMap[wk].used += Math.abs(h.delta);
    });
    const weeks = Object.keys(weekMap).map(Number).sort(function(a, b) { return b - a; }).slice(0, 6);
    const weekRows = weeks.map(function(wk) {
      const w = weekMap[wk];
      return '<tr><td>' + formatWeekLabel(wk) + '</td><td>' + w.bought.toLocaleString() + '</td><td>' +
        w.used.toLocaleString() + '</td><td style="color:' + (w.wasted ? 'var(--red)' : 'inherit') + ';">' +
        w.wasted.toLocaleString() + '</td></tr>';
    }).join('');

    return (
      '<div class="history-panel">' +
        '<div class="history-section-label">Recent activity</div>' +
        recentHtml +
        '<div class="history-section-label" style="margin-top:12px;">Bought vs used, by week</div>' +
        '<table class="week-table"><tr><th>Week</th><th>In</th><th>Used</th><th>Waste</th></tr>' + weekRows + '</table>' +
        '<button type="button" class="clear-history-btn" data-action="clear-history" data-idx="' + idx + '">Clear history</button>' +
      '</div>'
    );
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function setSyncStatus(msg, isSyncing) {
    const dot = document.getElementById('syncDot');
    const text = document.getElementById('syncText');
    if (!dot || !text) return;
    dot.classList.toggle('syncing', !!isSyncing);
    // Stay quiet when everything is fine; speak up only for problems
    const calm = /^(Connected|Synced|Saving)/i.test(msg);
    text.textContent = calm ? '' : msg;
    dot.style.opacity = isSyncing ? '1' : (calm ? '0.35' : '1');
  }

  const SESSION_ID = (function() {
    let id = sessionStorage.getItem('tally_session');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('tally_session', id);
    }
    return id;
  })();

  let presenceRef = null;

  // Records anyone with a profile opening the app, approved or not
  function logSignIn(kind) {
    if (!isConfigured || !roomCode || !myName) return;
    db.ref('tally/rooms/' + roomCode + '/sessions').push({
      name: myName,
      role: myRole || null,
      profileId: profileId || null,
      status: kind || 'opened',
      at: Date.now(),
      session: SESSION_ID
    }).catch(function () {});
  }

  function startPresence() {
    if (!isConfigured || !roomCode) return;
    presenceRef = db.ref('tally/rooms/' + roomCode + '/presence/' + SESSION_ID);

    let logged = false;
    db.ref('.info/connected').on('value', function(snap) {
      if (snap.val() !== true) return;
      presenceRef.onDisconnect().remove();
      presenceRef.set({
        name: myName || 'Unnamed',
        role: myRole || null,
        since: Date.now(),
        lastSeen: Date.now()
      });
      if (!logged) {
        logged = true;
        logSignIn('opened');
      }
    });

    setInterval(function() {
      if (presenceRef) {
        presenceRef.update({ lastSeen: Date.now(), name: myName || 'Unnamed', role: myRole || null });
      }
    }, 30000);

    window.addEventListener('pagehide', function() {
      if (presenceRef) presenceRef.remove();
    });
  }

  function watchPresence() {
    if (!isConfigured || !roomCode) return;
    db.ref('tally/rooms/' + roomCode + '/presence').on('value', function(snap) {
      const val = snap.val() || {};
      const cutoff = Date.now() - 90000;
      const people = Object.keys(val)
        .map(function(k) { return { id: k, ...val[k] }; })
        .filter(function(p) { return (p.lastSeen || 0) > cutoff; })
        .sort(function(a, b) { return (a.since || 0) - (b.since || 0); });

      const countEl = document.getElementById('activeCount');
      const listEl = document.getElementById('activeList');
      if (!countEl || !listEl) return;

      countEl.textContent = '(' + people.length + ')';

      if (!people.length) {
        listEl.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px 0;">Nobody else right now.</div>';
        return;
      }

      listEl.innerHTML = people.map(function(p) {
        const mins = Math.max(0, Math.round((Date.now() - (p.since || Date.now())) / 60000));
        const dur = mins < 1 ? 'just opened' : (mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h');
        const isMe = p.id === SESSION_ID;
        return '<div class="store-entry' + (isMe ? ' active' : '') + '">' +
          '<span class="code">' + escapeHtml(p.name || 'Unnamed') + (isMe ? ' (you)' : '') +
            (p.role ? '<span class="role-tag">' + escapeHtml(p.role) + '</span>' : '') + '</span>' +
          '<span style="font-size:10px;color:var(--text-dim);">' + dur + '</span>' +
        '</div>';
      }).join('');
    });
  }

  function initSync() {
    if (!isConfigured) {
      setSyncStatus('Not connected — finish setup above', false);
      render();
      return;
    }

    // Show whatever we last had on this device straight away, so the app is
    // usable in the freezer before (or without) any connection.
    const cached = loadLocal();
    // An EMPTY cache is never authoritative. Adopting it would blank the list
    // and then push that blank list over the real inventory on the next tap.
    if (cached && Array.isArray(cached.items) && cached.items.length) {
      items = cached.items;
      hasPending = !!cached.pending;
      suppressRemote = hasPending;
      minimized.clear();
      expanded.clear();
      items.forEach(function (it, i) { minimized.add(i); });
      render();
      setOfflineBanner();
    } else {
      hasPending = false;
      suppressRemote = false;
    }

    db.ref('.info/connected').on('value', function(snap) {
      const was = isOnline;
      isOnline = snap.val() === true;
      setOfflineBanner();
      if (isOnline) {
        setSyncStatus('Connected', false);
        if (!was && hasPending) flushPending();
      } else {
        setSyncStatus('Offline', false);
      }
    });

    let firstLoad = true;
    itemsRef.on('value', function(snapshot) {
      // Don't let the server overwrite work we haven't pushed yet
      if (suppressRemote && hasPending) {
        if (firstLoad) { firstLoad = false; runUrlCommand(); }
        return;
      }
      const val = snapshot.val();
      items = val && val.list ? val.list : [];
      saveLocal();
      if (firstLoad) {
        minimized.clear();
        expanded.clear();
        items.forEach(function(it, i) { minimized.add(i); });
      }
      render();
      updateCollapseAllBtn();
      if (firstLoad) {
        firstLoad = false;
        runUrlCommand();
      }
    }, function(err) {
      setSyncStatus('Sync error: ' + err.message, false);
    });
  }

  function runUrlCommand() {
    const params = new URLSearchParams(window.location.search);
    const cmd = params.get('cmd');
    if (!cmd) return;
    document.getElementById('commandInput').value = wordsToDigits(cmd);
    submitGlobalCommand(true);
    const clean = window.location.pathname;
    window.history.replaceState({}, '', clean);
  }

  // ===================== OFFLINE =====================
  // Everything you do offline is kept on the device and pushed when you're back.
  let isOnline = false;          // Firebase connection, not just wifi
  let hasPending = false;        // local edits not yet written to the server
  let suppressRemote = false;    // ignore server echoes while we hold unsynced work

  function localKey() { return 'tally_local_' + (roomCode || 'MAIN'); }

  function saveLocal() {
    try {
      localStorage.setItem(localKey(), JSON.stringify({
        items: items,
        savedAt: Date.now(),
        pending: hasPending
      }));
    } catch (e) {}
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(localKey());
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && Array.isArray(data.items)) ? data : null;
    } catch (e) { return null; }
  }

  // ===================== SYNC VERIFICATION =====================
  // The connection dot only says a socket is open. This actually compares what
  // this device holds against what's in the database, so silent divergence
  // gets caught before it turns into lost counts.
  let lastVerify = 0;
  let verifyState = 'unknown';   // 'ok' | 'drift' | 'error' | 'unknown'

  function fingerprint(list) {
    if (!Array.isArray(list)) return '0:';
    // name + units is enough to spot divergence without hashing everything
    return list.length + ':' + list.map(function (it) {
      return (it.name || '') + '=' + (it.units || 0);
    }).sort().join('|');
  }

  async function verifySync(force) {
    if (!isConfigured || !itemsRef || !isOnline) return;
    if (hasPending) return;                       // nothing to compare against yet
    if (!force && Date.now() - lastVerify < 90000) return;
    lastVerify = Date.now();
    try {
      const snap = await itemsRef.get();
      const val = snap.val();
      const remote = (val && val.list) || [];
      const same = fingerprint(remote) === fingerprint(items);
      verifyState = same ? 'ok' : 'drift';
      if (!same) {
        console.warn('Tally: local and server copies differ');
        showDrift(remote);
      }
      setConnDot();
    } catch (e) {
      verifyState = 'error';
      setConnDot();
    }
  }

  function showDrift(remote) {
    const bar = document.getElementById('driftBar');
    if (!bar) return;
    bar.innerHTML =
      '<span>\u26A0\uFE0F This phone and the server disagree about the counts.</span>' +
      '<button type="button" id="driftUse">Use server</button>' +
      '<button type="button" id="driftPush">Use mine</button>';
    bar.style.display = 'flex';

    on('driftUse', 'click', function () {
      items = remote;
      minimized.clear(); expanded.clear();
      items.forEach(function (it, i) { minimized.add(i); });
      saveLocal();
      render();
      bar.style.display = 'none';
      verifyState = 'ok';
      setConnDot();
      showCommandToast('Loaded the server copy');
    });

    on('driftPush', 'click', function () {
      snapshotForUndo('overwrite server');
      saveItems();
      bar.style.display = 'none';
      verifyState = 'ok';
      setConnDot();
      showCommandToast('Pushed this phone\'s copy');
    });
  }

  function setConnDot() {
    const d = document.getElementById('connDot');
    const t = document.getElementById('connTxt');
    if (!d || !t) return;
    d.classList.remove('offline', 'pending', 'syncing');
    if (!isOnline && hasPending) { d.classList.add('offline'); t.textContent = 'saved here'; }
    else if (!isOnline)          { d.classList.add('offline'); t.textContent = 'offline'; }
    else if (hasPending)         { d.classList.add('pending', 'syncing'); t.textContent = 'syncing'; }
    else if (verifyState === 'drift') { d.classList.add('pending'); t.textContent = 'check'; }
    else                         { t.textContent = ''; }
  }

  function setOfflineBanner() {
    setConnDot();
    const el = document.getElementById('offlineBar');
    if (!el) return;
    if (!isOnline && hasPending) {
      el.textContent = '\u26A1 Offline \u2014 your changes are saved on this device and will sync when you reconnect';
      el.className = 'offline-bar pending';
    } else if (!isOnline) {
      el.textContent = '\u26A1 Offline \u2014 you can keep counting';
      el.className = 'offline-bar';
    } else if (hasPending) {
      el.textContent = '\u21BB Syncing your offline changes\u2026';
      el.className = 'offline-bar syncing';
    } else {
      el.className = 'offline-bar hidden';
    }
  }

  let sawItems = false;   // this session has seen a non-empty list
  let allowEmptySave = false;

  function saveItems() {
    // Refuse to push an empty list over a list we know had items, unless the
    // user actually emptied it themselves. Silent wipes are unrecoverable
    // without a backup, so this is worth being paranoid about.
    if (!items.length && sawItems && !allowEmptySave) {
      setSyncStatus('Blocked an empty save \u2014 reload to restore', false);
      console.warn('Tally: refused to save an empty item list');
      return;
    }
    if (items.length) sawItems = true;
    saveLocal();
    // Local copy is always kept; the remote write needs a resolved store
    if (!isConfigured || !itemsRef) return;

    if (!isOnline) {
      hasPending = true;
      suppressRemote = true;
      saveLocal();
      setOfflineBanner();
      return;
    }

    setSyncStatus('Saving...', true);
    itemsRef.set({ list: items }).then(function() {
      hasPending = false;
      suppressRemote = false;
      allowEmptySave = false;
      saveLocal();
      setOfflineBanner();
      setSyncStatus('Connected', false);
      maybeAutoSnapshot();
      setTimeout(function () { verifySync(true); }, 1500);
    }).catch(function(err) {
      // Treat any failed write as pending rather than losing it
      hasPending = true;
      suppressRemote = true;
      saveLocal();
      setOfflineBanner();
      setSyncStatus('Save failed: ' + err.message, false);
    });
  }

  function flushPending() {
    if (!hasPending || !isOnline || !isConfigured || !itemsRef) return;
    setOfflineBanner();
    itemsRef.set({ list: items }).then(function () {
      hasPending = false;
      suppressRemote = false;
      saveLocal();
      setOfflineBanner();
      showCommandToast('Offline changes synced');
      maybeAutoSnapshot();
    }).catch(function () {
      // stay pending; we'll try again on the next reconnect
    });
  }

  function lowThresholdUnits(item) {
    if (!item) return null;
    if (item.lowStockValue != null) {
      return item.lowStockMode === 'unit'
        ? item.lowStockValue
        : item.lowStockValue * (item.caseSize || 1);
    }
    if (item.lowCases != null) return item.lowCases * (item.caseSize || 1);
    if (item.lowStock != null) return item.lowStock;
    return null;
  }

  function lowThresholdLabel(item) {
    if (item.lowStockValue != null) {
      return Number(item.lowStockValue.toFixed(2)) + (item.lowStockMode === 'unit' ? ' un' : ' cs');
    }
    if (item.lowCases != null) return Number(item.lowCases.toFixed(2)) + ' cs';
    if (item.lowStock != null) return item.lowStock + ' un';
    return null;
  }

  // ---------- haptics ----------
  function buzz(ms) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms || 12); } catch (e) {}
    }
  }


  // ---------- count change flash ----------
  let pendingBump = null;
  function bumpCount(idx) {
    pendingBump = idx;
  }
  function applyBump() {
    if (pendingBump == null) return;
    const els = document.querySelectorAll('[data-count="' + pendingBump + '"]');
    els.forEach(function (el) {
      el.classList.remove('count-bump');
      void el.offsetWidth;
      el.classList.add('count-bump');
    });
    pendingBump = null;
  }

  // ---------- theme ----------
  function applyTheme() {
    const light = localStorage.getItem('tally_theme') === 'light';
    document.body.classList.toggle('light', light);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.innerHTML = light ? '&#9728;' : '&#9789;';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#faf3ec' : '#17110e');
  }

  document.getElementById('themeToggle').addEventListener('click', function () {
    const light = localStorage.getItem('tally_theme') === 'light';
    localStorage.setItem('tally_theme', light ? 'dark' : 'light');
    applyTheme();
    buzz(8);
  });

  applyTheme();

  function touchItem(item) {
    if (item) item.touched = Date.now();
  }

  function pushHistory(item, delta, kind) {
    if (!item.history) item.history = [];
    const entry = { ts: Date.now(), delta: delta, actor: myName || 'someone' };
    if (myRole) entry.role = myRole;
    if (item && item.lastVariant) entry.variant = item.lastVariant;
    if (kind) entry.kind = kind;
    item.history.push(entry);
    if (item.history.length > 300) item.history = item.history.slice(-300);
    touchItem(item);
  }

  function updateSortToggle() {
    const btn = document.getElementById('sortToggle');
    btn.textContent = sortMode === 'recent' ? 'Recent first' : 'Manual order';
    btn.classList.toggle('recent', sortMode === 'recent');
  }

  document.getElementById('collapseAllBtn').addEventListener('click', function() {
    const allCollapsed = items.length > 0 && items.every(function(it, i) { return minimized.has(i); });
    if (allCollapsed) {
      minimized.clear();
    } else {
      items.forEach(function(it, i) { minimized.add(i); });
      expanded.clear();
    }
    updateCollapseAllBtn();
    render();
  });

  function updateCollapseAllBtn() {
    const btn = document.getElementById('collapseAllBtn');
    if (!btn) return;
    const allCollapsed = items.length > 0 && items.every(function(it, i) { return minimized.has(i); });
    btn.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
  }

  document.getElementById('sortToggle').addEventListener('click', function() {
    sortMode = sortMode === 'recent' ? 'manual' : 'recent';
    localStorage.setItem('tally_sort', sortMode);
    updateSortToggle();
    render();
  });

  updateSortToggle();

  document.getElementById('searchToggle').addEventListener('click', function() {
    const bar = document.getElementById('searchBar');
    const input = document.getElementById('searchInput');
    const nowExpanded = bar.classList.toggle('expanded');
    if (nowExpanded) {
      input.focus();
    } else {
      input.value = '';
      searchQuery = '';
      render();
    }
  });

  document.getElementById('searchInput').addEventListener('input', function(e) {
    searchQuery = e.target.value;
    render();
  });

  // ===================== PACK TYPES =====================
  // Not everything comes in a case: icing is a bucket, sprinkles a box, etc.
  const PACK_TYPES = {
    case:   { one: 'case',   many: 'cases',   short: 'cs',  unit: 'unit',   units: 'units' },
    bucket: { one: 'bucket', many: 'buckets', short: 'bkt', unit: 'scoop',  units: 'scoops' },
    box:    { one: 'box',    many: 'boxes',   short: 'bx',  unit: 'unit',   units: 'units' },
    bag:    { one: 'bag',    many: 'bags',    short: 'bag', unit: 'unit',   units: 'units' },
    tub:    { one: 'tub',    many: 'tubs',    short: 'tub', unit: 'unit',   units: 'units' },
    tray:   { one: 'tray',   many: 'trays',   short: 'tray', unit: 'unit',  units: 'units' }
  };

  function packOf(item) {
    return PACK_TYPES[(item && item.packType) || 'case'] || PACK_TYPES.case;
  }

  function packLabel(item, n) {
    const p = packOf(item);
    return n === 1 ? p.one : p.many;
  }

  function unitLabel(item, n) {
    const p = packOf(item);
    return n === 1 ? p.unit : p.units;
  }

  // ===================== CATEGORIES =====================
  // Seeded from the store's finishing chart; editable in Admin.
  const CATEGORY_DEFAULTS = ['Donuts', 'Bagels', 'Specialty', 'Munchkins', 'Muffins'];

  let categories = CATEGORY_DEFAULTS.slice();
  let catFilter = localStorage.getItem('tally_catfilter') || '';

  function catsRef() {
    return db.ref('tally/rooms/' + roomCode + '/categories');
  }

  async function loadCategories() {
    if (!isConfigured || !roomCode) return;
    try {
      const snap = await catsRef().get();
      const val = snap.val();
      if (Array.isArray(val) && val.length) {
        categories = val;
      } else {
        categories = CATEGORY_DEFAULTS.slice();
        await catsRef().set(categories).catch(function () {});
      }
    } catch (e) {}
  }

  async function saveCategories() {
    if (!isConfigured || !roomCode) return;
    try { await catsRef().set(categories); } catch (e) {}
  }

  // Best-guess category from an item name, used when seeding or adding
  function guessCategory(name) {
    const n = String(name).toLowerCase();
    if (/munchkin/.test(n)) return 'Munchkins';
    if (/bagel/.test(n)) return 'Bagels';
    if (/muffin/.test(n)) return 'Muffins';
    if (/croissant|fritter|coffee roll|fancy|stick|baker.s choice/.test(n)) return 'Specialty';
    if (/donut|ring|frost|glaz|kreme|creme|jelly|cruller|chocolate|sprinkle|sugar/.test(n)) return 'Donuts';
    return '';
  }

  function itemCategory(item) {
    return item.category || '';
  }

  function renderCatStrip() {
    const strip = document.getElementById('catStrip');
    if (!strip) return;

    const counts = {};
    let uncat = 0;
    items.forEach(function (it) {
      const cat = itemCategory(it);
      if (cat) counts[cat] = (counts[cat] || 0) + 1;
      else uncat++;
    });

    // "All" is always available, then every category that has items, in your order
    let html = '<button type="button" class="cat-chip' + (catFilter ? '' : ' on') +
      '" data-cat="">All ' + items.length + '</button>';

    categories.forEach(function (cat) {
      if (!counts[cat]) return;
      html += '<button type="button" class="cat-chip' + (catFilter === cat ? ' on' : '') +
        '" data-cat="' + escapeHtml(cat) + '">' + escapeHtml(cat) + ' ' + counts[cat] + '</button>';
    });

    if (uncat) {
      html += '<button type="button" class="cat-chip' + (catFilter === '__none' ? ' on' : '') +
        '" data-cat="__none">Uncategorised ' + uncat + '</button>';
    }

    strip.innerHTML = items.length ? html : '';
  }

  document.getElementById('catStrip').addEventListener('click', function (e) {
    const chip = e.target.closest('button[data-cat]');
    if (!chip) return;
    catFilter = chip.getAttribute('data-cat');
    localStorage.setItem('tally_catfilter', catFilter);
    render();
  });

  // Register the service worker so the app opens without a connection.
  // Harmless if sw.js isn't uploaded — the app just won't launch offline.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  window.addEventListener('online', function () {
    if (isConfigured && db) { try { db.goOnline(); } catch (e) {} }
  });

  window.addEventListener('offline', function () {
    isOnline = false;
    setOfflineBanner();
  });

  // Warn before leaving with unsynced work
  window.addEventListener('beforeunload', function (e) {
    if (hasPending) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Expand/collapse the admin sections
  document.getElementById('adminPanel').addEventListener('click', function (e) {
    const head = e.target.closest('.admin-sec-head');
    if (!head) return;
    head.parentElement.classList.toggle('open');
  });

  // Bind only if the element exists — a missing id must never break everything
  // that gets wired up after it.
  function on(id, evt, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
    return !!el;
  }

  // ---- admin sub-screens (moved out of the old accordion) ----
  function adminScreen(title, sub, html, onReady) {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML =
      '<div class="audit-item-name">' + title + '</div>' +
      (sub ? '<div class="audit-sub">' + sub + '</div>' : '') +
      html +
      '<div class="audit-actions"><button type="button" id="adminScrClose">Close</button></div>';
    on('adminScrClose', 'click', closeAudit);
    if (onReady) onReady();
  }

  function showStores() {
    adminScreen('Stores', 'Each store keeps its own inventory.',
      '<div id="storeList" class="store-list"></div>' +
      '<div class="admin-row" style="margin-top:10px;">' +
        '<input type="text" id="newStoreCode" placeholder="New store code" maxlength="12" autocapitalize="characters">' +
        '<button type="button" class="admin-mini-btn" id="createStoreBtn">Create</button>' +
      '</div>' +
      '<div class="admin-row">' +
        '<button type="button" class="admin-mini-btn" id="shareStoreBtn">Share this store\'s link</button>' +
      '</div>',
      function () {
        refreshStoreList();
        on('createStoreBtn', 'click', async function () {
          const code = normalizeRoom(document.getElementById('newStoreCode').value);
          if (!code) { document.getElementById('newStoreCode').style.borderColor = 'var(--red)'; return; }
          try {
            const stores = await addStore(code);
            document.getElementById('newStoreCode').value = '';
            renderStoreList(stores);
          } catch (e) {
            alert('Could not create store \u2014 this device is not an approved admin device.');
          }
        });
        on('shareStoreBtn', 'click', function () {
          const url = window.location.origin + window.location.pathname + '?store=' + roomCode;
          if (navigator.share) navigator.share({ title: 'Tally \u2014 ' + roomCode, url: url }).catch(function () {});
          else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { alert('Link copied.'); });
          else prompt('Copy this link:', url);
        });
        on('storeList', 'click', function (e) {
          const b = e.target.closest('button[data-store]');
          if (b) goToStore(b.getAttribute('data-store'));
        });
      });
  }

  function showDevices() {
    adminScreen('Admin devices', 'Devices that can change settings.',
      '<div id="deviceList" class="store-list"></div>' +
      '<div class="admin-row" style="margin-top:10px;">' +
        '<button type="button" class="admin-mini-btn" id="deviceIdBtn">Copy this device ID</button>' +
        '<button type="button" class="admin-mini-btn" id="addDeviceBtn">Add by ID</button>' +
      '</div>' +
      '<div class="audit-summary">A device ID changes if someone clears their browser data or switches phones. Easiest way to grant admin is the star in Staff.</div>',
      function () {
        loadConfig().then(function (cfg) { renderApprovedDevices(cfg); }).catch(function () {});
        on('deviceIdBtn', 'click', function () {
          if (!myUid) { alert('Not signed in yet.'); return; }
          if (navigator.clipboard) navigator.clipboard.writeText(myUid).then(function () { alert('Device ID copied:\n\n' + myUid); });
          else prompt('Device ID:', myUid);
        });
        on('addDeviceBtn', 'click', async function () {
          const uid = prompt('Paste the device ID to approve:');
          if (uid === null || !uid.trim()) return;
          const label = (prompt('Name this device:', 'Device') || 'Device').trim().slice(0, 30);
          try {
            const update = {};
            update['adminUids/' + uid.trim()] = { label: label, addedAt: Date.now() };
            await configRef().update(update);
            renderApprovedDevices(await loadConfig());
            alert('Device approved.');
          } catch (e) {
            alert('Could not approve \u2014 this device is not an approved admin device.');
          }
        });
        on('deviceList', 'click', async function (e) {
          const b = e.target.closest('button[data-revoke]');
          if (!b) return;
          if (!confirm('Revoke admin access for this device?')) return;
          try {
            await configRef().child('adminUids').child(b.getAttribute('data-revoke')).remove();
            renderApprovedDevices(await loadConfig());
          } catch (err) {
            alert('Could not revoke.');
          }
        });
      });
  }

  function showSecurity() {
    adminScreen('Security', null,
      '<div class="admin-row">' +
        '<button type="button" class="admin-mini-btn" id="changePassBtn">Change admin password</button>' +
      '</div>' +
      '<div class="admin-row">' +
        '<button type="button" class="admin-mini-btn danger" id="resetAdminBtn">Reset admin</button>' +
      '</div>' +
      '<div class="audit-summary">Reset admin clears every approved admin device. The next device that opens Tally claims it \u2014 do that only when you are about to open it yourself.</div>',
      function () {
        on('changePassBtn', 'click', async function () {
          const p = prompt('New admin password (at least 4 characters):');
          if (p === null) return;
          if (p.length < 4) { alert('Too short.'); return; }
          try {
            await configRef().update({ adminHash: await hashPass(p) });
            alert('Password updated.');
          } catch (e) {
            alert('Could not update password \u2014 this device is not an approved admin device.');
          }
        });
        on('resetAdminBtn', 'click', async function () {
          if (!confirm('Clear ALL approved admin devices?\n\nThe next device that opens Tally becomes the admin.')) return;
          try {
            await configRef().child('adminUids').remove();
            await configRef().child('adminUid').remove();
            alert('Admin cleared. Reload on the device you want as admin.');
            isAdmin = false;
            sessionStorage.removeItem('tally_admin');
            closeAudit();
            document.getElementById('adminPanel').style.display = 'none';
            document.getElementById('adminBtn').style.display = 'none';
          } catch (e) {
            alert('Could not reset \u2014 this device is not an approved admin device.');
          }
        });
      });
  }

  on('storesBtn', 'click', showStores);
  on('devicesBtn', 'click', showDevices);
  on('securityBtn', 'click', showSecurity);

  const NAV_TABS = {
    count: { label: 'Count', items: [
      ['barcodeBtn', '\uD83D\uDD22', 'Scan barcode', 'One by one, or a whole delivery then review'],
      ['sheetBtn',   '\uD83D\uDCCB', 'Scan production', 'Order sheets and delivery invoices'],
      ['trayBtn',    '\uD83E\uDD6F', 'Count a tray', 'Munchkins and loose product \u2014 photo or tap it out'],
      ['auditBtn',   '\u2705', 'Spot audit', 'Count a random sample, tap or hands-free']
    ]},
    order: { label: 'Ordering', items: [
      ['orderBtn',   '\uD83D\uDED2', 'Order list', 'What to order, from your real usage'],
      ['usageBtn',   '\uD83E\uDDEA', 'Usage breakdown', 'Icing and filling used, worked out from recipes'],
      ['varianceBtn','\uD83D\uDCC9', 'Variance history', 'Estimated vs actual, tracked over time']
    ]},
    review: { label: 'Review', items: [
      ['wasteBtn',    '\uD83D\uDDD1', 'Waste', 'Last 4 weeks, worst first'],
      ['auditHistBtn','\uD83D\uDCDC', 'Audit log', 'Past counts and discrepancies'],
      ['recipesBtn',  '\uD83D\uDCD6', 'Recipes', 'Base, filling and toppings for every donut']
    ]},
    more: { label: 'More', items: [
      ['catBtn',    '\uD83C\uDFF7', 'Categories', 'Rename, reorder, add'],
      ['bugMenuBtn','\uD83D\uDC1B', 'Report a problem', 'Goes straight to the manager'],
      ['tourBtn',   '\uD83C\uDF93', 'Show me around', 'Replay the walkthrough'],
      ['adminBtn',  '\uD83D\uDD12', 'Admin', 'Staff, devices, backups']
    ]}
  };

  let navTab = 'count';

  function renderSheet() {
    const tab = NAV_TABS[navTab];
    if (!tab) return;
    document.getElementById('sheetBody').innerHTML =
      '<div class="sheet-group">' +
        '<div class="sheet-label">' + tab.label + '</div>' +
        tab.items.map(function (r) {
          return '<button type="button" class="sheet-item" id="' + r[0] + '">' +
            '<span class="si-icon">' + r[1] + '</span>' +
            '<span class="si-text"><b>' + r[2] + '</b><i>' + r[3] + '</i></span>' +
          '</button>';
        }).join('') +
      '</div>';
    wireSheetActions();
  }

  function wireSheetActions() {
    const map = {
      barcodeBtn: chooseBarcodeMode,
      sheetBtn: openProductionPicker,
      trayBtn: openTrayPicker,
      auditBtn: startAudit,
      orderBtn: showOrderList,
      usageBtn: showUsage,
      varianceBtn: showVariance,
      wasteBtn: showWasteReport,
      auditHistBtn: showAuditHistory,
      recipesBtn: showRecipes,
      catBtn: showCategories,
      bugMenuBtn: openBugReport,
      tourBtn: replayTour,
      adminBtn: toggleAdmin
    };
    Object.keys(map).forEach(function (id) {
      on(id, 'click', function () { closeMenu(); map[id](); });
    });
  }

  function replayTour() {
    localStorage.removeItem('tally_tour_done');
    maybeStartTour();
  }

  function openMenu() {
    document.getElementById('menuScrim').style.display = 'block';
    document.getElementById('menuSheet').style.display = 'block';
  }

  function closeMenu() {
    document.getElementById('menuScrim').style.display = 'none';
    document.getElementById('menuSheet').style.display = 'none';
    const nav = document.getElementById('bnav');
    if (nav) Array.from(nav.children).forEach(function (x, i) {
      x.classList.toggle('active', i === 0);
    });
    navTab = 'count';
  }

  document.getElementById('bnav').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-nav]');
    if (!b) return;
    const tab = b.getAttribute('data-nav');
    Array.from(this.children).forEach(function (x) { x.classList.toggle('active', x === b); });
    navTab = tab;
    renderSheet();
    openMenu();
  });
  document.getElementById('menuClose').addEventListener('click', closeMenu);
  document.getElementById('menuScrim').addEventListener('click', closeMenu);

  // Picking anything in the menu closes it first, so the screen you open is clean
  document.getElementById('menuSheet').addEventListener('click', function (e) {
    if (e.target.closest('.sheet-item')) closeMenu();
  }, true);

  // ============ PENDING-APPROVAL ALERTS FOR ADMINS ============
  let pendingWatch = null;
  let knownPending = {};

  function watchPendingStaff() {
    if (!isConfigured || !roomCode || pendingWatch) return;
    pendingWatch = db.ref('tally/rooms/' + roomCode + '/staff');
    pendingWatch.on('value', function (snap) {
      const val = snap.val() || {};
      const waiting = Object.keys(val)
        .map(function (k) { return Object.assign({ id: k }, val[k]); })
        .filter(function (p) { return p.pending && p.uid; });

      // Ring only for people we haven't already been told about
      waiting.forEach(function (p) {
        if (!knownPending[p.id]) {
          knownPending[p.id] = true;
          notifyAdmin(p);
        }
      });
      Object.keys(knownPending).forEach(function (id) {
        if (!waiting.some(function (p) { return p.id === id; })) delete knownPending[id];
      });

      renderPendingBar(waiting);
    });
  }

  function renderPendingBar(waiting) {
    const bar = document.getElementById('pendingBar');
    if (!bar) return;
    if (!isAdmin || !waiting.length) {
      bar.style.display = 'none';
      return;
    }
    const names = waiting.map(function (p) {
      return escapeHtml(p.name || 'Someone') + (p.role ? ' (' + escapeHtml(p.role) + ')' : '');
    }).join(', ');
    bar.innerHTML =
      '<span>&#128100; ' + names + ' ' + (waiting.length > 1 ? 'are' : 'is') + ' waiting for approval</span>' +
      '<button type="button" id="pendingReview">Review</button>';
    bar.style.display = 'flex';
    document.getElementById('pendingReview').addEventListener('click', showStaff);
  }

  function notifyAdmin(person) {
    if (!isAdmin) return;
    buzz([60, 40, 60]);
    const who = (person.name || 'Someone') + (person.role ? ' (' + person.role + ')' : '');
    showCommandToast(who + ' is waiting for approval', true);

    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const body = who + ' set up a profile and needs approving.';
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) {
          reg.showNotification('Tally — approval needed', {
            body: body, tag: 'tally-pending', renotify: true
          });
        }).catch(function () { new Notification('Tally — approval needed', { body: body }); });
      } else {
        new Notification('Tally — approval needed', { body: body });
      }
    } catch (e) {}
  }

  function askNotifyPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    Notification.requestPermission().catch(function () {});
  }

  // ===================== FIRST-RUN TOUR =====================
  // Spotlight tour: dims the screen, cuts a hole around the real control,
  // and explains it. Falls back to a centred card when there's nothing to point at.
  const TOUR = [
    { target: null, icon: '\uD83C\uDF69', title: 'Welcome to Tally',
      text: 'This is how we track what\u2019s in the freezer, so nobody has to guess what to order. Two minutes and you\u2019ll know the whole thing.' },

    { target: '#itemList .item-card', place: 'below', title: 'Every product is a row',
      text: 'The little ring on the left fills up as stock goes up, and turns red when you\u2019re running low. The big number is how many cases you have.' },

    { target: '#itemList .item-card', place: 'below', title: 'Open one to count it',
      text: 'Tap any row to open it. You\u2019ll get big + and \u2212 buttons for whole cases, half cases, and single pieces.' },

    { target: '#itemList .item-card', place: 'below', title: 'Faster: swipe',
      text: 'On a closed row, swipe right to add a case and left to take one off. Handy when you\u2019re moving down a shelf.' },

    { target: '.cmd-main', place: 'below', title: 'Or talk to it',
      text: 'Tap the mic and say it plainly: \u201cadd 3 cases of croissants\u201d, \u201cremove 5 bagels\u201d, \u201chalf a case of hash browns\u201d. It understands numbers spoken as words too.' },

    { target: '.cmd-tools', place: 'below', title: 'Hands-free in the freezer',
      text: 'Hands-free keeps the mic listening so you can count with gloves on. The speaker button makes it read results back to you.' },

    { target: '.cat-strip', place: 'below', title: 'Jump to what you need',
      text: 'Filter to Donuts, Bagels, Munchkins and the rest. Tap All to see everything again.' },

    { target: '.bnav', place: 'above', title: 'Everything else is down here',
      text: 'Count is scanning and audits. Order is what to buy. Review is waste, history and recipes. More is settings and reporting a problem.' },

    { target: '.bnav-btn:nth-child(1)', place: 'above', title: 'Count',
      text: 'Scan a barcode on a case, photograph the order sheet, or count a tray of munchkins by camera. There\u2019s a spot audit in here too.' },

    { target: '.bnav-btn:nth-child(2)', place: 'above', title: 'Order',
      text: 'The order list works out what to buy from how fast things actually move here \u2014 not a fixed number someone guessed once.' },

    { target: null, icon: '\uD83D\uDDD1', title: 'Waste goes in Waste',
      text: 'If you throw something out, open the item and use the Waste button rather than just subtracting. Waste is kept separate so it never inflates what we order next week.' },

    { target: null, icon: '\uD83E\uDD6F', title: 'Munchkins and loose product',
      text: 'For trays, use Count a tray. Photograph it and the app counts them, then you tap to fix any it got wrong. Or tap it out by hand with big buttons.' },

    { target: null, icon: '\u2744', title: 'The freezer has no signal \u2014 that\u2019s fine',
      text: 'Keep counting. Everything saves on the phone and syncs the second you walk back out. The dot in the corner tells you where things stand: green is synced, red is offline.' },

    { target: null, icon: '\uD83D\uDC1B', title: 'If something\u2019s wrong, say so',
      text: 'More \u2192 Report a problem sends it straight to the manager, even from the freezer. If a count looks wrong or a button does nothing, that\u2019s worth reporting.' },

    { target: null, icon: '\u2705', title: 'That\u2019s it',
      text: 'You can replay this any time from More \u2192 Show me around. Go count something.' }
  ];

  let tourStep = 0;

  function maybeStartTour() {
    if (localStorage.getItem('tally_tour_done') === '1') return;
    tourStep = 0;
    document.getElementById('tourLayer').style.display = 'block';
    drawTour();
  }

  function drawTour() {
    const s = TOUR[tourStep];
    const layer = document.getElementById('tourLayer');
    const hole = document.getElementById('tourHole');
    const card = document.getElementById('tourCard');
    if (!s || !layer) return;

    let rect = null;
    if (s.target) {
      const el = document.querySelector(s.target);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.bottom > 0 && r.top < window.innerHeight) rect = r;
      }
    }

    if (rect) {
      const pad = 6;
      hole.style.display = 'block';
      hole.style.top = (rect.top - pad) + 'px';
      hole.style.left = (rect.left - pad) + 'px';
      hole.style.width = (rect.width + pad * 2) + 'px';
      hole.style.height = (rect.height + pad * 2) + 'px';
    } else {
      hole.style.display = 'none';
    }

    card.innerHTML =
      (s.icon ? '<div class="tour-icon">' + s.icon + '</div>' : '') +
      '<h2>' + s.title + '</h2>' +
      '<p>' + s.text + '</p>' +
      '<div class="tour-dots">' +
        TOUR.map(function (_, i) {
          return '<span class="tour-dot' + (i === tourStep ? ' on' : '') + '"></span>';
        }).join('') +
      '</div>' +
      '<div class="tour-actions">' +
        '<button type="button" class="tour-skip" id="tourSkip">' +
          (tourStep === TOUR.length - 1 ? 'Done' : 'Skip') + '</button>' +
        '<button type="button" class="tour-next" id="tourNext">' +
          (tourStep === TOUR.length - 1 ? 'Start counting' : 'Next') + '</button>' +
      '</div>';

    // Put the card clear of whatever is highlighted
    card.style.top = '';
    card.style.bottom = '';
    if (rect && s.place === 'above') {
      card.style.bottom = Math.min(window.innerHeight - rect.top + 18, window.innerHeight - 220) + 'px';
    } else if (rect && rect.top < window.innerHeight * 0.5) {
      card.style.top = Math.min(rect.bottom + 18, window.innerHeight - 240) + 'px';
    } else if (rect) {
      card.style.bottom = Math.min(window.innerHeight - rect.top + 18, window.innerHeight - 240) + 'px';
    } else {
      card.style.top = '50%';
      card.style.transform = 'translateY(-50%)';
    }
    if (rect) card.style.transform = '';

    document.getElementById('tourNext').addEventListener('click', function () {
      if (tourStep === TOUR.length - 1) { endTour(); return; }
      tourStep++;
      drawTour();
    });
    document.getElementById('tourSkip').addEventListener('click', endTour);
  }

  function endTour() {
    localStorage.setItem('tally_tour_done', '1');
    const layer = document.getElementById('tourLayer');
    if (layer) layer.style.display = 'none';
  }

  window.addEventListener('resize', function () {
    const layer = document.getElementById('tourLayer');
    if (layer && layer.style.display === 'block') drawTour();
  });

  // ============ RECIPE VOCABULARY (from the store's finishing chart) ============
  const BASES = [
    'Yeast Ring', 'Yeast Shell', 'Plain Cake Ring', 'Chocolate Cake Ring',
    'Blueberry Cake Ring', 'Sour Kreme Cake Ring', 'French Cruller', 'Stick',
    'Munchkin', 'Apple Fritter', 'Coffee Roll', 'Muffin', 'Bagel', 'Croissant', 'Other'
  ];

  const TOPPINGS = [
    'Glaze', 'Chocolate Icing', 'Vanilla Icing', 'Strawberry Icing', 'Maple Icing',
    'Choc & Van Icing', 'Powdered Sugar', 'Cinnamon Sugar', "Baker's Special Sugar",
    'Sprinkles', 'Toasted Coconut', 'Coffee Cake Streusel', 'Sanding Sugar', 'None'
  ];

  const FILLINGS = [
    'None', 'Bavarian Cream', 'Vanilla Kreme', 'Chocolate Kreme',
    'Apple', 'Lemon', 'Apple Raspberry Jelly'
  ];

  function baseToCategory(base) {
    if (base === 'Munchkin') return 'Munchkins';
    if (base === 'Bagel') return 'Bagels';
    if (base === 'Muffin') return 'Muffins';
    if (['Apple Fritter', 'Coffee Roll', 'Croissant', 'Stick', 'Other'].indexOf(base) !== -1) return 'Specialty';
    return 'Donuts';
  }

  // ============ RECIPE BOOK ============
  // Seeded exactly from the store's finishing chart. Editable in the app;
  // once saved it lives in Firebase with everything else.
  const RECIPE_SEED = [
    ['Apple N\' Spice',              'Yeast Shell',           'Apple',                 ['Cinnamon Sugar']],
    ['Bavarian Kreme',               'Yeast Shell',           'Bavarian Cream',        ['Powdered Sugar']],
    ['Blueberry Cake',               'Blueberry Cake Ring',   null,                    ['Glaze']],
    ['Boston Kreme',                 'Yeast Shell',           'Bavarian Cream',        ['Chocolate Icing']],
    ['Chocolate Frosted',            'Yeast Ring',            null,                    ['Chocolate Icing']],
    ['Chocolate Frosted Sprinkles',  'Yeast Ring',            null,                    ['Chocolate Icing', 'Sprinkles']],
    ['Chocolate Frosted Cake',       'Plain Cake Ring',       null,                    ['Chocolate Icing']],
    ['Chocolate Glazed',             'Chocolate Cake Ring',   null,                    ['Glaze']],
    ['Chocolate Kreme',              'Yeast Shell',           'Chocolate Kreme',       ['Powdered Sugar']],
    ['Cinnamon Cake',                'Plain Cake Ring',       null,                    ['Cinnamon Sugar']],
    ['Double Chocolate',             'Chocolate Cake Ring',   null,                    ['Chocolate Icing']],
    ['French Cruller',               'French Cruller',        null,                    ['Glaze']],
    ['Glazed',                       'Yeast Ring',            null,                    ['Glaze']],
    ['Jelly',                        'Yeast Shell',           'Apple Raspberry Jelly', ['Baker\'s Special Sugar']],
    ['Kreme Delight',                'Yeast Shell',           'Vanilla Kreme',         ['Chocolate Icing']],
    ['Lemon',                        'Yeast Shell',           'Lemon',                 ['Powdered Sugar']],
    ['Maple Frosted',                'Yeast Ring',            null,                    ['Maple Icing']],
    ['Marble Frosted',               'Yeast Ring',            null,                    ['Choc & Van Icing']],
    ['Old Fashioned',                'Plain Cake Ring',       null,                    []],
    ['Powdered Cake',                'Plain Cake Ring',       null,                    ['Powdered Sugar']],
    ['Sour Kreme',                   'Sour Kreme Cake Ring',  null,                    ['Glaze']],
    ['Stick - Glazed',               'Stick',                 null,                    ['Glaze']],
    ['Stick - Jelly',                'Stick',                 'Apple Raspberry Jelly', ['Baker\'s Special Sugar']],
    ['Stick - Plain',                'Stick',                 null,                    []],
    ['Strawberry Frosted',           'Yeast Ring',            null,                    ['Strawberry Icing']],
    ['Strawberry Frosted Sprinkles', 'Yeast Ring',            null,                    ['Strawberry Icing', 'Sprinkles']],
    ['Sugar Raised',                 'Yeast Ring',            null,                    ['Baker\'s Special Sugar']],
    ['Toasted Coconut',              'Plain Cake Ring',       null,                    ['Glaze', 'Toasted Coconut']],
    ['Vanilla Frosted',              'Yeast Ring',            null,                    ['Vanilla Icing']],
    ['Vanilla Frosted Sprinkles',    'Yeast Ring',            null,                    ['Vanilla Icing', 'Sprinkles']],
    ['Vanilla Kreme',                'Yeast Shell',           'Vanilla Kreme',         ['Powdered Sugar']],
    ['Apple Fritter',                'Apple Fritter',         'Apple',                 ['Glaze']],
    ['Coffee Roll',                  'Coffee Roll',           null,                    ['Glaze']],
    ['Blueberry Muffin',             'Muffin',                null,                    ['Sanding Sugar']],
    ['Chocolate Chip Muffin',        'Muffin',                null,                    ['Sanding Sugar']],
    ['Coffee Cake Muffin',           'Muffin',                null,                    ['Coffee Cake Streusel']],
    ['Corn Muffin',                  'Muffin',                null,                    []]
  ];

  let recipes = [];

  function recipesRef() { return db.ref('tally/rooms/' + roomCode + '/recipes'); }

  function seedRecipes() {
    return RECIPE_SEED.map(function (r) {
      return { name: r[0], base: r[1], filling: r[2], toppings: r[3] };
    });
  }

  async function loadRecipes() {
    if (!isConfigured || !roomCode) return;
    try {
      const snap = await recipesRef().get();
      const val = snap.val();
      if (Array.isArray(val) && val.length) recipes = val;
      else {
        recipes = seedRecipes();
        await recipesRef().set(recipes).catch(function () {});
      }
    } catch (e) { recipes = seedRecipes(); }
  }

  async function saveRecipes() {
    if (!isConfigured || !roomCode) return;
    try { await recipesRef().set(recipes); } catch (e) {}
  }

  function recipeFor(itemName) {
    const n = String(itemName || '').toLowerCase();
    // Exact first, then loose contains both ways
    let r = recipes.find(function (x) { return x.name.toLowerCase() === n; });
    if (r) return r;
    r = recipes.find(function (x) {
      const rn = x.name.toLowerCase();
      return n.indexOf(rn) !== -1 || rn.indexOf(n) !== -1;
    });
    return r || null;
  }

  // ============ COMPONENT USAGE ============
  // Links a recipe component ("Chocolate Icing") to a real inventory item
  // (a bucket) and how many donuts one full bucket finishes. From that we can
  // work out how much icing/filling went out with the donuts that were used.
  let components = {};   // { 'Chocolate Icing': { itemIdx|null, perPack: 400 } }

  function componentsRef() { return db.ref('tally/rooms/' + roomCode + '/components'); }

  async function loadComponents() {
    if (!isConfigured || !roomCode) return;
    try {
      const snap = await componentsRef().get();
      components = snap.val() || {};
    } catch (e) { components = {}; }
  }

  async function saveComponents() {
    if (!isConfigured || !roomCode) return;
    try { await componentsRef().set(components); } catch (e) {}
  }

  // Every component named anywhere in the recipe book
  function allComponents() {
    const set = {};
    recipes.forEach(function (r) {
      if (r.filling) set[r.filling] = 'filling';
      (r.toppings || []).forEach(function (t) { if (t) set[t] = set[t] || 'topping'; });
    });
    return Object.keys(set).sort().map(function (n) { return { name: n, kind: set[n] }; });
  }

  function componentItem(name) {
    const cfg = components[name];
    if (!cfg || cfg.itemName == null) return null;
    const idx = items.findIndex(function (it) { return it.name === cfg.itemName; });
    return idx === -1 ? null : { idx: idx, item: items[idx], perPack: cfg.perPack || 0 };
  }

  // How many donuts were finished in a window, per recipe component
  function componentUsage(days) {
    const since = Date.now() - (days || 28) * 86400000;
    const used = {};   // component -> donuts finished

    items.forEach(function (it) {
      const r = recipeFor(it.name);
      if (!r) return;
      const donuts = (it.history || [])
        .filter(function (h) { return h.ts >= since && h.delta < 0 && h.kind !== 'waste'; })
        .reduce(function (s, h) { return s + Math.abs(h.delta); }, 0);
      if (!donuts) return;
      if (r.filling) used[r.filling] = (used[r.filling] || 0) + donuts;
      (r.toppings || []).forEach(function (t) {
        used[t] = (used[t] || 0) + donuts;
      });
    });

    return Object.keys(used).map(function (name) {
      const donuts = used[name];
      const link = componentItem(name);
      const perPack = link ? link.perPack : 0;
      const est = perPack > 0 ? donuts / perPack : null;   // packs used
      let actual = null;
      if (link) {
        actual = (link.item.history || [])
          .filter(function (h) { return h.ts >= since && h.delta < 0; })
          .reduce(function (s, h) { return s + Math.abs(h.delta); }, 0) / (link.item.caseSize || 1);
      }
      return { name: name, donuts: donuts, link: link, estPacks: est, actualPacks: actual };
    }).sort(function (a, b) { return b.donuts - a.donuts; });
  }

  function showRecipes() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    function draw() {
      const rows = recipes.map(function (r, i) {
        const bits = [];
        if (r.base) bits.push(r.base);
        if (r.filling) bits.push('filled: ' + r.filling);
        if ((r.toppings || []).length) bits.push((r.toppings || []).join(' + '));
        return '<div class="audit-result-row">' +
          '<span>' + escapeHtml(r.name) +
            '<br><span style="font-size:11px;color:var(--text-dim);">' +
            escapeHtml(bits.join(' \u00b7 ') || 'nothing set') + '</span></span>' +
          '<span class="staff-actions">' +
            '<button type="button" class="staff-btn" data-recedit="' + i + '" title="Edit">&#9998;</button>' +
            '<button type="button" class="staff-btn del" data-recdel="' + i + '" title="Delete">&times;</button>' +
          '</span>' +
        '</div>';
      }).join('');

      body.innerHTML =
        '<div class="audit-item-name">Recipes</div>' +
        '<div class="audit-sub">' + recipes.length + ' recipes \u00b7 base, filling and toppings for each</div>' +
        rows +
        '<div class="admin-row" style="margin-top:12px;">' +
          '<input type="text" id="newRecName" placeholder="New donut name" maxlength="40">' +
          '<button type="button" class="admin-mini-btn" id="addRecBtn">Add</button>' +
        '</div>' +
        '<div class="audit-summary">These drive the usage breakdown: when a donut goes out, its filling and toppings are counted as used too.</div>' +
        '<div class="audit-actions"><button type="button" id="recClose">Close</button></div>';

      on('recClose', 'click', closeAudit);
      on('addRecBtn', 'click', function () {
        const el = document.getElementById('newRecName');
        const nm = el.value.trim();
        if (!nm) { el.style.borderColor = 'var(--red)'; return; }
        recipes.push({ name: nm, base: null, filling: null, toppings: [] });
        saveRecipes();
        editRecipe(recipes.length - 1, draw);
      });
    }

    body.addEventListener('click', function (e) {
      const ed = e.target.closest('button[data-recedit]');
      const dl = e.target.closest('button[data-recdel]');
      if (ed) { editRecipe(parseInt(ed.getAttribute('data-recedit'), 10), draw); return; }
      if (dl) {
        const i = parseInt(dl.getAttribute('data-recdel'), 10);
        if (!confirm('Delete the recipe for "' + recipes[i].name + '"?')) return;
        recipes.splice(i, 1);
        saveRecipes();
        draw();
      }
    });

    draw();
  }

  function editRecipe(i, back) {
    const r = recipes[i];
    if (!r) return;
    const body = document.getElementById('auditBody');
    let tops = (r.toppings || []).slice();

    function chips(list, isOn, key) {
      return '<div class="id-chips" data-key="' + key + '">' +
        list.map(function (v) {
          return '<button type="button" class="id-chip' + (isOn(v) ? ' on' : '') +
            '" data-val="' + escapeHtml(v) + '">' + escapeHtml(v) + '</button>';
        }).join('') + '</div>';
    }

    function draw() {
      body.innerHTML =
        '<div class="audit-item-name">' + escapeHtml(r.name) + '</div>' +
        '<div class="audit-sub">Tap to set. Toppings can be more than one.</div>' +
        '<div class="role-label">Base</div>' +
        chips(BASES, function (v) { return r.base === v; }, 'base') +
        '<div class="role-label">Filling</div>' +
        chips(FILLINGS, function (v) { return (r.filling || 'None') === v; }, 'filling') +
        '<div class="role-label">Toppings</div>' +
        chips(TOPPINGS, function (v) { return tops.indexOf(v) !== -1; }, 'topping') +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="recBack">Back</button>' +
          '<button type="button" id="recSave">Save</button></div>';

      body.querySelectorAll('.id-chips').forEach(function (grp) {
        grp.addEventListener('click', function (e) {
          const b = e.target.closest('button[data-val]');
          if (!b) return;
          const key = grp.getAttribute('data-key');
          const val = b.getAttribute('data-val');
          if (key === 'base') r.base = (r.base === val ? null : val);
          else if (key === 'filling') r.filling = (val === 'None' ? null : val);
          else {
            if (val === 'None') tops = [];
            else {
              const k = tops.indexOf(val);
              if (k === -1) tops.push(val); else tops.splice(k, 1);
            }
          }
          draw();
        });
      });

      on('recBack', 'click', function () { back(); });
      on('recSave', 'click', function () {
        r.toppings = tops;
        saveRecipes();
        back();
      });
    }
    draw();
  }

  function showUsage() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    function draw() {
      const rows = componentUsage(28);
      const comps = allComponents();

      const html = rows.map(function (r) {
        let right, note;
        if (r.estPacks == null) {
          right = '<span class="audit-var">\u2014</span>';
          note = 'not linked to stock yet';
        } else {
          const diff = (r.actualPacks != null) ? (r.actualPacks - r.estPacks) : null;
          const cls = (diff != null && Math.abs(diff) > Math.max(0.5, r.estPacks * 0.25)) ? 'off' : 'ok';
          right = '<span class="audit-var ' + cls + '">' + r.estPacks.toFixed(2) +
            (r.actualPacks != null ? ' / ' + r.actualPacks.toFixed(2) : '') + '</span>';
          note = r.donuts.toLocaleString() + ' donuts \u00b7 est / actual packs' +
            (diff != null && Math.abs(diff) > 0.01
              ? ' \u00b7 ' + (diff > 0 ? 'using ' + diff.toFixed(2) + ' more than expected'
                                       : 'using ' + Math.abs(diff).toFixed(2) + ' less than expected')
              : '');
        }
        return '<div class="audit-result-row">' +
          '<span>' + escapeHtml(r.name) +
            '<br><span style="font-size:11px;color:var(--text-dim);">' + note + '</span></span>' +
          right +
        '</div>';
      }).join('');

      body.innerHTML =
        '<div class="audit-item-name">Usage breakdown</div>' +
        '<div class="audit-sub">Last 4 weeks \u00b7 icing and filling worked out from donuts finished</div>' +
        (html || '<div class="no-history">Nothing to work from yet \u2014 count some donuts out first.</div>') +
        '<div class="audit-summary">Estimated packs come from your recipes and how many donuts each pack finishes. Actual comes from you marking a bucket empty. A big gap usually means over-icing, waste, or the per-pack number needs tuning.</div>' +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="usageLink">Link components</button>' +
          '<button type="button" id="usageClose">Close</button></div>';

      on('usageClose', 'click', closeAudit);
      on('usageLink', 'click', function () { linkComponents(draw); });
    }
    draw();
  }

  function linkComponents(back) {
    const body = document.getElementById('auditBody');

    function draw() {
      const comps = allComponents();
      const rows = comps.map(function (c2, i) {
        const cfg = components[c2.name] || {};
        const linked = cfg.itemName || null;
        return '<div class="audit-result-row">' +
          '<span>' + escapeHtml(c2.name) +
            '<br><span style="font-size:11px;color:' + (linked ? 'var(--text-dim)' : 'var(--red)') + ';">' +
              (linked ? escapeHtml(linked) + ' \u00b7 ' + (cfg.perPack || 0) + ' donuts per pack'
                      : 'not linked') + '</span></span>' +
          '<button type="button" class="staff-btn" data-linkc="' + i + '" title="Set">&#9998;</button>' +
        '</div>';
      }).join('');

      body.innerHTML =
        '<div class="audit-item-name">Link components</div>' +
        '<div class="audit-sub">Point each icing or filling at the bucket you count, and say how many donuts one pack finishes.</div>' +
        rows +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="linkBack">Back</button>' +
          '<button type="button" id="linkDone">Done</button></div>';

      on('linkBack', 'click', function () { back(); });
      on('linkDone', 'click', function () { saveComponents(); back(); });

      body.querySelectorAll('button[data-linkc]').forEach(function (b) {
        b.addEventListener('click', function () {
          const c2 = comps[parseInt(b.getAttribute('data-linkc'), 10)];
          const list = items.map(function (it, k) { return (k + 1) + '. ' + it.name; }).join('\n');
          const pick = prompt('Which item is "' + c2.name + '"?\n\n' + list +
            '\n\nType a number, or leave blank to unlink.',
            (components[c2.name] && components[c2.name].itemName) || '');
          if (pick === null) return;
          const v = pick.trim();
          if (!v) { delete components[c2.name]; saveComponents(); draw(); return; }
          const k = parseInt(v, 10);
          const item = items[k - 1];
          if (!item) { alert('No item with that number.'); return; }
          const per = parseInt(prompt('How many donuts does one ' + packOf(item).one +
            ' of ' + item.name + ' finish?', (components[c2.name] && components[c2.name].perPack) || '400'), 10);
          if (!per || per < 1) return;
          components[c2.name] = { itemName: item.name, perPack: per };
          saveComponents();
          draw();
        });
      });
    }
    draw();
  }

  function editItem(idx) {
    const item = items[idx];
    if (!item) return;
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    function row(label, value, action, danger) {
      return '<button type="button" class="set-row' + (danger ? ' danger' : '') + '" data-set="' + action + '">' +
        '<span class="set-label">' + label + '</span>' +
        '<span class="set-value">' + value + '</span>' +
      '</button>';
    }

    function draw() {
      const codes = Array.isArray(item.barcodes) ? item.barcodes.length : 0;
      body.innerHTML =
        '<div class="audit-item-name">' + escapeHtml(item.name) + '</div>' +
        '<div class="audit-sub">Settings for this item.</div>' +
        '<div class="set-list">' +
          row('Name', escapeHtml(item.name), 'name') +
          row('Category', itemCategory(item) ? escapeHtml(itemCategory(item)) : '<i>none</i>', 'cat') +
          row('Per ' + packOf(item).one, item.caseSize, 'case') +
          row('Comes in', packOf(item).one, 'pack') +
          row('Low stock at', lowThresholdLabel(item) || '<i>off</i>', 'low') +
          row('Note', item.note ? escapeHtml(item.note) : '<i>none</i>', 'note') +
          row('Barcodes', codes ? codes + ' linked' : '<i>none</i>', 'barcode') +
          row('Product code', item.productCode ? escapeHtml(item.productCode) : '<i>none</i>', 'code') +
          (isVariantItem(item)
            ? row('Varies \u2014 last was', item.lastVariant ? escapeHtml(item.lastVariant) : '<i>not set</i>', 'variant')
            : row('Varies day to day', item.variable ? 'yes' : 'no', 'variable')) +
          (recipeLine(item) ? row('Recipe', escapeHtml(recipeLine(item)), 'recipe') : '') +
          row('Delete item', '', 'delete', true) +
        '</div>' +
        '<div class="audit-actions"><button type="button" id="setDone">Done</button></div>';

      on('setDone', 'click', function () { closeAudit(); render(); });
    }

    body.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-set]');
      if (!b) return;
      const what = b.getAttribute('data-set');

      if (what === 'name') {
        const v = prompt('Item name:', item.name);
        if (v && v.trim()) { item.name = v.trim(); touchItem(item); saveItems(); draw(); }
        return;
      }
      if (what === 'case') {
        const v = parseInt(prompt('How many per ' + packOf(item).one + '?', item.caseSize), 10);
        if (v > 0) { item.caseSize = v; touchItem(item); saveItems(); draw(); }
        return;
      }
      if (what === 'pack') {
        const keys = Object.keys(PACK_TYPES);
        const menu = keys.map(function (k, i) { return (i + 1) + '. ' + PACK_TYPES[k].one; }).join('\n');
        const v = parseInt(prompt('What does it come in?\n\n' + menu, ''), 10);
        if (keys[v - 1]) { item.packType = keys[v - 1]; touchItem(item); saveItems(); draw(); }
        return;
      }
      if (what === 'cat') {
        const menu = categories.map(function (c2, i) { return (i + 1) + '. ' + c2; }).join('\n');
        const v = prompt('Category:\n\n' + menu + '\n\nNumber, new name, or blank to clear.', itemCategory(item));
        if (v === null) return;
        const t2 = v.trim();
        if (!t2) item.category = null;
        else if (/^\d+$/.test(t2) && categories[parseInt(t2, 10) - 1]) item.category = categories[parseInt(t2, 10) - 1];
        else { item.category = t2; if (categories.indexOf(t2) === -1) { categories.push(t2); saveCategories(); } }
        touchItem(item); saveItems(); draw();
        return;
      }
      if (what === 'low') { closeAudit(); openLowStockModal(idx); return; }
      if (what === 'note') {
        const v = prompt('Note (supplier, shelf, item number). Blank to clear:', item.note || '');
        if (v === null) return;
        item.note = v.trim() || null;
        touchItem(item); saveItems(); draw();
        return;
      }
      if (what === 'barcode') { closeAudit(); openBarcode('link', idx); return; }
      if (what === 'code') {
        const v = prompt('Product code from the order sheet (e.g. F20016):', item.productCode || '');
        if (v === null) return;
        item.productCode = v.trim().toUpperCase() || null;
        touchItem(item); saveItems(); draw();
        return;
      }
      if (what === 'variant') { askVariant(item, function () { editItem(idx); }); return; }
      if (what === 'variable') {
        item.variable = !item.variable;
        touchItem(item); saveItems(); draw();
        return;
      }
      if (what === 'recipe') { closeAudit(); showRecipes(); return; }
      if (what === 'delete') {
        if (!confirm('Delete "' + item.name + '" and its history?')) return;
        snapshotForUndo();
        items.splice(idx, 1);
        expanded.delete(idx); minimized.delete(idx);
        closeAudit(); render(); saveItems();
        return;
      }
    });

    draw();
  }

  // ============ VARIANCE TRACKING ============
  // Each time a bucket is marked empty we record how it compared to what the
  // recipes predicted, so over-icing shows up as a trend rather than one number.
  function varianceRef() { return db.ref('tally/rooms/' + roomCode + '/variance'); }

  async function recordVariance(componentName, packsUsed) {
    if (!isConfigured || !roomCode) return;
    const rows = componentUsage(28);
    const row = rows.find(function (r) { return r.name === componentName; });
    if (!row || row.estPacks == null) return;
    try {
      await varianceRef().push({
        at: Date.now(),
        component: componentName,
        estPacks: Number(row.estPacks.toFixed(3)),
        actualPacks: Number((row.actualPacks || 0).toFixed(3)),
        donuts: row.donuts,
        by: myName || 'someone'
      });
    } catch (e) {}
  }

  // Called whenever a component item goes down — that's a pack being used up
  function noteComponentUse(item, delta) {
    if (delta >= 0) return;
    const name = Object.keys(components).find(function (k) {
      return components[k] && components[k].itemName === item.name;
    });
    if (name) recordVariance(name, Math.abs(delta) / (item.caseSize || 1));
  }

  async function showVariance() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML = '<div class="audit-item-name">Variance history</div><div class="audit-sub">Loading\u2026</div>';

    let rows = [];
    try {
      const snap = await varianceRef().orderByChild('at').limitToLast(120).get();
      const val = snap.val() || {};
      rows = Object.keys(val).map(function (k) { return val[k]; })
        .sort(function (a, b) { return b.at - a.at; });
    } catch (e) {}

    if (!rows.length) {
      body.innerHTML = '<div class="audit-item-name">Variance history</div>' +
        '<div class="audit-sub">Nothing recorded yet.</div>' +
        '<div class="audit-summary">Link a component to its bucket in Usage breakdown, then mark buckets empty as you go. Each one gets compared to what the recipes predicted and logged here.</div>' +
        '<div class="audit-actions"><button type="button" id="varClose">Close</button></div>';
      on('varClose', 'click', closeAudit);
      return;
    }

    // Group by component so trends are readable
    const byComp = {};
    rows.forEach(function (r) {
      if (!byComp[r.component]) byComp[r.component] = [];
      byComp[r.component].push(r);
    });

    const html = Object.keys(byComp).sort().map(function (name) {
      const list = byComp[name];
      const diffs = list.map(function (r) { return r.actualPacks - r.estPacks; });
      const avg = diffs.reduce(function (s, d) { return s + d; }, 0) / diffs.length;
      const trend = avg > 0.15 ? 'using more than the recipes expect'
                  : avg < -0.15 ? 'using less than the recipes expect'
                  : 'tracking close to expected';
      const cls = Math.abs(avg) > 0.15 ? 'off' : 'ok';

      const recent = list.slice(0, 6).map(function (r) {
        const d = new Date(r.at);
        const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const diff = r.actualPacks - r.estPacks;
        return '<div class="var-row">' +
          '<span>' + when + '</span>' +
          '<span>' + r.donuts.toLocaleString() + ' donuts</span>' +
          '<span class="' + (Math.abs(diff) > 0.2 ? 'var-off' : 'var-ok') + '">' +
            (diff > 0 ? '+' : '') + diff.toFixed(2) + '</span>' +
        '</div>';
      }).join('');

      return '<div class="var-block">' +
        '<div class="var-head">' + escapeHtml(name) +
          '<span class="audit-var ' + cls + '">' + (avg > 0 ? '+' : '') + avg.toFixed(2) + ' avg</span></div>' +
        '<div class="var-note">' + list.length + ' record(s) \u00b7 ' + trend + '</div>' +
        '<div class="var-rows"><div class="var-row var-hd"><span>When</span><span>Donuts</span><span>Diff</span></div>' +
          recent + '</div>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Variance history</div>' +
      '<div class="audit-sub">Actual packs minus what the recipes predicted</div>' +
      html +
      '<div class="audit-summary">A positive number means more product went out than the recipes account for \u2014 usually heavy-handed icing, spillage, or a per-pack figure set too high. Consistently negative means the opposite. One-offs are noise; a steady lean is worth acting on.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="varCopy">Copy</button>' +
        '<button type="button" id="varClose">Close</button></div>';

    on('varClose', 'click', closeAudit);
    on('varCopy', 'click', function () {
      const text = 'Variance \u2014 ' + roomCode + '\n\n' + rows.map(function (r) {
        return new Date(r.at).toLocaleDateString() + '  ' + r.component +
          '  est ' + r.estPacks.toFixed(2) + '  actual ' + r.actualPacks.toFixed(2) +
          '  (' + r.donuts + ' donuts)';
      }).join('\n');
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { alert('Copied.'); });
      else prompt('Copy this:', text);
    });
  }

  function recipeLine(item) {
    const r = item && item.recipe;
    if (!r) return '';
    const parts = [];
    if (r.base) parts.push(r.base);
    if (r.filling && r.filling !== 'None') parts.push('filled: ' + r.filling);
    if (Array.isArray(r.toppings) && r.toppings.length) parts.push(r.toppings.join(' + '));
    else if (r.topping) parts.push(r.topping);
    return parts.join(' \u00b7 ');
  }

  // ===================== BUG REPORTS =====================
  const SEVERITIES = ['Blocking', 'Annoying', 'Idea'];
  let bugSeverity = 'Annoying';

  function bugsRef() { return db.ref('tally/rooms/' + roomCode + '/bugs'); }

  function drawSeverity() {
    const grid = document.getElementById('bugSeverity');
    if (!grid) return;
    grid.innerHTML = SEVERITIES.map(function (sv) {
      return '<button type="button" class="role-opt' + (sv === bugSeverity ? ' on' : '') +
        '" data-sev="' + sv + '">' + sv + '</button>';
    }).join('');
  }

  document.getElementById('bugSeverity').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-sev]');
    if (!b) return;
    bugSeverity = b.getAttribute('data-sev');
    drawSeverity();
  });

  function openBugReport() {
    document.getElementById('bugText').value = '';
    bugSeverity = 'Annoying';
    drawSeverity();
    document.getElementById('bugGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
  }

  function closeBugReport() {
    document.getElementById('bugGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  }

  document.getElementById('bugCancel').addEventListener('click', closeBugReport);

  document.getElementById('bugSend').addEventListener('click', async function () {
    const ta = document.getElementById('bugText');
    const text = ta.value.trim();
    if (!text) { ta.style.borderColor = 'var(--red)'; return; }

    const report = {
      text: text.slice(0, 1000),
      severity: bugSeverity,
      by: myName || 'Unnamed',
      role: myRole || null,
      at: Date.now(),
      store: roomCode || null,
      device: (navigator.userAgent || '').slice(0, 120),
      resolved: false
    };

    try {
      await bugsRef().push(report);
      closeBugReport();
      buzz(20);
      showCommandToast('Report sent \u2014 thanks');
    } catch (e) {
      // Don't lose it just because the freezer has no signal
      try {
        const q = JSON.parse(localStorage.getItem('tally_bugq') || '[]');
        q.push(report);
        localStorage.setItem('tally_bugq', JSON.stringify(q));
        closeBugReport();
        showCommandToast('Saved \u2014 will send when you\'re back online');
      } catch (e2) {
        alert('Could not send that report.');
      }
    }
  });

  async function flushBugQueue() {
    let q;
    try { q = JSON.parse(localStorage.getItem('tally_bugq') || '[]'); } catch (e) { return; }
    if (!q.length || !isConfigured || !roomCode) return;
    for (const r of q.slice()) {
      try {
        await bugsRef().push(r);
        q.shift();
      } catch (e) { break; }
    }
    localStorage.setItem('tally_bugq', JSON.stringify(q));
  }

  async function showBugs() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML = '<div class="audit-item-name">Reports</div><div class="audit-sub">Loading...</div>';

    let list = [];
    try {
      const snap = await bugsRef().orderByChild('at').limitToLast(80).get();
      const val = snap.val() || {};
      list = Object.keys(val).map(function (k) { return Object.assign({ key: k }, val[k]); })
        .sort(function (a, b) {
          if (!!a.resolved !== !!b.resolved) return a.resolved ? 1 : -1;
          return b.at - a.at;
        });
    } catch (e) {}

    function draw() {
      if (!list.length) {
        body.innerHTML = '<div class="audit-item-name">Reports</div>' +
          '<div class="audit-sub">Nothing reported yet.</div>' +
          '<div class="audit-summary">Staff can tap the bug button in the corner of any screen to send you a report.</div>' +
          '<div class="audit-actions"><button type="button" id="bugsClose">Close</button></div>';
        document.getElementById('bugsClose').addEventListener('click', closeAudit);
        return;
      }

      const open = list.filter(function (b) { return !b.resolved; }).length;
      const rows = list.map(function (b, i) {
        const d = new Date(b.at);
        const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
          d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return '<div class="bug-row' + (b.resolved ? ' done' : '') + '">' +
          '<span class="bug-sev ' + String(b.severity || 'Annoying').toLowerCase() + '">' +
            escapeHtml(b.severity || '?') + '</span>' +
          '<span class="bug-body">' + escapeHtml(b.text || '') +
            '<div class="bug-meta">' + escapeHtml(b.by || 'Unnamed') +
              (b.role ? ' (' + escapeHtml(b.role) + ')' : '') + ' &middot; ' + when + '</div>' +
          '</span>' +
          '<span class="staff-actions">' +
            '<button type="button" class="staff-btn' + (b.resolved ? '' : ' ok') +
              '" data-bugdone="' + i + '" title="' + (b.resolved ? 'Reopen' : 'Mark done') + '">' +
              (b.resolved ? '\u21BA' : '\u2713') + '</button>' +
            '<button type="button" class="staff-btn del" data-bugdel="' + i + '" title="Delete">&times;</button>' +
          '</span>' +
        '</div>';
      }).join('');

      body.innerHTML =
        '<div class="audit-item-name">Reports</div>' +
        '<div class="audit-sub">' + open + ' open &middot; ' + list.length + ' total</div>' +
        rows +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="bugsCopy">Copy open</button>' +
          '<button type="button" id="bugsClose">Close</button></div>';

      document.getElementById('bugsClose').addEventListener('click', closeAudit);
      document.getElementById('bugsCopy').addEventListener('click', function () {
        const text = 'Tally reports \u2014 ' + roomCode + '\n\n' +
          list.filter(function (b) { return !b.resolved; }).map(function (b) {
            return '[' + (b.severity || '?') + '] ' + b.text +
              '\n   \u2014 ' + (b.by || 'Unnamed') + ', ' + new Date(b.at).toLocaleString();
          }).join('\n\n');
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(function () { alert('Copied.'); });
        } else { prompt('Copy this:', text); }
      });
    }

    body.addEventListener('click', async function (e) {
      const done = e.target.closest('button[data-bugdone]');
      const del = e.target.closest('button[data-bugdel]');
      if (done) {
        const b = list[parseInt(done.getAttribute('data-bugdone'), 10)];
        if (!b) return;
        b.resolved = !b.resolved;
        try { await bugsRef().child(b.key).update({ resolved: b.resolved }); } catch (err) {}
        list.sort(function (x, y) {
          if (!!x.resolved !== !!y.resolved) return x.resolved ? 1 : -1;
          return y.at - x.at;
        });
        draw();
        return;
      }
      if (del) {
        const b = list[parseInt(del.getAttribute('data-bugdel'), 10)];
        if (!b || !confirm('Delete this report?')) return;
        try { await bugsRef().child(b.key).remove(); } catch (err) {}
        list = list.filter(function (x) { return x.key !== b.key; });
        draw();
      }
    });

    draw();
  }

  function watchBugs() {
    if (!isConfigured || !roomCode) return;
    bugsRef().on('value', function (snap) {
      const val = snap.val() || {};
      const open = Object.keys(val).filter(function (k) { return !val[k].resolved; }).length;
      const badge = document.getElementById('bugsBadge');
      if (badge) {
        badge.textContent = open ? open : '';
        badge.style.display = open ? 'inline-block' : 'none';
      }
    });
  }

  // ===================== HAND COUNT =====================
  // For things you count piece by piece rather than by case — munchkins mainly.
  // The sheet says 75; this tells you what you actually have.
  let counterIdx = null;
  let counterN = 0;
  let counterHist = [];
  let counterExpected = null;

  function openCounter(idx) {
    counterIdx = idx;
    counterN = 0;
    counterHist = [];
    const item = items[idx];
    counterExpected = item ? item.units : null;

    document.getElementById('counterTitle').textContent = item ? item.name : 'Hand count';
    document.getElementById('counterScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    drawCounter();
  }

  function closeCounter() {
    document.getElementById('counterScreen').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    counterIdx = null;
  }

  function drawCounter() {
    document.getElementById('counterNum').textContent = counterN.toLocaleString();
    document.getElementById('counterUndo').disabled = !counterHist.length;

    const item = counterIdx != null ? items[counterIdx] : null;
    const sub = document.getElementById('counterSub');
    const v = document.getElementById('counterVariance');

    if (item) {
      const cs = item.caseSize || 1;
      sub.textContent = counterN >= cs
        ? Number((counterN / cs).toFixed(2)) + ' ' + packLabel(item, counterN / cs)
        : 'tap anywhere to count';
    }

    if (item && counterExpected != null) {
      const diff = counterN - counterExpected;
      if (counterN === 0) {
        v.textContent = 'System says ' + counterExpected.toLocaleString() + ' \u2014 count what\'s really there';
        v.className = 'counter-variance exact';
      } else if (diff === 0) {
        v.textContent = '\u2713 Matches the system exactly';
        v.className = 'counter-variance exact';
      } else {
        v.textContent = (diff > 0 ? '+' : '') + diff.toLocaleString() +
          ' vs system (' + counterExpected.toLocaleString() + ')';
        v.className = 'counter-variance ' + (diff > 0 ? 'over' : 'under');
      }
    }
  }

  function counterAdd(n) {
    const before = counterN;
    counterN = Math.max(0, counterN + n);
    if (counterN !== before) {
      counterHist.push(counterN - before);
      if (counterHist.length > 500) counterHist.shift();
      buzz(n === 1 ? 8 : 16);
    }
    drawCounter();
  }

  document.getElementById('counterTap').addEventListener('click', function () { counterAdd(1); });

  document.getElementById('counterQuick').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-add]');
    if (!b) return;
    counterAdd(parseInt(b.getAttribute('data-add'), 10));
  });

  document.getElementById('counterUndo').addEventListener('click', function () {
    const last = counterHist.pop();
    if (last == null) return;
    counterN = Math.max(0, counterN - last);
    buzz(8);
    drawCounter();
  });

  document.getElementById('counterReset').addEventListener('click', function () {
    if (counterN && !confirm('Start this count over?')) return;
    counterN = 0;
    counterHist = [];
    drawCounter();
  });

  document.getElementById('counterClose').addEventListener('click', function () {
    if (counterN && !confirm('Leave without saving this count?')) return;
    closeCounter();
  });

  document.getElementById('counterSave').addEventListener('click', function () {
    const item = counterIdx != null ? items[counterIdx] : null;
    if (!item) { closeCounter(); return; }
    const delta = counterN - item.units;
    if (delta === 0) {
      showCommandToast(item.name + ' already matched \u2014 nothing changed');
      closeCounter();
      return;
    }
    snapshotForUndo();
    item.units = counterN;
    pushHistory(item, delta, 'count');
    render();
    saveItems();
    closeCounter();
    showCommandToast(item.name + ' set to ' + counterN.toLocaleString() + ' (' +
      (delta > 0 ? '+' : '') + delta.toLocaleString() + ')');
  });

  // Pick what to hand count — munchkins first, since that's the usual case
  // Some products aren't one thing — Baker's Choice might be yeast one day and
  // chocolate cake the next. Those items ask what they are before counting.
  const VARIANT_BASES = ['Yeast Ring', 'Yeast Shell', 'Chocolate Cake', 'Blueberry Cake', 'Other'];

  function isVariantItem(item) {
    if (!item) return false;
    if (item.variable) return true;
    return /baker.?s\s*choice/i.test(item.name || '');
  }

  function askVariant(item, then) {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    body.innerHTML =
      '<div class="audit-item-name">' + escapeHtml(item.name) + '</div>' +
      '<div class="audit-sub">This one varies. What is it today?</div>' +
      '<div class="hc-cats">' +
        VARIANT_BASES.map(function (b) {
          return '<button type="button" class="hc-cat" data-variant="' + escapeHtml(b) + '">' +
            escapeHtml(b) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="join-hint">Recorded with the count, so the history shows which kind it was.<br><br>' +
      '<button type="button" class="store-action" id="varCancel">Cancel</button></div>';

    on('varCancel', 'click', closeAudit);

    body.querySelectorAll('button[data-variant]').forEach(function (b) {
      b.addEventListener('click', function () {
        const v = b.getAttribute('data-variant');
        item.lastVariant = v;
        if (!Array.isArray(item.variantLog)) item.variantLog = [];
        item.variantLog.push({ at: Date.now(), variant: v, by: myName || 'someone' });
        if (item.variantLog.length > 60) item.variantLog = item.variantLog.slice(-60);
        touchItem(item);
        saveItems();
        then(v);
      });
    });
  }

  function chooseCountItem() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    if (!items.length) {
      body.innerHTML = '<div class="audit-item-name">Hand count</div>' +
        '<div class="audit-sub">No items yet.</div>' +
        '<div class="audit-actions"><button type="button" id="hcClose">Close</button></div>';
      on('hcClose', 'click', closeAudit);
      return;
    }

    // Step 1: pick a category, so the list of big buttons stays short
    const counts = {};
    let uncat = 0;
    items.forEach(function (it) {
      const cat = itemCategory(it);
      if (cat) counts[cat] = (counts[cat] || 0) + 1;
      else uncat++;
    });
    const used = categories.filter(function (cat) { return counts[cat]; });

    body.innerHTML =
      '<div class="audit-item-name">Hand count</div>' +
      '<div class="audit-sub">What are you counting?</div>' +
      '<div class="hc-cats">' +
        used.map(function (cat) {
          return '<button type="button" class="hc-cat" data-hccat="' + escapeHtml(cat) + '">' +
            escapeHtml(cat) + '<span>' + counts[cat] + '</span></button>';
        }).join('') +
        (uncat ? '<button type="button" class="hc-cat" data-hccat="__none">Uncategorised<span>' + uncat + '</span></button>' : '') +
        '<button type="button" class="hc-cat" data-hccat="__all">Everything<span>' + items.length + '</span></button>' +
      '</div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="hcPickCancel">Cancel</button></div>';

    on('hcPickCancel', 'click', closeAudit);

    body.querySelectorAll('button[data-hccat]').forEach(function (b) {
      b.addEventListener('click', function () {
        showCountItemsIn(b.getAttribute('data-hccat'));
      });
    });
  }

  // Step 2: big tap targets for the items in that category
  function showCountItemsIn(cat) {
    const body = document.getElementById('auditBody');
    const list = items.map(function (it, i) { return { it: it, i: i }; })
      .filter(function (r) {
        if (cat === '__all') return true;
        if (cat === '__none') return !itemCategory(r.it);
        return itemCategory(r.it) === cat;
      })
      .sort(function (a, b) { return a.it.name.localeCompare(b.it.name); });

    const label = cat === '__all' ? 'Everything' : (cat === '__none' ? 'Uncategorised' : cat);

    body.innerHTML =
      '<div class="audit-item-name">' + escapeHtml(label) + '</div>' +
      '<div class="audit-sub">Pick what you\u2019re counting.</div>' +
      '<div class="hc-items">' +
        list.map(function (r) {
          const c2 = calc(r.it.units, r.it.caseSize);
          return '<button type="button" class="hc-item" data-hcitem="' + r.i + '">' +
            '<span class="hc-name">' + escapeHtml(r.it.name) + '</span>' +
            '<span class="hc-now">' + r.it.units.toLocaleString() + ' ' + unitLabel(r.it, r.it.units) +
              '<i>' + c2.decimalCases + ' ' + packLabel(r.it, c2.decimalCases) + '</i></span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="hcBack">Back</button></div>';

    on('hcBack', 'click', chooseCountItem);

    body.querySelectorAll('button[data-hcitem]').forEach(function (b) {
      b.addEventListener('click', function () {
        const idx = parseInt(b.getAttribute('data-hcitem'), 10);
        const item = items[idx];
        if (isVariantItem(item)) askVariant(item, function () { openCounter(idx); });
        else openCounter(idx);
      });
    });
  }



  // ===================== HAND COUNTER =====================
  // For loose product (munchkins especially) where the sheet number is a guess.
  // Tap once per piece, or use the bump buttons for handfuls, and get a real number.
  let hcIdx = null, hcCount = 0, hcHistory = [], hcBump = 10;

  function startHandCount(preIdx) {
    if (!items.length) { alert('No items yet.'); return; }
    hcIdx = (preIdx != null) ? preIdx : null;
    hcCount = 0;
    hcHistory = [];
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    if (hcIdx == null) pickHandCountItem();
    else drawHandCount();
  }

  function pickHandCountItem() {
    const body = document.getElementById('auditBody');
    // Munchkins first, since that's the usual reason for counting by hand
    const order = items.map(function (it, i) { return i; }).sort(function (a, b) {
      const am = /munchkin/i.test(items[a].name) ? 0 : 1;
      const bm = /munchkin/i.test(items[b].name) ? 0 : 1;
      if (am !== bm) return am - bm;
      return items[a].name.localeCompare(items[b].name);
    });

    body.innerHTML =
      '<div class="audit-item-name">Hand count</div>' +
      '<div class="audit-sub">Which item are you counting?</div>' +
      order.map(function (i) {
        const it = items[i];
        return '<button type="button" class="sheet-item" data-hc="' + i + '" style="margin-bottom:6px;">' +
          '<span class="si-icon">' + (/munchkin/i.test(it.name) ? '&#127849;' : '&#128230;') + '</span>' +
          '<span class="si-text"><b>' + escapeHtml(it.name) + '</b>' +
          '<i>says ' + it.units.toLocaleString() + ' ' + unitLabel(it, it.units) + ' now</i></span></button>';
      }).join('') +
      '<div class="join-hint"><button type="button" class="store-action" id="hcPickCancel">Cancel</button></div>';

    document.getElementById('hcPickCancel').addEventListener('click', closeAudit);
    body.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-hc]');
      if (!b) return;
      hcIdx = parseInt(b.getAttribute('data-hc'), 10);
      hcCount = 0;
      hcHistory = [];
      drawHandCount();
    });
  }

  function drawHandCount() {
    const item = items[hcIdx];
    if (!item) { closeAudit(); return; }
    const body = document.getElementById('auditBody');
    const cs = item.caseSize || 1;
    const diff = hcCount - item.units;

    body.innerHTML =
      '<div class="hc-head">' +
        '<div class="hc-name">' + escapeHtml(item.name) + '</div>' +
        '<div class="hc-sub">system says ' + item.units.toLocaleString() + ' &middot; ' +
          'tap the circle once per piece</div>' +
      '</div>' +

      '<button type="button" class="hc-tap" id="hcTap">' +
        '<span class="hc-num">' + hcCount.toLocaleString() + '</span>' +
        '<span class="hc-unit">' + unitLabel(item, hcCount) + '</span>' +
      '</button>' +

      '<div class="hc-stats">' +
        '<span>' + Number((hcCount / cs).toFixed(2)) + ' ' + packLabel(item, hcCount / cs) + '</span>' +
        '<span class="' + (diff === 0 ? '' : (diff > 0 ? 'hc-over' : 'hc-under')) + '">' +
          (hcCount === 0 ? '&nbsp;' : (diff === 0 ? 'matches' : (diff > 0 ? '+' + diff + ' more than system' : diff + ' vs system'))) +
        '</span>' +
      '</div>' +

      '<div class="hc-bumps">' +
        '<button type="button" class="hc-bump" data-bump="1">+1</button>' +
        '<button type="button" class="hc-bump" data-bump="5">+5</button>' +
        '<button type="button" class="hc-bump" data-bump="10">+10</button>' +
        '<button type="button" class="hc-bump" data-bump="25">+25</button>' +
        '<button type="button" class="hc-bump" data-bump="' + cs + '">+' + cs + '</button>' +
      '</div>' +

      '<div class="hc-tools">' +
        '<button type="button" class="admin-mini-btn" id="hcUndo"' + (hcHistory.length ? '' : ' disabled') + '>&#8617; Undo</button>' +
        '<button type="button" class="admin-mini-btn" id="hcReset">Reset</button>' +
      '</div>' +

      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="hcCancel">Cancel</button>' +
        '<button type="button" id="hcSave">Set to ' + hcCount.toLocaleString() + '</button>' +
      '</div>' +
      '<div class="join-hint">Saving replaces the count with what you actually counted, and logs the difference so it shows up in the item\'s history.</div>';

    function add(n) {
      hcCount += n;
      hcHistory.push(n);
      buzz(n === 1 ? 10 : 18);
      drawHandCount();
    }

    document.getElementById('hcTap').addEventListener('click', function () { add(1); });
    body.querySelectorAll('.hc-bump').forEach(function (b) {
      b.addEventListener('click', function () { add(parseInt(b.getAttribute('data-bump'), 10)); });
    });

    document.getElementById('hcUndo').addEventListener('click', function () {
      if (!hcHistory.length) return;
      hcCount = Math.max(0, hcCount - hcHistory.pop());
      drawHandCount();
    });

    document.getElementById('hcReset').addEventListener('click', function () {
      if (hcCount && !confirm('Start this count over?')) return;
      hcCount = 0; hcHistory = [];
      drawHandCount();
    });

    document.getElementById('hcCancel').addEventListener('click', function () {
      if (hcCount && !confirm('Throw away this count of ' + hcCount + '?')) return;
      closeAudit();
    });

    document.getElementById('hcSave').addEventListener('click', function () {
      const delta = hcCount - item.units;
      snapshotForUndo();
      item.units = hcCount;
      if (delta !== 0) pushHistory(item, delta, 'handcount');
      touchItem(item);
      render();
      saveItems();
      closeAudit();
      showCommandToast(item.name + ' set to ' + hcCount.toLocaleString() +
        (delta ? ' (' + (delta > 0 ? '+' : '') + delta + ')' : ''));
    });
  }

  // ===================== TRAY COUNTER =====================
  // Counts round product (munchkins, donut holes) on a tray from a photo.
  // Auto-detect gets you close; you tap to fix anything it missed or doubled.
  let trayMarkers = [];
  let trayImg = null;
  let trayItemIdx = null;

  // ---- round-product detection ----
  // Munchkins are brown; the rack is bare metal. Brightness alone locks onto
  // the shiny wire, so we separate on COLOUR SATURATION instead, then use a
  // distance transform to pull apart pieces that touch.
  function otsu(values) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < values.length; i++) hist[values[i]]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function buildMask(data, W, H) {
    const n = W * H;
    const sat = new Uint8Array(n);
    const val = new Uint8Array(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat[p] = mx === 0 ? 0 : Math.round(((mx - mn) / mx) * 255);
      val[p] = mx;
    }

    function maskFrom(src, invert) {
      const t = otsu(src);
      const m = new Uint8Array(n);
      let on = 0;
      for (let p = 0; p < n; p++) {
        const hit = invert ? src[p] < t : src[p] > t;
        m[p] = hit ? 1 : 0;
        if (hit) on++;
      }
      return { m: m, frac: on / n };
    }

    // Prefer the saturation mask. The lower bound is deliberately small so a
    // nearly-empty tray still works; only reject it if it found almost nothing
    // or swallowed the whole frame.
    const bySat = maskFrom(sat, false);
    if (bySat.frac > 0.004 && bySat.frac < 0.85) return bySat.m;

    const byVal = maskFrom(val, false);
    const byValInv = maskFrom(val, true);
    const pick = (byVal.frac > 0.004 && byVal.frac < 0.85) ? byVal : byValInv;
    return pick.m;
  }

  function erodeMask(m, W, H) {
    const out = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (m[p] && m[p - W] && m[p + W] && m[p - 1] && m[p + 1]) out[p] = 1;
      }
    }
    return out;
  }

  // Chamfer 5/7 distance transform
  function distanceTransform(m, W, H) {
    const INF = 1e9;
    const d = new Float32Array(W * H);
    for (let p = 0; p < d.length; p++) d[p] = m[p] ? INF : 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!d[p]) continue;
        let b = d[p];
        if (y > 0) b = Math.min(b, d[p - W] + 5);
        if (x > 0) b = Math.min(b, d[p - 1] + 5);
        if (y > 0 && x > 0) b = Math.min(b, d[p - W - 1] + 7);
        if (y > 0 && x < W - 1) b = Math.min(b, d[p - W + 1] + 7);
        d[p] = b;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const p = y * W + x;
        if (!d[p]) continue;
        let b = d[p];
        if (y < H - 1) b = Math.min(b, d[p + W] + 5);
        if (x < W - 1) b = Math.min(b, d[p + 1] + 5);
        if (y < H - 1 && x < W - 1) b = Math.min(b, d[p + W + 1] + 7);
        if (y < H - 1 && x > 0) b = Math.min(b, d[p + W - 1] + 7);
        d[p] = b;
      }
    }
    return d;
  }

  // Each piece shows up as a local maximum in the distance map
  function findCenters(d, W, H) {
    let mx = 0;
    for (let p = 0; p < d.length; p++) if (d[p] < 1e8 && d[p] > mx) mx = d[p];
    if (!mx) return [];

    const floor = mx * 0.35;
    const cands = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        const v = d[p];
        if (v < floor) continue;
        if (d[p - 1] > v || d[p + 1] > v || d[p - W] > v || d[p + W] > v ||
            d[p - W - 1] > v || d[p - W + 1] > v || d[p + W - 1] > v || d[p + W + 1] > v) continue;
        cands.push({ v: v, x: x, y: y });
      }
    }
    if (!cands.length) return [];
    cands.sort(function (a, b) { return b.v - a.v; });

    // Typical piece size from the median peak, not the largest
    const sorted = cands.map(function (c2) { return c2.v; }).sort(function (a, b) { return a - b; });
    const med = sorted[Math.floor(sorted.length / 2)] || mx;
    const R = (med / 5) * 1.40;
    const R2 = R * R;

    const out = [];
    for (let i = 0; i < cands.length; i++) {
      const c2 = cands[i];
      let clash = false;
      for (let k = 0; k < out.length; k++) {
        const dx = c2.x - out[k].x, dy = c2.y - out[k].y;
        if (dx * dx + dy * dy < R2) { clash = true; break; }
      }
      if (!clash) out.push({ x: c2.x, y: c2.y });
    }
    return out;
  }

  function startTrayCount(idx) {
    trayItemIdx = (idx == null ? null : idx);
    sourcePicker('Count a tray',
      'Shoot straight down at the tray, even light, no shadows across it.',
      function (cam) {
        pickImage(cam, function (file) {
          const body = document.getElementById('auditBody');
          body.innerHTML = '<div class="audit-item-name">Counting</div>' +
            '<div class="audit-sub">Looking at the photo\u2026</div>';
          const img = new Image();
          img.onload = function () { analyseTray(img); };
          img.onerror = function () { ocrFailScreen('Could not open that photo.'); };
          img.src = URL.createObjectURL(file);
        });
      });
  }

  function analyseTray(img) {
    const MAXW = 520;
    const scale = Math.min(1, MAXW / img.width);
    const W = Math.round(img.width * scale), H = Math.round(img.height * scale);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);

    const data = ctx.getImageData(0, 0, W, H).data;
    const mask = buildMask(data, W, H);
    const eroded = erodeMask(mask, W, H);
    const dist = distanceTransform(eroded, W, H);
    trayMarkers = findCenters(dist, W, H);

    trayImg = cv.toDataURL('image/jpeg', 0.75);
    renderTray(W, H);
  }

  function renderTray(W, H) {
    const body = document.getElementById('auditBody');
    const item = trayItemIdx != null ? items[trayItemIdx] : null;

    body.innerHTML =
      '<div class="audit-item-name">Tray count: <span id="trayNum">' + trayMarkers.length + '</span></div>' +
      '<div class="audit-sub">Tap a dot to remove it, tap empty space to add one.</div>' +
      '<div class="tray-wrap" id="trayWrap">' +
        '<img src="' + trayImg + '" id="trayPhoto">' +
        '<div class="tray-dots" id="trayDots"></div>' +
      '</div>' +
      '<div class="admin-row" style="margin-top:10px;">' +
        '<button type="button" class="admin-mini-btn" id="trayClear">Clear all</button>' +
        '<button type="button" class="admin-mini-btn" id="trayRedo">Retake</button>' +
      '</div>' +
      '<div class="audit-summary">Auto-counting is a starting point, not gospel \u2014 pieces that touch can read as one. Check the dots before saving.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="trayCancel">Cancel</button>' +
        '<button type="button" id="traySave">' +
          (item ? 'Set ' + escapeHtml(item.name) : 'Use this count') + '</button>' +
      '</div>';

    function drawDots() {
      const wrap = document.getElementById('trayDots');
      wrap.innerHTML = trayMarkers.map(function (m, i) {
        return '<span class="tray-dot" data-dot="' + i + '" style="left:' +
          (m.x / W * 100) + '%;top:' + (m.y / H * 100) + '%;"></span>';
      }).join('');
      document.getElementById('trayNum').textContent = trayMarkers.length;
    }
    drawDots();

    document.getElementById('trayWrap').addEventListener('click', function (e) {
      const dot = e.target.closest('.tray-dot');
      if (dot) {
        trayMarkers.splice(parseInt(dot.getAttribute('data-dot'), 10), 1);
        buzz(8);
        drawDots();
        return;
      }
      const r = document.getElementById('trayPhoto').getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * W;
      const y = (e.clientY - r.top) / r.height * H;
      trayMarkers.push({ x: x, y: y });
      buzz(8);
      drawDots();
    });

    document.getElementById('trayClear').addEventListener('click', function () {
      trayMarkers = [];
      drawDots();
    });
    document.getElementById('trayRedo').addEventListener('click', function () {
      startTrayCount(trayItemIdx);
    });
    document.getElementById('trayCancel').addEventListener('click', closeAudit);

    document.getElementById('traySave').addEventListener('click', function () {
      const n = trayMarkers.length;
      if (trayItemIdx == null) {
        // No item chosen: let them pick one now
        const list = items.map(function (it, i) { return (i + 1) + '. ' + it.name; }).join('\n');
        const pick = prompt('Counted ' + n + '. Which item is this?\n\n' + list, '');
        const k = parseInt(pick, 10);
        if (!k || !items[k - 1]) { closeAudit(); return; }
        trayItemIdx = k - 1;
      }
      const item = items[trayItemIdx];
      const delta = n - item.units;
      snapshotForUndo();
      item.units = n;
      if (delta !== 0) pushHistory(item, delta, 'count');
      bumpCount(trayItemIdx);
      render();
      saveItems();
      closeAudit();
      showCommandToast(item.name + ' set to ' + n + ' from tray count');
    });
  }

  function updateProfileChip() {
    const el = document.getElementById('profileChip');
    if (!el) return;
    el.innerHTML = escapeHtml(myName || '\u2014') +
      (myRole ? '<span class="role-tag">' + escapeHtml(myRole) + '</span>' : '');
  }

  const ROLES = ['Crew', 'Baker', 'Shift Leader', 'Asst. Manager', 'Manager', 'Other'];
  let myRole = localStorage.getItem('tally_role') || '';

  function renderRoleGrid(selected) {
    const grid = document.getElementById('roleGrid');
    if (!grid) return;
    grid.innerHTML = ROLES.map(function (r) {
      return '<button type="button" class="role-opt' + (r === selected ? ' on' : '') +
        '" data-role="' + r + '">' + r + '</button>';
    }).join('');
  }

  document.getElementById('roleGrid').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-role]');
    if (!b) return;
    myRole = b.getAttribute('data-role');
    renderRoleGrid(myRole);
  });

  function saveProfile(name, role) {
    myName = name.trim().slice(0, 24);
    if (role != null) myRole = role;
    localStorage.setItem(NAME_KEY, myName);
    localStorage.setItem('tally_role', myRole || '');
    if (!profileId) {
      profileId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('tally_profile_id', profileId);
    }
    updateProfileChip();
    if (isConfigured && roomCode) {
      db.ref('tally/rooms/' + roomCode + '/staff/' + profileId).update({
        name: myName,
        role: myRole || null,
        lastSeen: Date.now(),
        uid: myUid || null,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      }).catch(function() {});
    }
    if (presenceRef) presenceRef.update({ name: myName || 'Unnamed', role: myRole || null });
  }

  document.getElementById('profileSaveBtn').addEventListener('click', function() {
    const val = document.getElementById('profileName').value.trim();
    if (!val) {
      document.getElementById('profileName').style.borderColor = 'var(--red)';
      return;
    }
    if (!myRole) {
      document.getElementById('roleGrid').style.outline = '1px solid var(--red)';
      return;
    }
    saveProfile(val);
    document.getElementById('profileGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    startApp();
  });

  document.getElementById('profileName').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('profileSaveBtn').click();
  });

  document.getElementById('editProfileBtn').addEventListener('click', function () {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    body.innerHTML =
      '<div class="audit-item-name">Your profile</div>' +
      '<div class="audit-sub">Shown on counts, audits and the activity log.</div>' +
      '<input type="text" id="editName" maxlength="24" autocapitalize="words" value="' +
        escapeHtml(myName) + '" placeholder="Your name">' +
      '<div class="role-label">Position</div>' +
      '<div class="role-grid" id="editRoleGrid"></div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="editCancel">Cancel</button>' +
        '<button type="button" id="editSave">Save</button></div>';

    let picked = myRole;
    function drawRoles() {
      document.getElementById('editRoleGrid').innerHTML = ROLES.map(function (r) {
        return '<button type="button" class="role-opt' + (r === picked ? ' on' : '') +
          '" data-erole="' + r + '">' + r + '</button>';
      }).join('');
    }
    drawRoles();

    document.getElementById('editRoleGrid').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-erole]');
      if (!b) return;
      picked = b.getAttribute('data-erole');
      drawRoles();
    });

    document.getElementById('editCancel').addEventListener('click', closeAudit);
    document.getElementById('editSave').addEventListener('click', function () {
      const v = document.getElementById('editName').value.trim();
      if (!v) { document.getElementById('editName').style.borderColor = 'var(--red)'; return; }
      saveProfile(v, picked);
      closeAudit();
      render();
    });
  });

  document.getElementById('addBtn').addEventListener('click', function() {
    const nameInput = document.getElementById('newName');
    const caseInput = document.getElementById('newCaseSize');
    const name = nameInput.value.trim();
    const caseSize = parseInt(caseInput.value, 10);
    if (!name) {
      nameInput.style.borderColor = 'var(--red)';
      return;
    }
    if (!caseSize || caseSize < 1) {
      caseInput.style.borderColor = 'var(--red)';
      return;
    }
    nameInput.style.borderColor = '';
    caseInput.style.borderColor = '';
    snapshotForUndo('add item');
    items.push({ name: name, caseSize: caseSize, units: caseSize, mode: 'case', touched: Date.now(), category: guessCategory(name) || null });
    minimized.add(items.length - 1);
    nameInput.value = '';
    caseInput.value = '';
    closeAddItem();
    render();
    saveItems();
  });

  // ---------- swipe a collapsed row: right = +1 case, left = -1 case ----------
  (function () {
    const list = document.getElementById('itemList');
    if (!list) return;

    let card = null, row = null, startX = 0, startY = 0, dx = 0, active = false, decided = false;
    const TRIGGER = 62;

    list.addEventListener('touchstart', function (e) {
      const c2 = e.target.closest('.item-card.mini');
      if (!c2) return;
      card = c2;
      row = c2.querySelector('.mini-row');
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      active = true;
      decided = false;
    }, { passive: true });

    list.addEventListener('touchmove', function (e) {
      if (!active || !card) return;
      const nx = e.touches[0].clientX - startX;
      const ny = e.touches[0].clientY - startY;

      if (!decided) {
        // Let vertical scrolling win if that is clearly the intent
        if (Math.abs(ny) > Math.abs(nx)) { active = false; return; }
        decided = true;
        card.classList.add('swiping');
      }

      dx = Math.max(-110, Math.min(110, nx));
      if (row) row.style.transform = 'translateX(' + dx + 'px)';

      const l = card.querySelector('.swipe-hint.left');
      const r = card.querySelector('.swipe-hint.right');
      if (l) l.classList.toggle('show', dx > 18);
      if (r) r.classList.toggle('show', dx < -18);
    }, { passive: true });

    function endSwipe() {
      if (!card) { active = false; return; }
      const idx = parseInt(card.getAttribute('data-idx'), 10);
      const item = items[idx];
      const moved = dx;

      if (row) row.style.transform = '';
      card.classList.remove('swiping');
      const l = card.querySelector('.swipe-hint.left');
      const r = card.querySelector('.swipe-hint.right');
      if (l) l.classList.remove('show');
      if (r) r.classList.remove('show');

      card = null; row = null; active = false;

      if (!item || Math.abs(moved) < TRIGGER) return;

      const cs = item.caseSize || 1;
      const delta = moved > 0 ? cs : -Math.min(cs, item.units);
      if (delta === 0) return;

      snapshotForUndo();
      item.units = Math.max(0, item.units + delta);
      pushHistory(item, delta);
      buzz(22);
      bumpCount(idx);
      render();
      saveItems();
    }

    list.addEventListener('touchend', endSwipe);
    list.addEventListener('touchcancel', endSwipe);
  })();

  document.getElementById('itemList').addEventListener('click', function(e) {
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = parseInt(btn.getAttribute('data-idx'), 10);
    if (isNaN(idx) || !items[idx]) return;
    const action = btn.getAttribute('data-action');

    if (btn.classList.contains('mode-btn')) {
      items[idx].mode = btn.getAttribute('data-mode');
      render();
      saveItems();
      return;
    }

    if (btn.classList.contains('remove-btn')) {
      if (!confirm('Delete "' + items[idx].name + '" and its history? You can undo this right after.')) return;
      snapshotForUndo('delete ' + items[idx].name);
      allowEmptySave = true;
      items.splice(idx, 1);
      expanded.delete(idx);
      minimized.delete(idx);
      render();
      saveItems();
      return;
    }

    if (btn.classList.contains('edit-case')) {
      const val = prompt('Units per case for "' + items[idx].name + '":', items[idx].caseSize);
      const n = parseInt(val, 10);
      if (n && n > 0) {
        items[idx].caseSize = n;
        touchItem(items[idx]);
        render();
        saveItems();
      }
      return;
    }

    if (btn.classList.contains('edit-barcode')) {
      const item = items[idx];
      const codes = Array.isArray(item.barcodes) ? item.barcodes : [];
      if (codes.length) {
        const which = confirm('"' + item.name + '" has ' + codes.length + ' linked code(s):\n\n' +
          codes.join('\n') + '\n\nOK = scan another code\nCancel = remove all codes');
        if (which) { openBarcode('link', idx); return; }
        if (confirm('Remove all barcodes from "' + item.name + '"?')) {
          item.barcodes = [];
          touchItem(item);
          render();
          saveItems();
        }
        return;
      }
      openBarcode('link', idx);
      return;
    }

    if (btn.classList.contains('edit-cat')) {
      const item = items[idx];
      const list = categories.slice();
      const menu = list.map(function (cat, i) { return (i + 1) + '. ' + cat; }).join('\n');
      const pick = prompt('Category for "' + item.name + '"\n\n' + menu +
        '\n\nType a number, or type a new category name. Blank clears it.',
        itemCategory(item));
      if (pick === null) return;
      const val = pick.trim();
      if (!val) {
        item.category = null;
      } else if (/^\d+$/.test(val) && list[parseInt(val, 10) - 1]) {
        item.category = list[parseInt(val, 10) - 1];
      } else {
        item.category = val;
        if (categories.indexOf(val) === -1) {
          categories.push(val);
          saveCategories();
        }
      }
      touchItem(item);
      render();
      saveItems();
      return;
    }

    if (btn.classList.contains('hc-open')) {
      startHandCount(idx);
      return;
    }

    if (btn.classList.contains('edit-variant')) {
      askVariant(items[idx], function () { closeAudit(); render(); });
      return;
    }

    if (btn.classList.contains('edit-item')) {
      editItem(idx);
      return;
    }

    if (btn.classList.contains('tray-btn')) {
      startTrayCount(idx);
      return;
    }

    if (btn.classList.contains('waste-btn')) {
      const item = items[idx];
      const cs = item.caseSize || 1;
      const ans = prompt('Log waste for "' + item.name + '".\n\n' +
        'How much was thrown out? Add "cs" for cases (e.g. "12" = 12 units, "1 cs" = 1 case).', '');
      if (ans === null) return;
      const txt = ans.trim().toLowerCase();
      const num = parseFloat(txt);
      if (isNaN(num) || num <= 0) return;
      const units = /\b(cs|case|cases|box|boxes)\b/.test(txt) ? Math.round(num * cs) : Math.round(num);
      const delta = -Math.min(units, item.units);
      if (delta === 0) { alert('Nothing on hand to waste.'); return; }
      snapshotForUndo('waste ' + item.name);
      item.units = Math.max(0, item.units + delta);
      pushHistory(item, delta, 'waste');
      buzz(20);
      bumpCount(idx);
      render();
      saveItems();
      showCommandToast('Logged ' + Math.abs(delta) + ' units wasted \u2014 ' + item.name, true);
      return;
    }

    if (btn.classList.contains('edit-note')) {
      const val = prompt('Note for "' + items[idx].name + '" (supplier, item number, where it lives, etc.). Leave blank to remove:', items[idx].note || '');
      if (val === null) return;
      items[idx].note = val.trim() || null;
      touchItem(items[idx]);
      render();
      saveItems();
      return;
    }

    if (btn.classList.contains('edit-lowstock')) {
      openLowStockModal(idx);
      return;
    }

    if (action === 'toggle-history') {
      if (expanded.has(idx)) expanded.delete(idx);
      else expanded.add(idx);
      render();
      return;
    }

    if (action === 'clear-history') {
      if (confirm('Clear all activity history for "' + items[idx].name + '"? This can\'t be undone.')) {
        items[idx].history = [];
        render();
        saveItems();
      }
      return;
    }

    if (action === 'more') {
      if (moreOpen.has(idx)) moreOpen.delete(idx); else moreOpen.add(idx);
      render();
      return;
    }

    if (action === 'toggle-mini') {
      if (minimized.has(idx)) minimized.delete(idx);
      else minimized.add(idx);
      updateCollapseAllBtn();
      render();
      return;
    }

    if (action === 'up' && idx > 0) {
      const tmp = items[idx - 1];
      items[idx - 1] = items[idx];
      items[idx] = tmp;
      render();
      saveItems();
      return;
    }

    if (action === 'down' && idx < items.length - 1) {
      const tmp = items[idx + 1];
      items[idx + 1] = items[idx];
      items[idx] = tmp;
      render();
      saveItems();
      return;
    }

    const item = items[idx];
    let delta = 0;
    const halfCase = Math.max(1, Math.round(item.caseSize / 2));
    if (action === 'unit+1') delta = 1;
    else if (action === 'unit-1') delta = -Math.min(1, item.units);
    else if (action === 'case+1') delta = item.caseSize;
    else if (action === 'case-1') delta = -Math.min(item.caseSize, item.units);
    else if (action === 'half+1') delta = halfCase;
    else if (action === 'half-1') delta = -Math.min(halfCase, item.units);
    if (delta !== 0) {
      snapshotForUndo((delta > 0 ? '+' : '\u2212') + Math.abs(delta) + ' ' + item.name);
      item.units = Math.max(0, item.units + delta);
      pushHistory(item, delta);
      noteComponentUse(item, delta);
      buzz(Math.abs(delta) >= item.caseSize ? 22 : 12);
      bumpCount(idx);
    }
    render();
    saveItems();
  });

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

  const NUM_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90, hundred: 100
  };

  function wordsToDigits(text) {
    const words = text.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < words.length) {
      const clean = words[i].toLowerCase().replace(/[^a-z]/g, '');
      if (Object.prototype.hasOwnProperty.call(NUM_WORDS, clean)) {
        let total = 0;
        let current = 0;
        while (i < words.length) {
          const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
          if (w === 'and') { i++; continue; }
          if (!Object.prototype.hasOwnProperty.call(NUM_WORDS, w)) break;
          const val = NUM_WORDS[w];
          if (val === 100) {
            current = (current === 0 ? 1 : current) * 100;
          } else {
            current += val;
          }
          i++;
        }
        total += current;
        out.push(String(total));
      } else {
        out.push(words[i]);
        i++;
      }
    }
    return out.join(' ');
  }

  function toTitleCase(s) {
    return s.replace(/\w\S*/g, function(w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
  }

  // Matching has to survive how people actually talk: "croissants" for
  // "Croissant, Plain", "munchkins" for "Munchkin, Yeast Glazed", partial names,
  // and words in a different order.
  function normWords(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(function (w) {
        // crude singularisation: boxes->box, cases->case, croissants->croissant
        if (w.length > 3 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
        if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
        if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
        return w;
      });
  }

  const MATCH_STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, with: 1, plain: 0.3 };

  function matchItem(nameGuess) {
    const q = normWords(nameGuess);
    if (!q.length) return -1;

    let bestIdx = -1, bestScore = 0;

    items.forEach(function (it, i) {
      const w = normWords(it.name);
      if (!w.length) return;

      let hits = 0, weight = 0;
      q.forEach(function (token) {
        const val = MATCH_STOP[token] != null ? MATCH_STOP[token] : 1;
        if (!val) return;
        // exact token, or a token that starts with it (choc -> chocolate)
        const found = w.some(function (x) {
          return x === token || (token.length >= 4 && x.indexOf(token) === 0) ||
                 (x.length >= 4 && token.indexOf(x) === 0);
        });
        if (found) { hits++; weight += val; }
      });

      if (!hits) return;
      // Favour matching most of what was said, then most of the item's name
      const coverage = weight / q.length;
      const specificity = hits / w.length;
      const score = coverage * 2 + specificity;
      if (coverage >= 0.5 && score > bestScore) { bestScore = score; bestIdx = i; }
    });

    return bestIdx;
  }

  function splitClauses(text) {
    return text
      .split(/,|\band then\b|\bthen\b|\band\b/i)
      .map(function(s) { return s.trim(); })
      .filter(Boolean);
  }

  function parseClause(text) {
    const raw = wordsToDigits(text.trim());
    if (!raw) return null;
    const lower = raw.toLowerCase();

    if (/\b(undo|never mind|nevermind|scratch that|take that back)\b/.test(lower)) {
      return { type: 'undo' };
    }

    if (/\b(what.?s low|whats low|low stock|what needs|need to order|shopping list|reorder)\b/.test(lower)) {
      return { type: 'lowreport' };
    }

    const renameMatch = lower.match(/\b(?:rename|call)\b\s+(.+?)\s+(?:to|as)\s+(.+)$/);
    if (renameMatch) {
      const idx = matchItem(renameMatch[1].replace(/\bthe\b/g, '').trim());
      if (idx === -1) return { type: 'error', message: 'Couldn\'t find "' + renameMatch[1].trim() + '" to rename.' };
      return { type: 'rename', idx: idx, name: toTitleCase(renameMatch[2].trim()) };
    }

    const caseSizeMatch = lower.match(/^(.+?)\s+(?:is|are|has|have)\s+(\d+)\s*(?:units?\s*)?(?:per|a|in a|to a)\s*(?:case|box)/);
    if (caseSizeMatch) {
      const idx = matchItem(caseSizeMatch[1].replace(/\b(the|a|an)\b/g, '').trim());
      if (idx !== -1) {
        return { type: 'casesize', idx: idx, value: parseInt(caseSizeMatch[2], 10) };
      }
    }

    const queryMatch = /\b(how many|how much|what.?s the count|count of|check on|check)\b/.test(lower);
    if (queryMatch) {
      let nameGuess = lower
        .replace(/\b(how many|how much|what.?s the count of|count of|check on|check|do we have|are there|is there|left|in stock|remaining|of|the|are|is)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const idx = matchItem(nameGuess);
      if (idx === -1) {
        return { type: 'error', message: nameGuess ? ('Couldn\'t find an item called "' + nameGuess + '."') : 'Which item did you want to check?' };
      }
      return { type: 'query', idx: idx };
    }

    const outOfStock = /\b(we'?re out of|out of|no more|none left|ran out of)\b/.test(lower);
    if (outOfStock) {
      let nameGuess = lower
        .replace(/\b(we'?re out of|out of|no more|none left|ran out of|of|the)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const idx = matchItem(nameGuess);
      if (idx !== -1) return { type: 'set', idx: idx, value: 0 };
    }

    const createMatch = lower.match(/\b(?:add|create|new)\b[^a-z0-9]*item\b(.*)$/);
    if (createMatch) {
      let rest = createMatch[1];
      const numMatch = rest.match(/-?\d+(\.\d+)?/);
      if (!numMatch) {
        return { type: 'error', message: 'Tell me the units per case too, like "add item napkins, 50 per case."' };
      }
      const caseSize = Math.round(parseFloat(numMatch[0]));
      let name = rest.slice(0, numMatch.index)
        .replace(/,/g, ' ')
        .replace(/\b(with|is|of|at|units?|per|case|cases|box|boxes|a|an)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name) name = 'New item';
      return { type: 'create', name: toTitleCase(name), caseSize: caseSize };
    }

    let sign = 1;
    if (/\b(remove|subtract|minus|took|take away|used up|used|sold|gave away|threw out|threw away)\b/.test(lower)) sign = -1;
    const setMode = /\bset\b/.test(lower) && sign === 1 && !/\badd\b/.test(lower);

    const fracMatch = lower.match(/\b(half|a half|one half|quarter|a quarter|three quarters?)\b/);
    const numMatch = lower.match(/-?\d+(\.\d+)?/);
    if (!numMatch && !fracMatch) {
      return { type: 'error', message: 'Didn\'t catch a number. Try "add 3 cases of napkins."' };
    }

    let fracValue = 0;
    if (fracMatch) {
      const f = fracMatch[1];
      if (/three quarters?/.test(f)) fracValue = 0.75;
      else if (/quarter/.test(f)) fracValue = 0.25;
      else fracValue = 0.5;
    }

    const num = numMatch ? Math.round(parseFloat(numMatch[0])) : 0;
    const isCaseWord = /\b(case|cases|box|boxes)\b/.test(lower);

    let nameGuess = lower
      .replace(numMatch ? numMatch[0] : '', ' ')
      .replace(/\b(half|a half|one half|quarter|a quarter|three quarters?)\b/g, ' ')
      .replace(/\b(add|remove|subtract|minus|set|took|take|away|used|up|plus|received|got|got in|delivered|restocked|brought in|dropped off|sold|gave|threw|out|of|to|from|the|a|an|is|units?|case|cases|box|boxes|please)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const idx = matchItem(nameGuess);
    if (idx === -1) {
      return {
        type: 'error',
        message: nameGuess ? ('Couldn\'t find an item called "' + nameGuess + '." Try "add item ' + nameGuess + ', 24 per case" to create it.') : 'Which item? Try "add 3 cases of napkins."'
      };
    }

    const item = items[idx];
    const caseCount = num + fracValue;
    const deltaUnits = isCaseWord || fracValue
      ? Math.round(caseCount * item.caseSize)
      : num;
    if (setMode) return { type: 'set', idx: idx, value: deltaUnits };
    return { type: 'delta', idx: idx, value: sign * deltaUnits };
  }

  function speak(text) {
    if (!speechEnabled || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.02;
      window.speechSynthesis.speak(utter);
    } catch (e) {}
  }

  function showCommandToast(msg, isError) {
    const t = document.getElementById('commandToast');
    t.textContent = msg || '';
    t.classList.toggle('error', !!isError);
    t.classList.toggle('show', !!msg);
  }

  function submitGlobalCommand(speakResult) {
    const input = document.getElementById('commandInput');
    const clauses = splitClauses(input.value);
    if (!clauses.length) return;

    const messages = [];
    let hadError = false;
    let anyChange = false;

    clauses.forEach(function(clause) {
      const result = parseClause(clause);
      if (!result) return;

      if (result.type === 'error') {
        messages.push(result.message);
        hadError = true;
        return;
      }

      if (result.type === 'query') {
        const it = items[result.idx];
        const c = calc(it.units, it.caseSize);
        messages.push(it.name + ': ' + c.decimalCases.toLocaleString() + ' cases (' + it.units.toLocaleString() + ' units)');
        return;
      }

      if (result.type === 'undo') {
        if (undoStack.length) {
          performUndo();
          messages.push('Undid the last change');
        } else {
          messages.push('Nothing to undo');
        }
        return;
      }

      if (result.type === 'lowreport') {
        const low = items.filter(function(it) {
          const t = lowThresholdUnits(it);
          return t != null && it.units <= t;
        });
        if (!low.length) {
          messages.push('Nothing is low right now');
        } else {
          messages.push('Low: ' + low.map(function(it) {
            return it.name + ' (' + calc(it.units, it.caseSize).decimalCases + ' cases)';
          }).join(', '));
        }
        return;
      }

      if (result.type === 'rename') {
        if (!anyChange) snapshotForUndo();
        anyChange = true;
        const oldName = items[result.idx].name;
        items[result.idx].name = result.name;
        touchItem(items[result.idx]);
        messages.push('Renamed ' + oldName + ' to ' + result.name);
        return;
      }

      if (result.type === 'casesize') {
        if (!anyChange) snapshotForUndo();
        anyChange = true;
        items[result.idx].caseSize = result.value;
        touchItem(items[result.idx]);
        messages.push(items[result.idx].name + ' is now ' + result.value + ' per case');
        return;
      }

      if (result.type === 'create') {
        if (!anyChange) snapshotForUndo();
        anyChange = true;
        items.push({ name: result.name, caseSize: result.caseSize, units: result.caseSize, mode: 'case', history: [], touched: Date.now(), category: guessCategory(result.name) || null });
        minimized.add(items.length - 1);
        messages.push('Created "' + result.name + '", ' + result.caseSize + ' per case');
        return;
      }

      if (!anyChange) snapshotForUndo();
      anyChange = true;
      const item = items[result.idx];
      if (result.type === 'set') {
        const delta = result.value - item.units;
        item.units = result.value;
        if (delta !== 0) pushHistory(item, delta);
        messages.push(result.value === 0 ? (item.name + ' set to 0') : ('Set ' + item.name + ' to ' + result.value.toLocaleString() + ' units'));
      } else {
        const before = item.units;
        item.units = Math.max(0, item.units + result.value);
        const actualDelta = item.units - before;
        if (actualDelta !== 0) pushHistory(item, actualDelta);
        const verb = result.value >= 0 ? 'Added' : 'Removed';
        messages.push(verb + ' ' + Math.abs(result.value).toLocaleString() + ' units ' + (result.value >= 0 ? 'to' : 'from') + ' ' + item.name);
      }
    });

    input.value = '';
    showCommandToast(messages.join(' • '), hadError);
    if (speakResult) speak(messages.join('. '));
    if (anyChange) {
      render();
      saveItems();
    }
  }

  document.getElementById('commandGo').addEventListener('click', function() { submitGlobalCommand(false); });
  document.getElementById('undoBtn').addEventListener('click', performUndo);
  document.getElementById('commandInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') submitGlobalCommand(false);
  });

  // ---- add item modal ----
  function openAddItem() {
    const n = document.getElementById('newName');
    const cs = document.getElementById('newCaseSize');
    n.value = ''; cs.value = '';
    n.style.borderColor = ''; cs.style.borderColor = '';
    document.getElementById('addItemGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    n.focus();
  }

  function closeAddItem() {
    document.getElementById('addItemGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  }

  document.getElementById('addItemBtn').addEventListener('click', openAddItem);
  document.getElementById('addItemCancel').addEventListener('click', closeAddItem);
  document.getElementById('newCaseSize').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('addBtn').click();
  });

  function updateVoiceButtons() {
    const sb = document.getElementById('speakBtn');
    sb.classList.toggle('on', speechEnabled);
    sb.textContent = speechEnabled ? '\uD83D\uDD0A' : '\uD83D\uDD07';
    const hf = document.getElementById('handsFreeBtn');
    hf.classList.toggle('live', handsFree);
    hf.textContent = handsFree ? '\u23F9 Stop' : '\uD83D\uDD04 Hands-free';
  }

  function startListening(continuous) {
    if (!SpeechRecognitionAPI) {
      showCommandToast('Voice input isn\'t supported in this browser — tap the field and use your keyboard\'s dictation button instead.', true);
      return;
    }
    const micBtn = document.getElementById('commandMic');
    const recognition = new SpeechRecognitionAPI();
    activeRecognition = recognition;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = !!continuous;

    recognition.onstart = function() {
      micBtn.classList.add('listening');
      showCommandToast(continuous ? 'Hands-free on — just talk' : 'Listening...');
    };

    recognition.onresult = function(e) {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const said = e.results[i][0].transcript;
        document.getElementById('commandInput').value = wordsToDigits(said);
        submitGlobalCommand(true);
      }
    };

    recognition.onerror = function(e) {
      if (e.error === 'no-speech' && handsFree) return;
      showCommandToast('Couldn\'t hear that clearly. Try again.', true);
    };

    recognition.onend = function() {
      micBtn.classList.remove('listening');
      if (handsFree && activeRecognition === recognition) {
        try { recognition.start(); micBtn.classList.add('listening'); } catch (err) {}
      }
    };

    try { recognition.start(); } catch (err) {}
  }

  function stopListening() {
    handsFree = false;
    if (activeRecognition) {
      try { activeRecognition.stop(); } catch (e) {}
      activeRecognition = null;
    }
    document.getElementById('commandMic').classList.remove('listening');
    updateVoiceButtons();
  }

  document.getElementById('commandMic').addEventListener('click', function() {
    if (handsFree) { stopListening(); return; }
    startListening(false);
  });

  document.getElementById('handsFreeBtn').addEventListener('click', function() {
    if (handsFree) {
      stopListening();
      showCommandToast('Hands-free off');
      return;
    }
    handsFree = true;
    updateVoiceButtons();
    startListening(true);
  });

  document.getElementById('speakBtn').addEventListener('click', function() {
    speechEnabled = !speechEnabled;
    localStorage.setItem('tally_speak', speechEnabled ? '1' : '0');
    updateVoiceButtons();
    if (speechEnabled) speak('Voice replies on');
  });

  updateVoiceButtons();

  const DEFAULT_STORE = 'MAIN';
  let isAdmin = false;

  async function hashPass(pass) {
    const buf = new TextEncoder().encode('tally:' + pass);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(function(b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  function configRef() { return db.ref('tally/config'); }

  async function loadConfig() {
    const snap = await configRef().get();
    return snap.val() || null;
  }

  function goToStore(code) {
    const clean = normalizeRoom(code);
    if (!clean) return false;
    localStorage.setItem('tally_room', clean);
    const params = new URLSearchParams(window.location.search);
    params.set('store', clean);
    window.location.search = params.toString();
    return true;
  }

  function renderStoreList(stores) {
    const wrap = document.getElementById('storeList');
    const list = stores && stores.length ? stores : [DEFAULT_STORE];
    wrap.innerHTML = list.map(function(code) {
      return '<div class="store-entry' + (code === roomCode ? ' active' : '') + '">' +
        '<span class="code">' + code + '</span>' +
        (code === roomCode ? '<span style="font-size:10px;color:var(--text-dim);">current</span>'
          : '<button type="button" data-store="' + code + '">open</button>') +
      '</div>';
    }).join('');
  }

  async function refreshStoreList() {
    const cfg = await loadConfig();
    renderStoreList((cfg && cfg.stores) || [DEFAULT_STORE]);
  }

  async function addStore(code) {
    const cfg = (await loadConfig()) || {};
    const stores = cfg.stores || [DEFAULT_STORE];
    if (stores.indexOf(code) === -1) stores.push(code);
    await configRef().update({ stores: stores });
    return stores;
  }

  document.getElementById('setupBtn').addEventListener('click', async function() {
    const p1 = document.getElementById('setupPass').value;
    const p2 = document.getElementById('setupPass2').value;
    if (!p1 || p1.length < 4) {
      document.getElementById('setupPass').style.borderColor = 'var(--red)';
      return;
    }
    if (p1 !== p2) {
      document.getElementById('setupPass2').style.borderColor = 'var(--red)';
      return;
    }
    const hash = await hashPass(p1);
    const adminUids = {};
    if (myUid) adminUids[myUid] = { label: 'First device', addedAt: Date.now() };
    try {
      await configRef().set({ adminHash: hash, stores: [DEFAULT_STORE], adminUid: myUid || null, adminUids: adminUids });
    } catch (e) {
      const code = e.code || e.message || 'unknown';
      alert('Could not save admin setup.\n\nError: ' + code +
        (String(code).indexOf('permission') !== -1
          ? '\n\nYour Firebase rules are blocking this. Open Realtime Database -> Rules and publish the updated rules (the ones that read the approved-device list), or temporarily use:\n\n{ "rules": { ".read": true, ".write": true } }'
          : ''));
      console.error('Tally setup error:', e);
      return;
    }
    sessionStorage.setItem('tally_admin', '1');
    goToStore(DEFAULT_STORE);
  });

  function isApprovedDevice(cfg) {
    if (!myUid || !cfg) return false;
    if (cfg.adminUids && cfg.adminUids[myUid]) return true;
    // Legacy single-device config
    if (cfg.adminUid && cfg.adminUid === myUid) return true;
    return false;
  }

  async function applyAdminDeviceState() {
    const banner = document.getElementById('adminReadOnly');
    if (banner) banner.style.display = 'none';
    let cfg = null;
    try { cfg = await loadConfig(); } catch (e) {}
    if (!cfg) return;

    // Migrate legacy single-uid config onto the map
    if (!cfg.adminUids && cfg.adminUid && cfg.adminUid === myUid) {
      const m = {};
      m[myUid] = { label: 'First device', addedAt: Date.now() };
      try { await configRef().update({ adminUids: m }); } catch (e) {}
    }
    renderApprovedDevices(cfg);
  }

  function renderApprovedDevices(cfg) {
    const wrap = document.getElementById('deviceList');
    if (!wrap) return;
    const map = (cfg && cfg.adminUids) || {};
    const uids = Object.keys(map);
    if (!uids.length) {
      wrap.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:4px 0;">No approved devices recorded.</div>';
      return;
    }
    wrap.innerHTML = uids.map(function(uid) {
      const d = map[uid] || {};
      const isMe = uid === myUid;
      return '<div class="store-entry' + (isMe ? ' active' : '') + '">' +
        '<span class="code" style="font-size:11px;">' + escapeHtml(d.label || 'Device') + (isMe ? ' (this one)' : '') + '</span>' +
        (isMe ? '<span style="font-size:10px;color:var(--text-dim);">current</span>'
              : '<button type="button" data-revoke="' + uid + '">revoke</button>') +
      '</div>';
    }).join('');
  }

  function toggleAdmin() {
    if (isAdmin) {
      const panel = document.getElementById('adminPanel');
      const showing = panel.style.display !== 'none';
      panel.style.display = showing ? 'none' : 'block';
      if (!showing) { refreshStoreList(); applyAdminDeviceState(); }
      return;
    }
    document.getElementById('adminGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
  }


  document.getElementById('adminCancelBtn').addEventListener('click', function() {
    document.getElementById('adminGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  });

  document.getElementById('adminLoginBtn').addEventListener('click', async function() {
    const entered = document.getElementById('adminPass').value;
    const cfg = await loadConfig();
    const hash = await hashPass(entered);
    if (!cfg || hash !== cfg.adminHash) {
      document.getElementById('adminPass').style.borderColor = 'var(--red)';
      return;
    }
    isAdmin = true;
    sessionStorage.setItem('tally_admin', '1');
    askNotifyPermission();
    watchPendingStaff();
    document.getElementById('adminGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
    document.getElementById('adminPanel').style.display = 'block';
    document.getElementById('adminPass').value = '';
    refreshStoreList();
    applyAdminDeviceState();
  });




  document.getElementById('adminLogoutBtn').addEventListener('click', function() {
    isAdmin = false;
    sessionStorage.removeItem('tally_admin');
    document.getElementById('adminPanel').style.display = 'none';
  });

  document.getElementById('migrateBtn').addEventListener('click', async function() {
    try {
      const snap = await db.ref('tally/items').get();
      const val = snap.val();
      const oldList = val && val.list ? val.list : null;
      if (!oldList || !oldList.length) {
        alert('No old inventory found to import.');
        return;
      }
      if (!confirm('Import ' + oldList.length + ' item(s) from the old inventory into store ' + roomCode + '? Existing items here will be kept and duplicates may appear.')) return;
      snapshotForUndo();
      oldList.forEach(function(oldItem) {
        const exists = items.some(function(it) {
          return it.name.toLowerCase() === String(oldItem.name || '').toLowerCase();
        });
        if (!exists) items.push(oldItem);
      });
      render();
      saveItems();
      alert('Imported. Your old items are now in ' + roomCode + '.');
    } catch (e) {
      alert('Import failed: ' + e.message);
    }
  });

  let auditState = null;

  function startAudit() {
    if (!items.length) {
      alert('No items to audit yet.');
      return;
    }

    // Offer hands-free before starting
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML =
      '<div class="audit-item-name">Spot audit</div>' +
      '<div class="audit-sub">A random sample of your items. How do you want to count?</div>' +
      '<div class="scan-choice">' +
        '<button type="button" class="scan-source" id="auditTapBtn">' +
          '<span class="scan-icon">&#128241;</span><span>Tap the numbers in</span>' +
        '</button>' +
        '<button type="button" class="scan-source" id="auditVoiceBtn">' +
          '<span class="scan-icon">&#127908;</span><span>Hands-free &mdash; it asks, you answer</span>' +
        '</button>' +
      '</div>' +
      '<div class="join-hint">Hands-free reads each item out loud and listens for your count. Good for gloves and cold hands.<br><br>' +
      '<button type="button" class="store-action" id="auditPickCancel">Cancel</button></div>';

    document.getElementById('auditPickCancel').addEventListener('click', closeAudit);
    document.getElementById('auditTapBtn').addEventListener('click', function () { beginAudit(false); });
    document.getElementById('auditVoiceBtn').addEventListener('click', function () { beginAudit(true); });
  }

  function beginAudit(handsFreeMode) {
    const count = Math.min(items.length, Math.max(3, Math.ceil(items.length * 0.25)));
    const pool = items.map(function(it, i) { return i; });
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    auditState = {
      queue: pool.slice(0, count),
      step: 0,
      results: [],
      startedAt: Date.now(),
      voice: !!handsFreeMode
    };
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    renderAuditStep();
  }

  function closeAudit() {
    stopAuditVoice();
    auditState = null;
    document.getElementById('auditGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  }

  function renderAuditStep() {
    const body = document.getElementById('auditBody');
    if (!auditState) return;

    if (auditState.step >= auditState.queue.length) {
      renderAuditReport();
      return;
    }

    const idx = auditState.queue[auditState.step];
    const item = items[idx];
    body.innerHTML =
      '<div class="audit-progress">ITEM ' + (auditState.step + 1) + ' OF ' + auditState.queue.length + '</div>' +
      '<div class="audit-item-name">' + escapeHtml(item.name) + '</div>' +
      '<div class="audit-sub">' + item.caseSize + ' per case &middot; count what\'s physically there</div>' +
      '<div class="audit-inputs">' +
        '<div class="audit-field"><label>FULL CASES</label><input type="number" min="0" id="auditCases" placeholder="0"></div>' +
        '<div class="audit-field"><label>LOOSE UNITS</label><input type="number" min="0" id="auditUnits" placeholder="0"></div>' +
      '</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="auditSkipBtn">Skip</button>' +
        '<button type="button" id="auditNextBtn">Next</button>' +
      '</div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="auditCancelBtn">Cancel audit</button></div>';

    if (auditState.voice) {
      const vm = document.createElement('div');
      vm.className = 'audit-voice-msg';
      vm.id = 'auditVoiceMsg';
      vm.textContent = 'Starting\u2026';
      body.insertBefore(vm, body.querySelector('.audit-inputs'));
      setTimeout(auditAsk, 250);
    } else {
      document.getElementById('auditCases').focus();
    }
    document.getElementById('auditNextBtn').addEventListener('click', function () {
      stopAuditVoice();
      recordAuditStep();
    });
    document.getElementById('auditSkipBtn').addEventListener('click', function() {
      stopAuditVoice();
      auditState.step++;
      renderAuditStep();
    });
    document.getElementById('auditCancelBtn').addEventListener('click', closeAudit);
  }

  // ---------- hands-free audit: speak the item, listen for the count ----------
  let auditRecog = null;

  function stopAuditVoice() {
    if (auditRecog) {
      try { auditRecog.abort(); } catch (e) {}
      auditRecog = null;
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  }

  function say(text, done) {
    if (!('speechSynthesis' in window)) { if (done) done(); return; }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.onend = function () { if (done) done(); };
      u.onerror = function () { if (done) done(); };
      window.speechSynthesis.speak(u);
    } catch (e) { if (done) done(); }
  }

  // "two and a half" / "3.5" / "two cases six" -> units
  function parseSpokenCount(text, item) {
    const t = wordsToDigits(String(text).toLowerCase());
    const cs = item.caseSize || 1;

    if (/\b(none|zero|empty|out|nothing)\b/.test(t)) return 0;
    if (/\b(skip|pass|next)\b/.test(t)) return 'skip';

    // "three point five" -> "3.5"
    const t2 = t.replace(/(\d+)\s*point\s*(\d+)/g, '$1.$2');
    const nums = (t2.match(/\d+(\.\d+)?/g) || []).map(parseFloat);

    // "three quarters" arrives as "3 quarters" after word-to-digit conversion
    if (/\b3\s+quarters\b/.test(t2)) return Math.round(0.75 * cs);

    let frac = 0;
    if (/\bquarters?\b/.test(t2)) frac = 0.25;
    else if (/\bhalf\b/.test(t2)) frac = 0.5;

    // A bare "half" or "a quarter" with no number still means something
    if (!nums.length) {
      if (!frac) return null;
      return Math.round(frac * cs);
    }

    // "2 cases and 30" style
    const caseThenUnits = t2.match(/(\d+(?:\.\d+)?)\s*(?:cs|case|cases|box|boxes)\D+(\d+)/);
    if (caseThenUnits) {
      return Math.round(parseFloat(caseThenUnits[1]) * cs) + parseInt(caseThenUnits[2], 10);
    }

    const saysUnits = /\b(unit|units|each|piece|pieces|singles?)\b/.test(t2);
    const n = nums[0] + frac;
    return saysUnits ? Math.round(n) : Math.round(n * cs);
  }

  function auditAsk() {
    if (!auditState || !auditState.voice) return;
    const idx = auditState.queue[auditState.step];
    const item = items[idx];
    if (!item) return;

    const prompt = 'How many cases of ' + item.name + '?';
    setAuditVoiceMsg(prompt, false);
    say(prompt, function () { auditListen(); });
  }

  function setAuditVoiceMsg(msg, listening) {
    const el = document.getElementById('auditVoiceMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = listening ? 'var(--teal)' : 'var(--text-dim)';
  }

  function auditListen() {
    if (!auditState || !auditState.voice) return;
    if (!SpeechRecognitionAPI) {
      setAuditVoiceMsg('Voice not supported here \u2014 type it in.', false);
      return;
    }
    const idx = auditState.queue[auditState.step];
    const item = items[idx];
    if (!item) return;

    stopAuditVoice();
    const rec = new SpeechRecognitionAPI();
    auditRecog = rec;
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onstart = function () { setAuditVoiceMsg('Listening\u2026', true); };

    rec.onresult = function (e) {
      const said = e.results[0][0].transcript;
      const parsed = parseSpokenCount(said, item);

      if (parsed === 'skip') {
        say('Skipped.', function () {
          auditState.step++;
          renderAuditStep();
        });
        return;
      }
      if (parsed == null) {
        say('Sorry, how many?', function () { auditListen(); });
        setAuditVoiceMsg('Didn\'t catch "' + said + '"', false);
        return;
      }

      const cases = Number((parsed / (item.caseSize || 1)).toFixed(2));
      auditState.results.push({
        idx: idx, name: item.name, expected: item.units,
        counted: parsed, caseSize: item.caseSize
      });
      buzz(20);
      setAuditVoiceMsg('Got ' + cases + ' cases', true);
      say('Got it, ' + cases + '.', function () {
        auditState.step++;
        renderAuditStep();
      });
    };

    rec.onerror = function (e) {
      if (e.error === 'no-speech') { say('Still there?', function () { auditListen(); }); return; }
      setAuditVoiceMsg('Mic problem \u2014 tap to retry', false);
    };

    try { rec.start(); } catch (e) {}
  }

  function recordAuditStep() {
    const idx = auditState.queue[auditState.step];
    const item = items[idx];
    const cases = parseInt(document.getElementById('auditCases').value, 10) || 0;
    const loose = parseInt(document.getElementById('auditUnits').value, 10) || 0;
    const counted = cases * item.caseSize + loose;
    auditState.results.push({
      idx: idx,
      name: item.name,
      expected: item.units,
      counted: counted,
      caseSize: item.caseSize
    });
    auditState.step++;
    renderAuditStep();
  }

  function renderAuditReport() {
    const body = document.getElementById('auditBody');
    const results = auditState.results;

    if (!results.length) {
      body.innerHTML = '<div class="audit-item-name">Audit cancelled</div>' +
        '<div class="audit-sub">Nothing was counted.</div>' +
        '<div class="audit-actions"><button type="button" id="auditDoneBtn">Close</button></div>';
      document.getElementById('auditDoneBtn').addEventListener('click', closeAudit);
      return;
    }

    const off = results.filter(function(r) { return r.counted !== r.expected; });
    const rows = results.map(function(r) {
      const diff = r.counted - r.expected;
      const cls = diff === 0 ? 'ok' : 'off';
      const label = diff === 0 ? 'match' : (diff > 0 ? '+' + diff : String(diff));
      return '<div class="audit-result-row">' +
        '<span>' + escapeHtml(r.name) + '</span>' +
        '<span class="audit-var ' + cls + '">' + r.expected + ' &rarr; ' + r.counted + ' (' + label + ')</span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Audit results</div>' +
      '<div class="audit-sub">' + results.length + ' item(s) counted &middot; ' + off.length + ' discrepancy(ies)</div>' +
      rows +
      '<div class="audit-summary">Applying corrections updates each item to the counted amount and logs it in that item\'s history, so the change is traceable for insurance.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="auditDiscardBtn">Discard</button>' +
        '<button type="button" id="auditApplyBtn">Apply corrections</button>' +
      '</div>';

    document.getElementById('auditDiscardBtn').addEventListener('click', closeAudit);
    document.getElementById('auditApplyBtn').addEventListener('click', function() {
      snapshotForUndo();
      auditState.results.forEach(function(r) {
        const item = items[r.idx];
        if (!item) return;
        const delta = r.counted - item.units;
        if (delta !== 0) {
          item.units = r.counted;
          pushHistory(item, delta);
        }
      });
      saveAuditRecord(auditState.results);
      render();
      saveItems();
      closeAudit();
      showCommandToast('Audit applied — ' + off.length + ' correction(s)');
    });
  }

  function auditLogRef() {
    return db.ref('tally/rooms/' + roomCode + '/audits');
  }

  function saveAuditRecord(results) {
    if (!isConfigured || !roomCode) return;
    const record = {
      ts: Date.now(),
      by: myName || 'someone',
      byRole: myRole || null,
      counted: results.length,
      discrepancies: results.filter(function(r) { return r.counted !== r.expected; }).length,
      lines: results.map(function(r) {
        return { name: r.name, expected: r.expected, counted: r.counted };
      })
    };
    auditLogRef().push(record).catch(function() {});
  }

  async function showAuditHistory() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML = '<div class="audit-item-name">Audit history</div><div class="audit-sub">Loading...</div>';

    let records = [];
    try {
      const snap = await auditLogRef().orderByChild('ts').limitToLast(25).get();
      const val = snap.val() || {};
      records = Object.keys(val).map(function(k) { return val[k]; }).sort(function(a, b) { return b.ts - a.ts; });
    } catch (e) {}

    if (!records.length) {
      body.innerHTML = '<div class="audit-item-name">Audit history</div>' +
        '<div class="audit-sub">No audits recorded yet for this store.</div>' +
        '<div class="audit-actions"><button type="button" id="auditHistCloseBtn">Close</button></div>';
      document.getElementById('auditHistCloseBtn').addEventListener('click', closeAudit);
      return;
    }

    const rows = records.map(function(r, i) {
      const d = new Date(r.ts);
      const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const cls = r.discrepancies ? 'off' : 'ok';
      return '<div class="audit-result-row">' +
        '<span>' + when + '<br><span style="font-size:11px;color:var(--text-dim);">by ' + escapeHtml(r.by || 'someone') + '</span></span>' +
        '<span class="audit-var ' + cls + '">' + r.counted + ' counted &middot; ' + r.discrepancies + ' off ' +
          '<button type="button" class="store-action" data-audit="' + i + '">details</button></span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Audit history</div>' +
      '<div class="audit-sub">Last ' + records.length + ' audit(s) for ' + roomCode + '</div>' +
      rows +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="auditExportBtn">Copy as text</button>' +
        '<button type="button" id="auditHistCloseBtn">Close</button>' +
      '</div>';

    document.getElementById('auditHistCloseBtn').addEventListener('click', closeAudit);

    document.getElementById('auditExportBtn').addEventListener('click', function() {
      const text = records.map(function(r) {
        const lines = (r.lines || []).map(function(l) {
          const diff = l.counted - l.expected;
          return '  ' + l.name + ': expected ' + l.expected + ', counted ' + l.counted + (diff ? ' (' + (diff > 0 ? '+' : '') + diff + ')' : '');
        }).join('\n');
        return new Date(r.ts).toLocaleString() + ' — by ' + (r.by || 'someone') +
          ' — ' + r.counted + ' counted, ' + r.discrepancies + ' discrepancies\n' + lines;
      }).join('\n\n');
      const full = 'Tally audit history — store ' + roomCode + '\n\n' + text;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(full).then(function() { alert('Copied to clipboard.'); });
      } else {
        prompt('Copy this:', full);
      }
    });

    body.addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-audit]');
      if (!btn) return;
      const r = records[parseInt(btn.getAttribute('data-audit'), 10)];
      if (!r) return;
      const detail = (r.lines || []).map(function(l) {
        const diff = l.counted - l.expected;
        return l.name + ': ' + l.expected + ' → ' + l.counted + (diff ? ' (' + (diff > 0 ? '+' : '') + diff + ')' : ' ✓');
      }).join('\n');
      alert(new Date(r.ts).toLocaleString() + '\nby ' + (r.by || 'someone') + '\n\n' + detail);
    });
  }

  let lowStockIdx = null;
  let lowStockMode = 'case';

  function setLowStockMode(mode) {
    lowStockMode = mode;
    Array.from(document.getElementById('lowStockMode').children).forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-lsmode') === mode);
    });
  }

  function openLowStockModal(idx) {
    const item = items[idx];
    if (!item) return;
    lowStockIdx = idx;

    let mode = 'case';
    let value = '';
    if (item.lowStockValue != null) {
      mode = item.lowStockMode === 'unit' ? 'unit' : 'case';
      value = item.lowStockValue;
    } else if (item.lowCases != null) {
      value = item.lowCases;
    } else if (item.lowStock != null) {
      mode = 'unit';
      value = item.lowStock;
    }

    document.getElementById('lowStockTitle').textContent = item.name;
    document.getElementById('lowStockSub').textContent =
      'Flag as low at or below this amount · ' + item.caseSize + ' per case';
    document.getElementById('lowStockValue').value = value;
    setLowStockMode(mode);
    document.getElementById('lowStockGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    document.getElementById('lowStockValue').focus();
  }

  function closeLowStockModal() {
    lowStockIdx = null;
    document.getElementById('lowStockGate').style.display = 'none';
    document.getElementById('appRoot').style.display = '';
  }

  document.getElementById('lowStockMode').addEventListener('click', function(e) {
    const btn = e.target.closest('button[data-lsmode]');
    if (btn) setLowStockMode(btn.getAttribute('data-lsmode'));
  });

  document.getElementById('lowStockSaveBtn').addEventListener('click', function() {
    if (lowStockIdx == null) return;
    const n = parseFloat(document.getElementById('lowStockValue').value);
    if (isNaN(n) || n < 0) {
      document.getElementById('lowStockValue').style.borderColor = 'var(--red)';
      return;
    }
    const item = items[lowStockIdx];
    item.lowStockValue = n;
    item.lowStockMode = lowStockMode;
    item.lowCases = null;
    item.lowStock = null;
    touchItem(item);
    closeLowStockModal();
    render();
    saveItems();
  });

  document.getElementById('lowStockClearBtn').addEventListener('click', function() {
    if (lowStockIdx == null) return;
    const item = items[lowStockIdx];
    item.lowStockValue = null;
    item.lowStockMode = null;
    item.lowCases = null;
    item.lowStock = null;
    touchItem(item);
    closeLowStockModal();
    render();
    saveItems();
  });

  document.getElementById('lowStockCancelBtn').addEventListener('click', closeLowStockModal);

  document.getElementById('lowStockValue').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('lowStockSaveBtn').click();
  });

  async function showSessionLog() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML = '<div class="audit-item-name">Sign-in log</div><div class="audit-sub">Loading...</div>';

    let records = [];
    try {
      const snap = await db.ref('tally/rooms/' + roomCode + '/sessions')
        .orderByChild('at').limitToLast(100).get();
      const val = snap.val() || {};
      records = Object.keys(val).map(function(k) { return val[k]; })
        .sort(function(a, b) { return b.at - a.at; });
    } catch (e) {}

    if (!records.length) {
      body.innerHTML = '<div class="audit-item-name">Sign-in log</div>' +
        '<div class="audit-sub">No sessions recorded yet for this store.</div>' +
        '<div class="audit-actions"><button type="button" id="sessCloseBtn">Close</button></div>';
      document.getElementById('sessCloseBtn').addEventListener('click', closeAudit);
      return;
    }

    const rows = records.map(function(r) {
      const d = new Date(r.at);
      const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return '<div class="audit-result-row">' +
        '<span>' + escapeHtml(r.name || 'Unnamed') +
          (r.role ? '<span class="role-tag">' + escapeHtml(r.role) + '</span>' : '') +
          (r.status && r.status !== 'opened'
            ? '<br><span style="font-size:10.5px;color:var(--red);">' + escapeHtml(r.status) + '</span>'
            : '') + '</span>' +
        '<span style="font-size:11px;color:var(--text-dim);">' + when + '</span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Sign-in log</div>' +
      '<div class="audit-sub">Last ' + records.length + ' session(s) in ' + roomCode + '</div>' +
      rows +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="sessExportBtn">Copy as text</button>' +
        '<button type="button" id="sessCloseBtn">Close</button>' +
      '</div>';

    document.getElementById('sessCloseBtn').addEventListener('click', closeAudit);
    document.getElementById('sessExportBtn').addEventListener('click', function() {
      const text = 'Tally sign-in log — store ' + roomCode + '\n\n' +
        records.map(function(r) {
          return new Date(r.at).toLocaleString() + ' — ' + (r.name || 'Unnamed');
        }).join('\n');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() { alert('Copied to clipboard.'); });
      } else {
        prompt('Copy this:', text);
      }
    });
  }

  async function showStaff() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML = '<div class="audit-item-name">Staff profiles</div><div class="audit-sub">Loading...</div>';

    let staff = [];
    let cfg = null;
    try {
      const snap = await db.ref('tally/rooms/' + roomCode + '/staff').get();
      const val = snap.val() || {};
      staff = Object.keys(val).map(function(k) { return { id: k, ...val[k] }; })
        .sort(function(a, b) { return (b.lastSeen || 0) - (a.lastSeen || 0); });
      cfg = await loadConfig();
    } catch (e) {}

    const adminUids = (cfg && cfg.adminUids) || {};
    const approvedUids = (cfg && cfg.approvedUids) || {};

    if (!staff.length) {
      body.innerHTML = '<div class="audit-item-name">Staff profiles</div>' +
        '<div class="audit-sub">Nobody has set up a profile in this store yet.</div>' +
        '<div class="audit-actions"><button type="button" id="staffCloseBtn">Close</button></div>';
      document.getElementById('staffCloseBtn').addEventListener('click', closeAudit);
      return;
    }

    const rows = staff.map(function(p) {
      const seen = p.lastSeen ? formatRelative(p.lastSeen) : 'never';
      const isMe = p.id === profileId;
      const isAdminUser = p.uid && adminUids[p.uid];
      const isOk = p.uid && (adminUids[p.uid] || approvedUids[p.uid]);
      const waiting = p.uid && !isOk;
      return '<div class="audit-result-row"' + (waiting ? ' style="background:rgba(194,79,63,0.12);border-radius:6px;"' : '') + '>' +
        '<span>' + escapeHtml(p.name || 'Unnamed') + (isMe ? ' (you)' : '') +
          (p.role ? '<span class="role-tag">' + escapeHtml(p.role) + '</span>' : '') +
          '<br><span style="font-size:11px;color:' + (waiting ? 'var(--red)' : 'var(--text-dim)') + ';">' +
            (waiting ? 'waiting for approval' : 'last seen ' + seen + (isAdminUser ? ' · admin' : '')) +
            (p.uid ? '' : ' · no device linked yet') + '</span></span>' +
        '<span class="staff-actions">' +
          (waiting
            ? '<button type="button" class="staff-btn ok" data-approve="' + p.uid + '" data-pname="' + escapeHtml(p.name || 'Unnamed') + '" title="Approve device">&#10003;</button>'
            : '') +
          (p.uid && isOk
            ? (isAdminUser
                ? '<button type="button" class="staff-btn" data-demote="' + p.uid + '" title="Remove admin">&#9733;</button>'
                : '<button type="button" class="staff-btn" data-promote="' + p.uid + '" data-pname="' + escapeHtml(p.name || 'Unnamed') + '" title="Make admin">&#9734;</button>')
            : '') +
          (p.uid && isOk && !isMe
            ? '<button type="button" class="staff-btn del" data-revoke="' + p.uid + '" data-pname="' +
              escapeHtml(p.name || 'Unnamed') + '" title="Revoke access">&#128683;</button>'
            : '') +
          (isMe ? '' : '<button type="button" class="staff-btn del" data-staff="' + p.id + '" title="Delete profile">&times;</button>') +
        '</span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Staff profiles</div>' +
      '<div class="audit-sub">' + staff.length + ' profile(s) in ' + roomCode + '</div>' +
      rows +
      '<div class="audit-summary">&#10003; approve device &middot; &#9734; make admin &middot; &#9733; remove admin &middot; &times; remove<br><br>New devices cannot change anything until approved. Approval applies to the device someone is signed in on — if they switch phones or browsers, approve them again.</div>' +
      '<div class="audit-actions"><button type="button" id="staffCloseBtn">Close</button></div>';

    document.getElementById('staffCloseBtn').addEventListener('click', closeAudit);

    body.addEventListener('click', async function(e) {
      const approve = e.target.closest('button[data-approve]');
      if (approve) {
        const uid = approve.getAttribute('data-approve');
        const name = approve.getAttribute('data-pname');
        if (!confirm('Approve "' + name + '" to use Tally?')) return;
        try {
          const update = {};
          update['approvedUids/' + uid] = { label: name, addedAt: Date.now() };
          await configRef().update(update);
          showStaff();
        } catch (err) {
          alert('Could not approve — this device is not an approved admin device.');
        }
        return;
      }

      const revoke = e.target.closest('button[data-revoke]');
      if (revoke) {
        const uid = revoke.getAttribute('data-revoke');
        const nm = revoke.getAttribute('data-pname');
        if (!confirm('Revoke access for "' + nm + '"?\n\nThey will be locked out and put back in the waiting list until you approve them again.')) return;
        try {
          await configRef().child('approvedUids').child(uid).remove();
          await configRef().child('adminUids').child(uid).remove();
          // Put their profile back into the pending state
          const person = staff.find(function (x) { return x.uid === uid; });
          if (person) {
            await db.ref('tally/rooms/' + roomCode + '/staff/' + person.id)
              .update({ pending: true }).catch(function () {});
          }
          showStaff();
        } catch (err) {
          alert('Could not revoke \u2014 this device is not an approved admin device.');
        }
        return;
      }

      const promote = e.target.closest('button[data-promote]');
      if (promote) {
        const uid = promote.getAttribute('data-promote');
        const name = promote.getAttribute('data-pname');
        if (!confirm('Give "' + name + '" admin access?')) return;
        try {
          const update = {};
          update['adminUids/' + uid] = { label: name, addedAt: Date.now() };
          await configRef().update(update);
          showStaff();
        } catch (err) {
          alert('Could not grant admin — this device is not an approved admin device.');
        }
        return;
      }

      const demote = e.target.closest('button[data-demote]');
      if (demote) {
        const uid = demote.getAttribute('data-demote');
        if (uid === myUid && !confirm('This will remove YOUR admin access on this device. Continue?')) return;
        if (uid !== myUid && !confirm('Remove admin access from this person?')) return;
        try {
          await configRef().child('adminUids').child(uid).remove();
          showStaff();
        } catch (err) {
          alert('Could not remove admin — this device is not an approved admin device.');
        }
        return;
      }

      const btn = e.target.closest('button[data-staff]');
      if (!btn) return;
      const id = btn.getAttribute('data-staff');
      const person = staff.find(function(p) { return p.id === id; });
      if (!confirm('Delete profile "' + (person ? person.name : id) + '"?\n\nTheir access is revoked too, so the device has to be approved again.')) return;
      if (person && person.uid) {
        await configRef().child('approvedUids').child(person.uid).remove().catch(function () {});
        await configRef().child('adminUids').child(person.uid).remove().catch(function () {});
      }
      await db.ref('tally/rooms/' + roomCode + '/staff/' + id).remove().catch(function() {});
      showStaff();
    });
  }

  function showOrderList() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    const rows = items.map(function (it, i) {
      const t = lowThresholdUnits(it);
      const b = computeBurn(it);
      const cs = it.caseSize || 1;
      const isLow = t != null && it.units <= t;
      // Flag anything low now, or forecast to run out within a week
      const soon = b && b.daysLeft != null && b.daysLeft <= 7;
      if (!isLow && !soon) return null;
      return {
        idx: i,
        name: it.name,
        note: it.note,
        haveCases: Number((it.units / cs).toFixed(2)),
        daysLeft: b && b.daysLeft != null ? b.daysLeft : null,
        rate: b ? b.perDayCases : null,
        order: suggestOrderCases(it),
        isLow: isLow
      };
    }).filter(Boolean).sort(function (a, b2) {
      const da = a.daysLeft == null ? 99 : a.daysLeft;
      const db = b2.daysLeft == null ? 99 : b2.daysLeft;
      return da - db;
    });

    if (!rows.length) {
      body.innerHTML = '<div class="audit-item-name">Order list</div>' +
        '<div class="audit-sub">Nothing is low or forecast to run out this week.</div>' +
        '<div class="audit-actions"><button type="button" id="orderCloseBtn">Close</button></div>';
      document.getElementById('orderCloseBtn').addEventListener('click', closeAudit);
      return;
    }

    const html = rows.map(function (r) {
      const urgency = r.daysLeft == null ? '' :
        (r.daysLeft <= 1 ? 'out today' :
         r.daysLeft <= 2 ? 'out tomorrow' :
         'out in ' + r.daysLeft + 'd');
      const sub = [
        'have ' + r.haveCases + ' cs',
        r.rate ? r.rate.toFixed(1) + ' cs/day' : null,
        urgency || (r.isLow ? 'below low line' : null),
        r.note ? escapeHtml(r.note) : null
      ].filter(Boolean).join(' \u00b7 ');
      const cls = (r.daysLeft != null && r.daysLeft <= 2) ? 'off' : 'ok';
      return '<div class="audit-result-row">' +
        '<span>' + escapeHtml(r.name) +
          '<br><span style="font-size:11px;color:var(--text-dim);">' + sub + '</span></span>' +
        '<span class="audit-var ' + cls + '">' + r.order + ' cs</span>' +
      '</div>';
    }).join('');

    const total = rows.reduce(function (s, r) { return s + r.order; }, 0);

    body.innerHTML =
      '<div class="audit-item-name">Order list</div>' +
      '<div class="audit-sub">' + rows.length + ' item(s) \u00b7 ' + total + ' case(s) \u00b7 soonest first</div>' +
      html +
      '<div class="audit-summary">Quantities cover about a week of your actual usage plus your low-stock buffer. Usage is learned from this store\'s own history, including which days run heavier. Items without enough history fall back to your low-stock line.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="orderCopyBtn">Copy list</button>' +
        '<button type="button" id="orderCloseBtn">Close</button>' +
      '</div>';

    document.getElementById('orderCloseBtn').addEventListener('click', closeAudit);
    document.getElementById('orderCopyBtn').addEventListener('click', function () {
      const text = 'Order list \u2014 ' + roomCode + ' \u2014 ' + new Date().toLocaleDateString() + '\n\n' +
        rows.map(function (r) {
          return r.order + ' cs  ' + r.name + '  (have ' + r.haveCases + ' cs' +
            (r.daysLeft != null ? ', out in ' + r.daysLeft + 'd' : '') + ')' +
            (r.note ? '  [' + r.note + ']' : '');
        }).join('\n');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () { alert('Order list copied.'); });
      } else {
        prompt('Copy this:', text);
      }
    });
  }

  // ===================== AUTO BACKUPS =====================
  const SNAPSHOT_INTERVAL = 2 * 60 * 1000;
  const SNAPSHOT_KEEP = 30;
  let lastSnapshotTs = 0;

  function snapshotsRef() {
    return db.ref('tally/rooms/' + roomCode + '/snapshots');
  }

  async function maybeAutoSnapshot() {
    if (!isConfigured || !roomCode || !items.length) return;
    if (Date.now() - lastSnapshotTs < SNAPSHOT_INTERVAL) return;
    lastSnapshotTs = Date.now();
    try {
      const last = await snapshotsRef().orderByChild('ts').limitToLast(1).get();
      const val = last.val() || {};
      const keys = Object.keys(val);
      const lastTs = keys.length ? (val[keys[0]].ts || 0) : 0;
      if (Date.now() - lastTs < SNAPSHOT_INTERVAL) return;

      await snapshotsRef().push({
        ts: Date.now(),
        by: myName || 'auto',
        itemCount: items.length,
        totalUnits: items.reduce(function (s, it) { return s + (it.units || 0); }, 0),
        items: items.map(function (it) {
          return {
            name: it.name,
            units: it.units,
            caseSize: it.caseSize,
            mode: it.mode || 'case',
            note: it.note || null,
            category: it.category || null,
            productCode: it.productCode || null,
            lowStockValue: it.lowStockValue != null ? it.lowStockValue : null,
            lowStockMode: it.lowStockMode || null,
            barcodes: Array.isArray(it.barcodes) ? it.barcodes : null,
            packType: it.packType || null,
            recipe: it.recipe || null,
            variable: !!it.variable,
            lastVariant: it.lastVariant || null
          };
        })
      });

      const all = await snapshotsRef().orderByChild('ts').get();
      const av = all.val() || {};
      const sorted = Object.keys(av).sort(function (a, b) { return (av[a].ts || 0) - (av[b].ts || 0); });
      for (let i = 0; i < sorted.length - SNAPSHOT_KEEP; i++) {
        await snapshotsRef().child(sorted[i]).remove().catch(function () {});
      }
    } catch (e) {}
  }

  function downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async function showSnapshots() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML = '<div class="audit-item-name">Backups</div><div class="audit-sub">Loading...</div>';

    let snaps = [];
    try {
      const snap = await snapshotsRef().orderByChild('ts').get();
      const val = snap.val() || {};
      snaps = Object.keys(val).map(function (k) { return Object.assign({ key: k }, val[k]); })
        .sort(function (a, b) { return b.ts - a.ts; });
    } catch (e) {}

    const stamp = new Date().toISOString().slice(0, 10);

    const rows = snaps.map(function (s, i) {
      const d = new Date(s.ts);
      const when = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      return '<div class="audit-result-row">' +
        '<span>' + when + '<br><span style="font-size:11px;color:var(--text-dim);">' +
          s.itemCount + ' items &middot; ' + (s.totalUnits || 0).toLocaleString() + ' units</span></span>' +
        '<button type="button" class="store-action" data-snap="' + i + '">restore</button>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Backups</div>' +
      '<div class="audit-sub">' + (snaps.length ? snaps.length + ' snapshot(s) &middot; newest first'
        : 'No snapshots yet &mdash; one saves as your changes sync.') + '</div>' +
      rows +
      '<div class="audit-summary">Snapshots save automatically when your changes sync, keeping the last ' + SNAPSHOT_KEEP +
      '. They live in the same database, so they protect against bad edits &mdash; not against losing the project. Download a copy for an off-site backup.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="snapCsv">Spreadsheet</button>' +
        '<button type="button" id="snapJson">Download backup</button></div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="snapClose">Close</button></div>';

    document.getElementById('snapClose').addEventListener('click', closeAudit);

    document.getElementById('snapJson').addEventListener('click', function () {
      downloadFile('tally-backup-' + roomCode + '-' + stamp + '.json',
        JSON.stringify({ tallyBackup: 1, store: roomCode, exportedAt: Date.now(),
                         exportedBy: myName || 'unknown', items: items }, null, 2),
        'application/json');
    });

    document.getElementById('snapCsv').addEventListener('click', function () {
      const header = ['Item', 'Category', 'Product code', 'Units', 'Per case', 'Cases', 'Low stock', 'Note'];
      const lines = items.map(function (it) {
        const cs = it.caseSize || 1;
        return [it.name, it.category || '', it.productCode || '', it.units, cs,
                Number((it.units / cs).toFixed(2)), lowThresholdLabel(it) || '', it.note || '']
               .map(csvEscape).join(',');
      });
      downloadFile('tally-' + roomCode + '-' + stamp + '.csv',
        [header.join(',')].concat(lines).join('\n'), 'text/csv');
    });

    body.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-snap]');
      if (!btn) return;
      const s = snaps[parseInt(btn.getAttribute('data-snap'), 10)];
      if (!s || !Array.isArray(s.items)) return;
      if (!confirm('Restore the snapshot from ' + new Date(s.ts).toLocaleString() + '?\n\n' +
          s.itemCount + ' items will REPLACE your current list. Undo is available right after.')) return;
      snapshotForUndo();
      items = s.items.map(function (it) {
        return {
          name: it.name, units: it.units, caseSize: it.caseSize, mode: it.mode || 'case',
          note: it.note || null, category: it.category || null, productCode: it.productCode || null,
          lowStockValue: it.lowStockValue, lowStockMode: it.lowStockMode,
          barcodes: Array.isArray(it.barcodes) ? it.barcodes : [],
          packType: it.packType || null, recipe: it.recipe || null,
          variable: !!it.variable, lastVariant: it.lastVariant || null,
          history: [], touched: Date.now()
        };
      });
      minimized.clear(); expanded.clear();
      items.forEach(function (it, i) { minimized.add(i); });
      render(); saveItems(); closeAudit();
      showCommandToast('Restored snapshot from ' + new Date(s.ts).toLocaleDateString());
    });
  }

  document.getElementById('snapshotsBtn').addEventListener('click', showSnapshots);




  // ===================== SHARED OCR LOADER =====================
  let tesseractLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLoading) return tesseractLoading;
    tesseractLoading = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('no scanner')); };
      document.head.appendChild(s);
    });
    return tesseractLoading;
  }

  async function runOcr(file, statusEl) {
    await loadTesseract();
    const res = await window.Tesseract.recognize(file, 'eng', {
      logger: function (m) {
        if (statusEl && m.status === 'recognizing text') {
          statusEl.textContent = 'Reading... ' + Math.round((m.progress || 0) * 100) + '%';
        }
      }
    });
    return (res && res.data && res.data.text) || '';
  }

  function pickImage(useCamera, onFile) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (useCamera) input.setAttribute('capture', 'environment');
    input.addEventListener('change', function () {
      const f = input.files && input.files[0];
      if (f) onFile(f);
    });
    input.click();
  }

  function sourcePicker(title, sub, onPick) {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML =
      '<div class="audit-item-name">' + title + '</div>' +
      '<div class="audit-sub">' + sub + '</div>' +
      '<div class="scan-choice">' +
        '<button type="button" class="scan-source" id="srcCam">' +
          '<span class="scan-icon">&#128247;</span><span>Take a photo</span></button>' +
        '<button type="button" class="scan-source" id="srcLib">' +
          '<span class="scan-icon">&#128444;</span><span>Choose from photos</span></button>' +
      '</div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="srcCancel">Cancel</button></div>';
    document.getElementById('srcCancel').addEventListener('click', closeAudit);
    document.getElementById('srcCam').addEventListener('click', function () { onPick(true); });
    document.getElementById('srcLib').addEventListener('click', function () { onPick(false); });
  }

  function ocrFailScreen(msg) {
    const body = document.getElementById('auditBody');
    body.innerHTML = '<div class="audit-item-name">Couldn\'t read that</div>' +
      '<div class="audit-sub">' + msg + '</div>' +
      '<div class="audit-actions"><button type="button" id="ocrClose">Close</button></div>';
    document.getElementById('ocrClose').addEventListener('click', closeAudit);
  }

  // ============ ORDER / PRODUCTION SHEET ============
  // OCR confuses O/0, I/l/1 and S/5 inside product codes, and some printouts
  // put pipes between columns. Normalise a line before matching.
  const SHEET_ROW = /([FU])[\s|]*([O0-9IlS][O0-9IlS]{4})\b[\s|]*(.+?)[\s|]+E\s?A\b[\s|]+(\d+)/i;

  function fixCode(letter, digits) {
    const d = String(digits)
      .replace(/[Oo]/g, '0')
      .replace(/[IlL]/g, '1')
      .replace(/[Ss]/g, '5');
    return (letter + d).toUpperCase();
  }

  function findByCode(code) {
    const up = String(code).toUpperCase();
    return items.findIndex(function (it) {
      return (it.productCode || '').toUpperCase() === up;
    });
  }

  function parseSheet(text) {
    const out = [], seen = {};
    text.split('\n').forEach(function (line) {
      const l = line.trim();
      if (!l) return;
      if (/\b(product code|order qty|rcvd|workpulse|manager|subtotal|total)\b/i.test(l)) return;
      const m = SHEET_ROW.exec(l);
      if (!m) return;
      const pcode = fixCode(m[1], m[2]);
      if (!/^[FU]\d{5}$/.test(pcode)) return;
      if (seen[pcode]) return;
      seen[pcode] = true;
      const name = m[3].replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      const qty = parseInt(m[4], 10);
      if (!qty || qty < 1 || qty > 9999) return;
      let idx = findByCode(pcode);
      if (idx === -1) idx = matchItem(name);
      out.push({ code: pcode, name: name, qty: qty, idx: idx, include: idx !== -1 });
    });
    return out;
  }

  let sheetResults = [], sheetDir = 1;

  function startSheetScan() {
    sourcePicker('Scan order sheet',
      'Lay it flat, good light, straight on. Reads the Product Code and Order Qty columns.',
      function (cam) {
        pickImage(cam, async function (file) {
          const body = document.getElementById('auditBody');
          body.innerHTML = '<div class="audit-item-name">Reading sheet</div>' +
            '<div class="audit-sub" id="ocrStatus">Loading scanner...</div>';
          let text = '';
          try { text = await runOcr(file, document.getElementById('ocrStatus')); }
          catch (e) { ocrFailScreen('Scanner could not run. Check your connection and try again.'); return; }
          sheetResults = parseSheet(text);
          renderSheetReview(text);
        });
      });
  }

  let identifyRow = null;

  function startIdentify(i) {
    identifyRow = i;
    const r = sheetResults[i];
    const body = document.getElementById('auditBody');

    let picked = {
      name: r.name,
      category: guessCategory(r.name) || 'Donuts',
      base: '',
      topping: '',
      filling: 'None',
      packType: 'case',
      packSize: 48
    };

    function chips(list, current, key) {
      return '<div class="id-chips" data-key="' + key + '">' +
        list.map(function (v) {
          return '<button type="button" class="id-chip' + (v === current ? ' on' : '') +
            '" data-val="' + escapeHtml(v) + '">' + escapeHtml(v) + '</button>';
        }).join('') + '</div>';
    }

    function draw() {
      body.innerHTML =
        '<div class="audit-item-name">What is this?</div>' +
        '<div class="audit-sub">' + r.code + ' &mdash; &ldquo;' + escapeHtml(r.name) + '&rdquo; isn\'t in your list yet.</div>' +

        '<div class="role-label">Name</div>' +
        '<input type="text" id="idName" value="' + escapeHtml(picked.name) + '" maxlength="40">' +

        '<div class="role-label">Category</div>' +
        chips(categories, picked.category, 'category') +

        '<div class="role-label">Base</div>' +
        chips(BASES, picked.base, 'base') +

        '<div class="role-label">Topping</div>' +
        chips(TOPPINGS, picked.topping, 'topping') +

        '<div class="role-label">Filling</div>' +
        chips(FILLINGS, picked.filling, 'filling') +

        '<div class="role-label">Comes in</div>' +
        chips(Object.keys(PACK_TYPES).map(function (k) { return PACK_TYPES[k].one; }),
              PACK_TYPES[picked.packType].one, 'packType') +

        '<div class="role-label">How many per ' + PACK_TYPES[picked.packType].one + '?</div>' +
        '<input type="number" id="idSize" value="' + picked.packSize + '" min="1">' +

        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="idSkip">Skip this one</button>' +
          '<button type="button" id="idSave">Add item</button></div>';

      body.querySelectorAll('.id-chips').forEach(function (grp) {
        grp.addEventListener('click', function (e) {
          const b = e.target.closest('button[data-val]');
          if (!b) return;
          const key = grp.getAttribute('data-key');
          const val = b.getAttribute('data-val');
          if (key === 'packType') {
            picked.packType = Object.keys(PACK_TYPES).find(function (k) {
              return PACK_TYPES[k].one === val;
            }) || 'case';
          } else {
            picked[key] = val;
            // Choosing a base suggests the category
            if (key === 'base' && typeof baseToCategory === 'function') {
              picked.category = baseToCategory(val);
            }
          }
          picked.name = document.getElementById('idName').value;
          const sz = parseInt(document.getElementById('idSize').value, 10);
          if (sz > 0) picked.packSize = sz;
          draw();
        });
      });

      document.getElementById('idSkip').addEventListener('click', function () {
        sheetResults[identifyRow].include = false;
        identifyRow = null;
        renderSheetReview('');
      });

      document.getElementById('idSave').addEventListener('click', function () {
        const nm = document.getElementById('idName').value.trim();
        const sz = parseInt(document.getElementById('idSize').value, 10);
        if (!nm) { document.getElementById('idName').style.borderColor = 'var(--red)'; return; }
        if (!sz || sz < 1) { document.getElementById('idSize').style.borderColor = 'var(--red)'; return; }

        items.push({
          name: nm,
          caseSize: sz,
          packType: picked.packType,
          units: 0,
          mode: 'case',
          category: picked.category || null,
          recipe: {
            base: picked.base || null,
            toppings: picked.topping ? [picked.topping] : [],
            filling: (picked.filling && picked.filling !== 'None') ? picked.filling : null
          },
          productCode: r.code,
          history: [],
          touched: Date.now()
        });
        minimized.add(items.length - 1);

        const newIdx = items.length - 1;
        sheetResults[identifyRow].idx = newIdx;
        sheetResults[identifyRow].include = true;
        identifyRow = null;
        saveItems();
        renderSheetReview('');
      });
    }

    draw();
  }

  function renderSheetReview(rawText) {
    const body = document.getElementById('auditBody');
    if (!sheetResults.length) {
      body.innerHTML = '<div class="audit-item-name">Nothing found</div>' +
        '<div class="audit-sub">No product-code rows were readable. Codes look like F20013 or U10034 &mdash; if those came out garbled, retake it closer and flatter.</div>' +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="shRaw">See raw text</button>' +
          '<button type="button" id="shClose">Close</button></div>';
      document.getElementById('shClose').addEventListener('click', closeAudit);
      document.getElementById('shRaw').addEventListener('click', function () {
        alert(rawText.slice(0, 1800) || '(nothing read)');
      });
      return;
    }

    const matched = sheetResults.filter(function (r) { return r.idx !== -1; }).length;
    const rows = sheetResults.map(function (r, i) {
      const known = r.idx !== -1;
      const label = known ? items[r.idx].name : r.name;
      return '<div class="audit-result-row">' +
        '<label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;">' +
          '<input type="checkbox" data-sh="' + i + '"' + (r.include ? ' checked' : '') + (known ? '' : ' disabled') + '>' +
          '<span>' + escapeHtml(label) +
            '<br><span style="font-size:11px;color:' + (known ? 'var(--text-dim)' : 'var(--red)') + ';">' +
              r.code + (known ? '' : ' &middot; not in your list') + '</span></span></label>' +
        '<span class="audit-var ' + (known ? 'ok' : 'off') + '">' +
          (known
            ? '<input type="number" class="scan-qty" data-shq="' + i + '" value="' + r.qty + '" min="0"> ea'
            : '<button type="button" class="id-btn" data-identify="' + i + '">What is it?</button>') +
        '</span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Review sheet</div>' +
      '<div class="audit-sub">' + sheetResults.length + ' row(s) &middot; ' + matched + ' matched</div>' +
      '<div class="mode-toggle" id="sheetDirToggle" style="margin-bottom:12px;">' +
        '<button type="button" class="active" data-dir="1">Add to freezer</button>' +
        '<button type="button" data-dir="-1">Take out</button></div>' +
      rows +
      '<div class="audit-summary">Quantities are EACH, not cases &mdash; taken from the Order Qty column. Check them before applying; OCR misreads digits. Unmatched codes are skipped &mdash; set an item\'s product code to link it for next time.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="shCancel">Cancel</button>' +
        '<button type="button" id="shApply">Apply</button></div>';

    sheetDir = 1;
    document.getElementById('sheetDirToggle').addEventListener('click', function (e) {
      const b = e.target.closest('button[data-dir]');
      if (!b) return;
      sheetDir = parseInt(b.getAttribute('data-dir'), 10);
      Array.from(this.children).forEach(function (x) { x.classList.toggle('active', x === b); });
    });
    document.getElementById('shCancel').addEventListener('click', closeAudit);

    body.addEventListener('click', function (e) {
      const idb = e.target.closest('button[data-identify]');
      if (idb) startIdentify(parseInt(idb.getAttribute('data-identify'), 10));
    });

    body.addEventListener('change', function (e) {
      const cb = e.target.closest('input[data-sh]');
      if (cb) sheetResults[parseInt(cb.getAttribute('data-sh'), 10)].include = cb.checked;
      const q = e.target.closest('input[data-shq]');
      if (q) {
        const n = parseInt(q.value, 10);
        sheetResults[parseInt(q.getAttribute('data-shq'), 10)].qty = isNaN(n) ? 0 : n;
      }
    });

    document.getElementById('shApply').addEventListener('click', function () {
      const use = sheetResults.filter(function (r) { return r.include && r.idx !== -1 && r.qty > 0; });
      if (!use.length) { alert('Nothing selected to apply.'); return; }
      snapshotForUndo();
      use.forEach(function (r) {
        const item = items[r.idx];
        if (!item) return;
        if (!item.productCode) item.productCode = r.code;
        const delta = sheetDir > 0 ? r.qty : -Math.min(r.qty, item.units);
        if (delta === 0) return;
        item.units = Math.max(0, item.units + delta);
        pushHistory(item, delta);
      });
      render();
      saveItems();
      closeAudit();
      showCommandToast((sheetDir > 0 ? 'Added ' : 'Removed ') + use.length + ' item(s) from sheet');
    });
  }

  // ============ INVOICE (free-form) ============
  function parseInvoiceLines(text) {
    const out = [];
    text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).forEach(function (line) {
      if (/\b(subtotal|total|tax|invoice|date|page|thank you|signature|driver|account|balance)\b/i.test(line)) return;
      if (line.replace(/[^a-z]/gi, '').length < 3) return;
      let qty = null, name = null;
      let m = line.match(/^(\d{1,3})\s*(?:cs|case|cases|ct|ea|bx|box)?\s+(.{3,})$/i);
      if (m) { qty = parseInt(m[1], 10); name = m[2]; }
      else {
        m = line.match(/^(.{3,}?)\s+(\d{1,3})(?:\s*(?:cs|case|cases|ct|ea)?)?$/i);
        if (m) { name = m[1]; qty = parseInt(m[2], 10); }
      }
      if (qty == null || !name || qty < 1 || qty > 999) return;
      name = name.replace(/\$\s*\d+[.,]?\d*/g, ' ').replace(/\b\d{5,}\b/g, ' ')
                 .replace(/[|_*#]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (name.replace(/[^a-z]/gi, '').length < 3) return;
      const idx = matchItem(name);
      out.push({ qty: qty, rawName: name, matchIdx: idx, include: idx !== -1 });
    });
    return out;
  }

  let scanResults = [];

  function startScan() {
    sourcePicker('Scan invoice', 'Flat, bright, straight-on photos read best.', function (cam) {
      pickImage(cam, async function (file) {
        const body = document.getElementById('auditBody');
        body.innerHTML = '<div class="audit-item-name">Reading invoice</div>' +
          '<div class="audit-sub" id="ocrStatus">Loading scanner...</div>';
        let text = '';
        try { text = await runOcr(file, document.getElementById('ocrStatus')); }
        catch (e) { ocrFailScreen('Scanner could not run. Check your connection.'); return; }
        scanResults = parseInvoiceLines(text);
        renderScanReview(text);
      });
    });
  }

  function renderScanReview(rawText) {
    const body = document.getElementById('auditBody');
    if (!scanResults.length) {
      body.innerHTML = '<div class="audit-item-name">Nothing found</div>' +
        '<div class="audit-sub">Couldn\'t pick out any quantity and item lines. Try a flatter, brighter photo.</div>' +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="scRaw">See raw text</button>' +
          '<button type="button" id="scClose">Close</button></div>';
      document.getElementById('scClose').addEventListener('click', closeAudit);
      document.getElementById('scRaw').addEventListener('click', function () {
        alert(rawText.slice(0, 1500) || '(nothing read)');
      });
      return;
    }
    const matched = scanResults.filter(function (r) { return r.matchIdx !== -1; }).length;
    const rows = scanResults.map(function (r, i) {
      const known = r.matchIdx !== -1;
      const label = known ? items[r.matchIdx].name : r.rawName;
      return '<div class="audit-result-row">' +
        '<label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer;">' +
          '<input type="checkbox" data-scan="' + i + '"' + (r.include ? ' checked' : '') + (known ? '' : ' disabled') + '>' +
          '<span>' + escapeHtml(label) + '<br><span style="font-size:11px;color:' +
            (known ? 'var(--text-dim)' : 'var(--red)') + ';">' +
            (known ? 'matches your item' : 'no match &mdash; skipped') + '</span></span></label>' +
        '<span class="audit-var ' + (known ? 'ok' : 'off') + '">' +
          '<input type="number" class="scan-qty" data-qty="' + i + '" value="' + r.qty + '" min="0"> cs</span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Review scan</div>' +
      '<div class="audit-sub">' + scanResults.length + ' line(s) &middot; ' + matched + ' matched</div>' +
      rows +
      '<div class="audit-summary">Check every line before applying. Quantities are added as CASES.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="scCancel">Cancel</button>' +
        '<button type="button" id="scApply">Add to counts</button></div>';

    document.getElementById('scCancel').addEventListener('click', closeAudit);
    body.addEventListener('change', function (e) {
      const cb = e.target.closest('input[data-scan]');
      if (cb) scanResults[parseInt(cb.getAttribute('data-scan'), 10)].include = cb.checked;
      const q = e.target.closest('input[data-qty]');
      if (q) {
        const n = parseInt(q.value, 10);
        scanResults[parseInt(q.getAttribute('data-qty'), 10)].qty = isNaN(n) ? 0 : n;
      }
    });
    document.getElementById('scApply').addEventListener('click', function () {
      const use = scanResults.filter(function (r) { return r.include && r.matchIdx !== -1 && r.qty > 0; });
      if (!use.length) { alert('Nothing selected to apply.'); return; }
      snapshotForUndo();
      use.forEach(function (r) {
        const item = items[r.matchIdx];
        if (!item) return;
        const delta = r.qty * (item.caseSize || 1);
        item.units += delta;
        pushHistory(item, delta);
      });
      render();
      saveItems();
      closeAudit();
      showCommandToast('Added ' + use.length + ' item(s) from invoice');
    });
  }

  // ===================== BARCODES =====================
  let bcStream = null, bcDetector = null, bcLoop = null, bcMode = 'count', bcLinkIdx = null, bcBusy = false;
  let batchTally = {};   // { itemIndex: casesScanned } collected in batch mode
  let batchUnknown = []; // codes scanned that match no item
  let zxingLoading = null;

  function findByBarcode(code) {
    return items.findIndex(function (it) {
      return Array.isArray(it.barcodes) && it.barcodes.indexOf(code) !== -1;
    });
  }

  function loadZXing() {
    if (window.ZXingBrowser) return Promise.resolve();
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('no scanner')); };
      document.head.appendChild(s);
    });
    return zxingLoading;
  }

  function bcSay(msg, ok) {
    const el = document.getElementById('barcodeMsg');
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok === false ? 'var(--red)' : (ok ? 'var(--teal)' : 'var(--amber)');
  }

  async function openBarcode(mode, linkIdx) {
    bcMode = mode || 'count';
    bcLinkIdx = (linkIdx == null ? null : linkIdx);
    bcBusy = false;
    document.getElementById('barcodeTitle').textContent =
      bcMode === 'link' ? 'Scan the code to link'
      : bcMode === 'batch' ? 'Scan everything \u2014 nothing saves yet'
      : 'Point at a barcode';
    const doneBtn = document.getElementById('batchDoneBtn');
    if (doneBtn) doneBtn.style.display = (bcMode === 'batch') ? '' : 'none';
    updateBatchCount();
    bcSay('');
    document.getElementById('barcodeGate').style.display = 'flex';

    const video = document.getElementById('barcodeVideo');
    try {
      bcStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      video.srcObject = bcStream;
      await video.play();
    } catch (e) {
      bcSay('Camera unavailable. Check permissions.', false);
      return;
    }

    if ('BarcodeDetector' in window) {
      try {
        bcDetector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf']
        });
        bcNativeLoop(video);
        return;
      } catch (e) {}
    }
    try {
      await loadZXing();
      const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
      bcLoop = await reader.decodeFromVideoElement(video, function (result) {
        if (result) handleBarcode(result.getText());
      });
    } catch (e) {
      bcSay('Scanning not supported on this browser.', false);
    }
  }

  async function bcNativeLoop(video) {
    if (!bcDetector) return;
    try {
      const found = await bcDetector.detect(video);
      if (found && found.length) handleBarcode(found[0].rawValue);
    } catch (e) {}
    if (document.getElementById('barcodeGate').style.display !== 'none') {
      bcLoop = setTimeout(function () { bcNativeLoop(video); }, 220);
    }
  }

  function closeBarcode() {
    const gate = document.getElementById('barcodeGate');
    if (gate) gate.style.display = 'none';
    if (bcLoop) {
      if (typeof bcLoop === 'number') clearTimeout(bcLoop);
      else if (bcLoop.stop) { try { bcLoop.stop(); } catch (e) {} }
      bcLoop = null;
    }
    bcDetector = null;
    if (bcStream) {
      bcStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      bcStream = null;
    }
    const v = document.getElementById('barcodeVideo');
    if (v) v.srcObject = null;
  }

  function handleBarcode(code) {
    if (bcBusy || !code) return;
    code = String(code).trim();
    if (!code) return;
    bcBusy = true;
    buzz(30);

    if (bcMode === 'link') {
      const item = items[bcLinkIdx];
      if (!item) { closeBarcode(); return; }
      const taken = findByBarcode(code);
      if (taken !== -1 && taken !== bcLinkIdx) {
        bcSay('Already linked to ' + items[taken].name, false);
        setTimeout(function () { bcBusy = false; }, 1600);
        return;
      }
      if (!Array.isArray(item.barcodes)) item.barcodes = [];
      if (item.barcodes.indexOf(code) === -1) item.barcodes.push(code);
      touchItem(item);
      render();
      saveItems();
      bcSay('Linked to ' + item.name, true);
      setTimeout(closeBarcode, 900);
      return;
    }

    const idx = findByBarcode(code);

    // ---- batch mode: collect, don't touch the counts yet ----
    if (bcMode === 'batch') {
      if (idx === -1) {
        if (batchUnknown.indexOf(code) === -1) batchUnknown.push(code);
        bcSay('Unknown code \u2014 noted', false);
      } else {
        batchTally[idx] = (batchTally[idx] || 0) + 1;
        const total = Object.keys(batchTally).reduce(function (s, k) { return s + batchTally[k]; }, 0);
        bcSay(items[idx].name + ' \u00d7' + batchTally[idx] + '  (' + total + ' scanned)', true);
      }
      updateBatchCount();
      setTimeout(function () { bcBusy = false; }, 700);
      return;
    }

    if (idx === -1) {
      bcSay('Unknown code', false);
      if (!confirm('No item uses this barcode.\n\nCreate a new item for it?')) {
        setTimeout(function () { bcBusy = false; }, 900);
        return;
      }
      const name = prompt('Item name:');
      if (!name || !name.trim()) { bcBusy = false; return; }
      const cs = parseInt(prompt('Units per case:', '24'), 10);
      if (!cs || cs < 1) { bcBusy = false; return; }
      snapshotForUndo('add item');
      items.push({ name: name.trim(), caseSize: cs, units: cs, mode: 'case',
                   history: [], touched: Date.now(), barcodes: [code],
                   category: guessCategory(name) || null });
      minimized.add(items.length - 1);
      render();
      saveItems();
      bcSay('Created ' + name.trim(), true);
      setTimeout(function () { bcBusy = false; bcSay(''); }, 1200);
      return;
    }

    const item = items[idx];
    const delta = item.caseSize || 1;
    snapshotForUndo();
    item.units += delta;
    pushHistory(item, delta);
    bumpCount(idx);
    render();
    saveItems();
    const c2 = calc(item.units, item.caseSize);
    bcSay('+1 case  ' + item.name + '  \u2192 ' + c2.decimalCases + ' cs', true);
    setTimeout(function () { bcBusy = false; }, 1100);
  }

  function updateBatchCount() {
    const el = document.getElementById('batchCount');
    if (!el) return;
    const total = Object.keys(batchTally).reduce(function (s, k) { return s + batchTally[k]; }, 0);
    el.textContent = total;
  }

  function showBatchReview() {
    closeBarcode();
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    const keys = Object.keys(batchTally);
    if (!keys.length) {
      body.innerHTML = '<div class="audit-item-name">Nothing scanned</div>' +
        '<div class="audit-sub">' + (batchUnknown.length
          ? batchUnknown.length + ' unknown code(s) were scanned but no items matched them.'
          : 'No barcodes were picked up.') + '</div>' +
        '<div class="audit-actions"><button type="button" id="bReClose">Close</button></div>';
      document.getElementById('bReClose').addEventListener('click', closeAudit);
      return;
    }

    function draw() {
      const rows = Object.keys(batchTally).map(function (k) {
        const idx = parseInt(k, 10);
        const item = items[idx];
        if (!item) return '';
        const cs = batchTally[k];
        return '<div class="audit-result-row">' +
          '<span>' + escapeHtml(item.name) +
            '<br><span style="font-size:11px;color:var(--text-dim);">' +
            (cs * (item.caseSize || 1)).toLocaleString() + ' units &middot; now ' +
            calc(item.units, item.caseSize).decimalCases + ' cs</span></span>' +
          '<span class="staff-actions">' +
            '<button type="button" class="staff-btn" data-bminus="' + idx + '">&minus;</button>' +
            '<input type="number" class="scan-qty" data-bqty="' + idx + '" value="' + cs + '" min="0">' +
            '<button type="button" class="staff-btn" data-bplus="' + idx + '">+</button>' +
          '</span>' +
        '</div>';
      }).join('');

      const totalCases = Object.keys(batchTally).reduce(function (s, k) { return s + batchTally[k]; }, 0);

      body.innerHTML =
        '<div class="audit-item-name">Review scan</div>' +
        '<div class="audit-sub">' + Object.keys(batchTally).length + ' item(s) &middot; ' +
          totalCases + ' case(s) scanned</div>' +
        rows +
        (batchUnknown.length
          ? '<div class="audit-summary">' + batchUnknown.length +
            ' unknown code(s) were skipped. Link them to items first, then rescan.</div>'
          : '') +
        '<div class="mode-toggle" id="batchDirToggle" style="margin:12px 0;">' +
          '<button type="button" class="active" data-bdir="1">Add to freezer</button>' +
          '<button type="button" data-bdir="-1">Take out</button></div>' +
        '<div class="audit-actions">' +
          '<button type="button" class="audit-skip" id="bReCancel">Discard</button>' +
          '<button type="button" id="bReApply">Apply</button></div>';

      document.getElementById('bReCancel').addEventListener('click', function () {
        batchTally = {}; batchUnknown = []; closeAudit();
      });

      document.getElementById('batchDirToggle').addEventListener('click', function (e) {
        const b = e.target.closest('button[data-bdir]');
        if (!b) return;
        batchDir = parseInt(b.getAttribute('data-bdir'), 10);
        Array.from(this.children).forEach(function (x) { x.classList.toggle('active', x === b); });
      });

      document.getElementById('bReApply').addEventListener('click', function () {
        const keys2 = Object.keys(batchTally);
        if (!keys2.length) { closeAudit(); return; }
        snapshotForUndo();
        let n = 0;
        keys2.forEach(function (k) {
          const idx = parseInt(k, 10);
          const item = items[idx];
          if (!item || !batchTally[k]) return;
          const units = batchTally[k] * (item.caseSize || 1);
          const delta = batchDir > 0 ? units : -Math.min(units, item.units);
          if (delta === 0) return;
          item.units = Math.max(0, item.units + delta);
          pushHistory(item, delta);
          n++;
        });
        batchTally = {}; batchUnknown = [];
        render(); saveItems(); closeAudit();
        showCommandToast((batchDir > 0 ? 'Added ' : 'Removed ') + n + ' item(s) from scan');
      });
    }

    body.addEventListener('click', function (e) {
      const minus = e.target.closest('button[data-bminus]');
      const plus = e.target.closest('button[data-bplus]');
      if (minus) {
        const k = minus.getAttribute('data-bminus');
        batchTally[k] = Math.max(0, (batchTally[k] || 0) - 1);
        if (!batchTally[k]) delete batchTally[k];
        draw();
        return;
      }
      if (plus) {
        const k = plus.getAttribute('data-bplus');
        batchTally[k] = (batchTally[k] || 0) + 1;
        draw();
      }
    });

    body.addEventListener('change', function (e) {
      const q = e.target.closest('input[data-bqty]');
      if (!q) return;
      const k = q.getAttribute('data-bqty');
      const n = parseInt(q.value, 10);
      if (isNaN(n) || n <= 0) delete batchTally[k];
      else batchTally[k] = n;
      draw();
    });

    draw();
  }

  let batchDir = 1;

  document.getElementById('batchDoneBtn').addEventListener('click', showBatchReview);

  function chooseBarcodeMode() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML =
      '<div class="audit-item-name">Scan barcodes</div>' +
      '<div class="audit-sub">How do you want to count?</div>' +
      '<div class="scan-choice">' +
        '<button type="button" class="scan-source" id="bcOneBtn">' +
          '<span class="scan-icon">1\u20E3</span>' +
          '<span><b style="display:block;">One by one</b>' +
          '<i style="font-style:normal;font-size:11px;color:var(--text-dim);">Each scan adds a case right away</i></span>' +
        '</button>' +
        '<button type="button" class="scan-source" id="bcBatchBtn">' +
          '<span class="scan-icon">&#128230;</span>' +
          '<span><b style="display:block;">Scan everything first</b>' +
          '<i style="font-style:normal;font-size:11px;color:var(--text-dim);">Collect the whole lot, then edit before saving</i></span>' +
        '</button>' +
      '</div>' +
      '<div class="join-hint">Batch is better for a full delivery &mdash; nothing changes until you review it.<br><br>' +
      '<button type="button" class="store-action" id="bcModeCancel">Cancel</button></div>';

    document.getElementById('bcModeCancel').addEventListener('click', closeAudit);
    document.getElementById('bcOneBtn').addEventListener('click', function () {
      closeAudit();
      openBarcode('count');
    });
    document.getElementById('bcBatchBtn').addEventListener('click', function () {
      closeAudit();
      batchTally = {};
      openBarcode('batch');
    });
  }

  document.getElementById('barcodeClose').addEventListener('click', closeBarcode);
  function openProductionPicker() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML =
      '<div class="audit-item-name">Scan production</div>' +
      '<div class="audit-sub">Which paperwork is it?</div>' +
      '<div class="scan-choice">' +
        '<button type="button" class="scan-source" id="prodOrderBtn">' +
          '<span class="scan-icon">&#128203;</span>' +
          '<span><b style="display:block;">Order sheet</b>' +
          '<i style="font-style:normal;font-size:11px;color:var(--text-dim);">Product codes and quantities</i></span>' +
        '</button>' +
        '<button type="button" class="scan-source" id="prodInvBtn">' +
          '<span class="scan-icon">&#129534;</span>' +
          '<span><b style="display:block;">Delivery invoice</b>' +
          '<i style="font-style:normal;font-size:11px;color:var(--text-dim);">Free-form supplier paperwork</i></span>' +
        '</button>' +
      '</div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="prodCancel">Cancel</button></div>';
    on('prodCancel', 'click', closeAudit);
    on('prodOrderBtn', 'click', startSheetScan);
    on('prodInvBtn', 'click', startScan);
  }


  function showWasteReport() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    const cutoff = Date.now() - 28 * 86400000;
    const rows = [];
    let grand = 0;

    items.forEach(function (it) {
      const w = (it.history || []).filter(function (h) {
        return h.kind === 'waste' && h.ts >= cutoff;
      });
      if (!w.length) return;
      const units = w.reduce(function (s, h) { return s + Math.abs(h.delta); }, 0);
      grand += units;
      rows.push({
        name: it.name,
        units: units,
        cases: Number((units / (it.caseSize || 1)).toFixed(2)),
        times: w.length,
        last: Math.max.apply(null, w.map(function (h) { return h.ts; }))
      });
    });

    rows.sort(function (a, b) { return b.units - a.units; });

    if (!rows.length) {
      body.innerHTML = '<div class="audit-item-name">Waste</div>' +
        '<div class="audit-sub">Nothing logged as waste in the last 4 weeks.</div>' +
        '<div class="audit-summary">Log waste with the Waste button on any item. Keeping it separate from normal usage means your order forecasts stay based on what actually sells.</div>' +
        '<div class="audit-actions"><button type="button" id="wClose">Close</button></div>';
      document.getElementById('wClose').addEventListener('click', closeAudit);
      return;
    }

    const html = rows.map(function (r) {
      return '<div class="audit-result-row">' +
        '<span>' + escapeHtml(r.name) +
          '<br><span style="font-size:11px;color:var(--text-dim);">' + r.times +
          ' time(s) &middot; last ' + formatRelative(r.last) + '</span></span>' +
        '<span class="audit-var off">' + r.cases + ' cs<br>' +
          '<span style="font-size:10px;font-weight:400;">' + r.units.toLocaleString() + ' un</span></span>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="audit-item-name">Waste &mdash; last 4 weeks</div>' +
      '<div class="audit-sub">' + rows.length + ' item(s) &middot; ' + grand.toLocaleString() + ' units total</div>' +
      html +
      '<div class="audit-summary">Waste is tracked separately from normal usage, so it never inflates your burn rate or order quantities.</div>' +
      '<div class="audit-actions">' +
        '<button type="button" class="audit-skip" id="wCopy">Copy</button>' +
        '<button type="button" id="wClose">Close</button></div>';

    document.getElementById('wClose').addEventListener('click', closeAudit);
    document.getElementById('wCopy').addEventListener('click', function () {
      const text = 'Waste report \u2014 ' + roomCode + ' \u2014 last 4 weeks\n\n' +
        rows.map(function (r) {
          return r.cases + ' cs (' + r.units + ' un)  ' + r.name + '  \u2014 ' + r.times + ' time(s)';
        }).join('\n') + '\n\nTotal: ' + grand + ' units';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () { alert('Waste report copied.'); });
      } else { prompt('Copy this:', text); }
    });
  }

  function showCategories() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    function draw() {
      const counts = {};
      items.forEach(function (it) {
        const cat = itemCategory(it);
        if (cat) counts[cat] = (counts[cat] || 0) + 1;
      });

      const rows = categories.map(function (cat, i) {
        return '<div class="audit-result-row">' +
          '<span>' + escapeHtml(cat) +
            '<br><span style="font-size:11px;color:var(--text-dim);">' +
              (counts[cat] || 0) + ' item(s)</span></span>' +
          '<span class="staff-actions">' +
            '<button type="button" class="staff-btn" data-cup="' + i + '" ' +
              (i === 0 ? 'disabled' : '') + ' title="Move up">&uarr;</button>' +
            '<button type="button" class="staff-btn" data-cdown="' + i + '" ' +
              (i === categories.length - 1 ? 'disabled' : '') + ' title="Move down">&darr;</button>' +
            '<button type="button" class="staff-btn" data-cren="' + i + '" title="Rename">&#9998;</button>' +
            '<button type="button" class="staff-btn del" data-cdel="' + i + '" title="Delete">&times;</button>' +
          '</span>' +
        '</div>';
      }).join('');

      body.innerHTML =
        '<div class="audit-item-name">Categories</div>' +
        '<div class="audit-sub">' + categories.length + ' categories &middot; order here sets the order of the filter chips</div>' +
        rows +
        '<div class="admin-row" style="margin-top:12px;">' +
          '<input type="text" id="newCatName" placeholder="New category" maxlength="24">' +
          '<button type="button" class="admin-mini-btn" id="addCatBtn">Add</button>' +
        '</div>' +
        '<div class="audit-summary">Renaming a category moves every item in it. Deleting one leaves those items uncategorised &mdash; they still show under All.</div>' +
        '<div class="audit-actions"><button type="button" id="catClose">Close</button></div>';

      document.getElementById('catClose').addEventListener('click', function () {
        closeAudit();
        render();
      });

      document.getElementById('addCatBtn').addEventListener('click', function () {
        const el = document.getElementById('newCatName');
        const val = el.value.trim();
        if (!val) { el.style.borderColor = 'var(--red)'; return; }
        if (categories.indexOf(val) === -1) categories.push(val);
        saveCategories();
        draw();
      });

      document.getElementById('newCatName').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') document.getElementById('addCatBtn').click();
      });
    }

    body.addEventListener('click', function (e) {
      const up = e.target.closest('button[data-cup]');
      const down = e.target.closest('button[data-cdown]');
      const ren = e.target.closest('button[data-cren]');
      const del = e.target.closest('button[data-cdel]');

      if (up) {
        const i = parseInt(up.getAttribute('data-cup'), 10);
        const t = categories[i - 1]; categories[i - 1] = categories[i]; categories[i] = t;
        saveCategories(); draw(); return;
      }
      if (down) {
        const i = parseInt(down.getAttribute('data-cdown'), 10);
        const t = categories[i + 1]; categories[i + 1] = categories[i]; categories[i] = t;
        saveCategories(); draw(); return;
      }
      if (ren) {
        const i = parseInt(ren.getAttribute('data-cren'), 10);
        const oldName = categories[i];
        const val = prompt('Rename "' + oldName + '" to:', oldName);
        if (val === null) return;
        const clean = val.trim();
        if (!clean) return;
        categories[i] = clean;
        items.forEach(function (it) { if (it.category === oldName) it.category = clean; });
        if (catFilter === oldName) {
          catFilter = clean;
          localStorage.setItem('tally_catfilter', catFilter);
        }
        saveCategories(); saveItems(); draw(); return;
      }
      if (del) {
        const i = parseInt(del.getAttribute('data-cdel'), 10);
        const name = categories[i];
        const n = items.filter(function (it) { return it.category === name; }).length;
        if (!confirm('Delete category "' + name + '"?' +
            (n ? '\n\n' + n + ' item(s) will become uncategorised. The items themselves are kept.' : ''))) return;
        categories.splice(i, 1);
        items.forEach(function (it) { if (it.category === name) it.category = null; });
        if (catFilter === name) {
          catFilter = '';
          localStorage.setItem('tally_catfilter', '');
        }
        saveCategories(); saveItems(); draw(); return;
      }
    });

    draw();
  }



  document.getElementById('staffBtn').addEventListener('click', showStaff);
  document.getElementById('bugsBtn').addEventListener('click', showBugs);
  function openTrayPicker() {
    const body = document.getElementById('auditBody');
    document.getElementById('auditGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    body.innerHTML =
      '<div class="audit-item-name">Count a tray</div>' +
      '<div class="audit-sub">How do you want to count it?</div>' +
      '<div class="scan-choice">' +
        '<button type="button" class="scan-source" id="trayPhotoBtn">' +
          '<span class="scan-icon">&#128247;</span>' +
          '<span><b style="display:block;">Photograph it</b>' +
          '<i style="font-style:normal;font-size:11px;color:var(--text-dim);">Counts them for you, you fix any it misses</i></span>' +
        '</button>' +
        '<button type="button" class="scan-source" id="trayTapBtn">' +
          '<span class="scan-icon">&#128400;</span>' +
          '<span><b style="display:block;">Tap it out</b>' +
          '<i style="font-style:normal;font-size:11px;color:var(--text-dim);">Big tap target, counts as you go</i></span>' +
        '</button>' +
      '</div>' +
      '<div class="join-hint"><button type="button" class="store-action" id="trayPickCancel">Cancel</button></div>';
    on('trayPickCancel', 'click', closeAudit);
    on('trayPhotoBtn', 'click', function () { startTrayCount(null); });
    on('trayTapBtn', 'click', function () { closeAudit(); chooseCountItem(); });
  }


  document.getElementById('sessionLogBtn').addEventListener('click', showSessionLog);



  // Each scene's animation illustrates its own line
  const TAGLINES = [
    'Counting the dough.',
    'Glazing the numbers.',
    'Sprinkling in the details.',
    'Hole lot of inventory.',
    'Fresh counts, daily.',
    'Donut worry, it saved.',
    'Rolling the numbers.',
    'Icing on the count.',
    'Batch by batch.',
    'Filling in the blanks.',
    'Warming up the case.',
    'One more for the road.'
  ];

  (function () {
    const el = document.getElementById('splashTagline');
    if (!el) return;

    let i = Math.floor(Math.random() * TAGLINES.length);

    function show() {
      el.textContent = TAGLINES[i];
      el.style.opacity = '1';
    }
    show();

    const timer = setInterval(function () {
      const splash = document.getElementById('splash');
      if (!splash || splash.classList.contains('hide')) {
        clearInterval(timer);
        return;
      }
      el.style.opacity = '0';
      setTimeout(function () {
        i = (i + 1) % TAGLINES.length;
        show();
      }, 350);
    }, 2600);
  })();

  function setSplashStatus(msg) {
    const el = document.getElementById('splashStatus');
    if (el) el.textContent = msg;
  }

  function hideSplash() {
    const s = document.getElementById('splash');
    if (!s || s.classList.contains('hide')) return;
    s.classList.add('hide');
    setTimeout(function() { s.style.display = 'none'; }, 500);
  }

  async function boot() {
    const minShow = new Promise(function(r) { setTimeout(r, 3000); });

    try {
      await firebase.auth().signInAnonymously();
      myUid = firebase.auth().currentUser ? firebase.auth().currentUser.uid : null;
    } catch (e) {
      authError = e.code || e.message || 'unknown error';
      setSplashStatus('Sign-in failed: ' + authError);
      console.error('Tally auth error:', e);
    }

    let cfg = null;
    try {
      cfg = await loadConfig();
    } catch (e) {
      setSplashStatus('Connection problem');
    }

    if (!cfg || !cfg.adminHash) {
      await minShow;
      hideSplash();
      document.getElementById('setupGate').style.display = 'flex';
      document.getElementById('appRoot').style.display = 'none';
      return;
    }

    if (!roomCode) {
      roomCode = DEFAULT_STORE;
      localStorage.setItem('tally_room', roomCode);
      itemsRef = db.ref('tally/rooms/' + roomCode + '/items');
    }

    if (!myName) {
      await minShow;
      hideSplash();
      renderRoleGrid(myRole);
      document.getElementById('profileGate').style.display = 'flex';
      document.getElementById('appRoot').style.display = 'none';
      return;
    }

    startApp();
    await minShow;
    hideSplash();
  }

  // If an admin revokes this device while it's open, lock it out right away
  // instead of waiting for the next launch.
  let accessWatch = null;
  function watchMyAccess() {
    if (!isConfigured || accessWatch) return;
    accessWatch = configRef();
    accessWatch.on('value', function (snap) {
      const cfg = snap.val();
      if (!cfg) return;
      if (isDeviceApproved(cfg)) return;
      accessWatch.off();
      accessWatch = null;
      isAdmin = false;
      sessionStorage.removeItem('tally_admin');
      const ab = document.getElementById('adminBtn');
      if (ab) ab.style.display = 'none';
      const ap = document.getElementById('adminPanel');
      if (ap) ap.style.display = 'none';
      alert('Your access was removed by an admin.');
      showPendingScreen();
    });
  }

  function isDeviceApproved(cfg) {
    if (!myUid || !cfg) return false;
    if (cfg.adminUids && cfg.adminUids[myUid]) return true;
    if (cfg.approvedUids && cfg.approvedUids[myUid]) return true;
    if (cfg.adminUid && cfg.adminUid === myUid) return true;
    return false;
  }

  function showPendingScreen() {
    logSignIn('waiting for approval');
    document.getElementById('pendingName').textContent = myName || 'this device';
    document.getElementById('pendingGate').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    // Register so an admin can see and approve this person
    if (profileId) {
      db.ref('tally/rooms/' + roomCode + '/staff/' + profileId).update({
        name: myName,
        lastSeen: Date.now(),
        uid: myUid || null,
        pending: true
      }).catch(function() {});
    }

    // Watch for approval and let them straight in
    configRef().on('value', function(snap) {
      const cfg = snap.val();
      if (isDeviceApproved(cfg)) {
        configRef().off();
        if (profileId) {
          db.ref('tally/rooms/' + roomCode + '/staff/' + profileId)
            .update({ pending: null }).catch(function() {});
        }
        document.getElementById('pendingGate').style.display = 'none';
        document.getElementById('appRoot').style.display = '';
        startApp();
      }
    });
  }

  async function startApp() {
    updateProfileChip();
    document.getElementById('storeChip').textContent = 'Store: ' + roomCode;

    let cfg = null;
    try { cfg = await loadConfig(); } catch (e) {}

    // If nobody holds admin yet, the first device to open claims it.
    if (cfg && myUid) {
      const existing = cfg.adminUids ? Object.keys(cfg.adminUids) : [];
      if (!existing.length) {
        try {
          const claim = {};
          claim['adminUids/' + myUid] = { label: myName || 'First device', addedAt: Date.now() };
          await configRef().update(claim);
          cfg = await loadConfig();
          setTimeout(function() {
            alert('This device is now the admin device.\n\nOpen Admin to manage stores, staff, and approve other devices.');
          }, 1200);
        } catch (e) {}
      }
    }

    const approved = isApprovedDevice(cfg);

    if (!isDeviceApproved(cfg)) {
      hideSplash();
      showPendingScreen();
      return;
    }

    const adminBtn = document.getElementById('adminBtn');
    if (!approved) {
      adminBtn.style.display = 'none';
      isAdmin = false;
      sessionStorage.removeItem('tally_admin');
      document.getElementById('adminPanel').style.display = 'none';
    } else {
      adminBtn.style.display = '';
      isAdmin = sessionStorage.getItem('tally_admin') === '1';
      adminBtn.textContent = isAdmin ? 'Admin \u2713' : 'Admin';
      if (isAdmin) {
        document.getElementById('adminPanel').style.display = 'block';
        refreshStoreList();
        applyAdminDeviceState();
      }
    }

    if (profileId) {
      db.ref('tally/rooms/' + roomCode + '/staff/' + profileId)
        .update({ name: myName, role: myRole || null, lastSeen: Date.now(), uid: myUid || null }).catch(function() {});
    }
    loadCategories();
    loadRecipes();
    setInterval(function () { verifySync(false); }, 120000);
    loadComponents();
    flushBugQueue();
    watchMyAccess();
    if (approved) { watchPendingStaff(); watchBugs(); }
    initSync();
    setTimeout(maybeStartTour, 600);
    startPresence();
    watchPresence();
  }

  // Safety net so the splash never traps the user
  setTimeout(hideSplash, 6000);

  boot();
