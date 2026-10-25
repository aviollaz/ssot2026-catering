import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {registerEntityApi} from '../dist/backend/api.js';
import {myEntities, entityLabels} from '../dist/backend/system.js';
import {browsing} from '../dist/backend/browsing.js';
import {entityResult} from './helpers/entity-result.mjs';
import {createAuthentication} from '../dist/backend/auth.js';
import {appTypeBehaviours} from '../dist/backend/value-types.js';

const tokens = new Map();
const fetch = (url, options = {}) => globalThis.fetch(url, {...options,
    headers: {...options.headers, Authorization: `Bearer ${tokens.get(new URL(url).origin)}`},
});

async function startApi(t, query) {
    const app = express();
    const user = {id: 'admin', usuario: 'admin', version_sesion: 'test-version'};
    const auth = createAuthentication({query: async () => ({rows: [user]})}, 'test-only-secret-with-at-least-32-bytes');
    registerEntityApi(app, typeof query === 'function' ? {query, connect: async () => { throw new Error('Unexpected transaction'); }} : query, auth);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    tokens.set(base, (await auth.issueToken(user)).token);
    t.after(() => tokens.delete(base));
    return base;
}

test('entity discovery comes from the SSOT and needs no database query', async t => {
    const base = await startApi(t, () => { throw new Error('Unexpected database query'); });
    const response = await fetch(`${base}/api/entities`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), Object.keys(myEntities).map(name => ({name, label: entityLabels[name]})));
    for (const name of ['unknown', 'constructor', 'platos;DROP TABLE ssot.platos']) {
        const invalid = await fetch(`${base}/api/entities/${encodeURIComponent(name)}`);
        assert.equal(invalid.status, 404);
        assert.deepEqual(await invalid.json(), {error: 'Entidad desconocida'});
    }
});

const text = {minLength: null, maxLength: null};
const positive = {minLength: null, maxLength: null, minimum: 1};

test('entity data preserves JSON value types and exposes only display metadata', async t => {
    let sql;
    const base = await startApi(t, async text => {
        sql = text;
        return entityResult([{cod_plato: 'EMP', cod_ing: 'HAR', cantidad: 500, private_extra: 'omit'}]);
    });
    const response = await fetch(`${base}/api/entities/recetas`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        name: 'recetas',
        label: 'Recetas', browsing, window: {kind: 'complete'}, versions: ['1'],
        pk: ['cod_plato', 'cod_ing'],
        columns: [
            {name: 'cod_plato', label: 'Plato', type: 'text', nullable: false, writable: true, constraints: text},
            {name: 'cod_ing', label: 'Ingrediente', type: 'text', nullable: false, writable: true, constraints: text},
            {name: 'cantidad', label: 'Cantidad por receta', type: 'posInteger', nullable: false, writable: true, constraints: positive},
        ],
        inputs: [
            {name: 'cod_plato', label: 'Plato', type: 'text', nullable: false, constraints: text, optionalOnUpdate: false},
            {name: 'cod_ing', label: 'Ingrediente', type: 'text', nullable: false, constraints: text, optionalOnUpdate: false},
            {name: 'cantidad', label: 'Cantidad por receta', type: 'posInteger', nullable: false, constraints: positive, optionalOnUpdate: false},
        ],
        foreignKeys: [
            {name: 'plato', entity: 'platos', fields: {cod_plato: 'cod_plato'}, displayFields: ['cod_plato', 'nombre']},
            {name: 'ingrediente', entity: 'ingredientes', fields: {cod_ing: 'cod_ing'}, displayFields: ['cod_ing', 'nombre']},
        ],
        rows: [{cod_plato: 'EMP', cod_ing: 'HAR', cantidad: 500}],
    });
    assert.match(sql, /SELECT "cod_plato", "cod_ing", "cantidad"/);
    assert.match(sql, /FROM "ssot"\."recetas"/);
    assert.match(sql, /ORDER BY "cod_plato" COLLATE "C" asc NULLS LAST, "cod_ing" COLLATE "C" asc NULLS LAST/);
});

