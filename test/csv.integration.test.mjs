import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication} from '../dist/backend/auth.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {parseCsv, stringifyCsv} from '../dist/backend/csv.js';
import {csvSettings} from '../dist/backend/csv-settings.js';

test('CSV imports use real transactions, SSOT constraints and authenticated API capabilities', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await initializeUsers(pool, {username: 'csv-admin', password: 'csv-test-long-password'});
        const app = express(), auth = createAuthentication(pool, 'csv-test-secret-with-at-least-32-bytes');
        const changes = [];
        registerEntityApi(app, pool, auth, name => changes.push(name));
        const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
        const base = `http://127.0.0.1:${server.address().port}/api/entities`;
        const user = (await pool.query('SELECT id, usuario, version_sesion FROM ssot.usuarios')).rows[0];
        const token = (await auth.issueToken(user)).token;
        const request = (path, text) => fetch(base + path, {method: text === undefined ? 'GET' : 'POST',
            headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv'}, ...(text === undefined ? {} : {body: text})});
        // Dishes differ only in code and description, the nullable text column.
        const dishes = rows => stringifyCsv([['Código', 'Plato', 'Descripción', 'Categoría', 'Porciones por receta', 'Precio por porción', 'Activo'],
            ...rows.map(([code, description]) => [code, 'Plato', description, 'Finger food', 12, 900, true])]);
        try {
            await t.test('capabilities and routes enforce visibility, authentication and upload size', async () => {
                assert.equal((await fetch(`${base}/platos/csv`)).status, 401);
                const users = await (await request('/usuarios')).json();
                assert.deepEqual(users.csv, {export: true, import: false, maxBytes: csvSettings.maxBytes});
                assert.deepEqual(parseCsv(await (await request('/usuarios/csv')).text()), [['Usuario'], ['csv-admin']]);
                assert.equal((await request('/usuarios/csv', 'Usuario\ncsv-admin')).status, 403);
                assert.equal((await request('/platos/csv', '')).status, 400);
                assert.equal((await request('/platos/csv', 'x'.repeat(csvSettings.maxBytes + 1))).status, 413);
                assert.deepEqual(changes, []);
            });
            await t.test('full exports round-trip text, null and SQL-looking values despite paging', async () => {
                const rows = [['empty', ''], ['null', null], ['unicode', 'Dulce 😀, "hola"\nOtra línea'], ["'; DROP TABLE ssot.platos; --", 'data']];
                const response = await request('/platos/csv', dishes(rows));
                assert.equal(response.status, 200, await response.clone().text());
                assert.deepEqual(await response.json(), {inserted: 4, unchanged: 0});
                assert.deepEqual(changes.splice(0), ['platos']);
                await pool.query(`INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo)
                    SELECT 'sentinel-' || i, 'Plato', 'Unchanged', 'Finger food', 12, 900, true FROM generate_series(1,201) i`);
                assert.equal((await (await request('/platos')).json()).window.kind, 'page');
                const exported = await request('/platos/csv');
                assert.match(exported.headers.get('content-type'), /text\/csv/);
                const csv = await exported.text();
                assert.equal(parseCsv(csv).length, 206);
                assert.deepEqual(await (await request('/platos/csv', csv)).json(), {inserted: 0, unchanged: 205});
                assert.deepEqual(changes, []);
                assert.equal((await pool.query("SELECT descripcion FROM ssot.platos WHERE cod_plato = 'empty'")).rows[0].descripcion, '');
                assert.equal((await pool.query("SELECT descripcion FROM ssot.platos WHERE cod_plato = 'null'")).rows[0].descripcion, null);
            });
            await t.test('conflicts roll back earlier inserts without publishing changes', async () => {
                const response = await request('/platos/csv', dishes([['new-before-conflict', 'new'], ['empty', 'changed']]));
                assert.equal(response.status, 409);
                assert.equal((await pool.query("SELECT 1 FROM ssot.platos WHERE cod_plato = 'new-before-conflict'")).rowCount, 0);
                assert.deepEqual(changes, []);
            });
            await t.test('simultaneous identical imports insert once; different data never overwrites', async () => {
                const csv = dishes([['concurrent', 'same']]);
                const responses = await Promise.all([request('/platos/csv', csv), request('/platos/csv', csv)]);
                assert.deepEqual(responses.map(r => r.status), [200, 200]);
                const results = await Promise.all(responses.map(r => r.json()));
                assert.equal(results.reduce((sum, r) => sum + r.inserted, 0), 1);
                assert.deepEqual(changes.splice(0), ['platos']);
                const conflicting = await Promise.all(['first', 'second'].map(value => request('/platos/csv', dishes([['contested', value]]))));
                assert.deepEqual(conflicting.map(r => r.status).sort(), [200, 409]);
                assert.deepEqual(changes.splice(0), ['platos']);
            });
            // Catering's entity validators are on orders and stock movements, whose generated ids keep them out of CSV
            // imports, so this step checks an SSOT value constraint instead.
            await t.test('composite keys, foreign keys and value constraints follow the SSOT', async () => {
                await pool.query("INSERT INTO ssot.ingredientes (cod_ing, nombre, unidad, stock_actual) VALUES ('HAR', 'Harina', 'g', 1000)");
                const headers = parseCsv(await (await request('/recetas/csv')).text())[0];
                assert.deepEqual(headers, ['Plato', 'Ingrediente', 'Cantidad por receta']);
                assert.deepEqual(await (await request('/recetas/csv', stringifyCsv([headers, ['empty', 'HAR', 500]]))).json(), {inserted: 1, unchanged: 0});
                const csv = await (await request('/recetas/csv')).text();
                assert.deepEqual(await (await request('/recetas/csv', csv)).json(), {inserted: 0, unchanged: 1});
                changes.length = 0;
                const invalidReference = await request('/recetas/csv', stringifyCsv([headers, ['null', 'HAR', 100], ['null', 'missing', 100]]));
                assert.equal(invalidReference.status, 400);
                assert.equal((await pool.query("SELECT 1 FROM ssot.recetas WHERE cod_plato = 'null'")).rowCount, 0);
                assert.equal((await request('/recetas/csv', stringifyCsv([headers, ['unicode', 'HAR', -1]]))).status, 400);
                assert.deepEqual(changes, []);
            });
        } finally {
            const closed = new Promise(resolve => server.close(resolve));
            server.closeAllConnections();
            await closed;
        }
    });
});
