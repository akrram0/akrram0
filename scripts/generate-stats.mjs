#!/usr/bin/env node
/**
 * Generate GitHub stats cards for the profile README.
 *
 *   node scripts/generate-stats.mjs            # live data (needs GITHUB_TOKEN)
 *   node scripts/generate-stats.mjs --mock     # deterministic sample data, no network
 *
 * No dependencies. Writes assets/stats-light.svg and assets/stats-dark.svg.
 */

import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOGIN = 'akrram0';
const API_URL = 'https://api.github.com/graphql';
const USER_AGENT = 'akrram0-profile-stats';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// Fixed anchor so mock output is byte-identical forever, not just within a day.
const MOCK_TODAY = '2026-10-23';
const MOCK_TOTAL = 555;

const THEMES = {
  light: {
    bg: '#faf7f0',
    ink: '#111',
    body: '#333',
    muted: '#666',
    border: 'rgba(0,0,0,.10)',
    green: '#2f7d32',
    empty: '#ebe8e1',
  },
  dark: {
    bg: '#0d1117',
    ink: '#e6edf3',
    body: '#c9d1d9',
    muted: '#8b949e',
    border: 'rgba(255,255,255,.10)',
    green: '#3fb950',
    empty: '#24292f',
  },
};

const LEVEL_ALPHAS = [0.25, 0.48, 0.72, 1];

