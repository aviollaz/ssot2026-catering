import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {versionOf} from './helpers/version.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication, registerAuthApi} from '../dist/backend/auth.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {registerEntityEvents} from '../dist/backend/entity-events.js';
import {entityPage} from '../dist/frontend/entity-query.js';

test('hybrid queries, concurrent saves and live events use the real database', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await initializeUsers(pool, {username: 'reader', password: 'integration-reader-password'});
        const app = express(), auth = createAuthentication(pool, 'integration-query-secret-with-32-bytes');
        const publish = registerEntityEvents(app, auth);
        registerAuthApi(app, pool, auth);
        registerEntityApi(app, pool, auth, publish);
        const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const user = (await pool.query('SELECT id, usuario, version_sesion FROM ssot.usuarios')).rows[0];
        const token = (await auth.issueToken(user)).token;
        const request = (path, method = 'GET', body, signal, jwt = token) => fetch(base + path, {
            method, headers: {'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`},
            ...(body === undefined ? {} : {body: JSON.stringify(body)}), ...(signal ? {signal} : {}),
        });
        const read = async (entity, query = {}) => {
            const response = await request(`/api/entities/${entity}?query=${encodeURIComponent(JSON.stringify(query))}`);
            assert.equal(response.status, 200, await response.clone().text());
            return response.json();
        };
        // The rows inserted by SQL below, as the API returns them.
        const service = (i, descripcion) => ({cod_servicio: 'S' + String(i).padStart(3, '0'), nombre: `Servicio ${i}`,
            descripcion, precio_persona: i, min_personas: 1, activo: true});
        try {
            await t.test('200 rows are complete; 201 are bounded, with matching filter/sort/page semantics', async () => {
                await pool.query(`INSERT INTO ssot.servicios (cod_servicio, nombre, precio_persona, min_personas, activo, descripcion) SELECT 'S' || lpad(i::text, 3, '0'), 'Servicio ' || i, i, 1, true, CASE i % 7 WHEN 0 THEN NULL WHEN 1 THEN 'Álgebra' WHEN 2 THEN 'álgebra' WHEN 3 THEN '100%_literal' WHEN 4 THEN '' WHEN 5 THEN '😀' ELSE 'Zulu' END FROM generate_series(1,200) i`);
                const small = await read('servicios');
                assert.equal(small.window.kind, 'complete');
                assert.equal(small.rows.length, 200);
                assert.equal(small.versions.length, 200);
                await pool.query("INSERT INTO ssot.servicios (cod_servicio, nombre, descripcion, precio_persona, min_personas, activo) VALUES ('S201', 'Servicio 201', 'last', 201, 1, true)");
                const first = await read('servicios');
                assert.deepEqual(first.window, {kind: 'page', total: 201, matched: 201, page: 1});
                assert.equal(first.rows.length, 10);
                const all = {...small, rows: [...small.rows, service(201, 'last')], versions: [...small.versions, 'unused']};
                for (const query of [{page: 2}, {page: 999}, {filter: '%_'}, {filter: 'ÁL'}, {filter: 'missing'},
                    {sort: 'descripcion', direction: 'asc', page: 2}, {sort: 'descripcion', direction: 'desc', page: 3},
                    {sort: 'precio_persona', direction: 'desc'}, {where: {precio_persona: 201}}, {where: {descripcion: null}}, {where: {descripcion: ''}}]) {
                    const actual = await read('servicios', query), expected = entityPage(all, query);
                    assert.deepEqual(actual.rows, expected.rows, JSON.stringify(query));
                    assert.equal(actual.window.matched, expected.matched);
                    assert.equal(actual.window.page, expected.page);
                }
                await pool.query("DELETE FROM ssot.servicios WHERE cod_servicio = 'S201'");
                assert.equal((await read('servicios')).window.kind, 'complete');
            });
            await t.test('unknown/private fields, wrong filter types and unsafe pagination are rejected', async () => {
                for (const query of [{sort: 'contrasena_hash'}, {where: {version_sesion: 'x'}}, {page: 0}, {page: 1.5}, {page: 2 ** 40}, {direction: 'DROP TABLE'}, {unexpected: true}]) {
                    const response = await request(`/api/entities/usuarios?query=${encodeURIComponent(JSON.stringify(query))}`);
                    assert.equal(response.status, 400, JSON.stringify(query));
                }
                assert.equal((await request(`/api/entities/servicios?query=${encodeURIComponent(JSON.stringify({where: {precio_persona: '1'}}))}`)).status, 400);
            });
            await t.test('two users cannot save the same version; deletes and key changes also invalidate it', async () => {
                assert.equal((await request('/api/entities/usuarios', 'POST', {usuario: 'writer', contrasena: 'integration-writer-password'})).status, 204);
                const writer = (await pool.query("SELECT id, usuario, version_sesion FROM ssot.usuarios WHERE usuario='writer'")).rows[0];
                const writerToken = (await auth.issueToken(writer)).token;
                const key = {cod_servicio: 'S001'}, version = versionOf(await read('servicios'), key);
                const responses = await Promise.all([token, writerToken].map((jwt, i) => request('/api/entities/servicios', 'PUT', {key, version, row: service(1, `writer ${i}`)}, undefined, jwt)));
                assert.deepEqual(responses.map(response => response.status).sort(), [204, 409]);
                const current = await read('servicios');
                assert.notEqual(versionOf(current, key), version);
                const stale = await request('/api/entities/servicios', 'PUT', {key, version, row: service(1, 'stale')});
                assert.equal(stale.status, 409);
                assert.match((await stale.json()).error, /borrador/);
                assert.deepEqual((await read('servicios')).rows, current.rows);
                assert.equal((await request('/api/entities/servicios', 'PUT', {key, row: service(1, 'no version')})).status, 400);
                await request('/api/entities/servicios', 'DELETE', key);
                assert.equal((await request('/api/entities/servicios', 'PUT', {key, version: versionOf(current, key), row: service(1, 'deleted')})).status, 409);
            });
            await t.test('authenticated live subscribers receive committed mutations and reconnect invalidations', async () => {
                const abort = new AbortController();
                const stream = await request('/api/events', 'GET', undefined, abort.signal);
                const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
                try {
                    assert.match((await reader.read()).value, /data: null/);
                    assert.equal((await request('/api/entities/servicios', 'POST', service(999, 'live'))).status, 204);
                    assert.match((await reader.read()).value, /data: "servicios"/);
                    assert.ok((await read('servicios')).rows.some(row => row.precio_persona === 999));
                } finally { abort.abort(); await reader.cancel().catch(() => {}); }
                const anonymous = await fetch(base + '/api/events');
                assert.equal(anonymous.status, 401);
            });
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
});
