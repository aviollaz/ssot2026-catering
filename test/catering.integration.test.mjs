import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication} from '../dist/backend/auth.js';
import {cargarPedidosEjemplo, comprasDePedido, comprasDePeriodo, crearPedido, entregarPedido, estadisticas, registerCateringApi} from '../dist/backend/catering.js';
import {loadTabData} from '../dist/backend/tab-data.js';
import {localDateTime} from '../dist/backend/value-types.js';

const cliente = {cliente_nombre: 'Ana', cliente_email: 'ana@example.com', cliente_telefono: '1', direccion: 'Calle 1', observaciones: null};

// Bread: 1000 g of flour and 5 g of salt make 10 portions. Stock: 1000 g of flour, 100 g of salt.
async function fixture(pool) {
    await pool.query(`INSERT INTO ssot.ingredientes (cod_ing, nombre, unidad, stock_actual) VALUES ('HAR', 'Harina', 'g', 1000), ('SAL', 'Sal', 'g', 100)`);
    await pool.query(`INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo)
        VALUES ('PAN', 'Pan', NULL, 'Entrada', 10, 100, true), ('OFF', 'Fuera de carta', NULL, 'Postre', 1, 999, false)`);
    await pool.query(`INSERT INTO ssot.recetas (cod_plato, cod_ing, cantidad) VALUES ('PAN', 'HAR', 1000), ('PAN', 'SAL', 5), ('OFF', 'HAR', 1)`);
    await pool.query(`INSERT INTO ssot.servicios (cod_servicio, nombre, descripcion, precio_persona, min_personas, activo)
        VALUES ('S', 'Servicio', 'Pan para todos', 500, 10, true), ('X', 'Inactivo', NULL, 1, 1, false)`);
    await pool.query(`INSERT INTO ssot.servicio_platos (cod_servicio, cod_plato, porciones_por_persona) VALUES ('S', 'PAN', 2), ('X', 'PAN', 1)`);
    const pedido = (estado, fecha_evento, porciones) =>
        crearPedido(pool, {...cliente, fecha_evento, personas: 1, platos: [{cod_plato: 'PAN', porciones}]}, {estado, ahora: null});
    return {
        A: (await pedido('Confirmado', '2026-11-10T12:00', 6)).id,
        B: (await pedido('Confirmado', '2026-11-20T12:00', 8)).id,
        P: (await pedido('Pendiente', '2026-11-05T12:00', 50)).id,
        C: (await pedido('Cancelado', '2026-11-01T12:00', 50)).id,
    };
}
const resumen = ({ingredientes}) => Object.fromEntries(ingredientes.map(({cod_ing, stock, necesidad, consumo_previo, comprar}) =>
    [cod_ing, {stock, necesidad, consumo_previo, comprar}]));

test('confirmed orders take the stock in date order and each buys only its own shortfall', async () => {
    await withTestDatabase(async ({pool}) => {
        const {A, B, P} = await fixture(pool);
        assert.deepEqual(resumen(await comprasDePedido(pool, A)), {
            HAR: {stock: 1000, necesidad: 600, consumo_previo: 0, comprar: 0},
            SAL: {stock: 100, necesidad: 3, consumo_previo: 0, comprar: 0},
        });
        // B comes after A: 600 g are already taken, so 400 g are left for its 800 g.
        assert.deepEqual(resumen(await comprasDePedido(pool, B)).HAR, {stock: 1000, necesidad: 800, consumo_previo: 600, comprar: 400});
        // The earlier pending (and cancelled) orders reserve nothing; a pending order is previewed as if confirmed.
        assert.deepEqual(resumen(await comprasDePedido(pool, P)).HAR, {stock: 1000, necesidad: 5000, consumo_previo: 0, comprar: 4000});
        assert.deepEqual(resumen(await comprasDePeriodo(pool, '2026-11-15', '2026-11-30')).HAR, {stock: 1000, necesidad: 800, consumo_previo: 600, comprar: 400});
        assert.deepEqual(resumen(await comprasDePeriodo(pool, '2026-11-01', '2026-11-30')).HAR, {stock: 1000, necesidad: 1400, consumo_previo: 0, comprar: 400});
        assert.deepEqual((await comprasDePeriodo(pool, '2026-12-01', '2026-12-31')).ingredientes, []);
        await assert.rejects(comprasDePedido(pool, '00000000-0000-4000-8000-000000000000'), {status: 404});
    });
});

