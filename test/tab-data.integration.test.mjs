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
        assert.deepEqual((await pool.query("SELECT activo, descripcion IS NOT NULL AS descrito FROM ssot.platos WHERE cod_plato='RAV'")).rows, [{activo: false, descrito: true}]);
        assert.deepEqual((await pool.query("SELECT unidad, unidad_compra FROM ssot.ingredientes WHERE cod_ing='HUE'")).rows, [{unidad: 'u', unidad_compra: 'maple'}]);
        const before = (await pool.query('SELECT * FROM ssot.servicios ORDER BY cod_servicio')).rows;
        await assert.rejects(loadTabData(pool, 'examples/data'), {code: '23505'});
        assert.deepEqual((await pool.query('SELECT * FROM ssot.servicios ORDER BY cod_servicio')).rows, before);
        const directory = await mkdtemp(join(tmpdir(), 'ssot-tab-'));
        try {
            // The first insert succeeds, but a later FK violation must roll it back.
            await writeFile(join(directory, 'servicios.tab'), 'cod_servicio|nombre|descripcion|precio_persona|min_personas|activo\nNEW|Nuevo|\\N|100|1|true\n');
            await writeFile(join(directory, 'servicio_platos.tab'), 'cod_servicio|cod_plato|porciones_por_persona\nNEW|MISSING|1\n');
            await assert.rejects(loadTabData(pool, directory), {code: '23503'});
            assert.deepEqual((await pool.query('SELECT * FROM ssot.servicios ORDER BY cod_servicio')).rows, before);
            await writeFile(join(directory, 'servicio_platos.tab'), 'cod_servicio|cod_plato|porciones_por_persona\nNEW|EMP|1\n');
            await writeFile(join(directory, 'pedido_invitados.tab'), 'pedido|nombre|email\nP1|Ana|sin-arroba\n');
            await assert.rejects(loadTabData(pool, directory), /email/);
            assert.deepEqual((await pool.query('SELECT * FROM ssot.servicios ORDER BY cod_servicio')).rows, before);
            await rm(join(directory, 'pedido_invitados.tab'));
            await writeFile(join(directory, 'servicios.tab'), 'cod_servicio|nombre|descripcion|precio_persona|min_personas|activo\nNEW|Nuevo|\\N|0|1|true\n');
            await assert.rejects(loadTabData(pool, directory), /valor inválido/);
            await writeFile(join(directory, 'servicios.tab'), 'cod_servicio|secret\nNEW|Bad\n');
            await assert.rejects(loadTabData(pool, directory), /columnas/);
        } finally {
            // Exact temporary directory created by this test; no repository or DB data removed.
            await rm(directory, {recursive: true, force: true});
        }
    });
});
