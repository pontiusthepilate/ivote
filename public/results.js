/* Ivote live results dashboard. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-NG');
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(a / b < 0.01 ? 2 : 1) : '0') + '%';
  const ELECTIONS = { pres: 'Presidential', sen: 'Senate', rep: 'House of Reps' };
  const FEATURED = ['ADC', 'APC', 'NDC', 'PDP'];
  let COLORS = {}, OTHER = '#9aa5a0';
  const color = (p) => COLORS[p] || OTHER;
  const NO_DATA = '#dfe5e2';
  const admin = () => { try { return localStorage.getItem('ivote.admin') || ''; } catch { return ''; } };

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), ...(admin() ? { 'x-admin-key': admin() } : {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Network problem');
    return j;
  }

  // ---- View state: election + drill-down path, kept in the URL hash ------------
  // #pres/state:24:Lagos/lga:24%2F10:Ikeja
  let election = 'pres';
  let stack = [{ scope: null, id: null, name: 'Nigeria' }];
  function readHash() {
    const parts = location.hash.slice(1).split('/').filter(Boolean);
    election = ELECTIONS[parts[0]] ? parts[0] : 'pres';
    stack = [{ scope: null, id: null, name: 'Nigeria' }];
    for (const p of parts.slice(1)) {
      const [scope, id, name] = p.split(':').map(decodeURIComponent);
      if (scope && id) stack.push({ scope, id, name: name || id });
    }
  }
  function writeHash() {
    const h = '#' + [election, ...stack.slice(1).map((n) => [n.scope, n.id, n.name].map(encodeURIComponent).join(':'))].join('/');
    if (location.hash !== h) history.pushState(null, '', h);
  }
  const node = () => stack[stack.length - 1];

  // What the table lists, and what the map draws, at each level.
  function plan() {
    const n = node();
    if (!n.scope) return { group: 'state', map: 'states', title: 'States', mapTitle: 'Leading party by state' };
    if (n.scope === 'state') {
      if (election === 'pres') return { group: 'lga', map: 'lgas', title: 'Local governments', mapTitle: `Leading party by LGA · ${n.name}` };
      return { group: election, map: 'lgas', mapGroup: 'lga', title: election === 'sen' ? 'Senatorial districts' : 'Federal constituencies', mapTitle: `Leading party by LGA · ${n.name}` };
    }
    if (n.scope === 'sen' || n.scope === 'rep') return { group: 'lga', map: 'lgas', title: 'Local governments', mapTitle: `Leading party by LGA · ${n.name}` };
    if (n.scope === 'lga') return { group: 'ward', map: 'points', title: 'Wards', mapTitle: `Leading party by ward · ${n.name}` };
    return { group: 'pu', map: 'points', title: 'Polling units', mapTitle: `Polling units · ${n.name}` };
  }
  const NEXT_SCOPE = { state: 'state', lga: 'lga', ward: 'ward', sen: 'sen', rep: 'rep' };

  // ---- Map ----------------------------------------------------------------------
  const map = L.map('map', { zoomSnap: 0.25, attributionControl: true, preferCanvas: true }).setView([9.1, 8.7], 6);
  // Street map only when zoomed into an LGA or ward. For heavy election-day traffic,
  // point this at a paid/own tile server (OSM's public tiles are for light use).
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 19, opacity: 0.6,
  });
  // Phones rotate and panes resize; keep Leaflet's idea of the map size current.
  if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize(false)).observe($('#map'));
  let layer = null, lastFitKey = null;
  const geo = {};
  const loadGeo = (name) => geo[name] || (geo[name] = fetch(`/geo/${name}.geojson`).then((r) => r.json()));

  function tip(name, g) {
    const ranked = Object.entries(g?.votes || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return `<div class="maptip"><b>${esc(name)}</b>
      ${ranked.length ? ranked.map(([p, v]) => `<div class="r"><span><span class="sw" style="background:${color(p)}"></span> ${esc(p)}</span><span>${fmt(v)}</span></div>`).join('') : '<div>No results yet</div>'}
      <div class="hint">${fmt(g?.reported)} of ${fmt(g?.total)} units reported</div></div>`;
  }

  async function drawMap(p, data, mapData) {
    const groups = new Map((mapData || data).groups.map((g) => [String(g.id), g]));
    const n = node();
    if (layer) { map.removeLayer(layer); layer = null; }
    const fitKey = `${election}|${stack.map((x) => x.id).join('/')}`;
    if (p.map === 'states' || p.map === 'lgas') {
      if (map.hasLayer(tiles)) map.removeLayer(tiles);
      const fc = await loadGeo(p.map);
      let feats = fc.features;
      if (p.map === 'lgas') {
        const ids = new Set(groups.keys());
        feats = feats.filter((f) => ids.has(f.properties.id));
      }
      layer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        style: (f) => {
          const g = groups.get(f.properties.code || f.properties.id);
          return { color: '#ffffff', weight: 1.5, fillOpacity: g?.leader ? 0.88 : 1, fillColor: g?.leader ? color(g.leader) : NO_DATA };
        },
        onEachFeature: (f, l) => {
          const id = f.properties.code || f.properties.id;
          l.bindTooltip(() => tip(f.properties.name, groups.get(id)), { sticky: true, direction: 'top' });
          l.on('mouseover', () => l.setStyle({ weight: 3, color: '#111814' }));
          l.on('mouseout', () => layer && layer.resetStyle(l));
          l.on('click', () => drill(p.map === 'states' ? 'state' : 'lga', id, f.properties.name));
        },
      }).addTo(map);
      if (fitKey !== lastFitKey && feats.length) { map.invalidateSize(false); map.fitBounds(layer.getBounds(), { padding: [10, 10], animate: false }); }
    } else {
      if (!map.hasLayer(tiles)) tiles.addTo(map);
      const pts = data.groups.filter((g) => g.lat != null);
      const fc = await loadGeo('lgas');
      const lgaId = n.scope === 'lga' ? n.id : n.id.split('/').slice(0, 2).join('/');
      const outline = fc.features.find((x) => x.properties.id === lgaId);
      layer = L.featureGroup([
        ...(outline ? [L.geoJSON(outline, { style: { color: '#006a40', weight: 2, fill: false, dashArray: '6 4' }, interactive: false })] : []),
        ...pts.map((g) => {
        const m = L.circleMarker([g.lat, g.lng], {
          radius: p.group === 'pu' ? 7 : 11, weight: 2, color: '#ffffff',
          fillColor: g.leader ? color(g.leader) : '#8a948f', fillOpacity: g.leader ? 0.95 : 0.55,
        });
        m.bindTooltip(() => tip(g.name, g), { direction: 'top' });
        m.on('click', () => (p.group === 'pu' ? openReview(g.id) : drill('ward', g.id, g.name)));
        return m;
      })]).addTo(map);
      if (fitKey !== lastFitKey && (pts.length || outline)) { map.invalidateSize(false); map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 15, animate: false }); }
    }
    lastFitKey = fitKey;
    // Legend: parties present on the map, plus "no results".
    const present = [...new Set([...groups.values()].map((g) => g.leader).filter(Boolean))].sort();
    $('#legend').innerHTML = present.map((x) => `<span><span class="sw" style="background:${color(x)}"></span>${esc(x)} leads</span>`).join('') +
      `<span><span class="sw" style="background:${NO_DATA};border:1px solid #c5cec9"></span>No results yet</span>`;
  }

  // ---- Panels --------------------------------------------------------------------
  function drawTiles(d) {
    $('#tiles').innerHTML = `
      <div class="tile"><div class="k">Polling units reported</div><div class="v">${fmt(d.reported)}</div>
        <div class="s">of ${fmt(d.total)} · ${pct(d.reported, d.total)}</div><div class="meter"><i style="width:${Math.min(100, (d.reported / (d.total || 1)) * 100)}%"></i></div></div>
      <div class="tile"><div class="k">Units needing review</div><div class="v">${fmt(d.disputed)}</div><div class="s">reporters disagree</div></div>
      <div class="tile"><div class="k">Problem reports</div><div class="v">${fmt(d.incidents)}</div><div class="s">incidents with photos, videos or notes</div></div>`;
  }

  function drawBars(d) {
    if (!d.totals.some((t) => t.votes > 0)) { $('#bars').innerHTML = '<p class="empty">No results reported here yet.</p>'; return; }
    const max = d.totals[0].votes;
    $('#bars').innerHTML = d.totals.slice(0, 12).map((t) => `
      <div class="bar" title="${esc(t.party)}: ${fmt(t.votes)} votes">
        <span class="p"><span class="sw" style="background:${color(t.party)}"></span>${esc(t.party)}</span>
        <div class="track"><div class="fill" style="width:${(t.votes / max) * 100}%;background:${color(t.party)}"></div></div>
        <span class="n">${fmt(t.votes)}</span>
      </div>`).join('') + (d.totals.length > 12 ? `<p class="hint">+ ${d.totals.length - 12} more parties</p>` : '');
  }

  function drawTable(p, d) {
    const parties = (d.totals.length ? d.totals.slice(0, 4).map((t) => t.party) : FEATURED);
    const isPu = p.group === 'pu';
    $('#tabletitle').textContent = `${p.title} (${fmt(d.groups.length)})`;
    const rows = d.groups.map((g) => {
      const status = isPu
        ? (g.disputed ? '<span class="chip warn">Disputed</span>' : g.reported ? '<span class="chip ok">Reported</span>' : '<span class="chip">No report</span>')
        : `${fmt(g.reported)} / ${fmt(g.total)}`;
      return `<tr data-id="${esc(g.id)}" data-name="${esc(g.name)}" tabindex="0">
        <td>${isPu ? `<span class="hint" style="font-family:ui-monospace,monospace">${esc(g.id.split('/')[3])}</span> ` : ''}${esc(g.name)}
          ${!isPu && g.disputed ? ` <span class="chip warn">${fmt(g.disputed)} disputed</span>` : ''}${g.incidents ? ` <span class="chip bad">${fmt(g.incidents)} problem${g.incidents > 1 ? 's' : ''}</span>` : ''}</td>
        <td>${g.leader ? `<span class="lead"><span class="sw" style="background:${color(g.leader)}"></span>${esc(g.leader)}</span>` : '—'}</td>
        ${parties.map((x) => `<td>${g.votes[x] != null ? fmt(g.votes[x]) : '—'}</td>`).join('')}
        <td>${status}</td></tr>`;
    }).join('');
    $('#table').innerHTML = `<thead><tr><th>${isPu ? 'Polling unit' : p.title.replace(/s$/, '').replace(/governments?$/, 'government')}</th><th>Leading</th>
      ${parties.map((x) => `<th>${esc(x)}</th>`).join('')}<th>${isPu ? 'Status' : 'Units reported'}</th></tr></thead><tbody>${rows}</tbody>`;
  }
  $('#table').addEventListener('click', (e) => {
    const tr = e.target.closest('tbody tr'); if (!tr) return;
    const p = plan();
    if (p.group === 'pu') openReview(tr.dataset.id); else drill(NEXT_SCOPE[p.group], tr.dataset.id, tr.dataset.name);
  });
  $('#table').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('tr')?.click(); });

  function drawCrumbs() {
    $('#crumbs').innerHTML = stack.map((n, i) => i === stack.length - 1
      ? `<span class="cur">${esc(n.name)}</span>`
      : `<button type="button" data-i="${i}">${esc(n.name)}</button><span class="sep">›</span>`).join('');
  }
  $('#crumbs').addEventListener('click', (e) => {
    const i = e.target.dataset.i; if (i == null) return;
    stack = stack.slice(0, +i + 1); writeHash(); render();
  });

  function drill(scope, id, name) { stack.push({ scope, id: String(id), name }); writeHash(); render(); }

  // ---- Render / refresh ----------------------------------------------------------
  let busy = false;
  async function render() {
    if (busy) return; busy = true;
    try {
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.e === election)));
      const p = plan(), n = node();
      const qs = (group) => `/api/results?election=${election}&group=${group}${n.scope ? `&scope=${n.scope}&id=${encodeURIComponent(n.id)}` : ''}`;
      const [data, mapData] = await Promise.all([api(qs(p.group)), p.mapGroup ? api(qs(p.mapGroup)) : null]);
      drawCrumbs(); drawTiles(data); drawBars(data); drawTable(p, data);
      $('#maptitle').textContent = p.mapTitle;
      await drawMap(p, data, mapData);
      $('#updated').textContent = `Updated ${new Date(data.updated_at).toLocaleTimeString()}`;
      document.title = `${ELECTIONS[election]} · ${n.name} · Ivote Live Results`;
    } catch (e) {
      $('#updated').textContent = `Could not update: ${e.message}`;
    } finally { busy = false; }
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    election = b.dataset.e;
    // District levels belong to one election; step back to the state when switching.
    stack = stack.filter((x) => !['sen', 'rep'].includes(x.scope) || x.scope === election);
    writeHash(); render();
  });
  window.addEventListener('popstate', () => { readHash(); render(); });
  setInterval(() => { if (!document.hidden && !$('#modal').open) render(); }, 15000);

  // ---- Polling unit review: numbers + every file, in one place -------------------
  const modal = $('#modal');
  function media(m) {
    const src = `/media/${m.id}`;
    const body = m.mime.startsWith('image/') ? `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${esc(m.comment || m.kind)}" loading="lazy"></a>`
      : m.mime.startsWith('video/') ? `<video src="${src}" controls preload="metadata" playsinline></video>`
      : `<a class="doc" href="${src}" target="_blank" rel="noopener">📄</a>`;
    return `<figure>${body}<figcaption>${m.comment ? esc(m.comment) : `<span class="hint">${m.kind === 'result_sheet' ? 'Result sheet' : 'No comment'}</span>`}
      <div class="hint">${ELECTIONS[m.election]} · ${new Date(m.created_at).toLocaleString()}</div></figcaption></figure>`;
  }
  let currentCode = null;
  async function openReview(code) {
    currentCode = code;
    $('#modalbody').innerHTML = '<div class="mbody"><p>Loading…</p></div>';
    if (!modal.open) modal.showModal();
    let d;
    try { d = await api(`/api/review?code=${encodeURIComponent(code)}`); }
    catch (e) { $('#modalbody').innerHTML = `<div class="mhead"><h2>Not found</h2><button class="btn ghost small" data-close>Close</button></div><div class="mbody"><p>${esc(e.message)}</p></div>`; return; }
    const isAdmin = !!admin();
    const pu = d.pu;
    const sections = Object.entries(ELECTIONS).map(([e, label]) => {
      const reps = d.reports.filter((r) => r.election === e);
      const sheets = d.media.filter((m) => m.election === e && m.kind === 'result_sheet');
      const res = d.results.find((r) => r.election === e);
      const where = e === 'sen' ? ` · ${esc(pu.sen)}` : e === 'rep' ? ` · ${esc(pu.rep)}` : '';
      if (!reps.length && !sheets.length) return `<h3>${label}${where}</h3><p class="hint">No results reported yet.</p>`;
      return `<h3>${label}${where} ${res && res.n_versions > 1 ? `<span class="chip warn">Disputed: ${res.n_versions} different results</span>` : ''}</h3>
        ${reps.map((r) => `<div class="rcard ${r.counted ? 'counted' : ''}">
          <div class="row">${r.counted ? '<span class="chip ok">Counted</span>' : ''}
            <span class="chip ${r.status === 'verified' ? 'ok' : r.status === 'rejected' ? 'bad' : ''}">${esc(r.status)}</span>
            <span class="hint">${new Date(r.created_at).toLocaleString()} · phone ${esc(r.device_id || '?')}</span>
            ${(r.flags || '').split(',').filter(Boolean).map((f) => `<span class="chip warn">${esc({ high_total: 'very high total', no_sheet: 'no photo' }[f] || f)}</span>`).join('')}</div>
          <div class="sc">${r.scores.map((s) => `<span><span class="sw" style="background:${color(s.party)}"></span> ${esc(s.party)} <b>${fmt(s.votes)}</b></span>`).join('')}</div>
          ${isAdmin ? `<div class="adminrow"><button class="btn small" data-status="verified" data-id="${r.id}">Verify</button>
            <button class="btn small danger" data-status="rejected" data-id="${r.id}">Reject</button>
            <button class="btn small ghost" data-status="pending" data-id="${r.id}">Reset</button></div>` : ''}
        </div>`).join('')}
        ${sheets.length ? `<p class="hint" style="margin-top:12px">Result sheet photos</p><div class="gallery">${sheets.map(media).join('')}</div>` : ''}`;
    }).join('');
    const incMedia = d.media.filter((m) => m.kind === 'incident');
    const incidents = d.incidents.length ? `<h3>Problem reports (${d.incidents.length})</h3>` + d.incidents.map((i) => `
      <div class="rcard"><div class="row"><span class="chip bad">${ELECTIONS[i.election]}</span><span class="hint">${new Date(i.created_at).toLocaleString()}</span></div>
        ${i.note ? `<p style="margin:8px 0">${esc(i.note)}</p>` : ''}
        <div class="gallery">${incMedia.filter((m) => m.incident_id === i.id).map(media).join('')}</div></div>`).join('')
      : '<h3>Problem reports</h3><p class="hint">None.</p>';
    $('#modalbody').innerHTML = `
      <div class="mhead"><div><h2>${esc(pu.name)}</h2>
        <div class="hint"><b style="font-family:ui-monospace,monospace">${esc(pu.code)}</b> · ${esc(pu.ward)} ward · ${esc(pu.lga)} · ${esc(pu.state)}</div></div>
        <button class="btn ghost small" type="button" data-close>Close</button></div>
      <div class="mbody">${sections}${incidents}</div>`;
  }
  modal.addEventListener('click', async (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) { modal.close(); return; }
    const b = e.target.closest('[data-status]');
    if (b) {
      try {
        await api(`/api/admin/reports/${b.dataset.id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: b.dataset.status }) });
        openReview(currentCode); render();
      } catch (err) { alert(err.message); }
    }
    const q = e.target.closest('[data-code]');
    if (q) openReview(q.dataset.code);
  });

  $('#find').onsubmit = (e) => { e.preventDefault(); const v = $('#findcode').value.trim(); if (v) openReview(v); };

  $('#reviewq').onclick = async () => {
    $('#modalbody').innerHTML = '<div class="mbody"><p>Loading…</p></div>';
    modal.showModal();
    const list = await api(`/api/disputed?election=${election}`).catch(() => []);
    $('#modalbody').innerHTML = `<div class="mhead"><h2>Needs review · ${ELECTIONS[election]}</h2><button class="btn ghost small" type="button" data-close>Close</button></div>
      <div class="mbody">${list.length ? `<p class="hint">Polling units where reporters sent different numbers. Open one to compare reports and photos.</p>
        <table><tbody>${list.map((x) => `<tr data-code="${esc(x.code)}"><td><b>${esc(x.name)}</b><div class="hint">${esc(x.code)} · ${esc(x.ward)}, ${esc(x.lga)}, ${esc(x.state)}</div></td>
          <td>${x.n_versions} versions</td><td>${x.n_reports} reports</td></tr>`).join('')}</tbody></table>` : '<p>No disputed polling units. 🎉</p>'}</div>`;
  };

  $('#adminbtn').onclick = async () => {
    const k = prompt('Admin key (leave empty to sign out):', '');
    if (k === null) return;
    try {
      if (!k) { localStorage.removeItem('ivote.admin'); alert('Signed out.'); return; }
      localStorage.setItem('ivote.admin', k);
      const r = await api('/api/admin/check');
      if (!r.ok) { localStorage.removeItem('ivote.admin'); alert('That key is not right.'); } else alert('Admin mode on. Open a polling unit to verify or reject reports.');
    } catch { alert('Could not check the key.'); }
  };

  // ---- Start --------------------------------------------------------------------
  api('/api/meta').then((m) => { COLORS = m.colors; OTHER = m.other_color || OTHER; }).catch(() => {}).finally(() => { readHash(); render(); });
})();
