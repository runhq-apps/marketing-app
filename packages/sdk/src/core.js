/**
 * The SDK core, written as one dependency-free factory so the same source can ship as
 * an ES module for bundlers and as a classic script tag for a marketing site.
 *
 * What it is for: keeping the thread from "an ad was clicked" to "this named person
 * paid us" unbroken. That means three things must survive a page navigation, a domain
 * hop from the marketing site to the app, and a return visit a week later:
 *   1. a stable anonymous id
 *   2. the FIRST touch (the ad that found them), kept separately from the last
 *   3. an identity, attached the moment the product knows one
 */
export function createClient(globalObj) {
  const win = globalObj;
  const doc = win.document;

  const STORE_ANON = 'runhq.anon';
  const STORE_FIRST = 'runhq.first_touch';
  const STORE_QUEUE = 'runhq.queue';
  const STORE_USER = 'runhq.user';

  const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  const CLICK_IDS = ['gclid', 'wbraid', 'gbraid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'rdt_cid', 'ttclid'];

  let config = {
    key: null,
    host: '',
    autoPage: true,
    autoOutboundUtm: false,
    flushInterval: 5000,
    batchSize: 20,
    debug: false,
    cookieDomain: null,
  };
  let queue = [];
  let timer = null;
  let started = false;
  let lastPath = null;

  /* ------------------------------------------------------------ storage */

  const safeLocal = {
    get(k) { try { return win.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { win.localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { win.localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /**
   * A cookie mirrors the anonymous id so it survives on a subdomain hop
   * (www.example.com → app.example.com), which localStorage alone does not.
   */
  function writeCookie(name, value, days) {
    if (!doc) return;
    const domain = config.cookieDomain || baseDomain();
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    doc.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax` +
      (domain ? `; domain=${domain}` : '') + (win.location?.protocol === 'https:' ? '; Secure' : '');
  }

  function readCookie(name) {
    if (!doc?.cookie) return null;
    const m = doc.cookie.match(new RegExp('(?:^|; )' + name.replace(/\./g, '\\.') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function baseDomain() {
    const host = win.location?.hostname || '';
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return null;
    const parts = host.split('.');
    return parts.length > 2 ? '.' + parts.slice(-2).join('.') : '.' + host;
  }

  function anonId() {
    let id = safeLocal.get(STORE_ANON) || readCookie(STORE_ANON);
    if (!id) {
      id = 'a_' + randomId();
      safeLocal.set(STORE_ANON, id);
    }
    writeCookie(STORE_ANON, id, 365);
    return id;
  }

  function randomId() {
    const c = win.crypto;
    if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
    if (c?.getRandomValues) {
      return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ---------------------------------------------------------- attribution */

  function currentTouch() {
    const touch = {};
    try {
      const params = new URL(win.location.href).searchParams;
      for (const k of UTM_KEYS.concat(CLICK_IDS, ['run_channel', 'ref'])) {
        const v = params.get(k);
        if (v) touch[k] = v;
      }
    } catch { /* non-browser environment */ }
    const ref = doc?.referrer || '';
    if (ref && !sameHost(ref)) touch.referrer = ref;
    return touch;
  }

  function sameHost(url) {
    try { return new URL(url).hostname === win.location.hostname; } catch { return false; }
  }

  /**
   * First touch is written once and never overwritten — that is the whole point of it.
   * It is what lets a Capterra click in March get the credit for a June signup.
   */
  function rememberFirstTouch(touch) {
    if (safeLocal.get(STORE_FIRST)) return;
    if (!Object.keys(touch).length) return;
    safeLocal.set(STORE_FIRST, JSON.stringify({ ...touch, at: new Date().toISOString(), landing: win.location?.href }));
  }

  function firstTouch() {
    try { return JSON.parse(safeLocal.get(STORE_FIRST) || 'null'); } catch { return null; }
  }

  /* ------------------------------------------------------------- sending */

  function enqueue(event) {
    queue.push(event);
    persistQueue();
    if (queue.length >= config.batchSize) flush();
    else schedule();
    if (config.debug) win.console?.log('[runhq]', event.name, event);
    return event;
  }

  function persistQueue() {
    // Survives an unload that beats the flush; replayed on the next page.
    safeLocal.set(STORE_QUEUE, JSON.stringify(queue.slice(-50)));
  }

  function schedule() {
    if (timer) return;
    timer = win.setTimeout(() => { timer = null; flush(); }, config.flushInterval);
  }

  function payload(events) {
    return {
      key: config.key,
      anon_id: anonId(),
      url: win.location?.href,
      referrer: doc?.referrer || null,
      events,
    };
  }

  function flush(useBeacon) {
    if (!queue.length || !config.key) return Promise.resolve({ sent: 0 });
    const batch = queue;
    queue = [];
    persistQueue();
    const url = config.host.replace(/\/$/, '') + '/api/collect';
    const body = JSON.stringify(payload(batch));

    if (useBeacon && win.navigator?.sendBeacon) {
      const ok = win.navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      if (ok) return Promise.resolve({ sent: batch.length, transport: 'beacon' });
    }
    return win.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      mode: 'cors',
      credentials: 'omit',
    }).then((r) => {
      if (!r.ok && r.status >= 500) requeue(batch); // client errors are permanent; server errors are not
      return { sent: batch.length, status: r.status };
    }).catch(() => {
      requeue(batch);
      return { sent: 0, queued: batch.length };
    });
  }

  function requeue(batch) {
    queue = batch.concat(queue).slice(-50);
    persistQueue();
    schedule();
  }

  function replayStoredQueue() {
    try {
      const stored = JSON.parse(safeLocal.get(STORE_QUEUE) || '[]');
      if (Array.isArray(stored) && stored.length) { queue = stored.concat(queue); flush(); }
    } catch { safeLocal.del(STORE_QUEUE); }
  }

  /* ---------------------------------------------------------- public API */

  const client = {
    init(options = {}) {
      config = { ...config, ...options };
      if (!config.key) throw new Error('runhq.init needs a { key }');
      if (!config.host) config.host = options.host || defaultHost();
      if (started) return client;
      started = true;

      const touch = currentTouch();
      rememberFirstTouch(touch);
      anonId();
      replayStoredQueue();

      if (config.autoPage) {
        client.page();
        watchHistory();
      }
      doc?.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') flush(true);
      });
      win.addEventListener?.('pagehide', () => flush(true));
      if (config.autoOutboundUtm) tagOutboundLinks();
      return client;
    },

    /** A page view. Called automatically on init and on SPA route changes. */
    page(name, props = {}) {
      const touch = currentTouch();
      return enqueue({
        name: 'page',
        ts: new Date().toISOString(),
        url: win.location?.href,
        referrer: doc?.referrer || null,
        props: { ...touch, ...props, title: name || doc?.title, first_touch: firstTouch() || undefined },
      });
    },

    /** Any product event. Pass `value` for revenue, `stage` to move the funnel. */
    track(name, props = {}) {
      if (!name) throw new Error('runhq.track needs an event name');
      return enqueue({
        name,
        ts: new Date().toISOString(),
        url: win.location?.href,
        value: props.value,
        stage: props.stage,
        props: { ...currentTouch(), ...props },
      });
    },

    /** Move a person to a funnel stage explicitly — trial, opportunity, customer. */
    stage(stageKey, props = {}) {
      return client.track(props.event || stageKey, { ...props, stage: stageKey });
    },

    /**
     * Attach an identity. Call this the instant you know an email — signup, demo form,
     * invite accept — and pass the CRM/user id so the record survives an email change.
     */
    identify(userId, traits = {}) {
      if (userId) safeLocal.set(STORE_USER, String(userId));
      const ev = enqueue({
        name: 'identify',
        ts: new Date().toISOString(),
        url: win.location?.href,
        user_id: userId ? String(userId) : undefined,
        traits,
        props: { first_touch: firstTouch() || undefined },
      });
      flush();
      return ev;
    },

    /** Revenue. `runhq.revenue(499, { plan: 'pro' })` counts a customer and its value. */
    revenue(value, props = {}) {
      return client.track(props.event || 'purchase', { ...props, value: Number(value) || 0, stage: props.stage || 'customer' });
    },

    /** Forget this browser — call from a cookie banner's reject path. */
    reset() {
      [STORE_ANON, STORE_FIRST, STORE_QUEUE, STORE_USER].forEach(safeLocal.del);
      writeCookie(STORE_ANON, '', -1);
      queue = [];
      return client;
    },

    flush: () => flush(),
    get anonymousId() { return anonId(); },
    get firstTouch() { return firstTouch(); },
    get userId() { return safeLocal.get(STORE_USER); },
    get config() { return { ...config, key: config.key ? config.key.slice(0, 12) + '…' : null }; },
  };

  function defaultHost() {
    // A script tag knows where it was loaded from; that is the collector.
    const script = doc?.currentScript || doc?.querySelector('script[data-runhq-key], script[src*="/sdk.js"]');
    if (script?.src) { try { return new URL(script.src).origin; } catch { /* fall through */ } }
    return win.location?.origin || '';
  }

  /** SPA route changes are page views; history is patched once. */
  function watchHistory() {
    lastPath = win.location?.pathname + win.location?.search;
    const fire = () => {
      const path = win.location.pathname + win.location.search;
      if (path === lastPath) return;
      lastPath = path;
      client.page();
    };
    for (const method of ['pushState', 'replaceState']) {
      const original = win.history?.[method];
      if (!original) continue;
      win.history[method] = function patched(...args) {
        const out = original.apply(this, args);
        fire();
        return out;
      };
    }
    win.addEventListener?.('popstate', fire);
  }

  /**
   * Optional: stamp this visit's attribution onto outbound links to your own app on a
   * different domain, so a marketing-site → app hop does not read as a new direct visit.
   */
  function tagOutboundLinks() {
    const hosts = Array.isArray(config.autoOutboundUtm) ? config.autoOutboundUtm : [];
    if (!hosts.length || !doc) return;
    doc.addEventListener('click', (e) => {
      const a = e.target?.closest?.('a[href]');
      if (!a) return;
      let url;
      try { url = new URL(a.href, win.location.href); } catch { return; }
      if (!hosts.some((h) => url.hostname.endsWith(h))) return;
      url.searchParams.set('run_anon', anonId());
      const ft = firstTouch();
      if (ft?.utm_source && !url.searchParams.has('utm_source')) url.searchParams.set('utm_source', ft.utm_source);
      a.href = url.toString();
    }, { capture: true });
  }

  return client;
}
