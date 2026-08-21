(function () {
  var script = document.currentScript;
  var cfg = (window.__EISE_BEACON__ || {});
  var endpoint = (script && script.dataset.endpoint) || cfg.endpoint || 'https://gallery.eise.app/a';
  var siteId = (script && script.dataset.site) || cfg.siteId || 'eise-prod';
  var lastPath = null;

  function send(event, extra) {
    var body = {
      site_id: siteId,
      event: event,
      path: location.pathname + location.search,
      referrer: document.referrer || null,
    };
    if (extra && extra.props) body.props = extra.props;
    if (extra && extra.variant) body.variant = extra.variant;
    if (extra && extra.user_id) body.user_id = extra.user_id;
    try {
      fetch(endpoint + '/event', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  function pageview() {
    var p = location.pathname + location.search;
    if (p === lastPath) return;
    lastPath = p;
    send('pageview');
  }

  window.eise = window.eise || {};
  window.eise.track = function (event, props) { send(event, { props: props }); };
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
