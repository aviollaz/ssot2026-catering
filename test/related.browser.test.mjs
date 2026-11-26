import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {withTestDatabase} from './helpers/database.mjs';
import {withBrowser, pageActions, until} from './helpers/browser.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication, registerAuthApi} from '../dist/backend/auth.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {registerEntityEvents} from '../dist/backend/entity-events.js';

// A dish with 201 of 202 ingredients in its recipe. Dishes are also referenced by orders, services and stock movements,
// so the review shows one section per relationship; the steps follow the recipe's.
test('related records page, cache and refresh through the real API', {timeout: 90000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await initializeUsers(pool, {username: 'browser', password: 'browser-test-password'});
        await pool.query(`INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo)
            VALUES ('EMP', 'Original', NULL, 'Finger food', 12, 900, true)`);
        await pool.query(`INSERT INTO ssot.ingredientes (cod_ing, nombre, unidad, stock_actual)
            SELECT 'I' || lpad(n::text, 3, '0'), 'Ingrediente ' || n, 'g', 0 FROM generate_series(1, 202) n`);
        await pool.query(`INSERT INTO ssot.recetas (cod_plato, cod_ing, cantidad)
            SELECT 'EMP', cod_ing, 500 FROM ssot.ingredientes WHERE cod_ing <> 'I202'`);
        const app = express(), auth = createAuthentication(pool, 'browser-test-secret-with-at-least-32-bytes');
        const publish = registerEntityEvents(app, auth);
        const reads = [];
        let reportRequests = 0;
        let failRelated = false;
        app.use('/api/entities', (req, res, next) => {
            if (req.method === 'POST' && req.path.endsWith('/report')) reportRequests++;
            if (req.method === 'GET') {
                reads.push({entity: req.path.slice(1), query: JSON.parse(req.query.query ?? '{}')});
                if (failRelated && req.path === '/recetas') {
                    failRelated = false;
                    res.status(503).json({error: 'Temporarily unavailable'});
                    return;
                }
            }
            next();
        });
        registerAuthApi(app, pool, auth);
        registerEntityApi(app, pool, auth, publish);
        app.use('/assets', express.static('dist/frontend'));
        app.use(express.static('src/frontend/public'));
        const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
        try {
            await withBrowser(async ({send, evaluate, errors}) => {
                const {inPage, waitFor, click, resize, textOf, valueOf} = pageActions({send, evaluate});
                const recipe = '.related-rows[data-entity=recetas]';
                const ready = () => waitFor(recipe => document.querySelector(recipe)?.getAttribute('aria-busy') === 'false', recipe);
                const rowCount = () => inPage(recipe => document.querySelectorAll(`${recipe} tbody tr`).length, recipe);
                await resize(1440, 900);
                await send('Page.navigate', {url: `http://127.0.0.1:${server.address().port}`});
                await waitFor(() => typeof document.querySelector('#login-form')?.onsubmit === 'function');
                await inPage(() => {
                    document.querySelector('#login-user').value = 'browser';
                    document.querySelector('#identity-form').requestSubmit();
                    document.querySelector('#login-password').value = 'browser-test-password';
                    document.querySelector('#login-form').requestSubmit();
                });
                await waitFor(() => !document.querySelector('#workspace').disabled && document.querySelector('[data-entity=platos]'));
                await waitFor(() => {
                    if (document.querySelector('#workspace').disabled) return false;
                    document.querySelector('[data-entity=platos]').click();
                    return true;
                });
                await waitFor(() => !document.querySelector('#workspace').disabled && document.querySelector('tbody [name=nombre]'));
                await inPage(() => {
                    const input = document.querySelector('tbody [name=nombre]');
                    input.value = 'Unsaved draft';
                    input.dispatchEvent(new Event('input', {bubbles: true}));
                });
                reads.length = 0;
                await click('tbody [aria-label="Ver datos actuales"]');
                await ready();

                await t.test('only the current association page and exact visible target keys are fetched', async () => {
                    assert.equal(await rowCount(), 10);
                    assert.match(await textOf(`${recipe} .related-controls [role=status]`), /201 registros · 1 \/ 21/);
                    assert.match(await textOf(`${recipe} .related-scroll`), /I001 — Ingrediente 1/);
                    assert.match(await textOf(`${recipe} .related-scroll`), /500/);
                    assert.deepEqual(reads.filter(read => read.entity === 'recetas'), [
                        {entity: 'recetas', query: {where: {cod_plato: 'EMP'}, page: 1}},
                    ]);
                    const targets = reads.filter(read => read.entity === 'ingredientes');
                    assert.equal(targets.length, 10);
                    assert.ok(targets.every(({query}) => /^I0[01]\d$/.test(query.where.cod_ing)));
                });
                await t.test('returning to a visited page uses the dialog cache', async () => {
                    await click(`${recipe} .related-controls [aria-label=Siguiente]`);
                    await ready();
                    assert.match(await textOf(`${recipe} .related-controls [role=status]`), /2 \/ 21/);
                    assert.match(await textOf(`${recipe} .related-scroll`), /I011 — Ingrediente 11/);
                    const count = reads.length;
                    await click(`${recipe} .related-controls [aria-label=Anterior]`);
                    await ready();
                    assert.match(await textOf(`${recipe} .related-controls [role=status]`), /1 \/ 21/);
                    assert.equal(reads.length, count);
                });
                await t.test('live changes refresh target labels and association membership while preserving drafts', async () => {
                    await pool.query("UPDATE ssot.ingredientes SET nombre = 'Updated elsewhere' WHERE cod_ing = 'I001'");
                    publish('ingredientes');
                    await waitFor(recipe => document.querySelector(`${recipe} .related-scroll`).textContent.includes('Updated elsewhere'), recipe);
                    await pool.query("INSERT INTO ssot.recetas (cod_plato, cod_ing, cantidad) VALUES ('EMP', 'I202', 500)");
                    publish('recetas');
                    await waitFor(recipe => document.querySelector(`${recipe} .related-controls [role=status]`).textContent.includes('202 registros'), recipe);
                    assert.equal(await valueOf('.table-scroll tbody [name=nombre]'), 'Unsaved draft');
                });
                await t.test('a failed related load can retry without closing the review', async () => {
                    failRelated = true;
                    await click(`${recipe} .related-controls [aria-label="Actualizar registros relacionados"]`);
                    await ready();
                    assert.match(await textOf(`${recipe} .related-controls [role=status]`), /Temporarily unavailable/);
                    assert.equal(await valueOf('.table-scroll tbody [name=nombre]'), 'Unsaved draft');
                    await click(`${recipe} .related-controls [aria-label="Actualizar registros relacionados"]`);
                    await ready();
                    assert.equal(await rowCount(), 10);
                    assert.match(await textOf(`${recipe} .related-controls [role=status]`), /202 registros/);
                });
                await t.test('mobile overflow stays inside the dialog and closing releases subscriptions', async () => {
                    await resize(320, 700);
                    assert.equal(await inPage(() => {
                        const dialog = document.querySelector('.review-dialog');
                        return dialog.scrollWidth <= dialog.clientWidth && document.documentElement.scrollWidth <= innerWidth;
                    }), true);
                    await click('.review-dialog > button');
                    await waitFor(() => !document.querySelector('.review-dialog'));
                    const count = reads.length;
                    publish('ingredientes');
                    // Await an SSE event after the change, instead of assuming delivery timing.
                    publish('platos');
                    await waitFor(() => document.querySelector('#status').textContent.includes('Hay datos nuevos'));
                    assert.equal(reads.length, count);
                    assert.equal(await valueOf('.table-scroll tbody [name=nombre]'), 'Unsaved draft');
                });
                await t.test('inline relationships load on expansion and offer search, sorting and typed filters', async () => {
                    const before = reads.length;
                    await click('.table-scroll [aria-label="Registros relacionados"]');
                    assert.equal(await inPage(() => [...document.querySelectorAll('.inline-related details')].some(details => details.open)), false);
                    assert.equal(reads.length, before);
                    await click(`.inline-related ${recipe} > summary`);
                    await ready();
                    assert.equal(await rowCount(), 10);
                    await inPage(recipe => {
                        const input = document.querySelector(`.inline-related ${recipe} input[type=search]`);
                        input.value = 'I200';
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                    }, recipe);
                    await ready();
                    assert.equal(await rowCount(), 1);
                    assert.match(await textOf(`${recipe} .related-scroll`), /I200/);
                    await inPage(recipe => {
                        const input = document.querySelector(`.inline-related ${recipe} input[type=search]`);
                        input.value = '';
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                    }, recipe);
                    await ready();
                    await inPage(recipe => {
                        const sort = document.querySelector(`.inline-related ${recipe} [aria-label="Ordenar por"]`);
                        sort.value = 'cod_ing';
                        sort.dispatchEvent(new Event('change', {bubbles: true}));
                    }, recipe);
                    await ready();
                    await click(`.inline-related ${recipe} [aria-label="Orden ascendente"]`);
                    await ready();
                    assert.match(await textOf(`${recipe} .related-scroll tbody tr:first-child`), /I202/);
                    await click(`.inline-related ${recipe} [aria-label^="Filtrar por columnas"]`);
                    await inPage(() => {
                        const dialog = document.querySelector('.column-filters');
                        const label = [...dialog.querySelectorAll('form > label')].find(label => label.textContent.includes('Cantidad por receta'));
                        label.querySelector('input').click();
                        const field = label.nextElementSibling;
                        const none = field.querySelector('input[type=checkbox]');
                        if (none?.checked) none.click();
                        field.querySelector('input[type=number]').value = '9999';
                        dialog.querySelector('form').requestSubmit();
                    });
                    await waitFor(() => !document.querySelector('.column-filters'));
                    await ready();
                    assert.match(await textOf(`${recipe} .related-scroll`), /Sin registros/);
                    assert.equal(await valueOf('.table-scroll tbody [name=nombre]'), 'Unsaved draft');
                    assert.equal(await inPage(() => document.documentElement.scrollWidth <= innerWidth), true);
                    await click('.table-scroll [aria-label="Registros relacionados"]');
                    assert.equal(await inPage(() => !!document.querySelector('.inline-related')), false);
                });
                await t.test('ending the session closes the review before clearing cached data', async () => {
                    await click('.table-scroll tbody [aria-label="Ver datos actuales"]');
                    await ready();
                    const count = reads.length;
                    await inPage(() => window.dispatchEvent(new Event('sessionexpired')));
                    await waitFor(() => !document.querySelector('.review-dialog') && document.querySelector('#workspace').hidden);
                    assert.equal(reads.length, count, 'Clearing the session must not start new related-record requests');
                });
                await t.test('reports discover fields, paginate, filter and refresh without domain imports', async () => {
                    await inPage(() => {
                        document.querySelector('#login-user').value = 'browser';
                        document.querySelector('#identity-form').requestSubmit();
                        document.querySelector('#login-password').value = 'browser-test-password';
                        document.querySelector('#login-form').requestSubmit();
                    });
                    await waitFor(() => !document.querySelector('#workspace').disabled && !document.querySelector('#session').hidden);
                    await click('#open-reports');
                    await waitFor(() => document.querySelector('.reports-page')?.getAttribute('aria-busy') === 'false');
                    await inPage(() => {
                        const select = document.querySelector('[aria-label="Tabla del reporte"]');
                        select.value = 'ingredientes';
                        select.dispatchEvent(new Event('change', {bubbles: true}));
                    });
                    await waitFor(() => document.querySelector('.report-results td')?.textContent === '202');
                    await inPage(() => {
                        const group = document.querySelector('.reports-page details > fieldset');
                        [...group.querySelectorAll('label')].find(label => label.textContent === 'Código').querySelector('input').click();
                        document.querySelector('.reports-page form').requestSubmit();
                    });
                    await waitFor(() => document.querySelector('.reports-page [role=status]').textContent.includes('202 resultados'));
                    assert.equal(await inPage(() => document.querySelectorAll('.report-results tbody tr').length), 10);
                    await click('[aria-label="Página siguiente del reporte"]');
                    await waitFor(() => document.querySelector('.report-results tbody tr:first-child td')?.textContent === 'I011');
                    await inPage(() => {
                        const input = document.querySelector('.reports-page input[type=search]');
                        input.value = 'Updated elsewhere';
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                    });
                    await waitFor(() => document.querySelector('.reports-page [role=status]').textContent.includes('1 resultados'));
                    assert.equal(await inPage(() => document.querySelectorAll('.report-results tbody tr').length), 1);
                    await pool.query("UPDATE ssot.ingredientes SET nombre = 'Updated elsewhere' WHERE cod_ing = 'I002'");
                    publish('ingredientes');
                    await waitFor(() => document.querySelector('.reports-page [role=status]').textContent.includes('2 resultados'));
                    assert.equal(await inPage(() => document.documentElement.scrollWidth <= innerWidth), true);
                    await inPage(() => {
                        const select = document.querySelector('[aria-label="Tabla del reporte"]');
                        select.value = 'usuarios';
                        select.dispatchEvent(new Event('change', {bubbles: true}));
                    });
                    await waitFor(() => document.querySelector('.reports-page [role=status]').textContent.includes('1 resultados'));
                    assert.doesNotMatch(await textOf('.reports-page details'), /Contraseña|Sesión|recuperacion|contrasena_hash/);
                    await click('[data-entity=platos]');
                    await waitFor(() => !document.querySelector('.reports-page') && !document.querySelector('#workspace').disabled);
                    const before = reportRequests;
                    const dishReads = reads.filter(read => read.entity === 'platos').length;
                    publish('ingredientes');
                    publish('platos');
                    await until(() => reads.filter(read => read.entity === 'platos').length > dishReads);
                    assert.equal(reportRequests, before, 'Leaving the report releases its live subscription');
                });
                await t.test('joined reports choose paths and join types, count distinct records and refresh joined dependencies', async () => {
                    await pool.query(`INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo)
                        VALUES ('TAR', 'Unmatched', NULL, 'Finger food', 8, 1200, true)`);
                    await waitFor(() => !document.querySelector('#workspace').disabled);
                    await click('#open-reports');
                    await waitFor(() => document.querySelector('.reports-page')?.getAttribute('aria-busy') === 'false');
                    await inPage(() => {
                        const select = document.querySelector('[aria-label="Tabla del reporte"]');
                        select.value = 'platos';
                        select.dispatchEvent(new Event('change', {bubbles: true}));
                    });
                    await waitFor(() => document.querySelector('.report-results td')?.textContent === '2');
                    const add = async (source, label) => {
                        await inPage((source, label) => {
                            const origin = document.querySelector('[aria-label="Origen de la relación"]');
                            origin.value = String(source);
                            origin.dispatchEvent(new Event('change', {bubbles: true}));
                            const relation = document.querySelector('[aria-label="Relación"]');
                            relation.value = [...relation.options].find(option => option.textContent.startsWith(label)).value;
                            document.querySelector('[aria-label="Tipo de nueva unión"]').value = 'left';
                            [...document.querySelectorAll('.report-joins button')].find(button => button.textContent === 'Agregar relación').click();
                        }, source, label);
                        await waitFor(() => !document.querySelector('.report-joins').disabled && document.querySelector('.reports-page').getAttribute('aria-busy') === 'false');
                    };
                    await add(0, 'Recetas');
                    await add(1, 'Ingredientes');
                    assert.equal(await inPage(() => document.querySelectorAll('.report-join-step').length), 2);
                    await inPage(() => {
                        [...document.querySelectorAll('.report-groups > label')].find(label => label.textContent === 'Platos · Plato').querySelector('input').click();
                        for (const label of document.querySelectorAll('.report-measures > label')) {
                            if (label.textContent.startsWith('Registros distintos')) label.querySelector('input').click();
                        }
                        document.querySelector('.reports-page form').requestSubmit();
                    });
                    await waitFor(() => document.querySelector('.report-results th')?.textContent === 'Platos · Plato');
                    assert.deepEqual(await inPage(() => [...document.querySelectorAll('.report-results tbody tr')].map(tr => [...tr.cells].map(cell => cell.textContent))), [
                        ['Original', '202', '1', '202', '202'], ['Unmatched', '1', '1', '0', '0'],
                    ]);
                    assert.equal(await inPage(() => {
                        const results = document.querySelector('.report-results').getBoundingClientRect();
                        const header = document.querySelector('.report-results thead').getBoundingClientRect();
                        const row = document.querySelector('.report-results tbody tr').getBoundingClientRect();
                        return results.height >= header.height + row.height && results.bottom <= innerHeight;
                    }), true, 'Report results remain visible below the controls on a phone');
                    const before = reportRequests;
                    await pool.query("DELETE FROM ssot.recetas WHERE cod_ing = 'I202'");
                    publish('recetas');
                    await waitFor(() => document.querySelector('.report-results tbody tr td:nth-child(2)')?.textContent === '201');
                    assert.equal(reportRequests, before + 1);
                    publish('ingredientes');
                    await until(() => reportRequests === before + 2);
                    await waitFor(() => document.querySelector('.reports-page').getAttribute('aria-busy') === 'false');
                    assert.equal(await inPage(() => document.documentElement.scrollWidth <= innerWidth), true);
                    await inPage(() => {
                        const select = document.querySelector('[aria-label="Tipo de unión 1"]');
                        select.value = 'inner';
                        select.dispatchEvent(new Event('change', {bubbles: true}));
                    });
                    await waitFor(() => document.querySelector('.report-results td')?.textContent === '201');
                    await add(1, 'Platos');
                    assert.equal(await inPage(() => document.querySelector('[aria-label="Origen de la relación"]').options.length), 4);
                    assert.equal(await inPage(() => {
                        const labels = [...document.querySelectorAll('.report-groups label')].map(label => label.textContent);
                        return labels.includes('Platos · Plato') && labels.some(label => label.includes('(4) · Plato'));
                    }), true);
                    await click('[aria-label="Quitar unión 1 y sus dependientes"]');
                    await waitFor(() => document.querySelector('.report-results td')?.textContent === '2');
                    assert.equal(await inPage(() => document.querySelectorAll('.report-join-step').length), 0);
                    await inPage(() => window.dispatchEvent(new Event('sessionexpired')));
                    await waitFor(() => document.querySelector('#workspace').hidden);
                    assert.equal(await inPage(() => !!document.querySelector('.reports-page')), false);
                });
                assert.deepEqual(errors, []);
            });
        } finally {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
});
