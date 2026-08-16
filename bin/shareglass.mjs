#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename, dirname, extname, join } from 'node:path';
import process from 'node:process';
import { webcrypto } from 'node:crypto';
import { analyzeBytes, sanitizeBytes, SHAREGLASS_VERSION } from '../src/core/analyze.js';
import { reportToJson, reportToMarkdown } from '../src/core/report.js';
import { formatBytes } from '../src/core/utils.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ANSI = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code, value) => ANSI ? `\u001b[${code}m${value}\u001b[0m` : value;
const bold = (value) => color('1', value);
const red = (value) => color('31', value);
const yellow = (value) => color('33', value);
const green = (value) => color('32', value);
const cyan = (value) => color('36', value);

function usage() {
  console.log(`
${bold(`ShareGlass ${SHAREGLASS_VERSION}`)} — see what your files reveal before you share them.

Usage:
  shareglass scan <file...> [--json | --markdown] [--fail-on <level>]
  shareglass clean <file> [--out <path>] [sanitization options]

Scan options:
  --json                 Print machine-readable JSON
  --markdown             Print a Markdown report
  --fail-on <level>      Exit 2 at or above: low, medium, high, critical

Clean options:
  --out <path>           Output path (default: <name>.safe.<ext>)
  --properties           Remove Office document properties (default)
  --comments             Remove Word comments (default)
  --thumbnail            Remove Office thumbnail (default)
  --custom-data          Remove custom XML and custom properties
  --neutralize-links     Replace external Office targets with a .invalid URL
  --accept-changes       Accept tracked Word revisions
  --force-signed         Create an unsigned copy of a signed Office document
  --force-provenance     Create an unsigned derivative of a C2PA-marked image

Examples:
  shareglass scan resume.docx
  shareglass scan release/* --fail-on high
  shareglass clean resume.docx --custom-data --neutralize-links
  shareglass clean photo.jpg --force-provenance
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else if (!arg.startsWith('--')) positional.push(arg);
    else {
      const key = arg.slice(2);
      if (['out', 'fail-on'].includes(key)) {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
        flags[key] = value;
      } else flags[key] = true;
    }
  }
  return { positional, flags };
}

function levelRank(level) {
  return { clear: 0, low: 1, medium: 2, high: 3, critical: 4 }[level] ?? 0;
}

function riskLabel(report) {
  const label = `${report.summary.level.toUpperCase()} ${report.summary.score}/100`;
  if (report.summary.level === 'critical' || report.summary.level === 'high') return red(label);
  if (report.summary.level === 'medium') return yellow(label);
  if (report.summary.level === 'low') return cyan(label);
  return green(label);
}

function printHuman(report) {
  console.log(`\n${bold(report.file.name)}  ${riskLabel(report)}`);
  console.log(`${report.type.label} · ${formatBytes(report.file.size)} · ${report.file.sha256.slice(0, 12)}…`);
  if (!report.findings.length) {
    console.log(green('  ✓ No findings'));
    return;
  }
  for (const item of report.findings) {
    const icon = item.severity === 'critical' || item.severity === 'high' ? red('●')
      : item.severity === 'medium' ? yellow('●')
        : item.severity === 'low' ? cyan('●') : '○';
    console.log(`  ${icon} ${item.severity.toUpperCase().padEnd(8)} ${item.title}`);
    if (item.evidence) console.log(`    ${item.evidence}`);
    if (item.path) console.log(`    ${color('2', item.path)}`);
  }
}

function defaultOutputPath(input) {
  const extension = extname(input);
  const stem = basename(input, extension);
  return join(dirname(input), `${stem}.safe${extension}`);
}

async function scanFile(file) {
  const absolute = resolve(file);
  const bytes = new Uint8Array(await readFile(absolute));
  return analyzeBytes({ name: basename(file), bytes });
}

async function runScan(files, flags) {
  if (!files.length) throw new Error('Provide at least one file to scan.');
  const reports = [];
  for (const file of files) reports.push(await scanFile(file));
  if (flags.json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  else if (flags.markdown) {
    console.log(reports.map((report) => reportToMarkdown(report)).join('\n\n---\n\n'));
  } else {
    for (const report of reports) printHuman(report);
    const total = reports.reduce((sum, report) => sum + report.summary.actionable, 0);
    console.log(`\n${reports.length} file(s) · ${total} actionable finding(s)`);
  }
  const threshold = flags['fail-on'];
  if (threshold && !['low', 'medium', 'high', 'critical'].includes(threshold)) {
    throw new Error('--fail-on must be one of: low, medium, high, critical.');
  }
  if (threshold && reports.some((report) => levelRank(report.summary.level) >= levelRank(threshold))) process.exitCode = 2;
}

async function runClean(file, flags) {
  if (!file) throw new Error('Provide one file to clean.');
  const absolute = resolve(file);
  const bytes = new Uint8Array(await readFile(absolute));
  const report = await analyzeBytes({ name: basename(file), bytes });
  const actions = [];
  if (report.type.kind === 'ooxml') {
    // Privacy-safe defaults are always applied. Extra flags add the more
    // destructive transformations instead of unexpectedly disabling defaults.
    actions.push('office-properties', 'office-thumbnail');
    if (report.type.officeType === 'docx') actions.push('office-comments');
    if (flags['custom-data']) actions.push('office-customxml');
    if (flags['neutralize-links']) actions.push('office-external-links');
    if (flags['accept-changes']) actions.push('office-accept-changes');
  } else actions.push('image-metadata');

  const result = await sanitizeBytes({
    name: basename(file), bytes, report, actions,
    forceSigned: Boolean(flags['force-signed']),
    forceProvenance: Boolean(flags['force-provenance'])
  });
  const output = resolve(flags.out || defaultOutputPath(absolute));
  await writeFile(output, result.bytes);
  console.log(`${green('✓')} Wrote ${bold(output)}`);
  console.log(`  Findings: ${result.verification.originalFindings} → ${result.verification.sanitizedFindings}`);
  if (result.verification.sameContent) console.log(`  ${green('Content fingerprint preserved')}`);
  for (const warning of result.warnings || []) console.log(`  ${yellow('Warning:')} ${warning}`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  if (flags.version) {
    console.log(SHAREGLASS_VERSION);
    return;
  }
  if (!command || flags.help) {
    usage();
    return;
  }
  if (command === 'scan') await runScan(positional, flags);
  else if (command === 'clean') await runClean(positional[0], flags);
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(red(`ShareGlass: ${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
