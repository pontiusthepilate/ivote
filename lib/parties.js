// Party names people are likely to type, mapped to the acronym we store.
// The first four are always shown on the reporting form, in alphabetical order.

const FEATURED = ['ADC', 'APC', 'NDC', 'PDP'];

// INEC's 22 registered parties (inecnigeria.org/parties, October 2026).
const KNOWN = {
  A: 'Accord',
  AA: 'Action Alliance',
  AAC: 'African Action Congress',
  ADC: 'African Democratic Congress',
  ADP: 'Action Democratic Party',
  APC: 'All Progressives Congress',
  APGA: 'All Progressives Grand Alliance',
  APM: 'Allied Peoples Movement',
  APP: 'Action Peoples Party',
  BP: 'Boot Party',
  DLA: 'Democratic Leadership Alliance',
  LP: 'Labour Party',
  NDC: 'Nigeria Democratic Congress',
  NDP: 'National Democratic Party',
  NNPP: 'New Nigeria Peoples Party',
  NRM: 'National Rescue Movement',
  PDP: 'Peoples Democratic Party',
  PRP: 'Peoples Redemption Party',
  SDP: 'Social Democratic Party',
  YP: 'Youth Party',
  YPP: 'Young Progressives Party',
  ZLP: 'Zenith Labour Party',
};

const byName = new Map(Object.entries(KNOWN).map(([k, v]) => [v.toUpperCase().replace(/[^A-Z]/g, ''), k]));
byName.set('ACCORDPARTY', 'A');
byName.set('LABOUR', 'LP');

// "labour party", "L.P.", " lp " -> "LP". Unknown names are kept, upper-cased.
function normalizeParty(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const letters = s.replace(/[^A-Z0-9]/g, '');
  if (!letters) return null;
  if (KNOWN[letters]) return letters;
  if (byName.has(letters)) return byName.get(letters);
  return s.slice(0, 40);
}

// Map colours, checked for colour-blind separation (always shown with the party
// name, never colour alone). Every other party is grey.
const COLORS = {
  APC: '#1f5fbf', PDP: '#d62828', ADC: '#2a9d8f', NDC: '#e9a30b', LP: '#f28fc0', NNPP: '#a06cd5',
};
const OTHER_COLOR = '#9aa5a0';

module.exports = { FEATURED, KNOWN, COLORS, OTHER_COLOR, normalizeParty };
