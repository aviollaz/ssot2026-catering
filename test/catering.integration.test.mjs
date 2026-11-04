import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication} from '../dist/backend/auth.js';
import {anularMovimiento, cargarMovimientosEjemplo, opcionesInventario, cargarPedidosEjemplo, comprasDePedido, comprasDePeriodo, crearPedido, estadisticas, historialMovimientos,
    registerCateringApi, registrarMovimiento} from '../dist/backend/catering.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {exportarTablas} from '../dist/backend/exportar.js';
import {inflateRawSync} from 'node:zlib';
import {loadTabData} from '../dist/backend/tab-data.js';
import {localDateTime} from '../dist/backend/value-types.js';

const cliente = {cliente_nombre: 'Ana', cliente_email: 'ana@example.com', cliente_telefono: '1', direccion: 'Calle 1', observaciones: null};

// Bread: 1000 g of flour and 5 g of salt make 10 portions. Stock: 1000 g of flour, 100 g of salt.
// Rows inserted by SQL carry the company by hand; the tests run as the initial one (helpers/database.mjs).
async function fixture(pool) {
    await pool.query(`INSERT INTO ssot.ingredientes (tenant, nombre, unidad, stock_actual) VALUES ('default', 'Harina', 'g', 1000), ('default', 'Sal', 'g', 100)`);
    await pool.query(`INSERT INTO ssot.platos (tenant, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo)
        VALUES ('default', 'Pan', NULL, 'Entrada', 10, 100, true), ('default', 'Fuera de carta', NULL, 'Postre', 1, 999, false)`);
    await pool.query(`INSERT INTO ssot.recetas (tenant, plato, ingrediente, cantidad)
        VALUES ('default', 'Pan', 'Harina', 1000), ('default', 'Pan', 'Sal', 5), ('default', 'Fuera de carta', 'Harina', 1)`);
    await pool.query(`INSERT INTO ssot.servicios (tenant, nombre, descripcion, precio_persona, min_personas, activo)
        VALUES ('default', 'Servicio', 'Pan para todos', 500, 10, true), ('default', 'Inactivo', NULL, 1, 1, false)`);
    await pool.query(`INSERT INTO ssot.servicio_platos (tenant, servicio, plato, porciones_por_persona) VALUES ('default', 'Servicio', 'Pan', 2), ('default', 'Inactivo', 'Pan', 1)`);
    const pedido = (estado, fecha_evento, porciones) =>
        crearPedido(pool, {...cliente, fecha_evento, personas: 1, platos: [{plato: 'Pan', porciones}]}, {estado, ahora: null});
    return {
        A: (await pedido('Confirmado', '2026-11-10T12:00', 6)).id,
        B: (await pedido('Confirmado', '2026-11-20T12:00', 8)).id,
        P: (await pedido('Pendiente', '2026-11-05T12:00', 50)).id,
        C: (await pedido('Cancelado', '2026-11-01T12:00', 50)).id,
    };
}
const resumen = ({ingredientes}) => Object.fromEntries(ingredientes.map(({nombre, stock, necesidad, consumo_previo, faltante, comprar}) =>
    [nombre, {stock, necesidad, consumo_previo, faltante, comprar}]));