test('empty entities still return their columns', async t => {
    const base = await startApi(t, async () => entityResult([]));
    const response = await fetch(`${base}/api/entities/ingredientes`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.name, 'ingredientes');
    assert.deepEqual(body.rows, []);
    assert.deepEqual(body.columns.map(column => column.name), ['cod_ing', 'nombre', 'unidad', 'stock_actual']);
    assert.equal(body.columns[3].type, 'cantidad');
});

test('database errors and rows inconsistent with the SSOT return a JSON error', async t => {
    const rows = [
        {cod_plato: 'EMP', cod_ing: 'HAR', cantidad: '500'},
        {cod_plato: null, cod_ing: 'HAR', cantidad: 500},
        {cod_plato: 'EMP', cantidad: 500},
    ];
    const base = await startApi(t, async () => {
        if (rows.length) return entityResult([rows.shift()]);
        throw new Error('Internal database details');
    });
    for (let index = 0; index < 4; index++) {
        const response = await fetch(`${base}/api/entities/recetas`);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), {error: 'No se pudieron procesar los datos.'});
    }
});

const send = (base, name, method, body) => fetch(`${base}/api/entities/${name}`, {
    method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
});

test('positive integers, quantities, enums and date-times validate parsed values without coercion', () => {
    const positive = appTypeBehaviours.posInteger;
    for (const value of [1, 2026]) {
        assert.equal(positive.check(value), true);
        assert.deepEqual(positive.deserialize(positive.serialize(value)), {ok: true, value});
    }
    for (const value of [0, -1, 1.5, NaN, Infinity, '1', true, null]) assert.equal(positive.check(value), false);
    for (const text of ['0', '-1', '1.5', '', 'Infinity', '9'.repeat(400)]) assert.equal(positive.deserialize(text).ok, false);
    const cantidad = appTypeBehaviours.cantidad;
    for (const value of [0, 1, 5000]) assert.deepEqual(cantidad.deserialize(cantidad.serialize(value)), {ok: true, value});
    for (const value of [-1, 1.5, '0', null]) assert.equal(cantidad.check(value), false);
    for (const [type, values, invalid] of [
        ['unidad', ['g', 'ml', 'u'], ['G', 'kg', '', 'g ']],
        ['categoria', ['Entrada', 'Principal', 'Postre', 'Bebida', 'Finger food'], ['entrada', 'Otra', '']],
        ['estadoPedido', ['Pendiente', 'Confirmado', 'Entregado', 'Cancelado'], ['pendiente', 'Listo', '']],
        ['fechaHora', ['2026-11-12T20:00', '2026-11-12T20:00:00'], ['2026-11-12', '2026-11-12 20:00', '2026-13-01T10:00', '12/11/2026 20:00', '']],
    ]) {
        const behaviour = appTypeBehaviours[type];
        for (const value of values) {
            assert.equal(behaviour.check(value), true);
            assert.deepEqual(behaviour.deserialize(behaviour.serialize(value)), {ok: true, value});
        }
        for (const text of invalid) {
            assert.equal(behaviour.check(text), false, `${type} ${text}`);
            assert.equal(behaviour.deserialize(text).ok, false);
        }
        assert.equal(behaviour.check(1), false);
    }
});

test('dish metadata supplies the positive minimum and enum choices to editors', async t => {
    const base = await startApi(t, async () => entityResult([]));
    const response = await fetch(`${base}/api/entities/platos`);
    assert.equal(response.status, 200);
    const {inputs} = await response.json();
    const input = name => inputs.find(column => column.name === name);
    assert.equal(input('porciones_receta').type, 'posInteger');
    assert.equal(input('porciones_receta').constraints.minimum, 1);
    assert.equal(input('porciones_receta').nullable, false);
    assert.equal(input('categoria').type, 'categoria');
    assert.deepEqual(input('categoria').constraints.options, ['Entrada', 'Principal', 'Postre', 'Bebida', 'Finger food']);
    assert.equal(input('categoria').nullable, false);
    assert.equal(input('descripcion').type, 'text');
    assert.equal(input('descripcion').nullable, true);
});

