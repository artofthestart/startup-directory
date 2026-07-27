#!/usr/bin/env node
/**
 * Art of the Startup — GitHub directory generator.
 *
 * Reads published rows from Supabase and emits a complete, ready-to-push
 * repo for each public list:
 *
 *   build/ai-tools-directory/   26 AI tools, grouped by category
 *   build/startup-directory/    39 companies, grouped by industry
 *   build/founder-profiles/     29 founders, grouped by industry
 *   build/dot-github/           the org profile README (repo name: .github)
 *
 * Each repo ships:
 *   README.md                 the human/GitHub-rendered list
 *   data/<name>.json          machine-readable, for anyone building on it
 *   docs/index.html           GitHub Pages build; links here are NOT
 *                             nofollow-sanitized the way README links are
 *   .github/workflows/refresh.yml   weekly regeneration
 *
 * No invented data. Every field comes from Supabase or is omitted.
 */

import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  process.exit(1);
}

const SITE = 'https://artofthestart.com';
const ORG = process.env.GITHUB_ORG || 'artofthestart';
const PAGES_HOST = `https://${ORG}.github.io`;
const OUT = new URL('./build/', import.meta.url).pathname;

// Build date is passed in so regenerated output is reproducible in CI.
const BUILD_DATE = process.env.BUILD_DATE || new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------------- fetching */

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/* ------------------------------------------------------------------ helpers */

/** Escape a value for use inside a markdown table cell. */
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * github.com anchor slug for a heading. Matches GitHub's algorithm: lowercase,
 * drop punctuation, then map each remaining space to a single hyphen (runs are
 * NOT collapsed — "Code & IT" becomes "code--it", with two hyphens).
 */
const anchor = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const place = (...parts) => parts.filter(Boolean).join(', ');

/** Fourth table column: an outbound site link, or a plain fallback value. */
const col4 = (r) =>
  r.website ? { text: domainOf(r.website), href: r.website } : r.col4 ?? null;

/** Surname-first sort key for a person, so an A–Z index reads correctly. */
const surnameKey = (full) => {
  const parts = String(full).trim().split(/\s+/);
  return parts.length < 2 ? full : `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`;
};

/**
 * Local mode writes every repo into build/<repo>/. CI mode (--only=<repo>,
 * how the scheduled Action runs it) writes that one repo straight into the
 * checkout root, and skips the files a live repo already owns.
 */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;