// ---------------------------------------------------------------------------
// args / errors
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { mock: false, login: DEFAULT_LOGIN, token: '' };
  for (const arg of argv) {
    if (arg === '--mock') opts.mock = true;
    else if (arg.startsWith('--token=')) opts.token = arg.slice('--token='.length).trim();
    else if (arg.startsWith('--user=')) {
      const login = arg.slice('--user='.length).trim();
      if (!login) fail('--user= requires a value');
      opts.login = login;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/generate-stats.mjs [--mock] [--token=...] [--user=akrram0]',
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GitHub GraphQL
// ---------------------------------------------------------------------------

const USER_QUERY = `
  query($login: String!, $cursor: String) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              weekday
            }
          }
        }
      }
      repositories(
        first: 100
        after: $cursor
        ownerAffiliations: OWNER
        privacy: PUBLIC
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          stargazerCount
          isFork
          primaryLanguage { name }
        }
      }
    }
  }
`;

async function gql(token, variables) {
  const body = JSON.stringify({ query: USER_QUERY, variables });
  const headers = {
    Authorization: `bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL, { method: 'POST', headers, body });
      const text = await res.text();
      if (!res.ok) {
        lastError = new Error(
          `GitHub API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`,
        );
        if (res.status < 500) throw lastError;
      } else {
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`GitHub API returned invalid JSON: ${text.slice(0, 200)}`);
        }
        if (Array.isArray(json.errors) && json.errors.length) {
          throw new Error(
            `GitHub GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`,
          );
        }
        if (!json.data) throw new Error('GitHub API returned no data.');
        return json.data;
      }
    } catch (err) {
      lastError = err;
      // GraphQL / auth / validation errors are not worth retrying.
      if (!/GitHub API 5\d\d|fetch failed|network|EAI_AGAIN|ETIMEDOUT/i.test(err.message)) {
        throw err;
      }
    }
    if (attempt < 2) await sleep(1500 * (attempt + 1));
  }
  throw lastError;
}

async function fetchStats(login, token) {
  let cursor = null;
  let calendar = null;
  let repoTotal = 0;
  const repos = [];

  for (let page = 0; page < 20; page++) {
    const data = await gql(token, { login, cursor });
    const user = data.user;
    if (!user) throw new Error(`GitHub user "${login}" was not found.`);

    if (!calendar) calendar = user.contributionsCollection?.contributionCalendar;
    const conn = user.repositories;
    if (!conn || !Array.isArray(conn.nodes)) {
      throw new Error('GitHub API response is missing repositories.');
    }
    repoTotal = conn.totalCount;
    repos.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
    if (page === 19) throw new Error('repository pagination exceeded 20 pages.');
  }

  const weeks = normalizeCalendar(calendar);
  const totalContributions = Number(calendar.totalContributions);
  if (!Number.isFinite(totalContributions)) {
    throw new Error('contributionCalendar.totalContributions is not a number.');
  }

  const stars = repos.reduce(
    (sum, r) => sum + (r.isFork ? 0 : Number(r.stargazerCount) || 0),
    0,
  );
  const languageCounts = new Map();
  for (const repo of repos) {
    if (repo.isFork) continue;
    const name = repo.primaryLanguage?.name || 'other';
    languageCounts.set(name, (languageCounts.get(name) || 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const today = utcToday();
  const { current, longest } = computeStreaks(weeks, today);

  return {
    login,
    totalContributions,
    weeks,
    repos: Number(repoTotal) || repos.length,
    stars,
    languages,
    currentStreak: current,
    longestStreak: longest,
  };
}

function normalizeCalendar(calendar) {
  if (!calendar || !Array.isArray(calendar.weeks) || calendar.weeks.length === 0) {
    throw new Error('contributionCalendar.weeks is missing or empty.');
  }
  const weeks = calendar.weeks.map((week, wi) => {
    const raw = week && week.contributionDays;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) {
      throw new Error(`contribution calendar week ${wi} has ${raw?.length ?? 0} days.`);
    }
    const days = raw.map((day, di) => {
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) {
        throw new Error(`invalid contribution day date at week ${wi}, day ${di}.`);
      }
      const count = Number(day.contributionCount);
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`invalid contribution count for ${day.date}.`);
      }
      return {
        date: day.date,
        count,
        weekday: Number.isInteger(day.weekday) ? day.weekday : di,
      };
    });
    // The in-progress week is returned up to today only; pad the rest with zeros.
    while (days.length < 7) {
      const last = days[days.length - 1];
      days.push({ date: addDays(last.date, 1), count: 0, weekday: days.length });
    }
    return { days };
  });
  return weeks;
}

// ---------------------------------------------------------------------------
// streaks
// ---------------------------------------------------------------------------

function computeStreaks(weeks, today) {
  const days = weeks
    .flatMap((week) => week.days)
    .filter((day) => day.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  let longest = 0;
  let run = 0;
  for (const day of days) {
    if (day.count > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  let i = days.length - 1;
  // A quiet "today" does not break the streak until the day is over.
  if (i >= 0 && days[i].date === today && days[i].count === 0) i -= 1;
  let current = 0;
  while (i >= 0 && days[i].count > 0) {
    current += 1;
    i -= 1;
  }

  return { current, longest };
}

// ---------------------------------------------------------------------------
// mock data (deterministic)
// ---------------------------------------------------------------------------

function mockStats(login) {
  const today = MOCK_TODAY;
  const start = addDays(today, -weekdayOf(today) - 52 * 7);
  const rng = mulberry32(0x612);

  const flat = [];
  for (let w = 0; w < 53; w++) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      flat.push({
        date,
        weekday: d,
        count: date > today ? 0 : rollContribution(rng, d),
      });
    }
  }

  // Pin a 15-day current streak (and a gap the day before it) before scaling.
  const past = flat.filter((day) => day.date <= today);
  const n = past.length;
  for (let i = Math.max(0, n - 15); i < n; i++) {
    past[i].count = Math.max(1, past[i].count);
  }
  if (n >= 16) past[n - 16].count = 0;

  const sum = past.reduce((total, day) => total + day.count, 0);
  if (sum === 0) throw new Error('mock generator produced an empty year.');
  const scale = MOCK_TOTAL / sum;
  for (const day of past) {
    day.count = day.count === 0 ? 0 : Math.max(1, Math.round(day.count * scale));
  }

  let diff = MOCK_TOTAL - past.reduce((total, day) => total + day.count, 0);
  const gapIndex = n - 16;
  let cursor = past.length - 1;
  let guard = 0;
  while (diff !== 0 && guard++ < 10000) {
    const day = past[cursor];
    if (cursor !== gapIndex) {
      if (diff > 0) {
        if (day.count < 14) {
          day.count += 1;
          diff -= 1;
        }
      } else if (day.count > 1) {
        day.count -= 1;
        diff += 1;
      }
    }
    cursor -= 1;
    if (cursor < 0) cursor = past.length - 1;
  }
  if (diff !== 0) throw new Error('mock generator could not reach the target total.');

  const weeks = [];
  for (let w = 0; w < 53; w++) {
    weeks.push({ days: flat.slice(w * 7, w * 7 + 7) });
  }

  const totalContributions = past.reduce((total, day) => total + day.count, 0);
  if (totalContributions !== MOCK_TOTAL) {
    throw new Error(`mock total drifted: ${totalContributions}`);
  }
  const { current, longest } = computeStreaks(weeks, today);

  return {
    login,
    totalContributions,
    weeks,
    repos: 7,
    stars: 2,
    languages: [
      { name: 'typescript', count: 4 },
      { name: 'javascript', count: 2 },
      { name: 'python', count: 1 },
      { name: 'shell', count: 1 },
    ],
    currentStreak: current,
    longestStreak: longest,
  };
}

function rollContribution(rng, weekday) {
  const r = rng();
  const weekend = weekday === 0 || weekday === 6;
  if (r < (weekend ? 0.3 : 0.14)) return 0;
  if (r < 0.62) return 1;
  if (r < 0.84) return 2;
  if (r < 0.94) return 4;
  if (r < 0.99) return 6;
  return 12;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

function parseDate(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDays(date, days) {
  return isoDate(parseDate(date) + days * 86400000);
}

function weekdayOf(date) {
  return new Date(parseDate(date)).getUTCDay();
}

function utcToday() {
  return isoDate(Date.now());
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// ---------------------------------------------------------------------------
// svg rendering
// ---------------------------------------------------------------------------

function renderCard(stats, themeName) {
  const t = THEMES[themeName];
  const levels = LEVEL_ALPHAS.map((alpha) => mix(t.bg, t.green, alpha));
  const totalLabel = esc(formatNumber(stats.totalContributions));
  const login = esc(stats.login);

  const cells = [];
  const heatX = 72;
  const heatY = 236;
  const cellSize = 14;
  const step = 20;

  stats.weeks.forEach((week, wi) => {
    week.days.forEach((day, di) => {
      const fill = day.count > 0 ? levels[levelIndex(day.count)] : t.empty;
      const x = heatX + wi * step;
      const y = heatY + di * step;
      cells.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${fill}"/>`,
      );
    });
  });

  const monthLabels = [];
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let lastMonth = -1;
  let lastLabelX = -1000;
  stats.weeks.forEach((week, wi) => {
    const first = week.days[0];
    if (!first) return;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (month === lastMonth) return;
    lastMonth = month;
    const x = heatX + wi * step;
    if (x - lastLabelX < 34 || x + 34 > 1200 - 72) return;
    monthLabels.push(
      `<text x="${x}" y="226" font-size="12" fill="${t.muted}" letter-spacing="0.08em">${monthNames[month]}</text>`,
    );
    lastLabelX = x;
  });

  const description = `${stats.totalContributions} contributions in the last 12 months, ` +
    `${stats.repos} public repositories, ${stats.stars} stars, ` +
    `${stats.currentStreak} day current streak.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400" role="img" aria-labelledby="title desc" font-family="'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace">
  <title id="title">GitHub activity for ${login}</title>
  <desc id="desc">${esc(description)}</desc>
  <rect x="0" y="0" width="1200" height="400" fill="${t.bg}"/>
  <text x="72" y="92" font-size="20" fill="${t.muted}" letter-spacing="1.2">// activity</text>
  <text x="1128" y="92" text-anchor="end" font-size="17" fill="${t.muted}" letter-spacing="0.8">last 12 months</text>
  <line x1="72" y1="112" x2="1128" y2="112" stroke="${t.border}" stroke-width="1"/>
  <text x="72" y="170" font-size="46" font-weight="600" fill="${t.ink}" letter-spacing="-1.5">${totalLabel}</text>
  <text x="72" y="194" font-size="16" fill="${t.muted}" letter-spacing="1.2">contributions</text>
  <text x="1128" y="170" text-anchor="end" font-size="15" fill="${t.muted}"><tspan font-size="22" font-weight="600" fill="${t.ink}">${esc(formatNumber(stats.repos))}</tspan> repos<tspan dx="24" font-size="22" font-weight="600" fill="${t.ink}">${esc(formatNumber(stats.stars))}</tspan> stars<tspan dx="24" font-size="22" font-weight="600" fill="${t.ink}">${esc(formatNumber(stats.currentStreak))}</tspan> day streak</text>
  ${monthLabels.join('\n  ')}
  ${cells.join('\n  ')}
</svg>
`;
}