const dish = {cod_plato: 'EMP', nombre: 'Empanadas', descripcion: null, categoria: 'Finger food', porciones_receta: 12, precio_porcion: 900, activo: true};

test('invalid dish values and keys are rejected before querying on create, update and delete', async t => {
    let calls = 0;
    const base = await startApi(t, async () => { calls++; return {rowCount: 1}; });
    const key = {cod_plato: dish.cod_plato};
    for (const [field, values] of [
        ['porciones_receta', [0, -1, 1.5, '12', null]],
        ['categoria', [1, 'entrada', 'Otra', null]],
        ['activo', ['true', 1, null]],
    ]) {
        for (const value of values) {
            const row = {...dish, [field]: value};
            for (const [method, body] of [['POST', row], ['PUT', {key, row, version: '1'}]]) {
                const response = await send(base, 'platos', method, body);
                assert.equal(response.status, 400, `${method} ${field}=${value}`);
                assert.ok((await response.json()).problems.some(problem => problem.field === field));
            }
        }
    }
    for (const value of [null, 1]) {
        assert.equal((await send(base, 'platos', 'DELETE', {cod_plato: value})).status, 400);
        assert.equal((await send(base, 'platos', 'PUT', {key: {cod_plato: value}, row: dish, version: '1'})).status, 400);
    }
    assert.equal(calls, 0);
});

test('valid enums, positive boundary and nullable description retain their values', async t => {
    const queries = [];
    const base = await startApi(t, async (sql, values) => { queries.push({sql, values}); return {rowCount: 1}; });
    for (const descripcion of ['Al horno', '', null]) {
        const row = {...dish, porciones_receta: 1, descripcion};
        assert.equal((await send(base, 'platos', 'POST', row)).status, 204);
        assert.deepEqual(queries.at(-1).values, Object.values(row));
        const updated = {...row, categoria: 'Entrada'};
        assert.equal((await send(base, 'platos', 'PUT', {key: {cod_plato: row.cod_plato}, row: updated, version: '1'})).status, 204);
        assert.deepEqual(queries.at(-1).values, [...Object.values(updated), row.cod_plato, '1']);
    }
});

test('CRUD uses parameters and targets the original key when the key is edited', async t => {
    const queries = [];
    const base = await startApi(t, async (sql, values) => { queries.push({sql, values}); return {rowCount: 1}; });
    const row = {cod_ing: '', nombre: "O'Reilly <script>", unidad: 'g', stock_actual: 0};
    assert.equal((await send(base, 'ingredientes', 'POST', row)).status, 204);
    assert.match(queries[0].sql, /^INSERT INTO "ssot"\."ingredientes"/);
    assert.deepEqual(queries[0].values, ['', row.nombre, 'g', 0]);
    assert.ok(!queries[0].sql.includes(row.nombre));
    assert.equal((await send(base, 'ingredientes', 'PUT', {key: {cod_ing: ''}, version: '1', row: {...row, cod_ing: 'RENAMED', nombre: 'Renamed', stock_actual: 5}})).status, 204);
    assert.match(queries[1].sql, /WHERE "cod_ing" = \$5 AND xmin::text = \$6$/);
    assert.deepEqual(queries[1].values, ['RENAMED', 'Renamed', 'g', 5, '', '1']);
    assert.equal((await send(base, 'recetas', 'DELETE', {cod_plato: 'EMP', cod_ing: 'RENAMED'})).status, 204);
    assert.match(queries[2].sql, /^DELETE FROM "ssot"\."recetas" WHERE "cod_plato" = \$1 AND "cod_ing" = \$2$/);
    assert.deepEqual(queries[2].values, ['EMP', 'RENAMED']);
    const service = {cod_servicio: 'CENA', nombre: 'Cena', descripcion: null, precio_persona: 1, min_personas: 1, activo: false};
    assert.equal((await send(base, 'servicios', 'POST', service)).status, 204);
    assert.deepEqual(queries[3].values, Object.values(service));
});

