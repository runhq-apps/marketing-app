/**
 * No bundler: the core is one dependency-free module, so shipping it is a matter of
 * wrapping the same source twice — once as ESM for bundlers, once as a classic script
 * that self-initialises from its own tag attributes.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const core = await readFile(new URL('./src/core.js', import.meta.url), 'utf8');
const body = core.replace(/^export function createClient/m, 'function createClient');
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });

const banner = `/* @runhq/sdk 0.1.0 — end-to-end marketing attribution. */`;

await writeFile(new URL('./dist/runhq.esm.js', import.meta.url), `${banner}
${core}

const runhq = typeof window !== 'undefined' ? createClient(window) : null;
export default runhq;
export { createClient };
`);

// The script-tag build reads its own data- attributes, so installing it is one line.
await writeFile(new URL('./dist/runhq.js', import.meta.url), `${banner}
(function (win) {
  if (win.runhq && win.runhq.__loaded) return;
${indent(body)}

  var runhq = createClient(win);
  runhq.__loaded = true;

  // Replay anything the page queued before this script finished loading:
  //   window.runhq = window.runhq || function(){ (window.runhq.q = window.runhq.q || []).push(arguments) };
  var pending = win.runhq && win.runhq.q ? win.runhq.q : [];
  win.runhq = runhq;

  var tag = win.document && (win.document.currentScript ||
    win.document.querySelector('script[data-runhq-key]'));
  if (tag && tag.getAttribute('data-runhq-key')) {
    runhq.init({
      key: tag.getAttribute('data-runhq-key'),
      host: tag.getAttribute('data-runhq-host') || undefined,
      debug: tag.getAttribute('data-runhq-debug') === 'true',
      autoPage: tag.getAttribute('data-runhq-auto-page') !== 'false'
    });
  }

  for (var i = 0; i < pending.length; i++) {
    var call = pending[i];
    var method = call[0];
    if (typeof runhq[method] === 'function') runhq[method].apply(runhq, [].slice.call(call, 1));
  }
})(typeof window !== 'undefined' ? window : globalThis);
`);

await writeFile(new URL('./dist/runhq.d.ts', import.meta.url), `${banner}
export interface RunConfig {
  /** Publishable project key, run_pk_… */
  key: string;
  /** Collector origin. Defaults to the origin the script was loaded from. */
  host?: string;
  /** Send a page view on init and on SPA route changes. Default true. */
  autoPage?: boolean;
  /** Hostnames of your own apps to stamp attribution onto when linked out to. */
  autoOutboundUtm?: string[] | false;
  flushInterval?: number;
  batchSize?: number;
  debug?: boolean;
  cookieDomain?: string | null;
}

export interface RunTraits {
  email?: string;
  name?: string;
  company?: string;
  country?: string;
  [key: string]: unknown;
}

export interface RunClient {
  init(config: RunConfig): RunClient;
  page(name?: string, props?: Record<string, unknown>): unknown;
  track(name: string, props?: Record<string, unknown> & { value?: number; stage?: string }): unknown;
  stage(stage: string, props?: Record<string, unknown>): unknown;
  identify(userId?: string, traits?: RunTraits): unknown;
  revenue(value: number, props?: Record<string, unknown>): unknown;
  reset(): RunClient;
  flush(): Promise<{ sent: number }>;
  readonly anonymousId: string;
  readonly firstTouch: Record<string, string> | null;
  readonly userId: string | null;
}

declare const runhq: RunClient;
export default runhq;
export function createClient(globalObj: typeof globalThis): RunClient;
`);

function indent(src) {
  return src.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
}

console.log('[runhq] SDK built → dist/runhq.js, dist/runhq.esm.js, dist/runhq.d.ts');
