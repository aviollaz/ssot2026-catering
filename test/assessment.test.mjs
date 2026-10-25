import assert from 'node:assert/strict';
import test from 'node:test';
import {sqlTypes} from 'system-definition';
import {assessDatabase, assessSchema, createPostgresScratch, decodeSqlSsot, generateCreate, generateMigrationSql, inferStructureChanges, projectSsotSchema} from '@system-definition/postgres-migrations';
import {ssot, sqlMapping, myRecords} from '../dist/backend/system.js';
import {databaseSettings} from '../dist/backend/database.js';

const value = result => {if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value;};
const system = value(decodeSqlSsot(ssot, sqlMapping));

test('assessment reports live schema differences without changing schema or data', async () => {
    const {schema} = databaseSettings.database;
    const scratch = createPostgresScratch({...databaseSettings.database,
        ...databaseSettings.initialUser}, [schema]);
    const handle = value(await scratch.create('clean-target'));
    try {
        const expected = value(projectSsotSchema(system, schema));
        const empty = value(await assessSchema(system, schema, handle.session));
        assert.ok(!empty.differences.some(diff => diff.path.length === 1 && diff.path[0] === 'schemas'));
        assert.ok(empty.differences.some(diff => diff.change === 'add'));
        for (const statement of value(generateCreate(expected)).statements) await handle.session.query(statement.text, statement.values);
        await handle.session.query("INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo) VALUES ('EMP', 'Keep this row', null, 'Entrada', 1, 1, true)", []);
        assert.deepEqual(value(await assessSchema(system, schema, handle.session)), {equal: true, differences: []});
        const absent = value(await assessSchema(system, 'missing_schema', handle.session));
        assert.ok(absent.differences.some(diff => diff.path.length === 1 && diff.path[0] === 'schemas'));

        const target = structuredClone(ssot);
        target.entities.platos.fields.notes = myRecords.completeField({type: 'text'}, 'notes');
        target.records.plato.notes = target.entities.platos.fields.notes;
        const changed = value(decodeSqlSsot(target, sqlMapping));
        const missing = value(await assessSchema(changed, schema, handle.session));
        assert.equal(missing.equal, false);
        assert.ok(missing.differences.some(diff => diff.change === 'add' && diff.path.at(-1) === 'notes'));
        assert.equal(missing.differences.find(diff => diff.path.at(-1) === 'notes').impact, 'preserving');
        assert.equal((await handle.session.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'notes'", [schema])).rows[0].count, 0);

        target.entities.platos.fields.descripcion.nullable = false;
        target.records.plato.descripcion.nullable = false;
        const required = value(await assessSchema(value(decodeSqlSsot(target, sqlMapping)), schema, handle.session));
        assert.ok(required.differences.some(diff => diff.path.includes('descripcion') && diff.path.at(-1) === 'nullable' && diff.impact === 'requiresDataCheck'));
        assert.equal((await handle.session.query('SELECT descripcion FROM ssot.platos', [])).rows[0].descripcion, null);

        await handle.session.query("UPDATE ssot.platos SET descripcion = ''", []);
        await handle.session.query('ALTER TABLE ssot.platos ADD COLUMN extra integer', []);
        await handle.session.query('ALTER TABLE ssot.platos ALTER COLUMN descripcion SET NOT NULL', []);
        await handle.session.query('CREATE INDEX extra_index ON ssot.platos (nombre)', []);
        const drift = value(await assessSchema(system, schema, handle.session));
        assert.ok(drift.differences.some(diff => diff.change === 'remove' && diff.path.at(-1) === 'extra'));
        assert.equal(drift.differences.find(diff => diff.path.at(-1) === 'extra').impact, 'destructive');
        assert.equal(drift.differences.find(diff => diff.path.at(-1) === 'extra_index').impact, 'preserving');
        assert.ok(drift.differences.some(diff => diff.change === 'remove' && diff.path.at(-1) === 'extra_index'));
        assert.ok(drift.differences.some(diff => diff.change === 'change' && diff.path.at(-1) === 'nullable' && diff.before === false && diff.after === true));
        assert.equal((await handle.session.query('SELECT nombre FROM ssot.platos', [])).rows[0].nombre, 'Keep this row');
        assert.equal((await handle.session.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'extra'", [schema])).rows[0].count, 1);
    } finally {value(await scratch.destroy(handle));}
});

test('the configured live database already matches the SSOT', async () => {
    assert.deepEqual(value(await assessDatabase(system, databaseSettings)), {equal: true, differences: []});
});

test('generated SQL preserves a rename and stages the required-field change around a backfill', async () => {
    const {schema} = databaseSettings.database;
    const scratch = createPostgresScratch({...databaseSettings.database, ...databaseSettings.initialUser}, [schema]);
    const handle = value(await scratch.create('clean-target'));
    try {
        const current = value(projectSsotSchema(system, schema));
        for (const statement of value(generateCreate(current)).statements) await handle.session.query(statement.text, statement.values);
        await handle.session.query("INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo) VALUES ('EMP', 'kept', null, 'Entrada', 1, 1, true)", []);
        await handle.session.query("ALTER TABLE ssot.platos ALTER COLUMN descripcion SET DEFAULT 'pending'", []);
        current.objects.find(object => object.kind === 'column' && object.identity.name === 'descripcion').defaultExpression = "'pending'::text";
        const target = structuredClone(ssot);
        delete target.entities.platos.fields.descripcion;
        delete target.records.plato.descripcion;
        target.entities.platos.fields.notes = myRecords.completeField({type: 'text', nullable: false}, 'notes');
        target.records.plato.notes = target.entities.platos.fields.notes;
        const changed = value(decodeSqlSsot(target, {...sqlMapping, text: sqlTypes.varchar}));
        const base = {from: {systemId: ssot.systemId, releaseId: 'before', releaseHash: '1'.repeat(64)},
            to: {systemId: ssot.systemId, releaseId: 'after', releaseHash: '2'.repeat(64)},
            fromSnapshotHash: '3'.repeat(64), toSnapshotHash: '4'.repeat(64), fromPersistenceHash: '5'.repeat(64), toPersistenceHash: '6'.repeat(64)};
        const changes = value(inferStructureChanges(base, current, value(projectSsotSchema(changed, schema)), [
            {before: {side: 'from', entity: 'platos', field: 'descripcion'}, after: {side: 'to', entity: 'platos', field: 'notes'}},
        ]));
        const statements = value(generateMigrationSql(changes, current, changed, schema, [{side: 'to', entity: 'platos', field: 'notes'}]));
        for (const statement of statements.filter(statement => statement.order < 50)) await handle.session.query(statement.text, []);
        assert.equal((await handle.session.query('SELECT notes FROM ssot.platos', [])).rows[0].notes, null);
        await handle.session.query("UPDATE ssot.platos SET notes = 'filled' WHERE notes IS NULL", []);
        for (const statement of statements.filter(statement => statement.order >= 50)) await handle.session.query(statement.text, []);
        assert.deepEqual(value(await assessSchema(changed, schema, handle.session)), {equal: true, differences: []});
        assert.deepEqual((await handle.session.query('SELECT nombre, notes FROM ssot.platos', [])).rows, [{nombre: 'kept', notes: 'filled'}]);
    } finally {value(await scratch.destroy(handle));}
});

test('generated migration SQL maps the backend definitions and all provided SQL types into PostgreSQL', async () => {
    const {schema} = databaseSettings.database;
    const scratch = createPostgresScratch({...databaseSettings.database, ...databaseSettings.initialUser}, [schema]);
    const handle = value(await scratch.create('clean-target'));
    try {
        const current = {formatVersion: 1, engineVersion: '18.6', schemas: [schema], objects: []};
        const base = {from: {systemId: ssot.systemId, releaseId: 'A', releaseHash: '1'.repeat(64)},
            to: {systemId: ssot.systemId, releaseId: 'B', releaseHash: '2'.repeat(64)},
            fromSnapshotHash: '3'.repeat(64), toSnapshotHash: '4'.repeat(64), fromPersistenceHash: '5'.repeat(64), toPersistenceHash: '6'.repeat(64)};
        const changes = value(inferStructureChanges(base, current, value(projectSsotSchema(system, schema)), []));
        for (const statement of value(generateMigrationSql(changes, current, system, schema))) await handle.session.query(statement.text, []);
        assert.deepEqual(value(await assessSchema(system, schema, handle.session)), {equal: true, differences: []});

        const names = Object.keys(sqlTypes);
        const vocabulary = {...ssot, systemId: 'sql-types', typeNames: names, records: {}, entities: {sql_types: {
            name: 'sql_types', record: 'sql_type', pk: ['integer'], fks: {}, uks: {}, validators: [],
            fields: Object.fromEntries(names.map(name => [name, {name, type: name, nullable: name !== 'integer'}])),
        }}};
        const mapped = value(decodeSqlSsot(vocabulary, sqlTypes));
        const vocabularySchema = schema + '_vocabulary';
        await handle.session.query('CREATE SCHEMA "' + vocabularySchema.replaceAll('"', '""') + '"', []);
        for (const statement of value(generateCreate(value(projectSsotSchema(mapped, vocabularySchema)))).statements) await handle.session.query(statement.text, statement.values);
        assert.deepEqual(value(await assessSchema(mapped, vocabularySchema, handle.session)), {equal: true, differences: []});
    } finally {value(await scratch.destroy(handle));}
});
