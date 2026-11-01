/* Candidates page: browse INEC's final list of candidates. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (u) => fetch(u).then((r) => r.json());

  const params = new URLSearchParams(location.search);
  $('#election').value = params.get('e') || 'pres';

  async function loadStates() {
    const states = await get('/api/states');
    $('#state').innerHTML = states.map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join('');
    if (params.get('s')) $('#state').value = params.get('s');
  }
  async function loadAreas() {
    const e = $('#election').value;
    $('#state').hidden = $('#area').hidden = e === 'pres';
    if (e === 'pres') return;
    const areas = await get(`/api/areas?election=${e}&state=${$('#state').value}`);
    $('#area').innerHTML = areas.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    if (params.get('a') && areas.some((a) => String(a.id) === params.get('a'))) $('#area').value = params.get('a');
  }
  async function loadList() {
    const e = $('#election').value, area = e === 'pres' ? 0 : $('#area').value;
    history.replaceState(null, '', `?e=${e}${e === 'pres' ? '' : `&s=${$('#state').value}&a=${area}`}`);
    const b = await get(`/api/ballot?election=${e}&area=${area}`);
    const logo = Object.fromEntries(b.parties.map((p) => [p.code, p]));
    $('#list').innerHTML = b.candidates.length ? b.candidates.map((c) => `
      <div class="crow">
        <img class="plogo" src="${esc(logo[c.party]?.logo || '')}" alt="${esc(c.party)} logo">
        <span class="pname"><b>${esc(c.party)}</b><small>${esc(c.name)}${c.running_mate ? `<br>Running mate: ${esc(c.running_mate)}` : ''}<br>${esc(logo[c.party]?.name || '')}</small></span>
      </div>`).join('') : '<p class="hint">No candidates found.</p>';
  }

  $('#election').onchange = async () => { params.delete('a'); await loadAreas(); loadList(); };
  $('#state').onchange = async () => { params.delete('a'); await loadAreas(); loadList(); };
  $('#area').onchange = loadList;

  $('#credits').textContent = 'Party logos: INEC.';

  loadStates().then(loadAreas).then(loadList);
})();