test('confirmed orders take the stock in date order and each buys only its own shortfall', async () => {
    await withTestDatabase(async ({pool}) => {
        const {A, B, P} = await fixture(pool);
        assert.deepEqual(resumen(await comprasDePedido(pool, A)), {
            Harina: {stock: 1000, necesidad: 600, consumo_previo: 0, faltante: 0, comprar: 0},
            Sal: {stock: 100, necesidad: 3, consumo_previo: 0, faltante: 0, comprar: 0},
        });
        // B comes after A: 600 g are already taken, so 400 g are left for its 800 g.
        assert.deepEqual(resumen(await comprasDePedido(pool, B)).Harina, {stock: 1000, necesidad: 800, consumo_previo: 600, faltante: 400, comprar: 400});
        // The earlier pending (and cancelled) orders reserve nothing; a pending order is previewed as if confirmed.
        assert.deepEqual(resumen(await comprasDePedido(pool, P)).Harina, {stock: 1000, necesidad: 5000, consumo_previo: 0, faltante: 4000, comprar: 4000});
        assert.deepEqual(resumen(await comprasDePeriodo(pool, '2026-11-15', '2026-11-30')).Harina, {stock: 1000, necesidad: 800, consumo_previo: 600, faltante: 400, comprar: 400});
        assert.deepEqual(resumen(await comprasDePeriodo(pool, '2026-11-01', '2026-11-30')).Harina, {stock: 1000, necesidad: 1400, consumo_previo: 0, faltante: 400, comprar: 400});
        assert.deepEqual((await comprasDePeriodo(pool, '2026-12-01', '2026-12-31')).ingredientes, []);
        await assert.rejects(comprasDePedido(pool, '00000000-0000-4000-8000-000000000000'), {status: 404});
    });
});

test('recipes accept fractional quantities and purchases round them up', async () => {
    await withTestDatabase(async ({pool}) => {
        const {A} = await fixture(pool);
        // Half an egg per bread: A's 6 portions need 3 eggs, and 0.25 g of salt per 10 portions rounds up to 1 g.
        await pool.query(`INSERT INTO ssot.ingredientes (tenant, nombre, unidad, stock_actual) VALUES ('default', 'Huevo', 'u', 0)`);
        await pool.query(`INSERT INTO ssot.recetas (tenant, plato, ingrediente, cantidad) VALUES ('default', 'Pan', 'Huevo', 5)`);
        await pool.query(`UPDATE ssot.recetas SET cantidad = 0.25 WHERE plato = 'Pan' AND ingrediente = 'Sal'`);
        assert.deepEqual((await pool.query(`SELECT cantidad FROM ssot.recetas WHERE ingrediente = 'Sal' AND plato = 'Pan'`)).rows, [{cantidad: 0.25}]);
        const {Huevo: HUE, Sal: SAL} = resumen(await comprasDePedido(pool, A));
        assert.deepEqual(HUE, {stock: 0, necesidad: 3, consumo_previo: 0, faltante: 3, comprar: 3});
        assert.deepEqual(SAL, {stock: 100, necesidad: 1, consumo_previo: 0, faltante: 0, comprar: 0});
    });
});

const stock = async pool => Object.fromEntries((await pool.query('SELECT nombre, stock_actual FROM ssot.ingredientes ORDER BY nombre')).rows
    .map(row => [row.nombre, row.stock_actual]));
const estado = async (pool, id) => (await pool.query('SELECT estado FROM ssot.pedidos WHERE id = $1', [id])).rows[0].estado;
const egreso = (pedido, porciones, extra = {}) => ({tipo: 'Egreso', pedido, platos: [{plato: 'Pan', porciones}], ...extra});