test('invalid shapes, types, keys and SSOT business rules fail before querying', async t => {
    let calls = 0;
    const base = await startApi(t, async () => { calls++; return {rowCount: 1}; });
    const order = {cliente_nombre: 'Ana', cliente_email: 'ana@example.com', cliente_telefono: '1', direccion: 'Calle 1',
        fecha_evento: '2026-11-12T20:00', personas: 10, estado: 'Pendiente', cod_servicio: null, total: 1000, observaciones: null};
    for (const body of [null, [], {}, {...order, cliente_nombre: null}, {...order, personas: '10'}, {...order, estado: 'Listo'},
        {...order, fecha_evento: '2026-13-01T20:00'}, {...order, extra: true}, {...order, id: 'chosen'}, {...order, cliente_email: 'sin-arroba'}]) {
        const response = await send(base, 'pedidos', 'POST', body);
        assert.equal(response.status, 400);
        assert.equal(typeof (await response.json()).error, 'string');
    }
    const row = {cod_plato: 'EMP', cod_ing: 'HAR', cantidad: 1};
    for (const key of [{}, {cod_plato: null, cod_ing: 'HAR'}, {cod_plato: 'EMP'}, {cod_plato: 'EMP', cod_ing: 'HAR', extra: true}]) {
        assert.equal((await send(base, 'recetas', 'DELETE', key)).status, 400);
        assert.equal((await send(base, 'recetas', 'PUT', {key, row, version: '1'})).status, 400);
    }
    assert.equal((await send(base, 'recetas', 'PUT', row)).status, 400);
    assert.equal((await fetch(`${base}/api/entities/recetas`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'})).status, 400);
    assert.equal(calls, 0);
});

test('missing rows and constraint conflicts have useful, non-sensitive errors', async t => {
    const base = await startApi(t, async sql => {
        if (sql.startsWith('INSERT')) throw Object.assign(new Error('Internal query and credentials'), {code: '23505'});
        return {rowCount: 0};
    });
    const row = {cod_ing: 'B', nombre: 'B', unidad: 'g', stock_actual: 0};
    assert.equal((await send(base, 'ingredientes', 'PUT', {key: {cod_ing: 'A'}, version: '1', row})).status, 409);
    assert.equal((await send(base, 'ingredientes', 'DELETE', {cod_ing: 'A'})).status, 404);
    const conflict = await send(base, 'ingredientes', 'POST', row);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {error: 'Ya existe un registro con esa clave.'});
});

test('delete dependency checks report every SSOT foreign key, including renamed fields', async t => {
    const queries = [];
    const base = await startApi(t, async (sql, values) => {
        queries.push({sql, values});
        if (sql.includes('FROM "ssot"."recetas"')) return {rows: [{count: 2, keys: [{cod_plato: 'EMP', cod_ing: 'HAR'}]}]};
        if (sql.includes('FROM "ssot"."pedido_platos"')) return {rows: [{count: 1, keys: [{pedido: 'p1', cod_plato: 'EMP'}]}]};
        return {rows: [{count: 0, keys: []}]};
    });
    const dish = await fetch(`${base}/api/entities/platos/delete-check`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({keys: [{cod_plato: 'EMP'}]}),
    });
    assert.equal(dish.status, 200);
    assert.deepEqual(await dish.json(), {
        blockers: [
            {entity: 'pedido_platos', relationship: 'plato', count: 1, keys: [{pedido: 'p1', cod_plato: 'EMP'}]},
            {entity: 'recetas', relationship: 'plato', count: 2, keys: [{cod_plato: 'EMP', cod_ing: 'HAR'}]},
        ],
    });
    const recipe = queries.find(query => query.sql.includes('FROM "ssot"."recetas"'));
    assert.match(recipe.sql, /LIMIT 10/);
    assert.match(recipe.sql, /SELECT DISTINCT dependent\."cod_plato", dependent\."cod_ing"/);
    assert.doesNotMatch(recipe.sql, /SELECT DISTINCT dependent\.\*/);
    assert.match(recipe.sql, /dependent\."cod_plato" = target\."cod_plato"/);
    assert.deepEqual(recipe.values, ['EMP']);

    const order = await fetch(`${base}/api/entities/pedidos/delete-check`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({keys: [{id: 'p1'}]}),
    });
    assert.equal(order.status, 200);
    assert.deepEqual(await order.json(), {
        blockers: [{entity: 'pedido_platos', relationship: 'pedido', count: 1, keys: [{pedido: 'p1', cod_plato: 'EMP'}]}],
    });
    assert.match(queries.at(-1).sql, /dependent\."pedido" = target\."id"/);
});

