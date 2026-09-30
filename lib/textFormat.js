'use strict';
// Display helpers for organizer-written text (instructions, venue notes).
//
// Stored text is plain UTF-8 with real newlines and "•" bullets. These helpers
// repair common corruption ON READ (never rewriting stored data) and turn text
// into HTML that is escaped exactly once.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#34': '"' };
const ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#39|#x27|#34);/g;
const MOJIBAKE_RE = /Ã[\u0080-¿]|â€|Â[ -¿·]/;
const CIPHERTEXT_RE = /^[0-9a-f]{32}:[0-9a-f]{32,}$/i;

function decodeEntities(s) {
  // Undo HTML-escaping applied at save time (possibly more than once, e.g.
  // "&amp;amp;"). Plain text never legitimately contains these sequences.
  for (let i = 0; i < 4 && ENTITY_RE.test(s); i++) {
    ENTITY_RE.lastIndex = 0;
    s = s.replace(ENTITY_RE, (_, name) => ENTITIES[name]);
  }
  ENTITY_RE.lastIndex = 0;
  return s;
}

function fixMojibake(s) {
  // UTF-8 bytes that were decoded as Latin-1/CP1252 ("â€”" for "—", "Ã—" for "×").
  if (!MOJIBAKE_RE.test(s)) return s;
  const cp1252 = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
    '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x100) bytes.push(cp);
    else if (cp1252[ch] !== undefined) bytes.push(cp1252[ch]);
    else return s; // contains real non-Latin-1 text: not a clean mojibake case
  }
  const fixed = Buffer.from(bytes).toString('utf8');
  return fixed.includes('�') ? s : fixed;
}

// Normalizes stored text for display. `decrypt` (optional) is used when the
// value is an "ivHex:cipherHex" blob that was stored encrypted by mistake.
function normalizeStoredText(value, { decrypt } = {}) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  if (decrypt && CIPHERTEXT_RE.test(s.trim())) {
    try { const d = decrypt(s.trim()); if (d) s = d; } catch (e) { /* leave as is */ }
  }
  s = s.replace(/\r\n?/g, '\n');
  if (!s.includes('\n') && s.includes('\\n')) s = s.replace(/\\n/g, '\n'); // JSON-escaped newlines stored literally
  s = decodeEntities(s);
  s = fixMojibake(s);
  return s.replace(/<br\s*\/?>/gi, '\n');
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Plain text -> HTML for emails: escaped once, line breaks kept, **bold** kept.
function textToHtml(value, opts) {
  return escapeHtml(normalizeStoredText(value, opts))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Masks an email for reports and logs: "t.bessarabova@gmail.com" -> "t***@gmail.com".
function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? s[0] + '***' : '';
  return s[0] + '***' + s.slice(at);
}

module.exports = { normalizeStoredText, textToHtml, escapeHtml, maskEmail };
