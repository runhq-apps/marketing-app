/**
 * A project's setup, as a file rather than a sequence of clicks.
 *
 * Everything the dashboard can be told — the project, its funnel, the channels it
 * spends on and the rules that sort traffic into them — is ordinary data, and the UI
 * is one way of entering it. This is the other way: a spec under `projects/`, applied
 * with `npm run provision projects/<name>.js`.
 *
 * The reason to want that is not typing speed. A funnel is a claim about how this
 * particular business acquires people, and a channel's match rules are a claim about
 * how its ad URLs are tagged; both are read by anyone trying to understand a number on
 * the dashboard, both drift, and neither survives being held only in a database on one
 * machine. In a file they are reviewable, diffable, and re-appliable against a fresh
 * database — which is also what makes a dashboard that was set up six months ago
 * something a new person can be handed.
 *
 * Applying is idempotent and additive. The project is matched by slug, the stages are
 * brought to exactly what the spec says, and a channel is created only if one of that
 * provider and name is not already there; an existing channel keeps its credentials,
 * its spend history and its sync state, and only has its match rules and checklist
 * refreshed. Nothing is ever deleted — a channel dropped from a spec is left alone,
 * because deleting it would delete the spend recorded against it.
 *
 *   npm run provision projects/rooftop.mjs          apply it
 *   npm run provision projects/rooftop.mjs --dry    say what it would do, change nothing
 *
 * A spec is an ES module with a default export (`.mjs`, so it needs no `type` field in
 * a package.json above it), or a `.json` file, shaped:
 *
 *   {
 *     project:  { name, website, currency, target_cac },
 *     stages:   [{ key, label, is_conversion }],     // in funnel order
 *     channels: [{ provider, name, auth_type, config }],
 *   }
 */
import './env.js';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import * as store from './store.js';
import { getProvider, PROVIDERS } from './connectors/index.js';
import { bad } from './http.js';

/**
 * Apply a spec. Returns what it did rather than printing it, so the CLI below and a
 * test can both see the same answer.
 */
export function provision(spec, { dryRun = false } = {}) {
  const wanted = spec?.project;
  if (!wanted?.name) throw bad('a spec needs project.name');

  // The slug is derived, never given: it is how a re-apply finds the project it made
  // last time, and a spec that could set it independently of the name could quietly
  // create a second project on the day someone renamed one.
  const slug = slugify(wanted.name);
  const existing = store.getProject(slug);
  const plan = { slug, created: !existing, stages: [], channels: [] };

  // Validate the whole spec before writing any of it: a spec that names a provider that
  // does not exist should fail with nothing half-applied.
  for (const ch of spec.channels ?? []) {
    if (!ch?.provider) throw bad('every channel needs a provider');
    if (!getProvider(ch.provider)) {
      throw bad(`unknown provider "${ch.provider}"`, { known: Object.keys(PROVIDERS) });
    }
  }
  if (spec.stages?.length && !spec.stages.some((s) => s.is_conversion)) {
    throw bad('one stage must be the conversion — without it nothing is ever a customer');
  }

  if (dryRun) {
    plan.stages = (spec.stages ?? []).map((s) => s.key ?? slugify(s.label));
    plan.channels = (spec.channels ?? []).map((ch) => ({
      name: ch.name || getProvider(ch.provider).label,
      provider: ch.provider,
      created: !existing || !findChannel(existing.id, ch),
    }));
    plan.project = existing ?? { ...wanted, slug, sdk_key: '(assigned on creation)' };
    return plan;
  }

  const project = existing
    ? store.updateProject(existing.id, pick(wanted, ['name', 'website', 'currency', 'target_cac']))
    : store.createProject({ ...wanted, stages: spec.stages });

  // createProject already wrote the stages from the spec; an existing project has its
  // own, which the spec is the authority on.
  if (existing && spec.stages?.length) store.setStages(project.id, spec.stages);
  plan.stages = store.projectStages(project.id).map((s) => s.key);

  for (const ch of spec.channels ?? []) {
    const name = ch.name || getProvider(ch.provider).label;
    const found = findChannel(project.id, ch);
    if (found) {
      // Config only. Credentials, spend and sync history belong to the running system,
      // not to the spec, and a re-apply must not disturb them.
      if (ch.config) store.updateChannel(found.id, { config: { ...store.channelConfig(found), ...ch.config } });
      plan.channels.push({ name, provider: ch.provider, created: false });
    } else {
      store.createChannel(project.id, { ...ch, name });
      plan.channels.push({ name, provider: ch.provider, created: true });
    }
  }

  plan.project = store.getProject(project.id);
  return plan;
}

const findChannel = (projectId, ch) => store.listChannels(projectId).find((c) =>
  c.provider === ch.provider && c.name === (ch.name || getProvider(ch.provider).label));

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/** A spec is a module with a default export, or plain JSON. */
export async function loadSpec(file) {
  const path = resolve(file);
  if (extname(path) === '.json') return JSON.parse(await readFile(path, 'utf8'));
  const mod = await import(pathToFileURL(path).href);
  const spec = mod.default ?? mod.spec;
  if (!spec) throw bad(`${file} exports no default spec`);
  return spec;
}

/* ------------------------------------------------------------------- CLI */

async function main(argv) {
  const dryRun = argv.includes('--dry') || argv.includes('--dry-run');
  const file = argv.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('usage: npm run provision <spec.mjs|spec.json> [--dry]');
    process.exitCode = 2;
    return;
  }

  const plan = provision(await loadSpec(file), { dryRun });
  const p = plan.project;
  const host = (process.env.RUNHQ_PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');

  console.log(`\n${dryRun ? 'Would apply' : 'Applied'} ${file}\n`);
  console.log(`  project   ${p.name} (${plan.slug})${plan.created ? '  — created' : '  — already existed, updated'}`);
  if (p.website) console.log(`  website   ${p.website}`);
  console.log(`  funnel    ${plan.stages.join(' → ')}`);
  for (const c of plan.channels) {
    console.log(`  channel   ${c.name}  (${c.provider})${c.created ? '  — created' : '  — already there'}`);
  }
  if (!plan.channels.length) console.log('  channel   none in the spec — add them as money starts going out');

  if (dryRun) return;

  console.log(`\n  SDK key   ${p.sdk_key}\n`);
  console.log('  Install it on the site and in the product:\n');
  console.log(`    <script async src="${host}/sdk.js" data-runhq-key="${p.sdk_key}"></script>\n`);
  console.log('  Then, in this order, because each one is worth nothing without the last:');
  console.log('    1. identify() people the moment the product knows who they are');
  console.log('    2. connect the revenue processor on the Revenue tab');
  console.log('    3. enter or connect what each channel actually costs on the Channels tab');
  console.log('    4. run the Audit tab and fix what it names\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[runhq] provision failed: ${e.message}`);
    if (e.extra) console.error(e.extra);
    process.exitCode = 1;
  });
}