test('bulk delete rejects malformed and duplicate selections before querying', async t => {
    let calls = 0;
    const base = await startApi(t, async () => { calls++; return {rows: []}; });
    for (const keys of [[], [{cod_ing: 1}], [{cod_ing: 'HAR'}, {cod_ing: 'HAR'}]]) {
        const response = await fetch(`${base}/api/entities/ingredientes/bulk-delete`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({keys}),
        });
        assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
});

test('bulk delete rolls the whole selection back when any row has dependents', async t => {
    const statements = [];
    const client = {
        async query(sql) {
            statements.push(sql);
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return {rowCount: null, rows: []};
            if (sql.includes('FOR UPDATE')) return {rowCount: 2, rows: [{cod_plato: 'EMP'}, {cod_plato: 'TAR'}]};
            if (sql.startsWith('WITH matching')) return {rows: [{count: 1, keys: [{cod_plato: 'EMP', cod_ing: 'HAR'}]}]};
            if (sql.startsWith('DELETE')) return {rowCount: 2, rows: []};
            throw new Error('Unexpected query in bulk-delete test');
        },
        release() {},
    };
    const base = await startApi(t, {query: async () => ({rows: []}), connect: async () => client});
    const response = await fetch(`${base}/api/entities/platos/bulk-delete`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({keys: [{cod_plato: 'EMP'}, {cod_plato: 'TAR'}]}),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /recetas \(plato\): 1/);
    assert.ok(statements.includes('ROLLBACK'));
    assert.ok(!statements.some(sql => sql.startsWith('DELETE')));
});

test('bulk delete removes all selected rows in one transaction when unreferenced', async t => {
    const statements = [];
    const client = {
        async query(sql) {
            statements.push(sql);
            if (sql === 'BEGIN' || sql === 'COMMIT') return {rowCount: null, rows: []};
            if (sql.includes('FOR UPDATE')) return {rowCount: 2, rows: [{cod_ing: 'HAR'}, {cod_ing: 'MAN'}]};
            if (sql.startsWith('WITH matching')) return {rows: [{count: 0, keys: []}]};
            if (sql.startsWith('DELETE')) return {rowCount: 2, rows: [{cod_ing: 'HAR'}, {cod_ing: 'MAN'}]};
            throw new Error('Unexpected query in bulk-delete test');
        },
        release() {},
    };
    const base = await startApi(t, {query: async () => ({rows: []}), connect: async () => client});
    const response = await fetch(`${base}/api/entities/ingredientes/bulk-delete`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({keys: [{cod_ing: 'HAR'}, {cod_ing: 'MAN'}]}),
    });
    assert.equal(response.status, 204);
    assert.ok(statements.includes('COMMIT'));
    assert.equal(statements.filter(sql => sql.startsWith('DELETE')).length, 1);
    assert.equal(statements.at(-1), 'COMMIT');
});