test('an Egreso takes the dishes actually made out of the stock and delivers the order', async () => {
    await withTestDatabase(async ({pool}) => {
        const {A, B, P} = await fixture(pool);
        await assert.rejects(registrarMovimiento(pool, egreso(P, 1)), {status: 409});
        // A quoted 6 portions but only 4 were made: the preview shows the change and saves nothing.
        const vista = await registrarMovimiento(pool, egreso(A, 4), {simular: true});
        assert.deepEqual(vista.ingredientes, [{ingrediente: 'Harina', cantidad: -400}, {ingrediente: 'Sal', cantidad: -2}]);
        assert.deepEqual(await stock(pool), {Harina: 1000, Sal: 100});
        assert.equal(await estado(pool, A), 'Confirmado');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM ssot.movimientos')).rows[0].n, 0);

        const {ingredientes} = await registrarMovimiento(pool, egreso(A, 4, {facturado: 500, observaciones: 'Faltaron 2 invitados'}));
        assert.deepEqual(ingredientes, [{ingrediente: 'Harina', cantidad: -400}, {ingrediente: 'Sal', cantidad: -2}]);
        assert.deepEqual(await stock(pool), {Harina: 600, Sal: 98});
        assert.equal(await estado(pool, A), 'Entregado');
        await assert.rejects(registrarMovimiento(pool, egreso(A, 4)), {status: 409});
        // A delivered order already left the stock, so it no longer counts as previous consumption.
        assert.deepEqual(resumen(await comprasDePedido(pool, B)).Harina, {stock: 600, necesidad: 800, consumo_previo: 0, faltante: 200, comprar: 200});
        // The real billing replaces the quote in the statistics: 500 for A plus B's 800.
        assert.equal((await estadisticas(pool)).porMes[0].facturacion, 1300);

        // Without an order (a spontaneous sale): stock never goes below 0, and the ledger keeps what actually changed.
        const espontaneo = await registrarMovimiento(pool, egreso(null, 100));
        assert.deepEqual(espontaneo.ingredientes, [{ingrediente: 'Harina', cantidad: -600}, {ingrediente: 'Sal', cantidad: -50}]);
        assert.deepEqual(await stock(pool), {Harina: 0, Sal: 48});
        assert.deepEqual((await pool.query('SELECT ingrediente, cantidad FROM ssot.movimiento_ingredientes WHERE movimiento = $1 ORDER BY ingrediente', [espontaneo.id])).rows,
            [{ingrediente: 'Harina', cantidad: -600}, {ingrediente: 'Sal', cantidad: -50}]);

        for (const [body, message] of [
            [{tipo: 'Egreso', ingredientes: [{ingrediente: 'Harina', cantidad: 1}]}, /platos que se hicieron/],
            [{tipo: 'Ingreso', pedido: B, ingredientes: [{ingrediente: 'Harina', cantidad: 1}]}, /solo un egreso se asocia/],
            [{tipo: 'Merma', facturado: 10, ingredientes: [{ingrediente: 'Harina', cantidad: 1}]}, /solo un egreso registra/],
            [{tipo: 'Anulación', ingredientes: [{ingrediente: 'Harina', cantidad: 1}]}, /una anulación indica/],
            [egreso(null, 1, {platos: [{plato: 'NADA', porciones: 1}]}), /NADA no existe/],
            [egreso(null, 0), /porciones/],
            [{tipo: 'Egreso', platos: []}, /entre 1 y/],
        ]) await assert.rejects(registrarMovimiento(pool, body), error => error.status === 400 && message.test(error.message), JSON.stringify(body));
    });
});

test('Ingreso, Merma and Ajuste use any unit of the ingredient and record the change', async () => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        await pool.query(`INSERT INTO ssot.unidades (tenant, nombre, base, factor) VALUES ('default', 'kg', 'g', 1000), ('default', 'l', 'ml', 1000)`);
        const movimiento = (tipo, ingredientes) => registrarMovimiento(pool, {tipo, ingredientes});
        assert.deepEqual((await movimiento('Ingreso', [{ingrediente: 'Harina', cantidad: 2.5, unidad: 'kg'}, {ingrediente: 'Sal', cantidad: 50}])).ingredientes,
            [{ingrediente: 'Harina', cantidad: 2500}, {ingrediente: 'Sal', cantidad: 50}]);
        assert.deepEqual((await movimiento('Merma', [{ingrediente: 'Sal', cantidad: 10, unidad: 'g'}])).ingredientes, [{ingrediente: 'Sal', cantidad: -10}]);
        assert.deepEqual(await stock(pool), {Harina: 3500, Sal: 140});
        // An Ajuste is the counted stock: the ledger keeps the difference, and nothing when it matches.
        assert.deepEqual((await movimiento('Ajuste', [{ingrediente: 'Harina', cantidad: 3, unidad: 'kg'}, {ingrediente: 'Sal', cantidad: 140}])).ingredientes,
            [{ingrediente: 'Harina', cantidad: -500}]);
        assert.deepEqual(await stock(pool), {Harina: 3000, Sal: 140});
        // The stock loaded by hand (1000 g and 100 g in the fixture) is what the history does not explain.
        const historial = Object.fromEntries((await opcionesInventario(pool)).ingredientes.map(i => [i.nombre, [i.stock_actual, i.historial]]));
        assert.deepEqual(historial, {Harina: [3000, 2000], Sal: [140, 40]});
        for (const [tipo, lineas, message] of [
            ['Ingreso', [{ingrediente: 'Harina', cantidad: 1, unidad: 'l'}], /no sirve para Harina/],
            ['Ingreso', [{ingrediente: 'Harina', cantidad: 1, unidad: 'pallet'}], /no sirve para Harina/],
            ['Ingreso', [{ingrediente: 'NADA', cantidad: 1}], /NADA no existe/],
            ['Merma', [{ingrediente: 'Harina', cantidad: 0}], /mayores que 0/],
            ['Ajuste', [{ingrediente: 'Harina', cantidad: -1}], /negativo/],
            ['Ingreso', [{ingrediente: 'Harina', cantidad: 1}, {ingrediente: 'Harina', cantidad: 2}], /una sola vez/],
        ]) await assert.rejects(movimiento(tipo, lineas), error => error.status === 400 && message.test(error.message), tipo);
        assert.deepEqual(await stock(pool), {Harina: 3000, Sal: 140});
        assert.deepEqual((await historialMovimientos(pool)).map(m => m.tipo).sort(), ['Ajuste', 'Ingreso', 'Merma']);
    });
});

