#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const bundleRoot = path.join(repoRoot, 'deploy', 'pages_bundle');
const outputDir = path.join(repoRoot, 'test-results');

const EXCLUDED_DIRS = new Set(['assets/vendor', 'node_modules', '.git']);
const TARGET_EXTS = new Set(['.html', '.css', '.js']);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(bundleRoot, full).replace(/\\/g, '/');
      if ([...EXCLUDED_DIRS].some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      files.push(...walk(full));
      continue;
    }
    if (TARGET_EXTS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

function countMatches(text, regex) {
  const match = text.match(regex);
  return match ? match.length : 0;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(score) {
  if (score >= 90) return 'production-grade';
  if (score >= 75) return 'needs polish';
  return 'needs structural cleanup';
}

function allowedInitTargets(rel) {
  const base = path.basename(rel);
  const baseNoExt = base.replace(/\.html$/i, '');
  const allowed = new Set([rel, base, baseNoExt]);

  if (rel.endsWith('/index.html')) {
    const folder = path.basename(path.dirname(rel));
    allowed.add(folder);
  }

  const aliases = {
    'project-co-dashboard.html': ['dashboard'],
    'my-tasks.html': ['my-tasks'],
    'my-tasks/index.html': ['my-tasks'],
    'project-co/dashboard/index.html': ['dashboard'],
    'project-co/meeting-mom/index.html': ['meeting-mom'],
  };

  for (const alias of aliases[rel] || []) {
    allowed.add(alias);
  }

  return allowed;
}

function shorten(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function analyzeHtml(filePath, rawText) {
  const rel = path.relative(bundleRoot, filePath).replace(/\\/g, '/');
  const issues = [];
  let score = 100;

  const deduct = (points, message) => {
    score = Math.max(0, score - points);
    issues.push(message);
  };

  const lower = rawText.toLowerCase();
  const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const buttons = [...rawText.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  const images = [...rawText.matchAll(/<img\b([^>]*)>/gi)];
  const initCalls = [...rawText.matchAll(/BT\.initApp\('([^']+)'\s*,\s*'([^']*)'/g)];

  if (!/<!doctype html>/i.test(rawText)) deduct(20, 'Missing HTML doctype');
  if (!/<html\b[^>]*\blang\s*=/i.test(rawText)) deduct(12, 'Missing html lang attribute');
  if (!/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(rawText)) deduct(12, 'Missing viewport meta tag');
  if (!titleMatch || !stripTags(titleMatch[1])) deduct(15, 'Missing page title');

  const buttonNoType = buttons.filter(([attrs]) => !/\btype\s*=\s*["'][^"']+["']/i.test(attrs)).length;
  if (buttonNoType > 0) deduct(Math.min(10, buttonNoType * 2), `${buttonNoType} button(s) missing explicit type`);

  const iconOnlyButtons = buttons.filter(([attrs, innerHtml]) => {
    const text = stripTags(innerHtml);
    const hasName = /\baria-label\s*=|\baria-labelledby\s*=|\btitle\s*=/i.test(attrs);
    const hasVisibleText = /[A-Za-z0-9ก-๙]/.test(text);
    return !hasVisibleText && !hasName;
  }).length;
  if (iconOnlyButtons > 0) deduct(Math.min(16, iconOnlyButtons * 4), `${iconOnlyButtons} icon-only button(s) lack an accessible name`);

  const imagesWithoutAlt = images.filter(([attrs]) => !/\balt\s*=/i.test(attrs)).length;
  if (imagesWithoutAlt > 0) deduct(Math.min(12, imagesWithoutAlt * 3), `${imagesWithoutAlt} image(s) missing alt text`);

  const outlineNoneCount = countMatches(lower, /outline\s*:\s*none/g);
  const hasFocusVisible = /:focus-visible\b/i.test(lower);
  if (outlineNoneCount > 0 && !hasFocusVisible) {
    deduct(8, 'Focus outline is suppressed without a :focus-visible replacement');
  }

  const mojibakeHits = countMatches(rawText, /[ÃÂâ€™â€œâ€�ï»¿�]/g);
  if (mojibakeHits > 0) {
    deduct(Math.min(20, mojibakeHits * 2), `${mojibakeHits} mojibake marker(s) detected`);
  }

  const badFontUrls = countMatches(rawText, /Sarabun:wght\?/g);
  if (badFontUrls > 0) {
    deduct(Math.min(10, badFontUrls * 5), `${badFontUrls} malformed Google Fonts URL(s) detected`);
  }

  for (const [, callArg] of initCalls) {
    if (/^deploy\/pages_bundle\//i.test(callArg)) {
      deduct(8, `BT.initApp uses a bundle path instead of a page key: ${callArg}`);
      continue;
    }
    const allowed = allowedInitTargets(rel);
    if (!allowed.has(callArg)) {
      deduct(4, `BT.initApp page key looks inconsistent: ${callArg}`);
    }
  }

  const inlineStyleCount = countMatches(rawText, /\sstyle\s*=/gi);
  if (inlineStyleCount > 25) {
    deduct(5, `High inline-style count (${inlineStyleCount})`);
  }

  const hasMain = /<main\b/i.test(rawText);
  if (!hasMain) deduct(5, 'No <main> landmark found');

  return {
    file: rel,
    module: rel.split('/')[0],
    score,
    band: classify(score),
    issues,
    title: (titleMatch ? stripTags(titleMatch[1]) : ''),
  };
}

function analyzeAsset(filePath, rawText) {
  const rel = path.relative(bundleRoot, filePath).replace(/\\/g, '/');
  const notes = [];
  const lower = rawText.toLowerCase();
  if (countMatches(rawText, /[ÃÂâ€™â€œâ€�ï»¿�]/g) > 0) {
    notes.push('Possible mojibake marker(s) detected');
  }
  if (countMatches(lower, /outline\s*:\s*none/g) > 0 && !/:focus-visible\b/i.test(lower)) {
    notes.push('Suppresses outlines without an explicit focus-visible fallback');
  }
  return {
    file: rel,
    notes,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# Betime Site Quality Audit');
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Pages scanned: ${report.summary.pagesScanned}`);
  lines.push(`- Average score: ${report.summary.averageScore.toFixed(1)}`);
  lines.push(`- Production-grade: ${report.summary.bands['production-grade'] || 0}`);
  lines.push(`- Needs polish: ${report.summary.bands['needs polish'] || 0}`);
  lines.push(`- Needs structural cleanup: ${report.summary.bands['needs structural cleanup'] || 0}`);
  lines.push('');
  lines.push('## Lowest Scoring Pages');
  lines.push('');
  lines.push('| Score | Band | File | Main Issues |');
  lines.push('| --- | --- | --- | --- |');
  report.pages.slice(0, 15).forEach((page) => {
    const issues = page.issues.length ? page.issues.join('; ') : 'None';
    lines.push(`| ${page.score} | ${page.band} | ${page.file} | ${shorten(issues, 110)} |`);
  });
  if (report.assets.length) {
    lines.push('');
    lines.push('## Shared Asset Notes');
    lines.push('');
    report.assets.forEach((asset) => {
      lines.push(`- ${asset.file}: ${asset.notes.length ? asset.notes.join('; ') : 'No issues flagged'}`);
    });
  }
  return lines.join('\n');
}

function main() {
  const files = walk(bundleRoot);
  const pageFiles = files.filter((file) => path.extname(file).toLowerCase() === '.html');
  const assetFiles = files.filter((file) => ['shared.js', 'assets/betime_solution/css/betime.css', 'assets/betime_solution/js/betime.js'].includes(path.relative(bundleRoot, file).replace(/\\/g, '/')));

  const pages = pageFiles.map((file) => analyzeHtml(file, fs.readFileSync(file, 'utf8')));
  pages.sort((a, b) => a.score - b.score || a.file.localeCompare(b.file));

  const assets = assetFiles.map((file) => analyzeAsset(file, fs.readFileSync(file, 'utf8')));
  const bands = pages.reduce((acc, page) => {
    acc[page.band] = (acc[page.band] || 0) + 1;
    return acc;
  }, {});
  const averageScore = pages.length
    ? pages.reduce((sum, page) => sum + page.score, 0) / pages.length
    : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    root: path.relative(repoRoot, bundleRoot).replace(/\\/g, '/'),
    summary: {
      pagesScanned: pages.length,
      averageScore,
      bands,
    },
    pages,
    assets,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'site-quality-audit.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'site-quality-audit.md'), toMarkdown(report), 'utf8');

  console.log(toMarkdown(report));
}

main();
