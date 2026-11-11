import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {cargarPedidosEjemplo, registerPublicApi} from '../dist/backend/catering.js';
import {loadTabData} from '../dist/backend/tab-data.js';
import {localDateTime} from '../dist/backend/value-types.js';

const cliente = {cliente_nombre: 'Ana', cliente_email: 'ana@example.com', cliente_telefono: '1', direccion: 'Calle 1', observaciones: null};

async function fixture(pool) {
    await pool.query(`INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo)
        VALUES ('PAN', 'Pan', NULL, 'Entrada', 10, 100, true), ('OFF', 'Fuera de carta', NULL, 'Postre', 1, 999, false)`);
    await pool.query(`INSERT INTO ssot.servicios (cod_servicio, nombre, descripcion, precio_persona, min_personas, activo)
        VALUES ('S', 'Servicio', 'Pan para todos', 500, 10, true), ('X', 'Inactivo', NULL, 1, 1, false)`);
    await pool.query(`INSERT INTO ssot.servicio_platos (cod_servicio, cod_plato, porciones_por_persona) VALUES ('S', 'PAN', 2), ('X', 'PAN', 1)`);
}

test('the example orders load through the public order logic', async () => {
    await withTestDatabase(async ({pool}) => {
        await loadTabData(pool, 'examples/data');
        assert.equal(await cargarPedidosEjemplo(pool, 'examples/data/pedidos.json'), 5);
    });
});

test('the public API validates orders against the SSOT and business rules and never exposes personal data', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        const app = express();
        const published = [];
        registerPublicApi(app, pool, name => published.push(name));
        const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
        t.after(() => new Promise(resolve => server.close(resolve)));
        const base = `http://127.0.0.1:${server.address().port}`;
        const request = (path, body) => fetch(base + path, body === undefined ? {} : {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const enDias = dias => localDateTime(new Date(Date.now() + dias * 24 * 60 * 60 * 1000));
        const contar = async () => (await pool.query('SELECT count(*)::int AS n FROM ssot.pedidos')).rows[0].n;

        const catalogo = await (await request('/api/public/catalogo')).json();
        assert.deepEqual(catalogo, {
            platos: [{cod_plato: 'PAN', nombre: 'Pan', descripcion: null, categoria: 'Entrada', precio_porcion: 100}],
            servicios: [{cod_servicio: 'S', nombre: 'Servicio', descripcion: 'Pan para todos', precio_persona: 500, min_personas: 10,
                platos: [{cod_plato: 'PAN', nombre: 'Pan', porciones_por_persona: 2}]}],
            anticipacionDias: 3,
        });

        const valido = {...cliente, fecha_evento: enDias(5), personas: 10, cod_servicio: 'S'};
        const antes = await contar();
        for (const [body, message] of [
            [{...valido, fecha_evento: enDias(1)}, /anticipación/],
            [{...valido, personas: 5}, /mínimo de 10/],
            [{...valido, cod_servicio: 'X'}, /no existe o no está disponible/],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: [{cod_plato: 'OFF', porciones: 1}]}, /OFF no existe o no está disponible/],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: [{cod_plato: 'PAN', porciones: 1}, {cod_plato: 'PAN', porciones: 2}]}, /una sola vez/],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: [{cod_plato: 'PAN', porciones: 0}]}, /porciones/i],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: []}, /Elegí entre 1/],
            [{...valido, platos: [{cod_plato: 'PAN', porciones: 1}]}, /servicio o armá/],
            [{...valido, total: 1}, /campos indicados/],
            [{...valido, estado: 'Confirmado'}, /campos indicados/],
            [{...valido, cliente_email: 'sin-arroba'}, /email/],
            [{...valido, fecha_evento: 'mañana'}, /fecha_evento/],
        ]) {
            const response = await request('/api/public/pedidos', body);
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.match((await response.json()).error, message);
        }
        assert.equal(await contar(), antes);
        assert.deepEqual(published, []);

        // The server prices the order and copies the service's dishes into it.
        const created = await request('/api/public/pedidos', valido);
        assert.equal(created.status, 201);
        const {id, total} = await created.json();
        assert.equal(total, 5000);
        assert.deepEqual(published, ['pedidos', 'pedido_platos']);
        assert.deepEqual((await pool.query('SELECT estado, cod_servicio, total FROM ssot.pedidos WHERE id = $1', [id])).rows, [{estado: 'Pendiente', cod_servicio: 'S', total: 5000}]);
        assert.deepEqual((await pool.query('SELECT cod_plato, porciones, precio_porcion FROM ssot.pedido_platos WHERE pedido = $1', [id])).rows,
            [{cod_plato: 'PAN', porciones: 20, precio_porcion: 100}]);
        const carta = await request('/api/public/pedidos', {...cliente, fecha_evento: enDias(5), personas: 3, platos: [{cod_plato: 'PAN', porciones: 7}]});
        assert.equal((await carta.json()).total, 700);

        // The uuid is the secret code; the status response holds no personal data.
        assert.deepEqual(await (await request(`/api/public/pedidos/${id}`)).json(),
            {estado: 'Pendiente', fecha_evento: `${valido.fecha_evento}:00`, personas: 10, total: 5000});
        for (const code of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "' OR '1'='1"]) {
            assert.equal((await request(`/api/public/pedidos/${encodeURIComponent(code)}`)).status, 404);
        }
        assert.equal((await request('/api/public/pedidos')).status, 404);
    });
});
