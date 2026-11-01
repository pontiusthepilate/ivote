/* Ivote reporter app. Plain JS, no build step. */
(() => {
  'use strict';

  const ELECTIONS = {
    pres: { name: 'Presidential', sub: 'President of Nigeria' },
    sen: { name: 'Senate', sub: 'Senatorial district' },
    rep: { name: 'House of Reps', sub: 'Federal constituency' },
  };
  const FEATURED = ['ADC', 'APC', 'NDC', 'PDP'];
  // INEC's registered parties, for when the ballot cannot be loaded (offline).
  const PARTY_NAMES = { A: 'Accord', AA: 'Action Alliance', AAC: 'African Action Congress', ADC: 'African Democratic Congress',
    ADP: 'Action Democratic Party', APC: 'All Progressives Congress', APGA: 'All Progressives Grand Alliance', APM: 'Allied Peoples Movement',
    APP: 'Action Peoples Party', BP: 'Boot Party', DLA: 'Democratic Leadership Alliance', LP: 'Labour Party', NDC: 'Nigeria Democratic Congress',
    NDP: 'National Democratic Party', NNPP: 'New Nigeria Peoples Party', NRM: 'National Rescue Movement', PDP: 'Peoples Democratic Party',
    PRP: 'Peoples Redemption Party', SDP: 'Social Democratic Party', YP: 'Youth Party', YPP: 'Young Progressives Party', ZLP: 'Zenith Labour Party' };
  const MAX_FILES = 10, MAX_SHEETS = 5, MAX_VIDEO_SECONDS = 30;

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  let deviceId = store.get('ivote.device');
  if (!deviceId) { deviceId = uid(); store.set('ivote.device', deviceId); }

  async function api(path) {
    const r = await fetch(path, { headers: { 'x-device-id': deviceId } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Network problem'), { status: r.status });
    return j;
  }

  function toast(msg, ms = 3500) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.append(t); setTimeout(() => t.remove(), ms);
  }

  // ---- Outbox: reports wait on the phone until they reach the server ----------
  const idb = new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    const req = indexedDB.open('ivote', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'client_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  async function tx(mode, fn) {
    const db = await idb; if (!db) return null;
    return new Promise((resolve, reject) => {
      const t = db.transaction('outbox', mode), s = t.objectStore('outbox');
      const r = fn(s);
      t.oncomplete = () => resolve(r && r.result); t.onerror = () => reject(t.error);
    });
  }
  const outbox = {
    put: (item) => tx('readwrite', (s) => s.put(item)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    all: () => tx('readonly', (s) => s.getAll()).then((x) => x || []),
  };

  async function sendItem(item) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(item.fields)) fd.append(k, v);
    for (const f of item.files) fd.append(f.field, f.blob, f.name);
    const r = await fetch(item.endpoint, { method: 'POST', body: fd, headers: { 'x-device-id': deviceId } });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true };
    // 4xx (except rate limit) means the server will never accept it as is.
    if (r.status >= 400 && r.status < 500 && r.status !== 429) return { ok: false, fatal: true, error: j.error };
    return { ok: false, error: j.error };
  }

  let flushing = false;
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      for (const item of await outbox.all()) {
        if (item.held && Date.now() - item.created < 120000) continue;
        try {
          const r = await sendItem(item);
          if (r.ok) { await outbox.del(item.client_id); toast(`${item.label} sent ✓`); }
          else if (r.fatal) { await outbox.del(item.client_id); toast(`${item.label} was not accepted: ${r.error || ''}`, 6000); }
        } catch { break; } // offline: try again later
      }
    } finally { flushing = false; updateOutbox(); }
  }
  async function updateOutbox() {
    const n = (await outbox.all()).length;
    const el = $('#outbox');
    el.textContent = `${n} waiting to send`;
    el.classList.toggle('hidden', !n);
  }
  window.addEventListener('online', flush);
  setInterval(flush, 30000);

  // Submits now if possible; otherwise keeps it for later. Returns 'sent' | 'queued'.
  async function submit(item) {
    item.client_id = item.fields.client_id;
    item.created = Date.now();
    // Saved first so nothing is lost if the phone dies mid-upload; "held" stops the
    // background sender from sending it a second time while we try.
    await outbox.put({ ...item, held: true }).catch(() => {});
    let r = null;
    try { r = await sendItem(item); } catch { /* offline */ }
    if (r && r.ok) { await outbox.del(item.client_id); updateOutbox(); return 'sent'; }
    if (r && r.fatal) { await outbox.del(item.client_id); updateOutbox(); throw new Error(r.error || 'Not accepted'); }
    await outbox.put({ ...item, held: false }).catch(() => {});
    updateOutbox();
    return 'queued';
  }

  // ---- Media helpers -----------------------------------------------------------
  // Shrinks photos before upload: result sheets stay readable, uploads stay small.
  async function compressImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 400 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }
  function videoDuration(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); resolve(v.duration); };
      v.onerror = () => resolve(null);
      v.src = URL.createObjectURL(file);
    });
  }

  // ---- Full-screen searchable picker -------------------------------------------
  function pick({ title, items, label = (x) => x.name, code = null, render = null }) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'sheet';
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', title);
      el.innerHTML = `
        <header><h3>${esc(title)}</h3><button class="close" type="button">Close</button></header>
        <div class="search"><input class="txt" type="search" placeholder="Type to search…" autocomplete="off" aria-label="Search"></div>
        <ul></ul>`;
      const ul = $('ul', el), input = $('input', el);
      const draw = () => {
        // Forgiving match: ignores spaces, punctuation and doubled letters ("nassa" finds "Nasarawa").
        const loose = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
        const term = loose(input.value);
        const list = items.filter((x) => !term || loose(label(x)).includes(term) || (code && code(x).includes(input.value.trim())));
        ul.innerHTML = list.length ? list.slice(0, 400).map((x) =>
          `<li><button type="button" data-i="${items.indexOf(x)}">${render ? render(x) : `${code ? `<span class="c">${esc(code(x))}</span>` : ''}${esc(label(x))}`}</button></li>`).join('')
          : '<li class="empty">Nothing matches. Try fewer letters.</li>';
      };
      const close = (v) => { el.remove(); window.removeEventListener('popstate', onPop); resolve(v); };
      const onPop = () => close(null);
      input.addEventListener('input', draw);
      ul.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) close(items[+b.dataset.i]); });
      $('.close', el).onclick = () => close(null);
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
      window.addEventListener('popstate', onPop);
      draw();
      document.body.append(el);
      if (items.length > 12) input.focus();
    });
  }

  // ---- Screens -----------------------------------------------------------------
  const app = $('#app');
  const back = $('#back');
  back.onclick = () => { location.hash = '#/'; };

  function home() {
    back.classList.add('hidden');
    document.title = 'Ivote';
    app.innerHTML = `
      <div class="wrap">
        <h1>Which election do you want to report?</h1>
        <p class="lead">Tap one. You can report the others later.</p>
        <div class="elections">
          ${Object.entries(ELECTIONS).map(([k, e]) => `
            <button class="election ${k}" type="button" data-e="${k}">
              <span>${e.name}<small>${e.sub}</small></span><span class="arrow" aria-hidden="true">›</span>
            </button>`).join('')}
        </div>
        <div class="home-links">
          <a class="linkbtn" href="/results">See live results</a>
          <a class="linkbtn" href="/candidates">See the candidates</a>
        </div>
      </div>`;
    app.querySelectorAll('.election').forEach((b) => b.onclick = () => { location.hash = `#/report/${b.dataset.e}`; });
  }

  function report(election) {
    const E = ELECTIONS[election];
    back.classList.remove('hidden');
    document.title = `${E.name} · Ivote`;
    // Location choice is shared by all three elections on this phone.
    const sel = store.get('ivote.place', {}) || {};
    let pu = null; // full polling unit record once chosen
    const sheets = []; // result sheet photos
    const files = []; // incident files {file, comment, duration}

    app.innerHTML = `
      <div class="band ${election}">${E.name} election</div>
      <div class="wrap">
        <section class="card" aria-labelledby="h-where">
          <h2 id="h-where"><span class="step">1</span>Your polling unit</h2>
          <div class="locstatus hidden" id="loc"></div>
          <label class="f" for="code">Polling unit number</label>
          <div class="codebox">
            <input class="txt" id="code" inputmode="numeric" placeholder="e.g. 24/10/03/015" autocomplete="off">
            <button class="btn" type="button" id="findcode">Find</button>
          </div>
          <p class="hint">It is printed on your voter's card (PVC) or at the polling unit.</p>
          <p class="err hidden" id="codeerr"></p>
          <p class="or">or choose it step by step</p>
          ${['state', 'lga', 'ward', 'pu'].map((k) => `
            <label class="f" id="l-${k}">${{ state: 'State', lga: 'Local government', ward: 'Ward', pu: 'Polling unit' }[k]}</label>
            <button class="picker" type="button" id="p-${k}" aria-labelledby="l-${k} p-${k}"><span class="ph">Choose…</span><span class="chev">▾</span></button>`).join('')}
          <button class="btn ghost addfile" type="button" id="relocate">📍 Use my location</button>
          <div class="puinfo hidden" id="puinfo"></div>
        </section>

        <section class="card main" aria-labelledby="h-scores">
          <h2 id="h-scores"><span class="step">2</span>Party scores</h2>
          <p class="hint">Copy the votes from the result sheet. Leave a box empty if you don't know it.</p>
          <div class="scores" id="scores"></div>
          <button class="btn outline addfile" type="button" id="addparty">＋ Add another party</button>

          <label class="f">Photo of the result sheet <span class="hint">(optional, up to ${MAX_SHEETS})</span></label>
          <div class="sheets" id="sheets"></div>
          <button class="btn ghost addfile" type="button" id="addsheet">📷 Take or add photo</button>
          <input type="file" id="sheetin" accept="image/*" capture="environment" class="hidden" multiple>

          <p class="err hidden" id="scoreerr"></p>
          <button class="btn big" type="button" id="sendscores">Send results</button>
        </section>

        <details class="card" id="incident">
          <summary><span class="sumicon" aria-hidden="true">⚠️</span><span class="sumtext">Report a problem at this polling unit or submit more result photos<small>Tap here to open</small></span></summary>
          <p class="hint">Violence, ballot snatching, vote buying, late materials, BVAS problems — or extra photos of the result sheet.</p>
          <label class="f" for="note">What happened? <span class="hint">(optional)</span></label>
          <textarea class="txt" id="note" maxlength="2000" placeholder="Write a few words…"></textarea>
          <label class="f">Photos, videos or files <span class="hint">(up to ${MAX_FILES}, videos ${MAX_VIDEO_SECONDS} seconds max)</span></label>
          <div class="files" id="files"></div>
          <button class="btn ghost addfile" type="button" id="addfile">📎 Add photo, video or file</button>
          <input type="file" id="filein" accept="image/*,video/*,application/pdf" class="hidden" multiple>
          <p class="err hidden" id="incerr"></p>
          <button class="btn big" type="button" id="sendinc">Send</button>
        </details>
        <a class="homebtn" href="#/">🏠 Back to home page</a>
      </div>`;

    const P = { state: $('#p-state'), lga: $('#p-lga'), ward: $('#p-ward'), pu: $('#p-pu') };
    const setPicker = (k, text, code) => {
      P[k].classList.toggle('set', !!text);
      P[k].innerHTML = text ? `<span>${code ? `<span class="hint" style="font-family:ui-monospace,monospace">${esc(code)}</span> ` : ''}${esc(text)}</span><span class="chev">▾</span>`
        : '<span class="ph">Choose…</span><span class="chev">▾</span>';
    };
    const refresh = () => {
      setPicker('state', sel.state_name); setPicker('lga', sel.lga_name); setPicker('ward', sel.ward_name);
      setPicker('pu', sel.pu_name, sel.pu_code && sel.pu_code.split('/')[3]);
      P.lga.disabled = !sel.state; P.ward.disabled = !sel.lga; P.pu.disabled = !sel.ward;
      const info = $('#puinfo');
      if (pu) {
        const extra = election === 'sen' ? `<div>Senatorial district: <b style="display:inline">${esc(pu.sen)}</b></div>`
          : election === 'rep' ? `<div>Federal constituency: <b style="display:inline">${esc(pu.rep)}</b></div>` : '';
        info.innerHTML = `<b>${esc(pu.name)}</b><span class="code">${esc(pu.code)}</span> · ${esc(pu.ward)}, ${esc(pu.lga)}, ${esc(pu.state)}${extra}`;
        info.classList.remove('hidden');
        $('#code').value = pu.code;
      } else info.classList.add('hidden');
      store.set('ivote.place', sel);
    };
    const loc = (msg, kind = '', busy = false) => {
      const el = $('#loc');
      el.className = `locstatus ${kind}`;
      el.innerHTML = `${busy ? '<span class="spin" aria-hidden="true"></span>' : ''}<span>${esc(msg)}</span>`;
    };

    // Setting a level clears everything below it (a new state means a new LGA, etc.).
    function setLevel(level, v) {
      const order = ['state', 'lga', 'ward', 'pu'];
      for (const k of order.slice(order.indexOf(level))) { delete sel[k]; delete sel[`${k}_name`]; if (k === 'pu') delete sel.pu_code; }
      pu = null;
      Object.assign(sel, v);
      refresh();
    }
    async function choosePu(code) {
      pu = await api(`/api/pu?code=${encodeURIComponent(code)}`);
      if (election !== 'pres') loadBallot();
      Object.assign(sel, {
        state: pu.state_code, state_name: pu.state, lga: pu.lga_id, lga_name: pu.lga,
        ward: pu.ward_id, ward_name: pu.ward, pu_code: pu.code, pu_name: pu.name,
      });
      refresh();
    }

    P.state.onclick = async () => {
      const v = await pick({ title: 'Choose your state', items: await api('/api/states') });
      if (v && v.code !== sel.state) setLevel('state', { state: v.code, state_name: v.name });
    };
    P.lga.onclick = async () => {
      const v = await pick({ title: 'Choose local government', items: await api(`/api/lgas?state=${sel.state}`) });
      if (v && v.id !== sel.lga) setLevel('lga', { lga: v.id, lga_name: v.name });
    };
    P.ward.onclick = async () => {
      const v = await pick({ title: 'Choose your ward', items: await api(`/api/wards?lga=${encodeURIComponent(sel.lga)}`) });
      if (v && v.id !== sel.ward) setLevel('ward', { ward: v.id, ward_name: v.name });
    };
    P.pu.onclick = async () => {
      const v = await pick({ title: 'Choose polling unit', items: await api(`/api/pus?ward=${encodeURIComponent(sel.ward)}`), code: (x) => x.code.split('/')[3] });
      if (v) await choosePu(v.code);
    };

    async function findCode() {
      const err = $('#codeerr');
      err.classList.add('hidden');
      const raw = $('#code').value.trim();
      if (!raw) return;
      try { await choosePu(raw); $('#loc').classList.add('hidden'); }
      catch (e) { err.textContent = e.status === 404 ? e.message : 'No network. Choose step by step, or try again.'; err.classList.remove('hidden'); }
    }
    $('#findcode').onclick = findCode;
    $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') findCode(); });

    function locateMe() {
      if (!navigator.geolocation) { loc('Your phone cannot share location. Please choose below.', 'warn'); return; }
      loc('Finding where you are…', '', true);
      navigator.geolocation.getCurrentPosition(async (p) => {
        try {
          const r = await api(`/api/locate?lat=${p.coords.latitude}&lng=${p.coords.longitude}`);
          if (r.match === 'pu') { await choosePu(r.code); loc(`Found your polling unit (${r.distance_m} m away). Change it below if this is wrong.`); return; }
          pu = null;
          for (const k of ['state', 'lga', 'ward', 'pu', 'state_name', 'lga_name', 'ward_name', 'pu_name', 'pu_code']) delete sel[k];
          if (r.state_code) {
            const states = await api('/api/states');
            Object.assign(sel, { state: r.state_code, state_name: r.state || (states.find((s) => s.code === r.state_code) || {}).name });
          }
          if (r.lga_id) Object.assign(sel, { lga: r.lga_id, lga_name: r.lga });
          if (r.ward_id) Object.assign(sel, { ward: r.ward_id, ward_name: r.ward });
          refresh();
          loc(r.ward_id ? `You seem to be in ${r.ward} ward. Now choose your polling unit.` : 'We found your area. Please choose the rest.');
        } catch (e) { loc(e.message || 'Could not match your location. Please choose below.', 'warn'); }
      }, (err) => locationOff(err && err.code), { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    }

    // Shown when the phone would not give a location: a switch to try again, and if the
    // browser or phone has location blocked (the app cannot undo that), how to allow it.
    function locationOff(code, tried = false) {
      const el = $('#loc');
      el.className = 'locstatus warn off';
      const help = !tried ? ''
        : code === 1 ? 'Location is blocked for this website. Tap the 🔒 lock (or ⋮ menu) beside the web address, open <b>Permissions</b> or <b>Site settings</b>, set <b>Location</b> to <b>Allow</b>, then switch on again.'
        : 'Your phone\'s location is turned off. Swipe down from the top of the screen, tap <b>Location</b> to turn it on, then switch on again.';
      el.innerHTML = `
        <span>Location is off. Type your polling unit number or choose below.</span>
        <label class="switch"><input type="checkbox" id="locswitch" role="switch" aria-checked="false"><span class="knob" aria-hidden="true"></span><b>Turn on location</b></label>
        ${help ? `<span class="lochelp">${help}</span>` : ''}`;
      $('#locswitch').onchange = (e) => {
        if (!e.target.checked) return;
        e.target.setAttribute('aria-checked', 'true');
        loc('Finding where you are…', '', true);
        if (!navigator.geolocation) { locationOff(2, true); return; }
        navigator.geolocation.getCurrentPosition(() => locateMe(), (err2) => locationOff(err2 && err2.code, true),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
      };
    }
    $('#relocate').onclick = locateMe;

    // ---- Scores ----
    // Each row: party logo | party (+ candidate name) | votes. Extra rows have a box to type the party.
    const rows = [...FEATURED.map((p) => ({ party: p, fixed: true })), ...(store.get('ivote.extraParties', []) || []).map((p) => ({ party: p }))];
    const scoresEl = $('#scores');
    let ballot = { parties: [], candidates: [] };
    const squash = (t) => String(t || '').toUpperCase().replace(/[^A-Z]/g, '');
    // "apc", "A.P.C." or "All Progressives Congress" -> "APC"; null if not a registered party.
    function partyCode(text) {
      const t = squash(text);
      if (!t) return null;
      if (PARTY_NAMES[t]) return t;
      return Object.keys(PARTY_NAMES).find((k) => squash(PARTY_NAMES[k]) === t) || null;
    }
    const logoOf = (code) => (ballot.parties.find((p) => p.code === code) || {}).logo || (code ? `/img/parties/${code}.png` : null);
    const logoHtml = (code) => code
      ? `<img class="plogo" src="${esc(logoOf(code))}" alt="${esc(code)} logo" loading="lazy">`
      : '<span class="plogo none" aria-hidden="true">?</span>';
    const candidateOf = (code) => ballot.candidates.find((c) => c.party === code);
    function drawScores() {
      scoresEl.innerHTML = rows.map((r, i) => {
        const code = r.fixed ? r.party : partyCode(r.party);
        const c = code && candidateOf(code);
        const middle = r.fixed
          ? `<span class="pname"><b>${esc(r.party)}</b><small>${c ? esc(c.name) : ''}</small></span>`
          : `<input class="txt party" list="partylist" data-i="${i}" value="${esc(r.party)}" placeholder="Party name" aria-label="Party name" maxlength="40" autocapitalize="characters">`;
        return `<div class="srow ${r.fixed ? '' : 'extra'}">
          <span class="logo-slot" data-logo="${i}">${logoHtml(code)}</span>${middle}
          <input class="txt votes" data-i="${i}" inputmode="numeric" pattern="[0-9]*" value="${esc(r.votes ?? '')}" placeholder="–" aria-label="Votes for ${esc(r.party || 'party')}">
          ${r.fixed ? '' : `<button class="x" type="button" data-rm="${i}" aria-label="Remove">×</button>`}
        </div>`;
      }).join('') + `<datalist id="partylist">${Object.keys(PARTY_NAMES).filter((k) => !FEATURED.includes(k)).map((k) => `<option value="${k}">${esc(PARTY_NAMES[k])}</option>`).join('')}</datalist>`;
    }
    async function loadBallot() {
      const area = election === 'pres' ? '&area=0' : pu ? `&pu=${encodeURIComponent(pu.code)}` : '';
      try { ballot = await api(`/api/ballot?election=${election}${area}`); } catch { /* offline: logos by code */ }
      drawScores();
    }
    scoresEl.addEventListener('input', (e) => {
      const i = e.target.dataset.i; if (i == null) return;
      if (e.target.classList.contains('votes')) { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); rows[i].votes = e.target.value; return; }
      rows[i].party = e.target.value;
      // Show the logo as soon as the typed name matches a party, without redrawing (keeps the keyboard open).
      scoresEl.querySelector(`[data-logo="${i}"]`).innerHTML = logoHtml(partyCode(e.target.value));
    });
    scoresEl.addEventListener('click', (e) => { const i = e.target.dataset.rm; if (i != null) { rows.splice(i, 1); drawScores(); } });
    $('#addparty').onclick = () => {
      rows.push({ party: '' }); drawScores();
      const boxes = scoresEl.querySelectorAll('input.party'); boxes[boxes.length - 1]?.focus();
    };
    drawScores();
    loadBallot();

    // ---- Result sheet photos ----
    const sheetIn = $('#sheetin');
    $('#addsheet').onclick = () => sheetIn.click();
    sheetIn.onchange = async () => {
      for (const f of sheetIn.files) { if (sheets.length >= MAX_SHEETS) break; sheets.push(await compressImage(f)); }
      sheetIn.value = ''; drawSheets();
    };
    function drawSheets() {
      $('#sheets').innerHTML = sheets.map((f, i) => `<div class="s" style="background-image:url(${URL.createObjectURL(f)})"><button type="button" data-i="${i}" aria-label="Remove photo">×</button></div>`).join('');
      $('#addsheet').disabled = sheets.length >= MAX_SHEETS;
    }
    $('#sheets').onclick = (e) => { const i = e.target.dataset.i; if (i != null) { sheets.splice(i, 1); drawSheets(); } };

    const needPu = (errEl) => {
      if (pu) return true;
      errEl.textContent = 'Choose your polling unit first (step 1).'; errEl.classList.remove('hidden');
      $('#h-where').scrollIntoView({ behavior: 'smooth' });
      return false;
    };

    $('#sendscores').onclick = async () => {
      const err = $('#scoreerr'); err.classList.add('hidden');
      if (!needPu(err)) return;
      const scores = rows.filter((r) => r.party.trim() && r.votes !== undefined && r.votes !== '').map((r) => ({ party: r.party.trim(), votes: +r.votes }));
      if (!scores.length) { err.textContent = 'Enter the votes for at least one party.'; err.classList.remove('hidden'); return; }
      const names = scores.map((s) => s.party.toUpperCase());
      if (new Set(names).size !== names.length) { err.textContent = 'A party is listed twice. Remove one.'; err.classList.remove('hidden'); return; }
      if (!confirm(`Send these results for ${pu.name}?\n\n${scores.map((s) => `${s.party.toUpperCase()}: ${s.votes}`).join('\n')}`)) return;
      store.set('ivote.extraParties', rows.filter((r) => !r.fixed && r.party.trim()).map((r) => r.party.trim().toUpperCase()));
      const btn = $('#sendscores'); btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const status = await submit({
          label: `${E.name} results`, endpoint: '/api/reports',
          fields: { client_id: uid(), election, pu_code: pu.code, scores: JSON.stringify(scores) },
          files: sheets.map((f, i) => ({ field: 'sheet', blob: f, name: f.name || `sheet-${i}.jpg` })),
        });
        done(status, election, pu);
      } catch (e) {
        err.textContent = e.message; err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Send results';
      }
    };

    // ---- Incident files ----
    const fileIn = $('#filein');
    $('#addfile').onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const err = $('#incerr'); err.classList.add('hidden');
      for (const f of fileIn.files) {
        if (files.length >= MAX_FILES) { err.textContent = `You can add up to ${MAX_FILES} files.`; err.classList.remove('hidden'); break; }
        let duration = null;
        if (f.type.startsWith('video/')) {
          duration = await videoDuration(f);
          if (duration && duration > MAX_VIDEO_SECONDS + 0.5) { err.textContent = `"${f.name}" is ${Math.round(duration)} seconds. Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter.`; err.classList.remove('hidden'); continue; }
        }
        if (f.size > 60 * 1024 * 1024) { err.textContent = `"${f.name}" is too big (60 MB max).`; err.classList.remove('hidden'); continue; }
        files.push({ file: f.type.startsWith('image/') ? await compressImage(f) : f, comment: '', duration, kind: 'incident' });
      }
      fileIn.value = ''; drawFiles();
    };
    function drawFiles() {
      $('#files').innerHTML = files.map((x, i) => {
        const url = URL.createObjectURL(x.file);
        const thumb = x.file.type.startsWith('image/') ? `<div class="thumb" style="background-image:url(${url})"></div>`
          : x.file.type.startsWith('video/') ? `<div class="thumb"><video src="${url}" muted playsinline preload="metadata"></video></div>`
          : '<div class="thumb">📄 File</div>';
        return `<div class="file">${thumb}<div>
          <div class="meta"><span>${esc(x.file.name || 'file')}${x.duration ? ` · ${Math.round(x.duration)}s` : ''}</span><button type="button" data-rm="${i}">Remove</button></div>
          ${x.file.type.startsWith('image/') ? `<div class="kind" role="radiogroup" aria-label="What is this photo?">
            <button type="button" data-k="result_sheet" data-ki="${i}" aria-pressed="${x.kind === 'result_sheet'}">Result photo</button>
            <button type="button" data-k="incident" data-ki="${i}" aria-pressed="${x.kind === 'incident'}">Problem</button></div>` : ''}
          <textarea class="txt" data-i="${i}" maxlength="500" placeholder="Comment on this file (optional)" aria-label="Comment">${esc(x.comment)}</textarea>
        </div></div>`;
      }).join('');
      $('#addfile').disabled = files.length >= MAX_FILES;
    }
    $('#files').addEventListener('input', (e) => { const i = e.target.dataset.i; if (i != null) files[i].comment = e.target.value; });
    $('#files').addEventListener('click', (e) => {
      const k = e.target.dataset.ki; if (k != null) { files[k].kind = e.target.dataset.k; drawFiles(); return; }
      const i = e.target.dataset.rm; if (i != null) { files.splice(i, 1); drawFiles(); }
    });

    $('#sendinc').onclick = async () => {
      const err = $('#incerr'); err.classList.add('hidden');
      if (!needPu(err)) return;
      const note = $('#note').value.trim();
      if (!note && !files.length) { err.textContent = 'Write what happened or add a photo, video or file.'; err.classList.remove('hidden'); return; }
      const btn = $('#sendinc'); btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const status = await submit({
          label: !note && files.every((f) => f.kind === 'result_sheet') ? 'Result photos' : 'Problem report', endpoint: '/api/incidents',
          fields: {
            client_id: uid(), election, pu_code: pu.code, note,
            comments: JSON.stringify(files.map((f) => f.comment)), kinds: JSON.stringify(files.map((f) => f.kind)), durations: JSON.stringify(files.map((f) => f.duration)),
          },
          files: files.map((f, i) => ({ field: 'files', blob: f.file, name: f.file.name || `file-${i}` })),
        });
        done(status, election, pu, true);
      } catch (e) {
        err.textContent = e.message; err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Send';
      }
    };

    // Start: reuse the unit chosen earlier on this phone, else find it from GPS.
    refresh();
    if (sel.pu_code) choosePu(sel.pu_code).catch(() => {});
    else locateMe();
  }

  function done(status, election, pu, incident = false) {
    const E = ELECTIONS[election];
    const others = Object.entries(ELECTIONS).filter(([k]) => k !== election);
    window.scrollTo(0, 0);
    app.innerHTML = `
      <div class="wrap done">
        <div class="tick ${status === 'sent' ? '' : 'wait'}" aria-hidden="true">${status === 'sent' ? '✓' : '⏳'}</div>
        <h1>${status === 'sent' ? 'Thank you! Sent.' : 'Saved on your phone'}</h1>
        <p class="lead">${status === 'sent'
          ? `Your ${incident ? 'report' : `${E.name} results`} for ${esc(pu.name)} reached Ivote.`
          : 'There is no network right now. Keep the app open or come back later — it will send by itself when network returns.'}</p>
        ${!incident ? others.map(([k, e]) => `<button class="btn election ${k}" type="button" data-e="${k}" style="min-height:64px;font-size:20px">Report ${e.name} too</button>`).join('') : ''}
        <button class="btn outline" type="button" data-e="${election}">Report something else here</button>
        <a class="btn ghost" style="display:block;text-decoration:none;margin-top:12px" href="/results">See live results</a>
        <a class="homebtn" href="#/">🏠 Back to home page</a>
      </div>`;
    app.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => {
      if (location.hash === `#/report/${b.dataset.e}`) report(b.dataset.e); else location.hash = `#/report/${b.dataset.e}`;
    });
  }

  function route() {
    const m = location.hash.match(/^#\/report\/(pres|sen|rep)$/);
    window.scrollTo(0, 0);
    if (m) report(m[1]); else home();
  }
  window.addEventListener('hashchange', route);
  route();
  updateOutbox();
  flush();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
