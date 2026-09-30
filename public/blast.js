// Organizer blast banner. Shows the latest blast addressed to this page's
// audience ("volunteers" or "judges"; "both" reaches everyone). Listens on the
// live stream and polls /api/blast/latest, because the stream only carries
// blasts sent through the same server instance.
(function () {
  const POLL_MS = 30000;
  const MAX_AGE_MS = 6 * 60 * 60 * 1000; // older blasts are not shown to new visitors
  const DISMISS_KEY = 'devfest_blast_dismissed';

  function dismissedId() {
    try { return localStorage.getItem(DISMISS_KEY); } catch (e) { return null; }
  }
  function setDismissed(id) {
    try { localStorage.setItem(DISMISS_KEY, id); } catch (e) { /* storage unavailable */ }
  }

  function banner() {
    let el = document.getElementById('devfest-blast-banner');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'devfest-blast-banner';
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;display:none;background:#fef7e0;border-bottom:2px solid #f9ab00;color:#202124;font-family:system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.15)';
    const inner = document.createElement('div');
    inner.style.cssText = 'max-width:48rem;margin:0 auto;padding:12px 16px;display:flex;gap:12px;align-items:flex-start';
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0';
    const label = document.createElement('div');
    label.textContent = 'Organizer announcement';
    label.style.cssText = 'font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#b06000';
    const msg = document.createElement('div');
    msg.className = 'devfest-blast-message';
    msg.style.cssText = 'font-size:15px;font-weight:600;white-space:pre-line;overflow-wrap:anywhere;margin-top:2px';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss announcement');
    close.style.cssText = 'font-size:22px;line-height:1;background:none;border:0;cursor:pointer;color:#5f6368;padding:0 4px';
    close.addEventListener('click', () => {
      el.style.display = 'none';
      if (el.dataset.id) setDismissed(el.dataset.id);
    });
    body.append(label, msg);
    inner.append(body, close);
    el.append(inner);
    document.body.prepend(el);
    return el;
  }

  function init({ audience, enabled = () => true }) {
    let lastShown = null;

    function show(blast) {
      if (!blast || !blast.id || !blast.message) return;
      if (blast.audience !== 'both' && blast.audience !== audience) return;
      if (!enabled()) return;
      if (blast.id === lastShown || blast.id === dismissedId()) return;
      if (blast.at && Date.now() - blast.at > MAX_AGE_MS) return;
      lastShown = blast.id;
      const el = banner();
      el.dataset.id = blast.id;
      el.querySelector('.devfest-blast-message').textContent = blast.message; // text only, never HTML
      el.style.display = 'block';
    }

    async function poll() {
      try {
        const res = await fetch('/api/blast/latest', { cache: 'no-store' });
        if (res.ok) show((await res.json()).blast);
      } catch (e) { /* offline; try again next poll */ }
    }

    try {
      const es = new EventSource('/api/stream');
      es.addEventListener('blast', e => {
        try { show(JSON.parse(e.data)); } catch (err) { /* ignore malformed event */ }
      });
    } catch (e) { /* EventSource unsupported; polling still works */ }

    poll();
    setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    return { poll };
  }

  // ---- "Text from my phone": group SMS links opened on the organizer's phone ----
  const SMS_GROUP_SIZE = 20;

  function smsPlatform(ua, maxTouchPoints) {
    ua = String(ua || '');
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'desktop';
  }

  // Link formats that open a prefilled message on the phone's own Messages app:
  //   iOS (Messages, iOS 8+):  sms://open?addresses=+1…,+1…&body=…
  //     The only iOS form that takes several recipients; a plain "sms:a,b" opens
  //     a message to the first number only.
  //   Android (Google Messages, Samsung Messages, AOSP):  sms:+1…;+1…?body=…
  //     RFC 5724 query-string body. ';' is the separator every Android messaging
  //     app splits on (Samsung ignores everything after a ','), so it is used here.
  // The body is encodeURIComponent'd, so & ? # + = and newlines (%0A) and emoji
  // (UTF-8 %XX) arrive intact instead of cutting the message short. Numbers are
  // already normalized to +<digits>, which needs no escaping.
  function smsHref(platform, numbers, message) {
    const body = encodeURIComponent(String(message == null ? '' : message).replace(/\r\n?/g, '\n'));
    if (platform === 'ios') return `sms://open?addresses=${numbers.join(',')}&body=${body}`;
    return `sms:${numbers.join(';')}?body=${body}`;
  }

  // Browser copy of lib/phone.js normalizePhone (the tests check they agree).
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
      if (digits.length === 10 || digits.length === 11) return null;
    }
    return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  }

  function smsGroups(numbers, size = SMS_GROUP_SIZE) {
    const out = [];
    for (let i = 0; i < numbers.length; i += size) out.push(numbers.slice(i, i + size));
    return out;
  }

  // One entry per group and platform to show ("desktop" shows both formats).
  function smsLinks(numbers, message, platform) {
    const platforms = platform === 'desktop' ? ['ios', 'android'] : [platform];
    const groups = smsGroups(numbers);
    const links = [];
    groups.forEach((g, i) => platforms.forEach(p => links.push({
      platform: p, group: i + 1, total: groups.length, count: g.length, href: smsHref(p, g, message)
    })));
    return links;
  }

  const api = { init, sms: { SMS_GROUP_SIZE, smsPlatform, smsHref, smsGroups, smsLinks, normalizePhone } };
  if (typeof window !== 'undefined') window.DevFestBlast = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
