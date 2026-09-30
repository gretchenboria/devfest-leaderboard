'use strict';
// Phone number helpers for "Text from my phone" (group SMS links).

// Returns a dialable "+<digits>" string, or null when the number is unusable.
// US/NANP: 10 digits (or 11 starting with 1) become +1XXXXXXXXXX. A number
// typed with a leading + and 8-15 digits is kept as an international number.
function normalizePhone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const intl = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);
  if (!intl || digits.startsWith('1')) {
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return '+1' + digits;
    if (!intl) return null;
    if (digits.length === 10 || digits.length === 11) return null; // malformed +1 number
  }
  return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

module.exports = { normalizePhone, chunk };
