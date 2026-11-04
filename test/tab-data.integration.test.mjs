import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withTestDatabase} from './helpers/database.mjs';
import {loadTabData} from '../dist/backend/tab-data.js';

test('tab-plus imports use SSOT types, FK order and atomic app-user writes', async () => {
    await withTestDatabase(async ({pool}) => {
        assert.equal(await loadTabData(pool, 'examples/data'), 59);
        assert.deepEqual((await pool.query("SELECT activo, descripcion IS NOT NULL AS descrito FROM ssot.platos WHERE nombre='Ravioles de ricota'")).rows, [{activo: false, descrito: true}]);
        assert.deepEqual((await pool.query("SELECT unidad, stock_actual, unidad_compra FROM ssot.ingredientes WHERE nombre='Huevo'")).rows, [{unidad: 'u', stock_actual: 30, unidad_compra: 'Maple (30 u)'}]);
        const before = (await pool.query('SELECT * FROM ssot.servicios ORDER BY nombre')).rows;
        await assert.rejects(loadTabData(pool, 'examples/data'), {code: '23505'});
        assert.deepEqual((await pool.query('SELECT * FROM ssot.servicios ORDER BY nombre')).rows, before);
        const directory = await mkdtemp(join(tmpdir(), 'ssot-tab-'));
        try {
            // The first insert succeeds, but a later FK violation must roll it back.
            await writeFile(join(directory, 'servicios.tab'), 'nombre|descripcion|precio_persona|min_personas|activo\nNEW|\\N|100|1|true\n');
            await writeFile(join(directory, 'servicio_platos.tab'), 'servicio|plato|porciones_por_persona\nNEW|MISSING|1\n');
            await assert.rejects(loadTabData(pool, directory), {code: '23503'});
            assert.deepEqual((await pool.query('SELECT * FROM ssot.servicios ORDER BY nombre')).rows, before);
            await writeFile(join(directory, 'servicio_platos.tab'), 'servicio|plato|porciones_por_persona\nNEW|Empanadas de jamón y queso|1\n');
            await writeFile(join(directory, 'pedidos.tab'), 'cliente_nombre|cliente_email|cliente_telefono|direccion|fecha_evento|personas|estado|servicio|total|observaciones\n' +
                'Ana|sin-arroba|1|Calle 1|2026-11-12T20:00|10|Pendiente|NEW|1000|\\N\n');
            await assert.rejects(loadTabData(pool, directory), /email/);
            assert.deepEqual((await pool.query('SELECT * FROM ssot.servicios ORDER BY nombre')).rows, before);
            await rm(join(directory, 'pedidos.tab'));
            await writeFile(join(directory, 'servicios.tab'), 'nombre|descripcion|precio_persona|min_personas|activo\nNEW|\\N|0|1|true\n');
            await assert.rejects(loadTabData(pool, directory), /valor inválido/);
            await writeFile(join(directory, 'servicios.tab'), 'nombre|secret\nNEW|Bad\n');
            await assert.rejects(loadTabData(pool, directory), /columnas/);
        } finally {
            // Exact temporary directory created by this test; no repository or DB data removed.
            await rm(directory, {recursive: true, force: true});
        }
    });
});
