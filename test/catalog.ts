/**
 * Build `test/CATALOG.md` from the real `node:test` declarations.
 *
 * The catalog is the coverage index: a stable ID, a type (unit / contract /
 * integration / regression / tooling), an area, and the case's own title. Test files
 * stay grouped by subsystem; the catalog is where the cases are grouped by type.
 *
 * `test/catalog.config.json` is the only hand-written classification. Every
 * `*.test.ts` file must have an entry; a mixed file lists per-case overrides. The
 * catalog test fails when this index is stale or a case is unclassified.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

export type CaseType = 'unit' | 'contract' | 'integration' | 'regression' | 'tooling' | 'e2e';

const REPO_PREFIX = 'P';
const TYPE_ORDER: CaseType[] = ['unit', 'contract', 'integration', 'regression', 'tooling', 'e2e'];
const TYPE_CODE: Record<CaseType, string> = {
  unit: 'UNIT',
  contract: 'CON',
  integration: 'INT',
  regression: 'REG',
  tooling: 'TOOL',
  e2e: 'E2E',
};

interface FileMeta {
  type: CaseType;
  area: string;
}

interface CaseOverride extends FileMeta {
  file: string;
  title: string;
}

interface CatalogConfig {
  files: Record<string, FileMeta>;
  cases?: CaseOverride[];
}

export interface CatalogCase extends FileMeta {
  id: string;
  file: string;
  line: number;
  title: string;
}

const TEST_DIR = import.meta.dirname;
const CONFIG_FILE = join(TEST_DIR, 'catalog.config.json');
const CATALOG_FILE = join(TEST_DIR, 'CATALOG.md');

function fail(message: string): never {
  throw new Error(message);
}

function isCaseType(value: unknown): value is CaseType {
  return typeof value === 'string' && TYPE_ORDER.includes(value as CaseType);
}

function readConfig(): CatalogConfig {
  const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  if (parsed === null || typeof parsed !== 'object') fail(`${CONFIG_FILE}: expected an object`);
  const config = parsed as CatalogConfig;
  if (config.files === null || typeof config.files !== 'object') fail(`${CONFIG_FILE}: files must be an object`);
  const files = readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.ts'));
  const configured = new Set(Object.keys(config.files));
  for (const file of files) {
    if (!configured.has(file)) fail(`${CONFIG_FILE}: missing classification for ${file}`);
  }
  for (const file of configured) {
    if (!files.includes(file)) fail(`${CONFIG_FILE}: classification names a missing test file ${file}`);
    const meta = config.files[file];
    if (!isCaseType(meta.type) || typeof meta.area !== 'string' || meta.area === '') {
      fail(`${CONFIG_FILE}: ${file} needs a valid type and a non-empty area`);
    }
  }
  for (const [index, override] of (config.cases ?? []).entries()) {
    if (!isCaseType(override.type) || typeof override.area !== 'string' || override.area === '') {
      fail(`${CONFIG_FILE}: cases[${index}] needs a valid type and a non-empty area`);
    }
    if (!Object.hasOwn(config.files, override.file)) {
      fail(`${CONFIG_FILE}: cases[${index}] names an unclassified file ${override.file}`);
    }
  }
  return config;
}

function collectFromFile(file: string, meta: FileMeta): CatalogCase[] {
  const path = join(TEST_DIR, file);
  const source = readFileSync(path, 'utf8');
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cases: CatalogCase[] = [];

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      const argument = node.arguments[0];
      if (
        argument === undefined ||
        !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        fail(`${file}: every test() needs a string title`);
      }
      cases.push({
        ...meta,
        id: '',
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        title: argument.text,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return cases;
}

function applyOverrides(cases: CatalogCase[], config: CatalogConfig): void {
  for (const override of config.cases ?? []) {
    const matches = cases.filter((entry) => entry.file === override.file && entry.title === override.title);
    if (matches.length !== 1) {
      fail(
        `${CONFIG_FILE}: case override for ${override.file} must match exactly one test title, ` +
          `found ${matches.length}: ${override.title}`,
      );
    }
    matches[0]!.type = override.type;
    matches[0]!.area = override.area;
  }
}

function assignIds(cases: CatalogCase[]): void {
  const counts = new Map<CaseType, number>();
  for (const entry of cases) {
    const next = (counts.get(entry.type) ?? 0) + 1;
    counts.set(entry.type, next);
    entry.id = `${REPO_PREFIX}-${TYPE_CODE[entry.type]}-${String(next).padStart(3, '0')}`;
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderCatalog(): string {
  const config = readConfig();
  const entries = Object.entries(config.files).flatMap(([file, meta]) => collectFromFile(file, meta));
  if (entries.length === 0) fail(`${CONFIG_FILE}: no test cases found`);
  applyOverrides(entries, config);
  entries.sort(
    (a, b) =>
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
      a.area.localeCompare(b.area) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  assignIds(entries);

  const lines: string[] = [
    '# Test catalog',
    '',
    '<!-- Generated by `npm run test:catalog`; do not edit by hand. -->',
    '',
    `Every \`node:test\` case in \`test/*.test.ts\`, grouped by type and area. ` +
      `There are **${entries.length}** cases.`,
    '',
    '| Type | Cases |',
    '| --- | ---: |',
  ];
  for (const type of TYPE_ORDER) {
    const count = entries.filter((entry) => entry.type === type).length;
    if (count > 0) lines.push(`| ${type} | ${count} |`);
  }
  lines.push('', '`unit` = one module/fakes; `contract` = public wire/package contract; ' +
    '`integration` = real platform or multi-module; `regression` = past-incident guard; ' +
    '`tooling` = repo/package/catalog checks; `e2e` = real pi/herdr.', '');

  for (const type of TYPE_ORDER) {
    const byType = entries.filter((entry) => entry.type === type);
    if (byType.length === 0) continue;
    lines.push(`## ${type} (${byType.length})`, '');
    const areas = [...new Set(byType.map((entry) => entry.area))];
    for (const area of areas) {
      lines.push(`### ${area}`, '', '| ID | File | Case |', '| --- | --- | --- |');
      for (const entry of byType.filter((item) => item.area === area)) {
        const location = `[${entry.file}:${entry.line}](./${entry.file}#L${entry.line})`;
        lines.push(`| ${entry.id} | ${location} | ${escapeCell(entry.title)} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function isMain(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const next = renderCatalog();
  if (process.argv.includes('--check')) {
    const current = readFileSync(CATALOG_FILE, 'utf8');
    if (current !== next) {
      console.error('test/CATALOG.md is stale; run `npm run test:catalog`');
      process.exitCode = 1;
    } else {
      console.log('test/CATALOG.md is up to date');
    }
  } else {
    writeFileSync(CATALOG_FILE, next);
    console.log(`wrote test/CATALOG.md (${next.match(/^\| /gm)?.length ?? 0} table rows)`);
  }
}
