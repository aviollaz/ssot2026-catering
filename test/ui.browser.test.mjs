import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {writeFile} from 'node:fs/promises';
import {withTestDatabase} from './helpers/database.mjs';
import {withBrowser, until} from './helpers/browser.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication, registerAuthApi} from '../dist/backend/auth.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {registerEntityEvents} from '../dist/backend/entity-events.js';
import {registerCateringApi} from '../dist/backend/catering.js';

test('table navigation and spreadsheet work with the real API', {timeout: 90000}, async () => {
    await withTestDatabase(async ({pool}) => {
        await initializeUsers(pool, {username: 'browser', password: 'browser-test-password'});
        await pool.query("INSERT INTO ssot.ingredientes (cod_ing, nombre, unidad, stock_actual) SELECT 'I' || lpad(i::text, 3, '0'), 'Ingrediente ' || i, 'g', i FROM generate_series(1,201) i");
        await pool.query("INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo) VALUES ('EMP', 'Empanadas', 'De carne', 'Finger food', 12, 900, true)");
        await pool.query("INSERT INTO ssot.recetas (cod_plato, cod_ing, cantidad) VALUES ('EMP', 'I001', 600)");
        await pool.query("INSERT INTO ssot.servicios (cod_servicio, nombre, descripcion, precio_persona, min_personas, activo) VALUES ('COCTEL', 'Cóctel', 'De pie', 1000, 10, true)");
        await pool.query("INSERT INTO ssot.servicio_platos (cod_servicio, cod_plato, porciones_por_persona) VALUES ('COCTEL', 'EMP', 3)");
        await pool.query(`INSERT INTO ssot.pedidos (id, cliente_nombre, cliente_email, cliente_telefono, direccion, fecha_evento, personas, estado, cod_servicio, total, observaciones, creado)
            VALUES ('00000000-0000-4000-8000-000000000001', 'Ana', 'ana@example.com', '1', 'Calle 1', '2026-11-12 20:00', 40, 'Confirmado', 'COCTEL', 40000, NULL, '2026-10-01 10:00')`);
        await pool.query("INSERT INTO ssot.pedido_platos (pedido, cod_plato, porciones, precio_porcion) VALUES ('00000000-0000-4000-8000-000000000001', 'EMP', 120, 900)");
        const app = express(), auth = createAuthentication(pool, 'browser-test-secret-with-at-least-32-bytes');
        const loginRequests = [];
        app.use('/api/auth/login', (req, _res, next) => { loginRequests.push(req.method); next(); });
        const publish = registerEntityEvents(app, auth);
        registerAuthApi(app, pool, auth);
        registerEntityApi(app, pool, auth, publish);
        registerCateringApi(app, pool, auth, publish);
        app.use('/assets', express.static('dist/frontend'));
        app.use(express.static('src/frontend/public'));
        const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
        try {
            await withBrowser(async ({send, evaluate, errors}) => {
                async function checkHeaderControls() {
                    const layout = await evaluate(`
                        const header=document.querySelector('thead .selection-col input').getBoundingClientRect();
                        const row=document.querySelector('tbody .selection-col input').getBoundingClientRect();
                        const left=(document.querySelector('thead .pinned-col') ?? document.querySelector('thead .selection-col')).getBoundingClientRect().right;
                        const right=document.querySelector('thead .row-actions').getBoundingClientRect().left;
                        return {alignment: Math.abs(header.left-row.left),
                            selectionWidth: document.querySelector('thead .selection-col').getBoundingClientRect().width,
                            cues: [...document.querySelectorAll('.scroll-cue')].filter(button=>!button.disabled).map(button=>{
                                const box=button.getBoundingClientRect();
                                return {withinData: box.left >= left-1 && box.right <= right+1,
                                    clickable: document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('.scroll-cue') === button};
                            })};`);
                    assert.ok(layout.alignment < 1, JSON.stringify(layout));
                    assert.equal(layout.selectionWidth, 44);
                    assert.ok(layout.cues.every(cue=>cue.withinData && cue.clickable), JSON.stringify(layout));
                }
                await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
                await send('Page.navigate', {url: `http://127.0.0.1:${server.address().port}`});
                await until(() => evaluate("return typeof document.querySelector('#login-form')?.onsubmit === 'function'"));
                assert.equal(await evaluate("return !document.querySelector('#authentication').hidden && !document.querySelector('#identity-form').hidden && document.querySelector('#login-form').hidden && !document.querySelector('dialog[open]')"), true);
                await evaluate("document.querySelector('#login-user').value='missing-user'; document.querySelector('#identity-form').requestSubmit();");
                assert.equal(loginRequests.length, 0);
                assert.equal(await evaluate("return document.activeElement.id === 'login-password' && document.querySelector('#identity-form').hidden && !document.querySelector('#login-form').hidden"), true);
                await evaluate("document.querySelector('#login-password').value='browser-test-password'; document.querySelector('#login-form').requestSubmit();");
                await until(() => evaluate("return !document.querySelector('#login-password').disabled && document.querySelector('#auth-status').textContent !== ''"));
                const unknownUserError = await evaluate("return document.querySelector('#auth-status').textContent");
                assert.equal(unknownUserError, 'No existe usuario con esas credenciales.');
                assert.equal(await evaluate("return document.querySelector('#login-password').value"), '');
                await evaluate("document.querySelector('#login-password').value='discard-me'; document.querySelector('#change-identity').click()");
                assert.equal(await evaluate("return !document.querySelector('#identity-form').hidden && document.activeElement.id === 'login-user' && document.querySelector('#login-password').value === ''"), true);
                await evaluate("document.querySelector('#login-user').value='browser'; document.querySelector('#identity-form').requestSubmit(); document.querySelector('#login-password').value='wrong'; document.querySelector('#login-form').requestSubmit();");
                await until(() => evaluate("return !document.querySelector('#login-password').disabled && document.querySelector('#auth-status').textContent !== ''"));
                assert.equal(await evaluate("return document.querySelector('#auth-status').textContent"), unknownUserError);
                await evaluate("document.querySelector('#show-recovery').click()");
                assert.equal(await evaluate("return !document.querySelector('#recovery-form').hidden && document.querySelector('#recover-user').value === 'browser' && !document.querySelector('dialog[open]')"), true);
                await evaluate("document.querySelector('#show-login').click(); document.querySelector('#login-password').value='browser-test-password'; document.querySelector('#login-form').requestSubmit();");
                await until(() => evaluate("return !document.querySelector('#workspace').disabled && !!document.querySelector('table')"));
                assert.equal(await evaluate("return document.querySelectorAll('#login-form h3').length"), 0);
                assert.deepEqual(await evaluate(`return import('/assets/value-field.js').then(({createValueField}) => {
                    const column={name:'choice',label:'Choice',type:'estadoPedido',nullable:true,optionalOnUpdate:false,constraints:{minLength:null,maxLength:null,options:['Pendiente','Confirmado']}};
                    const nullable=createValueField(column,null), required=createValueField({...column,nullable:false});
                    const bool=createValueField({...column,type:'boolean'},false);
                    return {value:nullable.read(),none:nullable.input.options[0].text,
                        checkboxes:nullable.field.querySelectorAll('input[type=checkbox]').length,
                        optionalValid:nullable.input.checkValidity(),requiredValid:required.input.checkValidity(),falseValue:bool.read()};
                })`), {value:null,none:'Ninguna',checkboxes:0,optionalValid:true,requiredValid:false,falseValue:false});
                await evaluate("document.querySelector('#open-tables').click()");
                assert.equal(await evaluate("return document.querySelector('#tables-panel').matches(':modal')"), true);
                await evaluate("const input=document.querySelector('#table-search'); input.value='ingred'; input.dispatchEvent(new Event('input'))");
                assert.deepEqual(await evaluate("return [...document.querySelectorAll('#table-list button')].filter(b=>!b.hidden).map(b=>b.textContent)"), ['Ingredientes']);
                await evaluate("document.querySelector('[data-entity=ingredientes]').click()");
                await until(() => evaluate("return !document.querySelector('#workspace').disabled && document.querySelector('.sheet-heading h2')?.textContent === 'Ingredientes'"));
                assert.equal(await evaluate("return document.querySelector('#tables-panel').open"), false);
                assert.equal(await evaluate("return document.querySelectorAll('tbody tr').length"), 10);
                await evaluate(`document.querySelector('[aria-label^="Filtrar por columnas"]').click();
                    const input=document.querySelector('.column-filters [name=stock_actual]');
                    input.closest('fieldset').previousElementSibling.querySelector('input').click();
                    input.value='201'; document.querySelector('.column-filters form').requestSubmit();`);
                await until(() => evaluate("return !document.querySelector('.column-filters') && document.querySelectorAll('tbody tr').length === 1"));
                assert.equal(await evaluate("return document.querySelector('tbody [name=stock_actual]').value"), '201');
                await evaluate(`document.querySelector('[aria-label^="Filtrar por columnas"]').click();
                    [...document.querySelectorAll('.column-filters button')].find(b=>b.textContent==='Quitar filtros').click();
                    document.querySelector('.column-filters form').requestSubmit();`);
                await until(() => evaluate("return !document.querySelector('.column-filters') && document.querySelectorAll('tbody tr').length === 10"));
                await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 500, deviceScaleFactor: 1, mobile: true});
                await evaluate("const scroll=document.querySelector('.table-scroll'); scroll.scrollTop=100; scroll.scrollLeft=100;");
                await until(() => evaluate("return document.querySelector('.table-scroll').scrollTop > 0"));
                const geometry = await evaluate(`
                    const scroll=document.querySelector('.table-scroll'), bounds=scroll.getBoundingClientRect();
                    return {overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                        header: Math.abs(document.querySelector('thead th').getBoundingClientRect().top - bounds.top),
                        selection: Math.abs(document.querySelector('tbody .selection-col').getBoundingClientRect().left - bounds.left),
                        actions: Math.abs(document.querySelector('tbody .row-actions').getBoundingClientRect().right - bounds.right),
                        controls: document.querySelector('.sheet-controls').getBoundingClientRect().bottom <= bounds.top,
                        bottom: innerHeight - bounds.bottom, horizontal: scroll.scrollWidth > scroll.clientWidth};
                `);
                assert.equal(geometry.overflow, false);
                assert.equal(geometry.controls, true);
                assert.equal(geometry.horizontal, true);
                for (const key of ['header', 'selection', 'actions']) assert.ok(geometry[key] <= 2, JSON.stringify(geometry));
                assert.ok(geometry.bottom <= 10, JSON.stringify(geometry));
                assert.equal(await evaluate("return [...document.querySelectorAll('tbody button')].every(b=>b.getAttribute('aria-label') && b.getBoundingClientRect().height >= 44)"), true);
                await evaluate("document.querySelector('th[data-column=nombre] .column-pin').click()");
                await until(() => evaluate("return document.querySelector('th.pinned-col')?.dataset.column === 'nombre'"));
                assert.equal(await evaluate("return document.querySelectorAll('th[aria-sort=ascending], th[aria-sort=descending]').length"), 0);
                await evaluate("const scroll=document.querySelector('.table-scroll'); scroll.scrollLeft=scroll.scrollWidth; scroll.scrollTop=100");
                await until(() => evaluate(`const cell=document.querySelector('tbody .pinned-col').getBoundingClientRect();
                    return Math.abs(cell.left-document.querySelector('tbody .selection-col').getBoundingClientRect().right) < 2`));
                assert.equal(await evaluate(`const pinned=document.querySelector('tbody .pinned-col').getBoundingClientRect();
                    const actions=document.querySelector('tbody .row-actions').getBoundingClientRect();
                    return pinned.right < actions.left && document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
                await send('Emulation.setDeviceMetricsOverride', {width: 320, height: 700, deviceScaleFactor: 1, mobile: true});
                await until(() => evaluate(`const pinned=document.querySelector('tbody .pinned-col').getBoundingClientRect();
                    return pinned.right < document.querySelector('tbody .row-actions').getBoundingClientRect().left && document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
                await checkHeaderControls();
                await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
                await until(() => evaluate("const scroll=document.querySelector('.table-scroll'); return document.querySelector('#workspace').classList.contains('docked') && scroll.scrollWidth <= scroll.clientWidth"));
                await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 500, deviceScaleFactor: 1, mobile: true});
                // Paging, editing and adding reuse the existing editors while retaining the pin.
                await evaluate("document.querySelector('.pagination [aria-label=Siguiente]').click()");
                await until(() => evaluate("return document.querySelector('tbody [name=stock_actual]')?.value === '11'"));
                assert.equal(await evaluate("return document.querySelector('tbody .pinned-col [name=nombre]').value"), 'Ingrediente 11');
                await evaluate("const input=document.querySelector('tbody .pinned-col [name=nombre]'); input.value='Edited while pinned'; input.dispatchEvent(new Event('change',{bubbles:true}))");
                await until(async () => (await pool.query("SELECT nombre FROM ssot.ingredientes WHERE cod_ing='I011'")).rows[0]?.nombre === 'Edited while pinned');
                await until(() => evaluate("return !document.querySelector('#workspace').disabled && document.querySelector('tbody .pinned-col [name=nombre]')?.value === 'Edited while pinned'"));
                await evaluate("document.querySelector('[aria-label=\"Agregar fila\"]').click(); document.querySelector('tr.new-row [name=nombre]').value='Keep draft'; document.querySelector('th[data-column=stock_actual] .column-pin').click()");
                assert.equal(await evaluate("return document.querySelector('tr.new-row [name=nombre]').value"), 'Keep draft');
                assert.equal(await evaluate("return document.querySelectorAll('th.pinned-col').length === 1 && document.querySelector('tr.new-row .pinned-col').dataset.column === 'stock_actual'"), true);
                await evaluate("document.querySelector('tr.new-row [aria-label=Cancelar]').click(); document.querySelector('#confirm-ok').click()");
                await until(() => evaluate("return !document.querySelector('tr.new-row')"));
                await evaluate("document.querySelector('th[data-column=stock_actual] .column-label').click()");
                await until(() => evaluate("return document.querySelector('th[data-column=stock_actual]').getAttribute('aria-sort') === 'ascending' && document.querySelector('tbody [name=stock_actual]')?.value === '1'"));
                await evaluate("document.querySelector('th[data-column=stock_actual] .column-pin').click()");
                assert.equal(await evaluate("return document.querySelectorAll('.pinned-col').length"), 0);
                assert.deepEqual(await evaluate("return [...document.querySelectorAll('thead [data-column]')].map(cell=>cell.dataset.column)"), ['cod_ing','nombre','unidad','stock_actual']);
                await evaluate("document.querySelector('.table-scroll').scrollLeft=0");
                await until(() => evaluate("return document.querySelector('.scroll-cue[data-direction=left]').disabled && !document.querySelector('.scroll-cue[data-direction=right]').disabled"));
                assert.equal(await evaluate("return getComputedStyle(document.querySelector('.scroll-cue[data-direction=right]')).visibility"), 'visible');
                await checkHeaderControls();
                await evaluate("document.querySelector('.scroll-cue[data-direction=right]').click()");
                await until(() => evaluate("return document.querySelector('.table-scroll').scrollLeft > 0 && !document.querySelector('.scroll-cue[data-direction=left]').disabled"));
                await evaluate("const scroll=document.querySelector('.table-scroll'); scroll.scrollLeft=(scroll.scrollWidth-scroll.clientWidth)/2");
                await until(() => evaluate("return [...document.querySelectorAll('.scroll-cue')].every(button=>!button.disabled)"));
                await checkHeaderControls();
                await evaluate("document.querySelector('.table-scroll').scrollLeft=1e6");
                await until(() => evaluate("return document.querySelector('.scroll-cue[data-direction=right]').disabled && !document.querySelector('.scroll-cue[data-direction=left]').disabled"));
                await checkHeaderControls();
                await evaluate("document.querySelector('.scroll-cue[data-direction=left]').click()");
                await until(() => evaluate("return !document.querySelector('.scroll-cue[data-direction=right]').disabled"));
                if (process.env.UI_SCREENSHOT) {
                    const {data} = await send('Page.captureScreenshot');
                    await writeFile(process.env.UI_SCREENSHOT, Buffer.from(data, 'base64'));
                }
                await evaluate("document.querySelector('#open-tables').click()");
                await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
                await until(() => evaluate("return !document.querySelector('#tables-panel').open"));
                // Wide enough for the drawer, the four ingredient columns and the action labels.
                await send('Emulation.setDeviceMetricsOverride', {width: 1920, height: 900, deviceScaleFactor: 1, mobile: false});
                await until(() => evaluate("return document.querySelector('#workspace').classList.contains('docked')"));
                assert.equal(await evaluate("return document.querySelector('#open-tables').hidden && !document.querySelector('#tables-panel').matches(':modal')"), true);
                assert.equal(await evaluate("const scroll=document.querySelector('.table-scroll'); return scroll.scrollWidth <= scroll.clientWidth"), true);
                assert.equal(await evaluate("return getComputedStyle(document.querySelector('tbody .row-actions .action-label')).display !== 'none'"), true);
                await until(() => evaluate("return [...document.querySelectorAll('.scroll-cue')].every(button=>getComputedStyle(button).display === 'none')"));
                // Long API labels must make docking depend on content, not just screen size.
                await evaluate("document.querySelector('#table-list [data-entity=ingredientes]').textContent='A very long table label '.repeat(20)");
                await until(() => evaluate("return !document.querySelector('#workspace').classList.contains('docked')"));
                await send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
                await until(() => evaluate("return !document.querySelector('#open-tables').hidden"));
                // Wide populated sheets must scroll inside their viewport, never the page.
                for (const [entity, label] of [['platos', 'Platos'], ['pedidos', 'Pedidos']]) {
                    await evaluate(`document.querySelector('[data-entity=${entity}]').click()`);
                    await until(() => evaluate(`return !document.querySelector('#workspace').disabled && document.querySelector('.sheet-heading h2')?.textContent === '${label}'`));
                    for (const width of [320, 390]) {
                        await send('Emulation.setDeviceMetricsOverride', {width, height: 844, deviceScaleFactor: 1, mobile: true});
                        const bounds = await evaluate(`return {page: document.documentElement.scrollWidth,
                            sheet: document.querySelector('.table-scroll').scrollWidth,
                            clipped: document.querySelector('.table-scroll').clientWidth}`);
                        assert.ok(bounds.page <= width, JSON.stringify({entity, width, ...bounds}));
                        assert.ok(bounds.sheet > bounds.clipped);
                        await evaluate("const scroll=document.querySelector('.table-scroll'); scroll.scrollLeft=(scroll.scrollWidth-scroll.clientWidth)/2");
                        await until(() => evaluate("return [...document.querySelectorAll('.scroll-cue')].every(button=>!button.disabled)"));
                        await checkHeaderControls();
                    }
                    if (process.env.UI_SCREENSHOT) {
                        const {data} = await send('Page.captureScreenshot');
                        await writeFile(`${process.env.UI_SCREENSHOT}.${entity}.png`, Buffer.from(data, 'base64'));
                    }
                }
                // Catering views share the drawer: purchases for the confirmed order, its delivery, and statistics.
                await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
                await evaluate("document.querySelector('[data-entity=compras]').click()");
                await until(() => evaluate("return !document.querySelector('#workspace').disabled && document.querySelector('.catering-view h2')?.textContent === 'Compras' && !!document.querySelector('.catering-table')"));
                // 120 empanadas need 120 × 600 / 12 = 6000 g of I001, with 1 g in stock.
                assert.deepEqual(await evaluate("return [...document.querySelector('.catering-table tbody tr').cells].map(cell => cell.textContent)"),
                    ['Ingrediente 1', 'g', '1', '6.000', '0', '5.999', '5.999']);
                await evaluate("[...document.querySelectorAll('.catering-view button')].find(b => b.textContent === 'Marcar entregado').click()");
                await until(() => evaluate("return document.querySelector('#confirm-dialog').open"));
                await evaluate("document.querySelector('#confirm-ok').click()");
                await until(() => evaluate("return /entregado/.test(document.querySelector('.catering-status').textContent)"));
                assert.deepEqual((await pool.query("SELECT estado FROM ssot.pedidos")).rows, [{estado: 'Entregado'}]);
                assert.deepEqual((await pool.query("SELECT stock_actual FROM ssot.ingredientes WHERE cod_ing = 'I001'")).rows, [{stock_actual: 0}]);
                await evaluate("document.querySelector('[data-entity=estadisticas]').click()");
                await until(() => evaluate("return !document.querySelector('#workspace').disabled && document.querySelectorAll('.stat-card').length === 4"));
                assert.deepEqual(errors, []);
                await evaluate("document.querySelector('#manage-account').click()");
                assert.equal(await evaluate("return document.querySelector('#account').matches(':modal') && !document.querySelector('#account-management').hidden && document.querySelector('#authentication').hidden"), true);
                await evaluate("document.querySelector('#close-account').click(); window.dispatchEvent(new Event('sessionexpired'))");
                assert.equal(await evaluate("return !document.querySelector('#authentication').hidden && !document.querySelector('#identity-form').hidden && document.querySelector('#workspace').hidden && document.querySelector('#login-user').value === '' && !document.querySelector('dialog[open]')"), true);
                // The public page places an order without an account and shows its code.
                await send('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/pedido.html`});
                await until(() => evaluate("return !!document.querySelector('.card.service')"));
                await evaluate(`document.querySelector('.card.service').click(); document.querySelector('#menu-siguiente').click();
                    document.querySelector('#personas').value = '12'; document.querySelector('#fecha').value = '2030-01-15T20:00';
                    document.querySelector('#paso-evento').requestSubmit();
                    const contact = document.querySelector('#paso-contacto');
                    for (const [name, value] of Object.entries({cliente_nombre: 'Laura', cliente_email: 'laura@example.com', cliente_telefono: '1', direccion: 'Calle 2'})) contact.elements[name].value = value;
                    contact.requestSubmit();`);
                assert.match(await evaluate("return document.querySelector('#resumen .total').textContent"), /12\.000/);
                await evaluate("document.querySelector('#confirmar').click()");
                await until(() => evaluate("return !document.querySelector('#paso-listo').hidden"));
                const code = await evaluate("return document.querySelector('#codigo').textContent");
                assert.deepEqual((await pool.query('SELECT estado, total, personas FROM ssot.pedidos WHERE id = $1', [code])).rows, [{estado: 'Pendiente', total: 12000, personas: 12}]);
                assert.deepEqual((await pool.query('SELECT cod_plato, porciones FROM ssot.pedido_platos WHERE pedido = $1', [code])).rows, [{cod_plato: 'EMP', porciones: 36}]);
                assert.deepEqual(errors, []);
            });
        } finally {
            const closed = new Promise(resolve => server.close(resolve));
            server.closeAllConnections();
            await closed;
        }
    });
});
