(function () {
  var script = document.currentScript;
  var cfg = (window.__EISE_BEACON__ || {});
  var endpoint = (script && script.dataset.endpoint) || cfg.endpoint || 'https://gallery.eise.app/a';
  var siteId = (script && script.dataset.site) || cfg.siteId || 'eise-prod';
  // Detect Electron at runtime and route to the desktop segment, no matter which
  // bundle served this beacon. The Electron preload exposes window.electronAPI
  // synchronously before the first script runs, so it's safe to read here. This
  // keeps the desktop attribution stable even after the auto-updater swaps in
  // the web-flavored bundle from https://eise.app/.
  if (typeof window !== 'undefined' && window.electronAPI) {
    siteId = 'eise-electron';
  }
  var lastPath = null;

  // --- session id -----------------------------------------------------------
  // The server mints a session id and hands it back as an HttpOnly cookie, but
  // that cookie only exists once the FIRST request has completed. pageview()
  // fires at load and human_interaction fires on the first scroll/mousemove/
  // touchstart, which routinely lands inside that round trip. Both then arrived
  // cookieless and the server minted a separate session for each, splitting a
  // single visit across two session rows (one holding only the pageview, one
  // holding only the interaction). Measured at ~478 split visits per 21 days,
  // ~11% of all sessions, which made the reported interaction-to-stack rate
  // read 40% when the true rate was 57%.
  //
  // Minting the id here and sending it on every event removes the race.
  // resolveSessionId() on the server prefers its own cookie when one exists,
  // so returning visitors keep the session they already had.
  //
  // Deliberately in-memory only, NOT localStorage. The race is entirely within
  // one page load, so a per-load id closes it; cross-load continuity is still
  // the HttpOnly cookie's job, exactly as before. That keeps us from writing a
  // second, script-readable copy of the identifier to the user's device, which
  // would be a new consent surface (ePrivacy Art 5(3) covers localStorage on
  // the same terms as cookies) and a new XSS target, for no gain on any visitor
  // whose cookies work. Visitors who block cookies outright get one session per
  // page load instead of one per visit; still better than the split sessions
  // they get today.
  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = '';
      for (var i = 0; i < 16; i++) h += (b[i] + 0x100).toString(16).slice(1);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) {
      // Last resort, if Web Crypto is missing entirely. Not cryptographically
      // random, but it must still come out in the same 36-char v4 shape as
      // randUuid() on the server, so ids are one format everywhere.
      var s = '';
      for (var j = 0; j < 32; j++) s += Math.floor(Math.random() * 16).toString(16);
      s = s.slice(0, 12) + '4' + s.slice(13, 16) + '89ab'.charAt(Math.floor(Math.random() * 4)) + s.slice(17);
      return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
    }
  }

  // No sync-back from the server response is needed: when a cookie exists it
  // outranks this id on every request alike, so the two can never disagree
  // partway through a load.
  var sessionId = uuid();

  // Returns a Promise<boolean> that resolves to true if the beacon reached the
  // server (2xx) and false otherwise. Never rejects. Callers that don't care
  // can ignore the return value. stack_ping delivery uses it to keep undelivered
  // log lines in a retry buffer instead of losing them on a dropped fetch.
  function send(event, extra) {
    var body = {
      site_id: siteId,
      event: event,
      // Sent on every event so the very first burst of a visit shares one
      // session even before the server's cookie has come back. The cookie still
      // wins server-side when it exists.
      session_id: sessionId,
      // client_ts pins the event to its emit time so bursts (stack_start +
      // immediate stack_ping) don't get reordered by concurrent-POST arrival
      // jitter. Server verifies + clamps to ±10min skew before trusting it.
      client_ts: Date.now(),
      path: location.pathname + location.search,
      referrer: document.referrer || null,
    };
    if (extra && extra.props) body.props = extra.props;
    if (extra && extra.variant) body.variant = extra.variant;
    if (extra && extra.variants) body.variants = extra.variants;
    if (extra && extra.user_id) body.user_id = extra.user_id;
    try {
      return fetch(endpoint + '/event', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).then(function (r) { return !!(r && r.ok); }, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function pageview() {
    var p = location.pathname + location.search;
    if (p === lastPath) return;
    lastPath = p;
    send('pageview');
  }

  window.eise = window.eise || {};
  window.eise.track = function (event, props, extra) {
    return send(event, {
      props: props,
      variants: extra && extra.variants ? extra.variants : undefined,
    });
  };

  // navigator.sendBeacon() variant for pagehide / tab-close. fetch() with
  // keepalive:true isn't reliable on iOS Safari when the tab is actually going
  // away — sendBeacon is the browser-guaranteed delivery path for that moment.
  // Returns true if the beacon was queued (does NOT mean delivered), false if
  // the browser refused (payload too big, disabled, etc.). Fire-and-forget.
  window.eise.sendBeacon = function (event, props) {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    try {
      var body = {
        site_id: siteId,
        event: event,
        session_id: sessionId,
        client_ts: Date.now(),
        path: location.pathname + location.search,
        referrer: document.referrer || null,
      };
      if (props) body.props = props;
      // Blob with explicit JSON MIME so the server parses it identically to
      // fetch()-posted events.
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      return navigator.sendBeacon(endpoint + '/event', blob);
    } catch (e) {
      return false;
    }
  };
  window.eise.pageview = pageview;
  window.eise.experiment = function (name) {
    return fetch(endpoint + '/experiment/' + encodeURIComponent(name) + '?site_id=' + encodeURIComponent(siteId), {
      credentials: 'include',
    })
      .then(function (r) { return r.ok ? r.json() : { variant: null }; })
      .then(function (d) { return d.variant; })
      .catch(function () { return null; });
  };
  window.eise.whoami = function () {
    return fetch(endpoint + '/whoami', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : { role: null }; })
      .catch(function () { return { role: null }; });
  };

  pageview();

  // Auto-track clicks to external hosts. keepalive on the fetch survives
  // same-tab navigation; capture phase ensures we fire before any handler
  // that might preventDefault.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var t = e.target;
    var link = t && t.closest ? t.closest('a[href]') : null;
    if (!link) return;
    // Some links (e.g. "Let me know!" that opens Sentry feedback in-page
    // when available) explicitly manage their own tracking. Skip auto-track
    // for those — the click handler fires window.eise.track manually when
    // it can confirm the user actually navigated.
    if (link.hasAttribute('data-no-track')) return;
    var href = link.getAttribute('href');
    if (!href) return;
    var url;
    try { url = new URL(href, location.href); } catch (_) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.hostname === location.hostname) return;
    send('click_ext', { props: { url: url.href } });
  }, true);

  var _push = history.pushState;
  history.pushState = function () {
    _push.apply(this, arguments);
    setTimeout(pageview, 0);
  };
  var _replace = history.replaceState;
  history.replaceState = function () {
    _replace.apply(this, arguments);
    setTimeout(pageview, 0);
  };
  window.addEventListener('popstate', pageview);
})();