test('annulling a movement reverses its stock change and returns its order to Confirmado', async () => {
    await withTestDatabase(async ({pool}) => {
        const {A} = await fixture(pool);
        const {id} = await registrarMovimiento(pool, egreso(A, 6));
        assert.deepEqual(await stock(pool), {Harina: 400, Sal: 97});
        const anulacion = await anularMovimiento(pool, id);
        assert.deepEqual(anulacion.ingredientes, [{ingrediente: 'Harina', cantidad: 600}, {ingrediente: 'Sal', cantidad: 3}]);
        assert.deepEqual(await stock(pool), {Harina: 1000, Sal: 100});
        assert.equal(await estado(pool, A), 'Confirmado');
        await assert.rejects(anularMovimiento(pool, id), {status: 409});
        await assert.rejects(anularMovimiento(pool, anulacion.id), {status: 409});
        await assert.rejects(anularMovimiento(pool, '00000000-0000-4000-8000-000000000000'), {status: 404});
        const historial = await historialMovimientos(pool);
        assert.deepEqual(historial.find(m => m.tipo === 'Anulación').anula, id);
        assert.equal(historial.find(m => m.id === id).anulado, true);
        // The order can now be delivered again with its real dishes.
        await registrarMovimiento(pool, egreso(A, 5));
        assert.equal(await estado(pool, A), 'Entregado');
    });
});

// Reads back every entry of a zip through its central directory, as Excel does.
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
        const filtrada = unzip(await exportarTablas(pool, ['recetas'], {consulta: {where: {plato: 'Fuera de carta'}, sort: 'ingrediente', direction: 'desc'}}));
        assert.equal([...filtrada['xl/worksheets/sheet1.xml'].matchAll(/<row /g)].length, 2);
        for (const [tablas, opciones] of [[['usuarios']], [['recetas', 'recetas']], [[]], [['recetas', 'platos'], {consulta: {}}], [['recetas'], {consulta: {sort: 'nada'}}]]) {
            await assert.rejects(exportarTablas(pool, tablas, opciones), {status: 400}, JSON.stringify(tablas));
        }
    });
});

test('statistics group orders by state, month and dish', async () => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        assert.deepEqual(await estadisticas(pool), {
            porEstado: [{estado: 'Cancelado', pedidos: 1}, {estado: 'Confirmado', pedidos: 2}, {estado: 'Pendiente', pedidos: 1}],
            porMes: [{mes: '2026-11', pedidos: 2, facturacion: 1400, personas: 2}],
            platosMasPedidos: [{plato: 'Pan', porciones: 64, pedidos: 3}],
        });
    });
});