function levelIndex(count) {
  if (count >= 7) return 3;
  if (count >= 5) return 2;
  if (count >= 3) return 1;
  return 0;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mix(from, to, alpha) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const channel = (x, y) => Math.round(x + (y - x) * alpha);
  return rgbToHex(channel(a[0], b[0]), channel(a[1], b[1]), channel(a[2], b[2]));
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

function assertSafeSvg(name, content) {
  if (/<script\b/i.test(content)) throw new Error(`${name} contains a <script> element.`);
  if (/\shref\s*=/i.test(content)) throw new Error(`${name} contains an href attribute.`);
  if (/\{\{/.test(content)) throw new Error(`${name} contains an unresolved placeholder.`);
  if (/url\(/i.test(content)) throw new Error(`${name} references an external url().`);
}

function writeCards(stats) {
  mkdirSync(OUT_DIR, { recursive: true });

  const outputs = ['light', 'dark'].map((theme) => ({
    name: `stats-${theme}.svg`,
    content: renderCard(stats, theme),
  }));
  for (const output of outputs) assertSafeSvg(output.name, output.content);

  const staged = outputs.map((output) => {
    const target = join(OUT_DIR, output.name);
    const temp = join(OUT_DIR, `.${output.name}.tmp`);
    writeFileSync(temp, output.content, 'utf8');
    return { temp, target };
  });
  for (const file of staged) renameSync(file.temp, file.target);

  return outputs.map((output) => join(OUT_DIR, output.name));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let stats;
  if (opts.mock) {
    stats = mockStats(opts.login);
    console.log(`mock data for @${opts.login} (no network)`);
  } else {
    const token = opts.token || (process.env.GITHUB_TOKEN || '').trim();
    if (!token) {
      fail('missing GitHub token: pass --token=... or set GITHUB_TOKEN (or use --mock).');
    }
    stats = await fetchStats(opts.login, token);
  }

  if (!Number.isFinite(stats.totalContributions) || stats.totalContributions <= 0) {
    throw new Error('refusing to render empty stats: totalContributions is zero.');
  }

  const files = writeCards(stats);
  for (const file of files) console.log(`wrote ${file}`);
  console.log(
    `@${stats.login}: ${stats.totalContributions} contributions, ${stats.repos} repos, ` +
      `${stats.stars} stars, streak ${stats.currentStreak} (longest ${stats.longestStreak}), ` +
      `${stats.weeks.length} weeks`,
  );
}

main().catch((err) => {
  console.error(`error: ${err?.message || err}`);
  // Let the runtime close any fetch sockets cleanly before exiting non-zero.
  process.exitCode = 1;
});
