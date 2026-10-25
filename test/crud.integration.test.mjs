import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import test from 'node:test';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {withTestDatabase} from './helpers/database.mjs';
import {versionOf} from './helpers/version.mjs';

// Adapted from PR #6: launch the actual server against an isolated current schema.
test('server startup, authenticated CRUD and atomic bulk deletion use the app connection', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool, config}) => {
        const password = 'crud-test-long-password';
        await initializeUsers(pool, {username: 'crud-admin', password});
        const child = spawn(process.execPath, ['dist/backend/server.js'], {
            env: {...process.env, DATABASE_URL: config.connectionString ?? '', PGDATABASE: config.database,
                PGHOST: config.host, PGPORT: String(config.port), PGUSER: config.user, PGPASSWORD: config.password,
                PORT: '0', JWT_SECRET: 'crud-test-secret-with-at-least-32-bytes'},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = once(child, 'exit');
        try {
            const base = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Server startup timed out')), 15000);
                let output = '';
                child.stdout.on('data', chunk => {
                    output += chunk;
                    const match = output.match(/http:\/\/localhost:\d+/);
                    if (match) { clearTimeout(timer); resolve(match[0]); }
                });
                child.once('error', error => { clearTimeout(timer); reject(error); });
                child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited before startup: ${code}`)); });
            });
            let token;
            const request = (path, method = 'GET', body) => fetch(base + path, {method,
                headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
                ...(body === undefined ? {} : {body: JSON.stringify(body)}),
            });
            const send = (entity, method, body) => request(`/api/entities/${entity}`, method, body);
            await t.test('real entry point serves health, frontend and authenticated API', async () => {
                assert.deepEqual(await (await request('/health')).json(), {ok: true});
                assert.match(await (await request('/')).text(), /id="tables-panel"/);
                assert.equal((await request('/assets/main.js')).status, 200);
                assert.equal((await request('/api/entities')).status, 401);
                const login = await request('/api/auth/login', 'POST', {usuario: 'crud-admin', contrasena: password});
                assert.equal(login.status, 200);
                token = (await login.json()).token;
            });
            await t.test('CRUD preserves types, unrelated fields and composite keys', async () => {
                for (const [cod_ing, nombre] of [['HAR', 'Harina'], ['QUE', 'Queso'], ['MAN', 'Manteca']]) {
                    assert.equal((await send('ingredientes', 'POST', {cod_ing, nombre, unidad: 'g', stock_actual: 0})).status, 204);
                }
                const dish = {cod_plato: 'EMP', nombre: 'Empanadas', descripcion: null, categoria: 'Finger food', porciones_receta: 12, precio_porcion: 900, activo: true};
                assert.equal((await send('platos', 'POST', dish)).status, 204);
                assert.deepEqual((await (await send('platos')).json()).rows, [dish]);
                const row = {cod_plato: 'EMP', cod_ing: 'HAR', cantidad: 500};
                assert.equal((await send('recetas', 'POST', row)).status, 204);
                assert.equal((await send('recetas', 'POST', {...row, cod_ing: 'QUE'})).status, 204);
                const changed = {...row, cod_ing: 'MAN', cantidad: 1};
                const key = {cod_plato: 'EMP', cod_ing: 'HAR'};
                const version = versionOf(await (await send('recetas')).json(), key);
                assert.equal((await send('recetas', 'PUT', {key, row: changed, version})).status, 204);
                const listed = await (await send('recetas')).json();
                assert.deepEqual(listed.rows.find(value => value.cod_ing === 'MAN'), changed);
                assert.deepEqual(listed.rows.find(value => value.cod_ing === 'QUE'), {...row, cod_ing: 'QUE'});
                assert.equal((await send('recetas', 'DELETE', {cod_plato: 'EMP', cod_ing: 'MAN'})).status, 204);
                assert.equal((await send('recetas', 'DELETE', {cod_plato: 'EMP', cod_ing: 'QUE'})).status, 204);
            });
            await t.test('dependency previews and failed batches preserve every selected row', async () => {
                for (const cod_ing of ['A1', 'A2']) assert.equal((await send('ingredientes', 'POST', {cod_ing, nombre: cod_ing, unidad: 'u', stock_actual: 1})).status, 204);
                assert.equal((await send('recetas', 'POST', {cod_plato: 'EMP', cod_ing: 'HAR', cantidad: 1})).status, 204);
                const keys = [{cod_ing: 'A1'}, {cod_ing: 'HAR'}];
                const preview = await (await send('ingredientes/delete-check', 'POST', {keys})).json();
                assert.deepEqual(preview.blockers, [{entity: 'recetas', relationship: 'ingrediente', count: 1, keys: [{cod_plato: 'EMP', cod_ing: 'HAR'}]}]);
                assert.equal((await send('ingredientes/bulk-delete', 'POST', {keys})).status, 409);
                assert.equal((await pool.query('SELECT count(*)::int AS count FROM ssot.ingredientes')).rows[0].count, 5);
                assert.equal((await send('ingredientes/bulk-delete', 'POST', {keys: [{cod_ing: 'A1'}, {cod_ing: 'missing'}]})).status, 404);
                assert.equal((await pool.query('SELECT count(*)::int AS count FROM ssot.ingredientes')).rows[0].count, 5);
                assert.equal((await send('ingredientes/bulk-delete', 'POST', {keys: [{cod_ing: 'A1'}, {cod_ing: 'A2'}]})).status, 204);
                assert.deepEqual((await pool.query('SELECT cod_ing FROM ssot.ingredientes ORDER BY cod_ing')).rows, [{cod_ing: 'HAR'}, {cod_ing: 'MAN'}, {cod_ing: 'QUE'}]);
            });
            await t.test('generated keys, timestamps and renamed FK fields follow the SSOT', async () => {
                const order = {cliente_nombre: 'Ana', cliente_email: 'ana@example.com', cliente_telefono: '1', direccion: 'Calle 1',
                    fecha_evento: '2026-11-12T20:00', personas: 10, estado: 'Pendiente', cod_servicio: null, total: 9000, observaciones: null};
                assert.equal((await send('pedidos', 'POST', order)).status, 204);
                const [stored] = (await (await send('pedidos')).json()).rows;
                assert.match(stored.id, /^[0-9a-f-]{36}$/);
                assert.match(stored.creado, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
                assert.equal(stored.fecha_evento, '2026-11-12T20:00:00');
                const line = {pedido: stored.id, cod_plato: 'EMP', porciones: 10, precio_porcion: 900};
                assert.equal((await send('pedido_platos', 'POST', line)).status, 204);
                const keys = [{id: stored.id}];
                const preview = await (await send('pedidos/delete-check', 'POST', {keys})).json();
                assert.equal(preview.blockers[0].entity, 'pedido_platos');
                assert.deepEqual(preview.blockers[0].keys, [{pedido: stored.id, cod_plato: 'EMP'}]);
                assert.equal((await send('pedidos/bulk-delete', 'POST', {keys})).status, 409);
                assert.equal((await send('pedido_platos/bulk-delete', 'POST', {keys: [{pedido: stored.id, cod_plato: 'EMP'}]})).status, 204);
                assert.equal((await send('pedidos/bulk-delete', 'POST', {keys})).status, 204);
            });
            await t.test('SQL-looking input remains data across CRUD, filters, pagination, dependency checks and authentication', async () => {
                await pool.query("INSERT INTO ssot.ingredientes (cod_ing, nombre, unidad, stock_actual) SELECT 'sentinel-' || i, 'Unchanged', 'g', 0 FROM generate_series(1,200) i");
                const baseline = (await pool.query('SELECT cod_ing, nombre FROM ssot.ingredientes ORDER BY cod_ing')).rows;
                const payloads = ["' OR '1'='1", "'); DROP TABLE ssot.ingredientes; --", '"; SELECT pg_sleep(2); --',
                    "/* comment */ UNION SELECT 'secret'", '100%_literal\\value', 'Unicode ＇；--'];
                const query = value => `/api/entities/ingredientes?query=${encodeURIComponent(JSON.stringify(value))}`;
                for (const [index, payload] of payloads.entries()) {
                    const row = {cod_ing: payload, nombre: payload, unidad: 'g', stock_actual: 0};
                    assert.equal((await send('ingredientes', 'POST', row)).status, 204);
                    for (const search of [{filter: payload}, {where: {cod_ing: payload}}]) {
                        const response = await request(query(search));
                        assert.equal(response.status, 200);
                        const result = await response.json();
                        assert.deepEqual(result.rows, [row]);
                        assert.equal(result.window.matched, 1);
                    }
                    const original = await (await request(query({where: {cod_ing: payload}}))).json();
                    const changed = {...row, cod_ing: `changed-${payload}`, nombre: `updated-${payload}`};
                    assert.equal((await send('ingredientes', 'PUT', {key: {cod_ing: payload}, row: changed, version: original.versions[0]})).status, 204);
                    const key = {cod_ing: changed.cod_ing};
                    assert.deepEqual(await (await send('ingredientes/delete-check', 'POST', {keys: [key]})).json(), {blockers: []});
                    const deleted = index % 2 ? await send('ingredientes', 'DELETE', key) : await send('ingredientes/bulk-delete', 'POST', {keys: [key]});
                    assert.equal(deleted.status, 204);
                    for (const search of [{sort: payload}, {direction: payload}, {page: payload}, {where: {[payload]: 'x'}}]) {
                        assert.equal((await request(query(search))).status, 400);
                    }
                    assert.equal((await send(encodeURIComponent(payload))).status, 404);
                    assert.equal((await send('ingredientes', 'POST', {...row, [payload]: true})).status, 400);
                    assert.equal((await send('ingredientes', 'PUT', {key: {cod_ing: '1'}, row: {...row, cod_ing: '1'}, version: payload})).status, 400);
                    const login = await request('/api/auth/login', 'POST', {usuario: 'crud-admin', contrasena: payload.padEnd(12, '-')});
                    assert.equal(login.status, 401);
                    assert.equal((await login.json()).token, undefined);
                    assert.deepEqual((await pool.query('SELECT cod_ing, nombre FROM ssot.ingredientes ORDER BY cod_ing')).rows, baseline);
                }
                for (const name of ['__proto__', 'constructor', 'toString']) {
                    assert.equal((await request(query({where: {[name]: 'injected'}}))).status, 400);
                }
                assert.equal((await pool.query('SELECT count(*)::int AS count FROM ssot.usuarios')).rows[0].count, 1);
            });
        } finally {
            if (child.exitCode === null) child.kill();
            await exited;
        }
    });
});