async function write(repo, relPath, contents) {
  if (ONLY) {
    if (repo !== ONLY) return;
    // The Action's own files and the licence are committed once, by hand.
    if (relPath.startsWith('.github/') || relPath === 'LICENSE') return;
    const full = join(process.cwd(), relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
    return;
  }
  const full = join(OUT, repo, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

/* ------------------------------------------------------------ shared blocks */

const LICENSE = `Creative Commons Attribution 4.0 International (CC BY 4.0)

You are free to share and adapt this dataset for any purpose, including
commercially, provided you give appropriate credit to Art of the Startup
(https://artofthestart.com) and indicate if changes were made.

Full licence text: https://creativecommons.org/licenses/by/4.0/
`;

const contributing = (kind, submitPath) => `# Contributing

## Adding an entry

Entries in this list are written profiles published on Art of the Startup.
To be included, submit through the site:

**${SITE}${submitPath}**

Our editors read every submission, check it against public sources, and come
back with questions when something is thin. The subscription covers the
editorial work behind the page: research, writing, review, markup, and
hosting. It does not buy placement here, a position in the ordering, or a
favourable write-up.

## Corrections

Facts change. If something in this list is wrong or out of date, open an
issue with the entry name and what needs fixing, and we will correct the
source profile. Corrections are free and always will be.

## Using this data

Everything here is also published as JSON under \`data/\`, under CC BY 4.0.
Mirror it, build on it, or ship it in your own project. Attribution to
Art of the Startup is all we ask.

## A note on the ordering

${kind} are grouped by category and then alphabetically. There is no ranking,
no score, and nothing is weighted by what anyone paid. If you are looking for
"best of" ordering, this list will disappoint you on purpose.
`;

const workflow = (repoName) => `name: Refresh directory

on:
  schedule:
    # Every Monday at 06:00 UTC
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Regenerate from source
        env:
          SUPABASE_URL: \${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: \${{ secrets.SUPABASE_ANON_KEY }}
          GITHUB_ORG: \${{ github.repository_owner }}
        run: node .github/scripts/generate.mjs --only=${repoName}

      - name: Commit if the list changed
        run: |
          git config user.name  "aots-bot"
          git config user.email "bot@artofthestart.com"
          if [ -n "\$(git status --porcelain)" ]; then
            git add -A
            git commit -m "Refresh directory ($(date -u +%Y-%m-%d))"
            git push
          else
            echo "No changes."
          fi
`;

/**
 * GitHub Pages build. This is plain static HTML served from github.io, so
 * unlike README markdown it is not run through GitHub's nofollow sanitiser
 * and the outbound links pass credit.
 */
function pagesHtml({ repo, title, tagline, intro, groups, columns, rows, submitPath, submitLabel, sisters }) {
  const canonical = `${PAGES_HOST}/${repo}/`;
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: title,
    description: tagline,
    url: canonical,
    numberOfItems: rows.length,
    itemListOrder: 'https://schema.org/ItemListUnordered',
    itemListElement: rows.map((r, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: r.profile,
      name: r.name,
    })),
  };

  const sections = groups
    .map(
      (g) => `
    <section id="${anchor(g.name)}">
      <h2>${esc(g.name)} <span class="count">${g.items.length}</span></h2>
      <table>
        <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>
${g.items
  .map(
    (r) => `          <tr>
            <td><a href="${esc(r.profile)}">${esc(r.name)}</a></td>
            <td>${esc(r.blurb)}</td>
            <td>${esc(r.meta)}</td>
            <td>${(() => {
              const c = col4(r);
              if (!c) return '<span class="na">—</span>';
              return c.href
                ? `<a href="${esc(c.href)}" rel="noopener">${esc(c.text)}</a>`
                : esc(c.text);
            })()}</td>
          </tr>`
  )
  .join('\n')}
        </tbody>
      </table>
    </section>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Art of the Startup</title>
<meta name="description" content="${esc(tagline)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(tagline)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(itemList)}</script>
<style>
  :root { --ink:#16161a; --gray:#5b5b63; --rule:#e2ddd4; --cream:#faf7f2; --flame:#ee3b21; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem 4rem; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         color:var(--ink); max-width:1080px; margin-inline:auto; }
  h1 { font-size:2.1rem; margin:0 0 .5rem; letter-spacing:-.02em; }
  .lede { color:var(--gray); max-width:70ch; margin:0 0 1.25rem; }
  .meta { font-size:.85rem; color:var(--gray); border-top:1px solid var(--rule);
          border-bottom:1px solid var(--rule); padding:.6rem 0; margin:0 0 1.75rem; }
  .cta { background:var(--cream); border-left:4px solid var(--flame); padding:1rem 1.2rem;
         border-radius:0 8px 8px 0; margin:0 0 2rem; }
  .cta p { margin:0 0 .6rem; }
  .cta a.btn { display:inline-block; background:var(--flame); color:#fff; text-decoration:none;
               font-weight:700; padding:.55rem 1.1rem; border-radius:6px; }
  nav.toc { margin:0 0 2rem; }
  nav.toc ul { list-style:none; padding:0; margin:.5rem 0 0; display:flex; flex-wrap:wrap; gap:.45rem; }
  nav.toc a { display:inline-block; border:1px solid var(--rule); border-radius:999px;
              padding:.25rem .75rem; font-size:.85rem; text-decoration:none; color:var(--ink); }
  nav.toc a:hover { border-color:var(--ink); }
  h2 { font-size:1.25rem; margin:2rem 0 .6rem; padding-bottom:.3rem; border-bottom:2px solid var(--ink); }
  h2 .count { font-size:.8rem; font-weight:400; color:var(--gray); }
  table { width:100%; border-collapse:collapse; font-size:.92rem; }
  th { text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em;
       color:var(--gray); padding:.4rem .6rem .4rem 0; font-weight:600; }
  td { padding:.55rem .6rem .55rem 0; border-top:1px solid var(--rule); vertical-align:top; }
  td:first-child { font-weight:600; white-space:nowrap; }
  td a { color:#1b3a6b; }
  .na { color:var(--gray); }
  nav.sisters { margin-top:2.5rem; }
  nav.sisters h2 { margin-bottom:.6rem; }
  nav.sisters ul { list-style:none; padding:0; margin:0; }
  nav.sisters li { padding:.3rem 0; }
  footer { margin-top:3rem; padding-top:1.25rem; border-top:1px solid var(--rule);
           font-size:.85rem; color:var(--gray); }
  @media (max-width:700px) { td:nth-child(3), th:nth-child(3) { display:none; } }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="lede">${esc(intro)}</p>
<p class="meta">${rows.length} entries · Updated ${BUILD_DATE} · Source: <a href="${SITE}/">Art of the Startup</a></p>

<div class="cta">
  <p><strong>${esc(submitLabel)}</strong> Our editors write the profile from your answers and you approve it before anything publishes.</p>
  <a class="btn" href="${SITE}${submitPath}">Submit for review</a>
</div>

<nav class="toc" aria-label="Categories">
  <strong>Jump to</strong>
  <ul>${groups.map((g) => `<li><a href="#${anchor(g.name)}">${esc(g.name)} (${g.items.length})</a></li>`).join('')}</ul>
</nav>
${sections}

<nav class="sisters" aria-label="Other directories">
  <h2>Other directories</h2>
  <ul>
    ${(sisters ?? [])
      .map(
        (s) =>
          `<li><a href="${PAGES_HOST}/${s.repo}/">${esc(s.title)}</a> <span class="na">${esc(s.note)}</span></li>`
      )
      .join('\n    ')}
    <li><a href="${SITE}/ai-tools/">AI Tools Directory on artofthestart.com</a></li>
    <li><a href="${SITE}/companies/">Company Directory on artofthestart.com</a></li>
    <li><a href="${SITE}/profiles/">Founder Profiles on artofthestart.com</a></li>
  </ul>
</nav>

<footer>
  <p>Maintained by <a href="${SITE}/">Art of the Startup</a>. Data also available as
  <a href="https://github.com/${ORG}/${repo}/tree/main/data">JSON</a> under CC BY 4.0.
  Corrections welcome via <a href="https://github.com/${ORG}/${repo}/issues">GitHub issues</a>.</p>
</footer>
</body>
</html>
`;
}

/** README.md for a catalog repo. */
function readme({ repo, title, tagline, intro, groups, columns, rows, submitPath, submitLabel, sisters }) {
  const toc = groups
    .map((g) => `- [${g.name}](#${anchor(g.name)}) (${g.items.length})`)
    .join('\n');

  const body = groups
    .map((g) => {
      const head = `| ${columns.join(' | ')} |\n|${columns.map(() => '---').join('|')}|`;
      const lines = g.items
        .map((r) => {
          const c = col4(r);
          const last = !c ? '—' : c.href ? `[${cell(c.text)}](${c.href})` : cell(c.text);
          return `| **[${cell(r.name)}](${r.profile})** | ${cell(r.blurb)} | ${cell(r.meta) || '—'} | ${last} |`;
        })
        .join('\n');
      return `### ${g.name}\n\n${head}\n${lines}\n`;
    })
    .join('\n');

  const sisterLines = sisters
    .map((s) => `- [${s.title}](https://github.com/${ORG}/${s.repo}) — ${s.note}`)
    .join('\n');

  return `# ${title}

${intro}

**${rows.length} entries · updated ${BUILD_DATE}** · Browsable version: **[${PAGES_HOST}/${repo}/](${PAGES_HOST}/${repo}/)**

> ${tagline}

### ${submitLabel}

Submissions go through **[${SITE}${submitPath}](${SITE}${submitPath})**. Our editors read
every one, check it against public sources, and come back with questions when something is
thin. You approve a preview before anything publishes. The fee covers the editorial work,
not placement in this list or a position in the ordering.

---

## Contents

${toc}

---

${body}
---

## How this list works

Every entry links to a written profile on Art of the Startup covering what it is, how it
works, and who it suits. The profiles are drafted by our editorial team from information the
subject supplies and checked against public sources.

Entries are grouped by category, then alphabetical. **There is no ranking and no score.**
Nothing here is ordered by what anyone paid, and we do not publish "best of" positions,
star ratings, or popularity counts.

## Machine-readable data

The same list is published as JSON in [\`data/\`](data/), refreshed on the same schedule.
Licensed **CC BY 4.0** — mirror it, build on it, ship it in your own project. Attribution
to Art of the Startup is all we ask.

## Other lists from Art of the Startup

${sisterLines}

## Corrections

Facts change. Open an [issue](https://github.com/${ORG}/${repo}/issues) with the entry name
and what needs fixing and we will correct the source profile. Corrections are free.

## Licence

Data: [CC BY 4.0](LICENSE). Maintained by [Art of the Startup](${SITE}/).
`;
}

/* --------------------------------------------------------------- repo specs */

function bucket(items, keyFn, fallback, sort) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it) || fallback;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  const out = [...map.entries()].map(([name, list]) => ({
    name,
    items: list.sort((a, b) => (a.sortKey || a.name).localeCompare(b.sortKey || b.name)),
  }));
  return sort === 'alpha'
    ? out.sort((a, b) => a.name.localeCompare(b.name))
    : out.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

/**
 * Group by a semantic key (category / industry), but fall back to an A–Z index
 * when the unclassified bucket swallows more than 40% of the list — a directory
 * whose biggest section is "Other" is worse than no sections at all. Once the
 * missing industry_id values are filled in upstream, the next refresh flips
 * itself back to semantic grouping with no code change.
 */
function group(items, keyFn, fallback = 'Other') {
  const semantic = bucket(items, keyFn, fallback);
  const other = semantic.find((g) => g.name === fallback);
  if (!other || other.items.length / items.length <= 0.4) return semantic;
  return bucket(items, (it) => (it.sortKey || it.name).charAt(0).toUpperCase(), '#', 'alpha');
}

async function build() {
  if (!ONLY) await rm(OUT, { recursive: true, force: true });
  const SELF = await readFile(new URL(import.meta.url), 'utf8');

  /* ---- AI tools ---- */
  const toolCats = await rest('ai_tool_categories?select=id,name,slug&order=sort');
  const catName = new Map(toolCats.map((c) => [c.id, c.name]));
  const toolsRaw = await rest(
    'ai_tools?select=slug,name,website,tagline,category_id,published_at&status=eq.published&order=name'
  );
  const tools = toolsRaw.map((t) => ({
    name: t.name,
    blurb: t.tagline || '',
    meta: catName.get(t.category_id) || 'Other',
    website: t.website || '',
    profile: `${SITE}/ai-tools/${t.slug}/`,
    slug: t.slug,
  }));

  /* ---- companies ---- */
  const industries = await rest('industries?select=id,name,slug');
  const indName = new Map(industries.map((i) => [i.id, i.name]));
  const companiesRaw = await rest(
    'companies?select=slug,name,website,tagline,summary,industry_id,hq_city,hq_state,founded_year&status=eq.published&order=name'
  );
  const companies = companiesRaw.map((c) => ({
    name: c.name,
    blurb: c.tagline || c.summary || '',
    meta: place(c.hq_city, c.hq_state) || (c.founded_year ? `Founded ${c.founded_year}` : ''),
    website: c.website || '',
    profile: `${SITE}/business/${c.slug}/`,
    slug: c.slug,
    industry: indName.get(c.industry_id) || 'Other',
  }));

  /* ---- founders ---- */
  const peopleRaw = await rest(
    'people?select=slug,full_name,headline,role_title,current_company_name,location_city,location_state,industry_id&status=eq.published&order=full_name'
  );
  const people = peopleRaw.map((p) => ({
    name: p.full_name,
    sortKey: surnameKey(p.full_name),
    blurb: p.headline || p.role_title || '',
    meta: place(p.location_city, p.location_state),
    website: '',
    col4: p.current_company_name ? { text: p.current_company_name } : null,
    // People profiles live at /bio/<slug>/; /profiles/ is the index listing.
    profile: `${SITE}/bio/${p.slug}/`,
    slug: p.slug,
    industry: indName.get(p.industry_id) || 'Other',
  }));

  const SPECS = [
    {
      repo: 'ai-tools-directory',
      title: 'AI Tools Directory',
      tagline:
        'Every entry links to a written profile covering what the tool does, its core features, how pricing works, and who it suits.',
      intro:
        'An open, regularly updated directory of AI tools, maintained by the editorial team at Art of the Startup. Each tool has a full written profile rather than a one-line blurb scraped from a homepage.',
      columns: ['Tool', 'What it does', 'Category', 'Website'],
      rows: tools,
      groups: group(tools, (t) => t.meta),
      submitPath: '/ai-tools/submit/',
      submitLabel: 'Get your AI tool listed',
    },
    {
      repo: 'startup-directory',
      title: 'Startup & Company Directory',
      tagline:
        'Written company profiles covering what each one does, where it is based, and how it got started.',
      intro:
        'An open directory of startups and companies profiled by Art of the Startup. Each entry links to a full written profile rather than a database stub.',
      columns: ['Company', 'What it does', 'Based in', 'Website'],
      rows: companies,
      groups: group(companies, (c) => c.industry),
      submitPath: '/submit/company/',
      submitLabel: 'Get your company profiled',
    },
    {
      repo: 'founder-profiles',
      title: 'Founder & Operator Profiles',
      tagline:
        'Written profiles of founders, executives, and builders: background, what they are building, and what they have shipped.',
      intro:
        'An open index of founder and operator profiles published by Art of the Startup. Each entry links to a full written profile.',
      columns: ['Name', 'Known for', 'Based in', 'Company'],
      rows: people,
      groups: group(people, (p) => p.industry),
      submitPath: '/submit/founder/',
      submitLabel: 'Get your founder profile written',
    },
  ];

  for (const spec of SPECS) {
    const sisters = SPECS.filter((s) => s.repo !== spec.repo).map((s) => ({
      repo: s.repo,
      title: s.title,
      note: `${s.rows.length} entries`,
    }));

    await write(spec.repo, 'README.md', readme({ ...spec, sisters }));
    await write(spec.repo, 'CONTRIBUTING.md', contributing(spec.title, spec.submitPath));
    await write(spec.repo, 'LICENSE', LICENSE);
    await write(
      spec.repo,
      `data/${spec.repo}.json`,
      JSON.stringify(
        {
          name: spec.title,
          description: spec.tagline,
          source: SITE,
          licence: 'CC-BY-4.0',
          updated: BUILD_DATE,
          count: spec.rows.length,
          entries: spec.rows.map((r) => ({
            name: r.name,
            description: r.blurb,
            category: r.industry ?? r.meta,
            website: r.website || null,
            profile: r.profile,
          })),
        },
        null,
        2
      ) + '\n'
    );
    await write(spec.repo, 'docs/index.html', pagesHtml({ ...spec, sisters }));
    await write(spec.repo, 'docs/.nojekyll', '');
    await write(
      spec.repo,
      'docs/sitemap.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PAGES_HOST}/${spec.repo}/</loc><lastmod>${BUILD_DATE}</lastmod><changefreq>weekly</changefreq></url>
</urlset>
`
    );
    await write(spec.repo, '.github/workflows/refresh.yml', workflow(spec.repo));
    // The Action re-runs this same file, so each repo carries a copy of it.
    await write(spec.repo, '.github/scripts/generate.mjs', SELF);
    console.log(`${spec.repo.padEnd(22)} ${String(spec.rows.length).padStart(3)} entries, ${spec.groups.length} groups`);
  }

  /* ---- root Pages site (repo name must be "<org>.github.io") ----
     A user/org Pages site is the only place github.io will serve a root
     robots.txt, a sitemap index, and a Search Console verification file, so
     the three project sites are only properly indexable once this exists. */
  const rootRepo = `${ORG}.github.io`;
  await write(
    rootRepo,
    'index.html',
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Art of the Startup — Open Directories</title>
<meta name="description" content="Open, machine-readable versions of the Art of the Startup directories: AI tools, startups and companies, and founder profiles.">
<link rel="canonical" href="${PAGES_HOST}/">
<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Art of the Startup — Open Directories',
      url: `${PAGES_HOST}/`,
      isPartOf: { '@type': 'WebSite', name: 'Art of the Startup', url: `${SITE}/` },
      hasPart: SPECS.map((s) => ({
        '@type': 'ItemList',
        name: s.title,
        url: `${PAGES_HOST}/${s.repo}/`,
        numberOfItems: s.rows.length,
      })),
    })}</script>
<style>
  body { margin:0; padding:3rem 1.25rem 4rem; max-width:52rem; margin-inline:auto;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; color:#16161a; }
  h1 { font-size:2.1rem; margin:0 0 .5rem; letter-spacing:-.02em; }
  p.lede { color:#5b5b63; max-width:65ch; }
  ul { list-style:none; padding:0; }
  li { border-top:1px solid #e2ddd4; padding:1rem 0; }
  li a.t { font-size:1.15rem; font-weight:700; text-decoration:none; color:#16161a; }
  li p { margin:.2rem 0 0; color:#5b5b63; font-size:.93rem; }
  footer { margin-top:2.5rem; border-top:1px solid #e2ddd4; padding-top:1rem; font-size:.85rem; color:#5b5b63; }
</style>
</head>
<body>
<h1>Art of the Startup — open directories</h1>
<p class="lede">Machine-readable versions of the directories we publish at
<a href="${SITE}/">artofthestart.com</a>. Every entry links to a written profile. CC BY 4.0.</p>
<ul>
${SPECS.map(
  (s) => `  <li>
    <a class="t" href="${PAGES_HOST}/${s.repo}/">${esc(s.title)}</a>
    <p>${s.rows.length} entries · ${esc(s.tagline)}</p>
  </li>`
).join('\n')}
</ul>
<footer>
  <p>Source: <a href="${SITE}/">Art of the Startup</a> ·
  <a href="https://github.com/${ORG}">GitHub</a> ·
  <a href="${SITE}/submit/">Get listed</a></p>
</footer>
</body>
</html>
`
  );
  await write(
    rootRepo,
    'robots.txt',
    `User-agent: *
Allow: /

Sitemap: ${PAGES_HOST}/sitemap.xml
`
  );
  await write(
    rootRepo,
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${PAGES_HOST}/sitemap-root.xml</loc><lastmod>${BUILD_DATE}</lastmod></sitemap>
${SPECS.map(
  (s) => `  <sitemap><loc>${PAGES_HOST}/${s.repo}/sitemap.xml</loc><lastmod>${BUILD_DATE}</lastmod></sitemap>`
).join('\n')}
</sitemapindex>
`
  );
  await write(
    rootRepo,
    'sitemap-root.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PAGES_HOST}/</loc><lastmod>${BUILD_DATE}</lastmod><changefreq>weekly</changefreq></url>
</urlset>
`
  );
  await write(rootRepo, '.nojekyll', '');
  if (!ONLY) console.log(`${rootRepo.padEnd(22)} root Pages site + sitemap index`);

  /* ---- org profile README (repo name must be ".github") ---- */
  const profile = `# Art of the Startup

Business intelligence for people building in the AI era — reporting, guides, and written
directories at **[artofthestart.com](${SITE}/)**.

We publish open, machine-readable versions of our directories here. Each list is generated
from the same source as the site and refreshed weekly.

## Directories

| List | Entries | Browse | Data |
|---|---|---|---|
${SPECS.map(
  (s) =>
    `| **[${s.title}](https://github.com/${ORG}/${s.repo})** | ${s.rows.length} | [${PAGES_HOST}/${s.repo}/](${PAGES_HOST}/${s.repo}/) | [JSON](https://github.com/${ORG}/${s.repo}/tree/main/data) |`
).join('\n')}

## Using our data

Everything published here is **CC BY 4.0**. Mirror it, build on it, or ship it in your own
project — attribution to Art of the Startup is all we ask.

## Getting listed

Profiles are written by our editorial team from information the subject supplies, checked
against public sources, and approved by the subject before publication. Start at
**[${SITE}/submit/](${SITE}/submit/)**.

There is no ranking in any of these lists, no score, and no ordering by what anyone paid.

## Corrections

Open an issue on the relevant repo. Corrections are free and always will be.
`;
  await write('dot-github', 'profile/README.md', profile);
  console.log('dot-github            org profile README');

  console.log(`\nTotal: ${tools.length + companies.length + people.length} entries across ${SPECS.length} repos.`);
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