test('the example data reproduces the documented purchase calculation', async () => {
    await withTestDatabase(async ({pool}) => {
        await loadTabData(pool, 'examples/data');
        assert.equal(await cargarPedidosEjemplo(pool, 'examples/data/pedidos.json'), 5);
        // A purchase of water comes in bidones of 6 l.
        assert.equal(await cargarMovimientosEjemplo(pool, 'examples/data/movimientos.json'), 1);
        assert.equal((await pool.query("SELECT stock_actual FROM ssot.ingredientes WHERE nombre = 'Agua mineral'")).rows[0].stock_actual, 32000);
        const {rows} = await pool.query("SELECT id, cliente_nombre FROM ssot.pedidos WHERE estado = 'Confirmado' ORDER BY fecha_evento");
        const [ana, bruno] = await Promise.all(rows.map(row => comprasDePedido(pool, row.id).then(resumen)));
        assert.deepEqual(rows.map(row => row.cliente_nombre), ['Ana Gómez', 'Bruno Díaz']);
        assert.deepEqual([ana.Huevo.comprar, bruno.Huevo.comprar], [9, 28]);
        // Bruno's order buys only its share; together with Ana's 9 the eggs missing so far are 37.
        assert.equal(bruno.Huevo.faltante, 37);
        assert.deepEqual([ana['Queso cremoso'].comprar, bruno['Queso cremoso'].comprar], [0, 2500]);
    });
});

