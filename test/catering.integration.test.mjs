import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication} from '../dist/backend/auth.js';
import {createCustomerAuthentication, registerCustomerAuthApi} from '../dist/backend/customer-auth.js';
import {cargarPedidosEjemplo, crearPedido, registerCateringApi} from '../dist/backend/catering.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {exportarTablas} from '../dist/backend/exportar.js';
import {inflateRawSync} from 'node:zlib';
import {loadTabData} from '../dist/backend/tab-data.js';
import {localDateTime} from '../dist/backend/value-types.js';

const cliente = {cliente_nombre: 'Ana', cliente_email: 'ana@example.com', cliente_telefono: '1', direccion: 'Calle 1', observaciones: null};

// Bread: 1000 g of flour and 5 g of salt make 10 portions; four orders in different states.
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

function unzip(buffer) {
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const files = {};
    for (let i = 0, at = buffer.readUInt32LE(end + 16); i < buffer.readUInt16LE(end + 10); i++) {
        const [size, nameLength, offset] = [buffer.readUInt32LE(at + 20), buffer.readUInt16LE(at + 28), buffer.readUInt32LE(at + 42)];
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
        const start = offset + 30 + buffer.readUInt16LE(offset + 26);
        files[name] = inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
        at += 46 + nameLength;
    }
    return files;
}

test('tables export to an Excel workbook with names instead of codes and without contact data by default', async () => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        const files = unzip(await exportarTablas(pool, ['recetas', 'pedidos']));
        assert.ok(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet2.xml'].every(name => name in files));
        assert.match(files['xl/workbook.xml'], /<sheet name="Recetas" sheetId="1" r:id="rId1"\/><sheet name="Pedidos"/);
        const recetas = files['xl/worksheets/sheet1.xml'];
        // Column labels from the SSOT, the dish and ingredient by name, and quantities as numbers.
        assert.match(recetas, /<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Plato<\/t>/);
        assert.match(recetas, /<t xml:space="preserve">Pan<\/t><\/is><\/c><c r="B\d" t="inlineStr"><is><t xml:space="preserve">Harina<\/t><\/is><\/c><c r="C\d"><v>1000<\/v>/);
        assert.doesNotMatch(files['xl/worksheets/sheet2.xml'], /ana@example\.com|Calle 1/);
        assert.match(unzip(await exportarTablas(pool, ['pedidos'], {contacto: true}))['xl/worksheets/sheet1.xml'], /ana@example\.com/);
        // The sheet's own filters apply across every page.
        const filtrada = unzip(await exportarTablas(pool, ['recetas'], {consulta: {where: {cod_plato: 'OFF'}, sort: 'cod_ing', direction: 'desc'}}));
        assert.equal([...filtrada['xl/worksheets/sheet1.xml'].matchAll(/<row /g)].length, 2);
        for (const [tablas, opciones] of [[['usuarios']], [['recetas', 'recetas']], [[]], [['recetas', 'platos'], {consulta: {}}], [['recetas'], {consulta: {sort: 'nada'}}]]) {
            await assert.rejects(exportarTablas(pool, tablas, opciones), {status: 400}, JSON.stringify(tablas));
        }
    });
});


test('the example orders load through the public order logic', async () => {
    await withTestDatabase(async ({pool}) => {
        await loadTabData(pool, 'examples/data');
        assert.equal(await cargarPedidosEjemplo(pool, 'examples/data/pedidos.json'), 5);
    });
});