test('delivering an order takes its consumption out of the stock in the same transaction', async () => {
    await withTestDatabase(async ({pool}) => {
        const {A, B, P} = await fixture(pool);
        await assert.rejects(entregarPedido(pool, P), {status: 409});
        assert.deepEqual(await entregarPedido(pool, A), {consumo: [{cod_ing: 'HAR', cantidad: 600}, {cod_ing: 'SAL', cantidad: 3}]});
        assert.deepEqual((await pool.query('SELECT cod_ing, stock_actual FROM ssot.ingredientes ORDER BY cod_ing')).rows,
            [{cod_ing: 'HAR', stock_actual: 400}, {cod_ing: 'SAL', stock_actual: 97}]);
        assert.deepEqual((await pool.query('SELECT estado FROM ssot.pedidos WHERE id = $1', [A])).rows, [{estado: 'Entregado'}]);
        // A delivered order already left the stock, so it no longer counts as previous consumption.
        assert.deepEqual(resumen(await comprasDePedido(pool, B)).HAR, {stock: 400, necesidad: 800, consumo_previo: 0, comprar: 400});
        await assert.rejects(entregarPedido(pool, A), {status: 409});
        // Stock never goes below zero, even when the missing purchase was not loaded.
        await entregarPedido(pool, B);
        assert.equal((await pool.query("SELECT stock_actual FROM ssot.ingredientes WHERE cod_ing = 'HAR'")).rows[0].stock_actual, 0);
    });
});

test('statistics group orders by state, month and dish', async () => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        assert.deepEqual(await estadisticas(pool), {
            porEstado: [{estado: 'Cancelado', pedidos: 1}, {estado: 'Confirmado', pedidos: 2}, {estado: 'Pendiente', pedidos: 1}],
            porMes: [{mes: '2026-11', pedidos: 2, facturacion: 1400, personas: 2}],
            platosMasPedidos: [{cod_plato: 'PAN', nombre: 'Pan', porciones: 64, pedidos: 3}],
        });
    });
});

test('the example data reproduces the documented purchase calculation', async () => {
    await withTestDatabase(async ({pool}) => {
        await loadTabData(pool, 'examples/data');
        assert.equal(await cargarPedidosEjemplo(pool, 'examples/data/pedidos.json'), 5);
        const {rows} = await pool.query("SELECT id, cliente_nombre FROM ssot.pedidos WHERE estado = 'Confirmado' ORDER BY fecha_evento");
        const [ana, bruno] = await Promise.all(rows.map(row => comprasDePedido(pool, row.id).then(resumen)));
        assert.deepEqual(rows.map(row => row.cliente_nombre), ['Ana Gómez', 'Bruno Díaz']);
        assert.deepEqual([ana.HUE.comprar, bruno.HUE.comprar], [9, 28]);
        assert.deepEqual([ana.QUE.comprar, bruno.QUE.comprar], [0, 2500]);
    });
});

test('the public API validates orders against the SSOT and business rules and never exposes personal data', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        await initializeUsers(pool, {username: 'catering-admin', password: 'catering-test-password'});
        const app = express(), auth = createAuthentication(pool, 'catering-test-secret-with-at-least-32-bytes');
        const published = [];
        registerCateringApi(app, pool, auth, name => published.push(name));
        const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
        t.after(() => new Promise(resolve => server.close(resolve)));
        const base = `http://127.0.0.1:${server.address().port}`;
        const user = (await pool.query('SELECT id, usuario, version_sesion FROM ssot.usuarios')).rows[0];
        const {token} = await auth.issueToken(user);
        const request = (path, body, jwt) => fetch(base + path, body === undefined ? {headers: jwt ? {Authorization: `Bearer ${jwt}`} : {}} : {
            method: 'POST', headers: {'Content-Type': 'application/json', ...(jwt ? {Authorization: `Bearer ${jwt}`} : {})}, body: JSON.stringify(body)});
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

        // Purchases, deliveries and statistics require a session.
        for (const path of ['/api/catering/pedidos', `/api/catering/pedidos/${id}/compras`, '/api/catering/estadisticas', '/api/catering/compras?desde=2026-11-01&hasta=2026-11-30']) {
            assert.equal((await request(path)).status, 401, path);
            assert.equal((await request(path, undefined, token)).status, 200, path);
        }
        assert.equal((await request(`/api/catering/pedidos/${id}/entregar`, {})).status, 401);
        assert.equal((await request(`/api/catering/pedidos/${id}/entregar`, {}, token)).status, 409);
        assert.equal((await request('/api/catering/compras?desde=hoy&hasta=2026-11-30', undefined, token)).status, 400);
        const pendientes = await (await request('/api/catering/pedidos', undefined, token)).json();
        assert.ok(pendientes.every(pedido => ['Pendiente', 'Confirmado'].includes(pedido.estado)));
        assert.ok(pendientes.some(pedido => pedido.id === id));
    });
});