test('the public API validates orders against the SSOT and business rules and never exposes personal data', {timeout: 60000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await fixture(pool);
        await initializeUsers(pool, {username: 'catering-admin', password: 'catering-test-password'});
        const app = express(), auth = createAuthentication(pool, 'catering-test-secret-with-at-least-32-bytes');
        const published = [];
        registerCateringApi(app, pool, auth, name => published.push(name));
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

        // Each company has its own public page: without it, or with one that does not exist, there is no catalog.
        assert.equal((await request('/api/public/catalogo')).status, 404);
        assert.equal((await request('/api/public/catalogo?empresa=otra')).status, 404);
        const catalogo = await (await request('/api/public/catalogo?empresa=default')).json();
        assert.deepEqual(catalogo, {
            empresa: 'Mi empresa',
            platos: [{nombre: 'Pan', descripcion: null, categoria: 'Entrada', precio_porcion: 100}],
            servicios: [{nombre: 'Servicio', descripcion: 'Pan para todos', precio_persona: 500, min_personas: 10,
                platos: [{plato: 'Pan', porciones_por_persona: 2}]}],
            anticipacionDias: 3,
        });

        const valido = {...cliente, fecha_evento: enDias(5), personas: 10, servicio: 'Servicio'};
        const antes = await contar();
        for (const [body, message] of [
            [{...valido, fecha_evento: enDias(1)}, /anticipación/],
            [{...valido, personas: 5}, /mínimo de 10/],
            [{...valido, servicio: 'Inactivo'}, /no existe o no está disponible/],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: [{plato: 'Fuera de carta', porciones: 1}]}, /Fuera de carta no existe o no está disponible/],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: [{plato: 'Pan', porciones: 1}, {plato: 'Pan', porciones: 2}]}, /una sola vez/],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: [{plato: 'Pan', porciones: 0}]}, /porciones/i],
            [{...cliente, fecha_evento: enDias(5), personas: 2, platos: []}, /Elegí entre 1/],
            [{...valido, platos: [{plato: 'Pan', porciones: 1}]}, /servicio o armá/],
            [{...valido, total: 1}, /campos indicados/],
            [{...valido, estado: 'Confirmado'}, /campos indicados/],
            [{...valido, cliente_email: 'sin-arroba'}, /email/],
            [{...valido, fecha_evento: 'mañana'}, /fecha_evento/],
        ]) {
            const response = await request('/api/public/pedidos?empresa=default', body);
            assert.equal(response.status, 400, JSON.stringify(body));
            assert.match((await response.json()).error, message);
        }
        assert.equal(await contar(), antes);
        assert.deepEqual(published, []);

        // The server prices the order and copies the service's dishes into it.
        const created = await request('/api/public/pedidos?empresa=default', valido);
        assert.equal(created.status, 201);
        const {id, total} = await created.json();
        assert.equal(total, 5000);
        assert.deepEqual(published, ['pedidos', 'pedido_platos']);
        assert.deepEqual((await pool.query('SELECT estado, servicio, total FROM ssot.pedidos WHERE id = $1', [id])).rows, [{estado: 'Pendiente', servicio: 'Servicio', total: 5000}]);
        assert.deepEqual((await pool.query('SELECT plato, porciones, precio_porcion FROM ssot.pedido_platos WHERE pedido = $1', [id])).rows,
            [{plato: 'Pan', porciones: 20, precio_porcion: 100}]);
        const carta = await request('/api/public/pedidos?empresa=default', {...cliente, fecha_evento: enDias(5), personas: 3, platos: [{plato: 'Pan', porciones: 7}]});
        assert.equal((await carta.json()).total, 700);

        // The order code is the secret; the status response holds no personal data.
        assert.deepEqual(await (await request(`/api/public/pedidos/${id}?empresa=default`)).json(),
            {estado: 'Pendiente', fecha_evento: `${valido.fecha_evento}:00`, personas: 10, total: 5000});
        for (const code of ['AAAA-AAAA', 'not-a-code', "' OR '1'='1"]) {
            assert.equal((await request(`/api/public/pedidos/${encodeURIComponent(code)}?empresa=default`)).status, 404);
        }
        assert.equal((await request('/api/public/pedidos')).status, 404);

        // Purchases, inventory and statistics require a session.
        for (const path of ['/api/catering/pedidos', `/api/catering/pedidos/${id}/compras`, `/api/catering/pedidos/${id}/egreso`, '/api/catering/estadisticas',
            '/api/catering/compras?desde=2026-11-01&hasta=2026-11-30', '/api/catering/inventario', '/api/catering/movimientos',
            '/api/catering/exportar/tablas', '/api/catering/exportar?tablas=platos,pedidos']) {
            assert.equal((await request(path)).status, 401, path);
            assert.equal((await request(path, undefined, token)).status, 200, path);
        }
        const entrega = {tipo: 'Egreso', pedido: id, platos: [{plato: 'Pan', porciones: 20}]};
        assert.equal((await request('/api/catering/movimientos', entrega)).status, 401);
        // A pending order cannot be delivered, and nothing is published.
        published.length = 0;
        assert.equal((await request('/api/catering/movimientos', entrega, token)).status, 409);
        assert.equal((await request('/api/catering/movimientos/simular', {...entrega, pedido: null}, token)).status, 200);
        assert.deepEqual(published, []);
        const ingreso = await request('/api/catering/movimientos', {tipo: 'Ingreso', ingredientes: [{ingrediente: 'Sal', cantidad: 1}]}, token);
        assert.equal(ingreso.status, 201);
        assert.ok(published.includes('ingredientes') && published.includes('movimientos'));
        assert.equal((await request(`/api/catering/movimientos/${(await ingreso.json()).id}/anular`, {}, token)).status, 201);
        // The movement history is written only by the inventory endpoints, never by the generic sheets.
        const send = (path, method, body) => fetch(`${base}/api/entities/${path}`, {method,
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify(body)});
        assert.equal((await send('movimientos', 'POST', {fecha: '2026-11-01T10:00', tipo: 'Ingreso', pedido: null, facturado: null, anula: null, observaciones: null})).status, 405);
        assert.equal((await send('movimiento_ingredientes', 'DELETE', {movimiento: id, ingrediente: 'Sal'})).status, 405);
        const movimientosSheet = await (await fetch(`${base}/api/entities/movimientos`, {headers: {Authorization: `Bearer ${token}`}})).json();
        assert.equal(movimientosSheet.readOnly, true);
        assert.equal((await request('/api/catering/compras?desde=hoy&hasta=2026-11-30', undefined, token)).status, 400);
        const pendientes = await (await request('/api/catering/pedidos', undefined, token)).json();
        assert.ok(pendientes.every(pedido => ['Pendiente', 'Confirmado'].includes(pedido.estado)));
        assert.ok(pendientes.some(pedido => pedido.id === id));
    });
});
