const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const lockPath = path.join(projectRoot, 'package-lock.json');
const outputPath = path.join(projectRoot, 'THIRD_PARTY_NOTICES.md');

const rootPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const directRuntime = new Set(Object.keys(rootPackage.dependencies || {}));

function packageNameFromLockPath(lockEntryPath) {
  const marker = 'node_modules/';
  const index = lockEntryPath.lastIndexOf(marker);
  return index >= 0 ? lockEntryPath.slice(index + marker.length) : lockEntryPath;
}

function readInstalledPackage(lockEntryPath) {
  const installedPackagePath = path.join(projectRoot, ...lockEntryPath.split('/'), 'package.json');
  if (!fs.existsSync(installedPackagePath)) return null;
  return JSON.parse(fs.readFileSync(installedPackagePath, 'utf8'));
}

function normalizeLicense(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const values = value.map(item => normalizeLicense(item)).filter(Boolean);
    return values.length ? values.join(' OR ') : null;
  }
  if (value && typeof value === 'object') return normalizeLicense(value.type);
  return null;
}

function detectLicenseFromFile(lockEntryPath) {
  const packageRoot = path.join(projectRoot, ...lockEntryPath.split('/'));
  if (!fs.existsSync(packageRoot)) return null;
  const fileName = fs.readdirSync(packageRoot).find(name => /^licen[cs]e(?:\..*)?$/i.test(name));
  if (!fileName) return null;
  const text = fs.readFileSync(path.join(packageRoot, fileName), 'utf8').slice(0, 8000);
  if (/Apache License[\s\S]{0,100}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Mozilla Public License[\s\S]{0,100}2\.0/i.test(text)) return 'MPL-2.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,100}2\.1/i.test(text)) return 'LGPL-2.1-only';
  if (/GNU GENERAL PUBLIC LICENSE[\s\S]{0,100}3/i.test(text)) return 'GPL-3.0-only';
  if (/The MIT License|MIT License \(MIT\)|Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/ISC License|Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee/i.test(text)) return 'ISC';
  if (/Redistribution and use in source and binary forms, with or without modification/i.test(text)) {
    return /Neither the name of|contributors may be used to endorse/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  return null;
}

function sourceFor(installedPackage) {
  const repository = installedPackage?.repository;
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return installedPackage?.homepage || '';
}

function escapeTable(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const runtimeEntries = [];
const unresolved = [];
for (const [lockEntryPath, entry] of Object.entries(lock.packages || {})) {
  if (!lockEntryPath || entry.dev === true || entry.link || !entry.version || !lockEntryPath.includes('node_modules/')) continue;
  const name = packageNameFromLockPath(lockEntryPath);
  const installedPackage = readInstalledPackage(lockEntryPath);
  const license = normalizeLicense(entry.license)
    || normalizeLicense(installedPackage?.license)
    || normalizeLicense(installedPackage?.licenses)
    || detectLicenseFromFile(lockEntryPath);
  if (!license) {
    unresolved.push(`${name}@${entry.version} (${lockEntryPath})`);
    continue;
  }
  runtimeEntries.push({
    name,
    version: entry.version,
    license,
    direct: directRuntime.has(name),
    source: sourceFor(installedPackage),
  });
}

if (unresolved.length) {
  console.error('Unable to determine licenses for production dependencies:');
  for (const item of unresolved) console.error(`- ${item}`);
  process.exit(1);
}

const uniqueRuntimeEntries = [...new Map(runtimeEntries.map(entry => [
  `${entry.name}\0${entry.version}\0${entry.license}`,
  entry,
])).values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const directBuildEntries = Object.keys(rootPackage.devDependencies || {}).sort().map(name => {
  const lockEntryPath = `node_modules/${name}`;
  const entry = lock.packages?.[lockEntryPath];
  const installedPackage = readInstalledPackage(lockEntryPath);
  const license = normalizeLicense(entry?.license)
    || normalizeLicense(installedPackage?.license)
    || normalizeLicense(installedPackage?.licenses)
    || detectLicenseFromFile(lockEntryPath);
  if (!entry?.version || !license) {
    console.error(`Unable to determine build dependency metadata for ${name}`);
    process.exit(1);
  }
  return { name, version: entry.version, license, source: sourceFor(installedPackage) };
});

const licenseCounts = new Map();
for (const entry of uniqueRuntimeEntries) {
  licenseCounts.set(entry.license, (licenseCounts.get(entry.license) || 0) + 1);
}

const lockSha256 = crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
const lines = [
  '# Third-Party Notices',
  '',
  'Synapse uses third-party open-source software. Each component remains subject to its own license. This inventory is generated from the production dependency closure in `package-lock.json`; generation fails when a shipped package has no identifiable license.',
  '',
  `- Production packages: ${uniqueRuntimeEntries.length}`,
  `- Direct runtime dependencies: ${directRuntime.size}`,
  `- Lockfile SHA-256: \`${lockSha256}\``,
  '',
  '## License summary',
  '',
  '| License expression | Packages |',
  '| --- | ---: |',
  ...[...licenseCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([license, count]) => `| ${escapeTable(license)} | ${count} |`),
  '',
  '## Production dependency inventory',
  '',
  '| Component | Version | License | Direct | Source |',
  '| --- | ---: | --- | :---: | --- |',
  ...uniqueRuntimeEntries.map(entry => `| ${escapeTable(entry.name)} | ${escapeTable(entry.version)} | ${escapeTable(entry.license)} | ${entry.direct ? 'yes' : ''} | ${escapeTable(entry.source)} |`),
  '',
  '## Direct build and development dependencies',
  '',
  'These packages are required to build and validate Synapse, but are not part of the production dependency closure above.',
  '',
  '| Component | Version | License | Source |',
  '| --- | ---: | --- | --- |',
  ...directBuildEntries.map(entry => `| ${escapeTable(entry.name)} | ${escapeTable(entry.version)} | ${escapeTable(entry.license)} | ${escapeTable(entry.source)} |`),
  '',
  '## License texts',
  '',
  'Canonical license texts remain in the corresponding installed package or source repository. Packaged releases include this inventory and preserve license files shipped with production dependencies. This notice does not relicense third-party software under the Synapse MIT License.',
  '',
];

fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
console.log(`Wrote ${path.basename(outputPath)} with ${uniqueRuntimeEntries.length} production packages.`);
