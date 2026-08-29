(function () {
  var script = document.currentScript;
  var cfg = (window.__EISE_BEACON__ || {});
  var endpoint = (script && script.dataset.endpoint) || cfg.endpoint || 'https://gallery.eise.app/a';
  var siteId = (script && script.dataset.site) || cfg.siteId || 'eise-prod';
  var lastPath = null;

  // Returns a Promise<boolean> that resolves to true if the beacon reached the
  // server (2xx) and false otherwise. Never rejects. Callers that don't care
  // can ignore the return value. stack_ping delivery uses it to keep undelivered
  // log lines in a retry buffer instead of losing them on a dropped fetch.
  function send(event, extra) {
    var body = {
      site_id: siteId,
      event: event,
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
