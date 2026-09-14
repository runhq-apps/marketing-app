/**
 * Provision a project from a declarative spec file.
 *
 * Clicking a project together in the UI is fine once. It is not fine as the record of
 * how a project is set up: nobody can review it, nothing reproduces it on a second
 * install, and a channel's UTM rules — the thing attribution actually turns on — end up
 * known only to whoever typed them. A spec file is reviewable, diffable and re-runnable.
 *
 *   node packages/server/scripts/provision.mjs projects/arrr-fun.json
 *
 * It talks to the HTTP API rather than the database, so the same command provisions a
 * local install and a deployed one, and the server's own hooks (the first audit run,
 * credential sealing) fire exactly as they do for the UI.
 *
 * Re-running is the point: the project is matched by slug and reconciled in place, so a
 * spec edit is applied by running it again. It never deletes — a channel that has left
 * the spec is reported, not removed, because removing one takes its spend history with it.
 */

const usage = `Usage: provision.mjs <spec.json> [--host URL] [--token TOKEN] [--dry-run]

  --host    Run server to provision against (default $RUNHQ_PUBLIC_URL or http://localhost:4000)
  --token   Admin token, if the server sets RUNHQ_ADMIN_TOKEN (default $RUNHQ_ADMIN_TOKEN)
  --dry-run Report what would change; write nothing.`;

/**
 * Apply `spec` to the Run install at `host`. Returns the project as it now stands plus
 * a list of what changed, so the caller can print it and a test can assert on it.
 */
export async function provision(spec, { host, token = null, dryRun = false, fetchImpl = fetch } = {}) {
  const base = String(host).replace(/\/$/, '');
  const changes = [];

  const call = async (path, init = {}) => {
    const res = await fetchImpl(base + path, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${body?.error ?? text}`);
    return body;
  };
  const send = (method, path, body) => call(path, { method, body: JSON.stringify(body) });

  if (!spec?.project?.name) throw new Error('spec.project.name is required');
  const wanted = spec.project;

  // Match on slug, which is derived from the name and is what the API itself resolves by.
  // Matching on name would re-create the project the moment somebody fixed its casing.
  const slug = wanted.slug ?? slugify(wanted.name);
  const existing = (await call('/api/projects?archived=1')).find((p) => p.slug === slug) ?? null;

  let project;
  if (!existing) {
    changes.push(`create project ${slug}`);
    project = dryRun
      ? { ...wanted, slug, id: '(dry-run)', sdk_key: '(dry-run)' }
      : await send('POST', '/api/projects', { ...wanted, stages: spec.stages });
  } else {
    project = existing;
    const patch = {};
    for (const k of ['name', 'website', 'currency', 'target_cac']) {
      if (k in wanted && wanted[k] !== existing[k]) patch[k] = wanted[k];
    }
    if (existing.archived) patch.archived = 0;
    if (Object.keys(patch).length) {
      changes.push(`update project ${slug}: ${Object.keys(patch).join(', ')}`);
      if (!dryRun) project = await send('PATCH', `/api/projects/${existing.id}`, patch);
    }
  }

  // Stages are set outright rather than merged: the spec's funnel IS the funnel, and a
  // half-merged one would silently keep a stage somebody deliberately removed. Skipped
  // when they already match, so a no-op run does not rewrite every lead's stage ordering.
  if (spec.stages?.length && !(dryRun && !existing)) {
    // Read them back rather than trusting the create response, which does not carry
    // stages — assuming it did made every fresh project re-post the funnel it just got.
    const current = await call(`/api/projects/${project.id}/stages`);
    if (!sameStages(current, spec.stages)) {
      changes.push(`set ${spec.stages.length} funnel stages`);
      if (!dryRun) await send('POST', `/api/projects/${project.id}/stages`, { stages: spec.stages });
    }
  }

  if (spec.channels?.length && !(dryRun && !existing)) {
    const current = existing ? await call(`/api/projects/${project.id}/channels`) : [];
    for (const want of spec.channels) {
      const match = current.find((c) => c.name === want.name);
      if (!match) {
        changes.push(`create channel "${want.name}" (${want.provider})`);
        if (!dryRun) await send('POST', `/api/projects/${project.id}/channels`, want);
      } else if (JSON.stringify(match.config ?? {}) !== JSON.stringify(want.config ?? {})) {
        changes.push(`update channel "${want.name}" config`);
        if (!dryRun) await send('PATCH', `/api/channels/${match.id}`, { config: want.config ?? {} });
      }
    }
    for (const c of current) {
      // Deleting cascades to spend_daily. A channel dropped from the spec is a decision
      // for a human with the history in front of them, not a side effect of a re-run.
      if (!spec.channels.some((w) => w.name === c.name)) changes.push(`(left alone) channel "${c.name}" is not in the spec`);
    }
  }

  const full = dryRun && !existing ? project : await call(`/api/projects/${project.id}`);
  return { project: full, changes, created: !existing };
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';

/**
 * Compare against what the SERVER will store, not against what the spec literally says:
 * it slugifies every key on the way in (`signed_in` becomes `signed-in`), so comparing
 * raw spec keys makes a settled project look permanently out of date and rewrites the
 * funnel on every run.
 */
function sameStages(current, wanted) {
  if (current.length !== wanted.length) return false;
  return current.every((c, i) => c.key === slugify(wanted[i].key ?? wanted[i].label)
    && c.label === (wanted[i].label ?? wanted[i].key)
    && !!c.is_conversion === !!wanted[i].is_conversion);
}

/** The install snippet, with this project's real key in it — the thing you actually go and paste. */
export function installSnippet(project, host) {
  return `<script async src="${host.replace(/\/$/, '')}/sdk.js" data-runhq-key="${project.sdk_key}"></script>`;
}

/* ------------------------------------------------------------------------ cli */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const VALUED = new Set(['--host', '--token']);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  // The spec file is the one bare word that is not itself the value of --host/--token.
  const file = args.find((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]));

  if (!file || args.includes('--help')) { console.log(usage); process.exit(file ? 0 : 1); }

  const host = flag('host', process.env.RUNHQ_PUBLIC_URL || 'http://localhost:4000');
  const token = flag('token', process.env.RUNHQ_ADMIN_TOKEN || null);
  const dryRun = args.includes('--dry-run');

  const spec = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));

  let result;
  try {
    result = await provision(spec, { host, token, dryRun });
  } catch (e) {
    console.error(`[provision] ${e.message}`);
    if (/fetch failed/i.test(e.message)) console.error(`[provision] is the server running? ${host}`);
    process.exit(1);
  }

  console.log(`[provision] ${dryRun ? 'would apply' : 'applied'} ${file} → ${host}`);
  for (const c of result.changes) console.log(`  · ${c}`);
  if (!result.changes.length) console.log('  · already up to date');

  if (!dryRun) {
    console.log(`\n  project   ${result.project.name} (${result.project.slug})`);
    console.log(`  dashboard ${host.replace(/\/$/, '')}/projects/${result.project.slug}`);
    console.log(`  sdk key   ${result.project.sdk_key}`);
    console.log(`\n  ${installSnippet(result.project, host)}\n`);
  }
}