test('the public API validates orders against the SSOT and business rules and never exposes personal data', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        await initializeUsers(pool, {username: 'catering-admin', password: 'catering-test-password'});
        const app = express(), auth = createAuthentication(pool, 'catering-test-secret-with-at-least-32-bytes');
        const customerAuth = createCustomerAuthentication(pool, 'catering-test-secret-with-at-least-32-bytes');
        const published = [];
        registerCustomerAuthApi(app, pool, customerAuth);
        registerCateringApi(app, pool, auth, customerAuth, name => published.push(name));
        registerEntityApi(app, pool, auth);
        const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
        t.after(() => new Promise(resolve => server.close(resolve)));
        const base = `http://127.0.0.1:${server.address().port}`;
        const user = (await pool.query('SELECT id, usuario, version_sesion FROM ssot.usuarios')).rows[0];
        const {token} = await auth.issueToken(user);
        const request = (path, body, jwt) => fetch(base + path, body === undefined ? {headers: jwt ? {Authorization: `Bearer ${jwt}`} : {}} : {
            method: 'POST', headers: {'Content-Type': 'application/json', ...(jwt ? {Authorization: `Bearer ${jwt}`} : {})}, body: JSON.stringify(body)});
        const enDias = dias => localDateTime(new Date(Date.now() + dias * 24 * 60 * 60 * 1000));
        const contar = async () => (await pool.query('SELECT count(*)::int AS n FROM ssot.pedidos')).rows[0].n;

        const anonimo = await request('/api/public/pedidos', {...cliente, fecha_evento: enDias(5), personas: 10, cod_servicio: 'S'});
        assert.equal(anonimo.status, 201);
        const pedidoAnonimo = (await anonimo.json()).id;
        assert.deepEqual((await pool.query('SELECT cliente_id FROM ssot.pedidos WHERE id = $1', [pedidoAnonimo])).rows,
            [{cliente_id: null}]);
        const registered = await request('/api/public/auth/register', {email: 'ANA@example.com', contrasena: 'customer-test-password'});
        assert.equal(registered.status, 201);
        const {token: customerToken, customer} = await registered.json();
        assert.equal(customer.email, 'ana@example.com');
        const vinculo = await request(`/api/public/mis-pedidos/${pedidoAnonimo}`, {}, customerToken);
        assert.deepEqual(await vinculo.json(), {associated: true});
        const historial = await request('/api/public/mis-pedidos', undefined, customerToken);
        assert.equal(historial.status, 200);
        assert.deepEqual((await historial.json()).map(pedido => pedido.id), [pedidoAnonimo]);
        assert.deepEqual((await pool.query('SELECT cliente_id FROM ssot.pedidos WHERE id = $1', [pedidoAnonimo])).rows,
            [{cliente_id: customer.id}]);
        published.length = 0;
        assert.equal((await request('/api/entities', undefined, customerToken)).status, 401);
        assert.equal((await request('/api/catering/pedidos', undefined, customerToken)).status, 401);
        assert.equal((await request('/api/public/pedidos', {...cliente, fecha_evento: enDias(5), personas: 10, cod_servicio: 'S'}, token)).status, 401);

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
            const response = await request('/api/public/pedidos', body, customerToken);
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.match((await response.json()).error, message);
        }
        assert.equal(await contar(), antes);
        assert.deepEqual(published, []);

        // The server prices the order and copies the service's dishes into it.
        const created = await request('/api/public/pedidos', valido, customerToken);
        assert.equal(created.status, 201);
        const {id, total} = await created.json();
        assert.equal(total, 5000);
        assert.deepEqual(published, ['pedidos', 'pedido_platos']);
        assert.deepEqual((await pool.query('SELECT estado, cod_servicio, total, cliente_id FROM ssot.pedidos WHERE id = $1', [id])).rows,
            [{estado: 'Pendiente', cod_servicio: 'S', total: 5000, cliente_id: customer.id}]);
        assert.deepEqual((await pool.query('SELECT cod_plato, porciones, precio_porcion FROM ssot.pedido_platos WHERE pedido = $1', [id])).rows,
            [{cod_plato: 'PAN', porciones: 20, precio_porcion: 100}]);
        const carta = await request('/api/public/pedidos', {...cliente, fecha_evento: enDias(5), personas: 3, platos: [{cod_plato: 'PAN', porciones: 7}]}, customerToken);
        assert.equal((await carta.json()).total, 700);

        // The uuid is the secret code; the status response holds no personal data.
        assert.deepEqual(await (await request(`/api/public/pedidos/${id}`)).json(),
            {estado: 'Pendiente', fecha_evento: `${valido.fecha_evento}:00`, personas: 10, total: 5000});
        for (const code of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "' OR '1'='1"]) {
            assert.equal((await request(`/api/public/pedidos/${encodeURIComponent(code)}`)).status, 404);
        }
        assert.equal((await request('/api/public/pedidos')).status, 404);

        // The Excel export requires a session; the business views (purchases, inventory, statistics) are gone.
        for (const path of ['/api/catering/exportar/tablas', '/api/catering/exportar?tablas=platos,pedidos']) {
            assert.equal((await request(path)).status, 401, path);
            assert.equal((await request(path, undefined, token)).status, 200, path);
        }
        for (const path of ['/api/catering/pedidos', `/api/catering/pedidos/${id}/compras`, '/api/catering/estadisticas', '/api/catering/inventario']) {
            assert.equal((await request(path, undefined, token)).status, 404, path);
        }
        // The stock history stays read-only in the generic sheets.
        const send = (path, method, body) => fetch(`${base}/api/entities/${path}`, {method,
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
        assert.equal((await send('movimientos', 'POST', {fecha: '2026-11-01T10:00', tipo: 'Ingreso', pedido: null, facturado: null, anula: null, observaciones: null})).status, 405);
        assert.equal((await (await fetch(`${base}/api/entities/movimientos`, {headers: {Authorization: `Bearer ${token}`}})).json()).readOnly, true);
    });
});
