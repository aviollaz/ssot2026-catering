import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {captureMigrationState, decodeSqlSsot, jsonBytes, migrationDirectory, readCatalogState, readStateBytes, readStoredCatalog, sha256Hex, verifyMigrationFiles} from '@system-definition/postgres-migrations';
import {ssot, sqlMapping} from '../dist/backend/system.js';
import {createMigrationAuthoring} from '../dist/backend/migration-authoring.js';

const value = result => { if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value; };

test('authored migration checks load exact bytes and reject changed, missing or escaping resources', async t => {
    const prefix = join(tmpdir(), 'ssot-authored-resources-');
    const directory = await mkdtemp(prefix);
    t.after(async () => {assert.ok(directory.startsWith(prefix)); await rm(directory, {recursive: true, force: true});});
    const migrationAuthoring = createMigrationAuthoring(directory);
    const name = 'empty.sql';
    const bytes = Buffer.from('SELECT true AS ok;\n');
    await writeFile(join(directory, name), bytes);
    const ref = {kind: 'check', name, contentHash: sha256Hex(bytes)};
    assert.equal(value(await migrationAuthoring.readSql(ref)), bytes.toString('utf8'));
    const changed = await migrationAuthoring.readSql({...ref, contentHash: '0'.repeat(64)});
    assert.equal(changed.ok, false);
    assert.equal(changed.problems[0].messageKey, 'migration.checksumMismatch');
    for (const name of ['missing.sql', '../baseline.json']) {
        assert.equal((await migrationAuthoring.readSql({...ref, name})).ok, false);
    }
});

test('the current SSOT migration state survives canonical JSON serialization, including renamed FK fields', async () => {
    const system = value(decodeSqlSsot(ssot, sqlMapping));
    const state = value(await captureMigrationState(system, 'ssot', 'roundtrip'));
    assert.deepEqual(value(await readStateBytes(jsonBytes(state))), state);
});

test('migration artifacts retain valid hashes and grant CRUD only when their tables are created', async () => {
    const root = 'migrations';
    const catalog = value(await readStoredCatalog(root));
    const expected = {
        '0001_initial': ['materias', 'pabellones', 'planes'],
        '0002_authentication': ['usuarios'],
        '0003_authenticated_administrators': [],
        '0004_materias_plan_fk': [],
        '0005_update_schema': ['departamentos', 'enrolamientos', 'estudiantes'],
        '0006_update_schema': [],
        '0007_update_schema': ['ingredientes', 'pedido_platos', 'pedidos', 'platos', 'recetas', 'servicio_platos', 'servicios'],
    };
    for (let index = 0; index < catalog.releases.length; index++) value(await readCatalogState(root, catalog, index));
    for (const published of catalog.migrations) {
        const verified = value(await verifyMigrationFiles(migrationDirectory(root, published), published));
        const text = await readFile(join(migrationDirectory(root, published), verified.manifest.script.path), 'utf8');
        const tables = [...text.matchAll(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"\."([^"]+)" TO "ssot2026_user";/g)].map(match => match[1]).sort();
        assert.deepEqual(tables, expected[published.migration.id]);
        assert.doesNotMatch(text, /^--/m);
        assert.doesNotMatch(text, /ALTER DEFAULT PRIVILEGES[^;]+\bGRANT\b/);
        assert.equal(published.migration.steps.some(step => step.id === 'app-permissions'), tables.length > 0);
        if (published.migration.id === '0001_initial') assert.match(text, /ALTER DEFAULT PRIVILEGES[^;]+\bREVOKE\b/);
    }
});

test('the plan FK migration only changes the constraint and leaves existing data untouched', async () => {
    const text = await readFile('migrations/entries/0004_materias_plan_fk/0004_materias_plan_fk.sql', 'utf8');
    assert.match(text, /FOREIGN KEY \("plan"\) REFERENCES "ssot"\."planes" \("plan"\)/);
    assert.doesNotMatch(text, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CASCADE|NOT VALID)\b/i);
});

test('the schema update keeps four decision bindings and executes their shared guard once', async () => {
    const catalog = value(await readStoredCatalog('migrations'));
    const published = catalog.migrations.find(entry => entry.migration.id === '0005_update_schema');
    assert.ok(published);
    const directory = migrationDirectory('migrations', published);
    const {authoring, manifest} = value(await verifyMigrationFiles(directory, published));
    assert.equal(authoring.decisions.length, 4);
    assert.equal(authoring.migration.before.length, 1);
    const check = authoring.migration.before[0];
    assert.equal(check.name, '0005_materias_empty.sql');
    for (const decision of authoring.decisions) {
        assert.equal(decision.resolution.kind, 'check');
        assert.deepEqual(decision.resolution.run, check);
    }
    const sql = await readFile(join(directory, manifest.script.path), 'utf8');
    assert.equal([...sql.matchAll(/SELECT NOT EXISTS \(SELECT 1 FROM "ssot"\."materias"\) AS ok;/g)].length, 1);
});

test('the catering model replaces the academic tables in two steps: their FKs first, then the tables', async () => {
    const catalog = value(await readStoredCatalog('migrations'));
    const script = async id => {
        const published = catalog.migrations.find(entry => entry.migration.id === id);
        const directory = migrationDirectory('migrations', published);
        const {authoring, manifest} = value(await verifyMigrationFiles(directory, published));
        return {authoring, sql: await readFile(join(directory, manifest.script.path), 'utf8')};
    };
    // PostgreSQL rejects dropping a table that another table still references.
    const fks = await script('0006_update_schema');
    assert.equal([...fks.sql.matchAll(/DROP CONSTRAINT "[^"]+_fkey"/g)].length, 5);
    assert.doesNotMatch(fks.sql, /DROP TABLE|CREATE TABLE|\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CASCADE)\b/);
    const swap = await script('0007_update_schema');
    const dropped = [...swap.sql.matchAll(/DROP TABLE "ssot"\."([^"]+)";/g)].map(match => match[1]).sort();
    assert.deepEqual(dropped, ['departamentos', 'enrolamientos', 'estudiantes', 'materias', 'pabellones', 'planes']);
    assert.ok(swap.authoring.decisions.length > 0);
    assert.ok(swap.authoring.decisions.every(decision => decision.resolution.kind === 'discard'));
    assert.match(swap.sql, /FOREIGN KEY \("pedido"\) REFERENCES "ssot"\."pedidos" \("id"\)/);
});
