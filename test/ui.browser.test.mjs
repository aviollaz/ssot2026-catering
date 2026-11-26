import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {writeFile} from 'node:fs/promises';
import {withTestDatabase} from './helpers/database.mjs';
import {withBrowser, until, pageActions} from './helpers/browser.mjs';
import {initializeUsers} from '../dist/backend/bootstrap.js';
import {createAuthentication, registerAuthApi} from '../dist/backend/auth.js';
import {createCustomerAuthentication, registerCustomerAuthApi} from '../dist/backend/customer-auth.js';
import {registerEntityApi} from '../dist/backend/api.js';
import {registerEntityEvents} from '../dist/backend/entity-events.js';
import {registerCateringApi} from '../dist/backend/catering.js';

// The real API and frontend on a random port, recording login requests.
async function startServer(pool) {
    const app = express(), auth = createAuthentication(pool, 'browser-test-secret-with-at-least-32-bytes');
    const customerAuth = createCustomerAuthentication(pool, 'browser-test-secret-with-at-least-32-bytes');
    const loginRequests = [];
    app.use('/api/auth/login', (req, _res, next) => { loginRequests.push(req.method); next(); });
    const publish = registerEntityEvents(app, auth);
    registerAuthApi(app, pool, auth);
    registerCustomerAuthApi(app, pool, customerAuth);
    registerEntityApi(app, pool, auth, publish);
    registerCateringApi(app, pool, auth, customerAuth, publish);
    app.get('/inicio', (_req, res) => res.sendFile('src/frontend/public/pedido.html', {root: process.cwd()}));
    app.use('/assets', express.static('dist/frontend'));
    app.use(express.static('src/frontend/public'));
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    return {url: `http://127.0.0.1:${server.address().port}`, loginRequests, close: async () => {
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await closed;
    }};
}

// The steps share one browser session and run in order: each one starts where the previous one ended.
test('table navigation and spreadsheet work with the real API', {timeout: 90000}, async t => {
    await withTestDatabase(async ({pool}) => {
        await initializeUsers(pool, {username: 'browser', password: 'browser-test-password'});
        await pool.query("INSERT INTO ssot.ingredientes (cod_ing, nombre, unidad) SELECT 'I' || lpad(i::text, 3, '0'), 'Ingrediente ' || i, 'g' FROM generate_series(1,201) i");
        await pool.query("INSERT INTO ssot.platos (cod_plato, nombre, descripcion, categoria, porciones_receta, precio_porcion, activo) VALUES ('EMP', 'Empanadas', 'De carne', 'Finger food', 12, 900, true)");
        await pool.query("INSERT INTO ssot.recetas (cod_plato, cod_ing, cantidad) VALUES ('EMP', 'I001', 600)");
        await pool.query("INSERT INTO ssot.servicios (cod_servicio, nombre, descripcion, precio_persona, min_personas, activo) VALUES ('COCTEL', 'Cóctel', 'De pie', 1000, 10, true)");
        await pool.query("INSERT INTO ssot.servicio_platos (cod_servicio, cod_plato, porciones_por_persona) VALUES ('COCTEL', 'EMP', 3)");
        await pool.query(`INSERT INTO ssot.pedidos (id, cliente_telefono, direccion, fecha_evento, personas, estado, cod_servicio, total, observaciones, creado)
            VALUES ('00000000-0000-4000-8000-000000000001', '1', 'Calle 1', '2026-11-12 20:00', 40, 'Confirmado', 'COCTEL', 40000, NULL, '2026-10-01 10:00')`);
        await pool.query("INSERT INTO ssot.pedido_invitados (pedido, nombre, email) VALUES ('00000000-0000-4000-8000-000000000001', 'Ana', 'ana@example.com')");
        await pool.query("INSERT INTO ssot.pedido_platos (pedido, cod_plato, porciones, precio_porcion) VALUES ('00000000-0000-4000-8000-000000000001', 'EMP', 120, 900)");
        const server = await startServer(pool);
        try {
            await withBrowser(async ({send, evaluate, errors}) => {
                const {inPage, waitFor, resize, click, setValue, submit, valueOf, textOf, isVisible, focusedId, dialogIsOpen, rowCount} = pageActions({send, evaluate});
                const sheetIsReady = heading => waitFor(heading => !document.querySelector('#workspace').disabled &&
                    document.querySelector('.sheet-heading h2')?.textContent === heading, heading);
                // The menu ignores clicks while the sheet is busy, so wait until it is idle.
                const openTable = async (entity, heading) => {
                    await waitFor(() => !document.querySelector('#workspace').disabled);
                    await click(`[data-entity=${entity}]`);
                    await sheetIsReady(heading);
                };
                const login = async password => { await setValue('#login-password', password); await submit('#login-form'); };
                const loginAnswered = () => waitFor(() => !document.querySelector('#login-password').disabled && document.querySelector('#auth-status').textContent !== '');
                // Header and row checkboxes line up, and every active scroll arrow sits over the data columns and can be clicked.
                const checkHeaderControls = async () => {
                    const layout = await inPage(() => {
                        const header = document.querySelector('thead .selection-col input').getBoundingClientRect();
                        const row = document.querySelector('tbody .selection-col input').getBoundingClientRect();
                        const left = (document.querySelector('thead .pinned-col') ?? document.querySelector('thead .selection-col')).getBoundingClientRect().right;
                        const right = document.querySelector('thead .row-actions').getBoundingClientRect().left;
                        return {alignment: Math.abs(header.left - row.left),
                            selectionWidth: document.querySelector('thead .selection-col').getBoundingClientRect().width,
                            cues: [...document.querySelectorAll('.scroll-cue')].filter(button => !button.disabled).map(button => {
                                const box = button.getBoundingClientRect();
                                return {withinData: box.left >= left - 1 && box.right <= right + 1,
                                    clickable: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.scroll-cue') === button};
                            })};
                    });
                    assert.ok(layout.alignment < 1, JSON.stringify(layout));
                    assert.equal(layout.selectionWidth, 44);
                    assert.ok(layout.cues.every(cue => cue.withinData && cue.clickable), JSON.stringify(layout));
                };

                await t.test('login asks for the user, then the password, and gives one generic error', async () => {
                    await resize(390, 844);
                    await send('Page.navigate', {url: server.url});
                    await waitFor(() => typeof document.querySelector('#login-form')?.onsubmit === 'function');
                    assert.equal(await isVisible('#authentication'), true);
                    assert.equal(await isVisible('#identity-form'), true);
                    assert.equal(await isVisible('#login-form'), false);
                    assert.equal(await dialogIsOpen(), false);
                    // The password can be shown and hidden again.
                    await inPage(() => document.querySelector('#login-form .toggle-password').click());
                    assert.equal(await inPage(() => document.querySelector('#login-password').type === 'text' &&
                        document.querySelector('#login-form .toggle-password').getAttribute('aria-label') === 'Ocultar contraseña'), true);
                    await inPage(() => document.querySelector('#login-form .toggle-password').click());

                    // Moving to the password step makes no server request.
                    await setValue('#login-user', 'missing-user');
                    await submit('#identity-form');
                    assert.equal(server.loginRequests.length, 0);
                    assert.equal(await focusedId(), 'login-password');
                    assert.equal(await isVisible('#identity-form'), false);
                    assert.equal(await isVisible('#login-form'), true);

                    // An unknown user gets the generic error and the password is cleared.
                    await login('browser-test-password');
                    await loginAnswered();
                    const genericError = await textOf('#auth-status');
                    assert.equal(genericError, 'No existe usuario con esas credenciales.');
                    assert.equal(await valueOf('#login-password'), '');

                    // Going back to change the user discards the typed password.
                    await setValue('#login-password', 'discard-me');
                    await click('#change-identity');
                    assert.equal(await isVisible('#identity-form'), true);
                    assert.equal(await focusedId(), 'login-user');
                    assert.equal(await valueOf('#login-password'), '');

                    // A wrong password gets the same error as an unknown user.
                    await setValue('#login-user', 'browser');
                    await submit('#identity-form');
                    await login('wrong');
                    await loginAnswered();
                    assert.equal(await textOf('#auth-status'), genericError);

                    // Recovery keeps the typed user.
                    await click('#show-recovery');
                    assert.equal(await isVisible('#recovery-form'), true);
                    assert.equal(await valueOf('#recover-user'), 'browser');
                    assert.equal(await dialogIsOpen(), false);

                    await click('#show-login');
                    await login('browser-test-password');
                    await waitFor(() => !document.querySelector('#workspace').disabled && !!document.querySelector('table'));
                    assert.equal(await inPage(() => document.querySelectorAll('#login-form h3').length), 0);
                });

                await t.test('value fields read null, false and list options', async () => {
                    assert.deepEqual(await inPage(async () => {
                        const {createValueField} = await import('/assets/value-field.js');
                        const column = {name: 'choice', label: 'Choice', type: 'estadoPedido', nullable: true, optionalOnUpdate: false,
                            constraints: {minLength: null, maxLength: null, options: ['Pendiente', 'Confirmado']}};
                        const nullable = createValueField(column, null), required = createValueField({...column, nullable: false});
                        const bool = createValueField({...column, type: 'boolean'}, false);
                        return {value: nullable.read(), none: nullable.input.options[0].text,
                            checkboxes: nullable.field.querySelectorAll('input[type=checkbox]').length,
                            optionalValid: nullable.input.checkValidity(), requiredValid: required.input.checkValidity(), falseValue: bool.read()};
                    }), {value: null, none: 'Ninguna', checkboxes: 0, optionalValid: true, requiredValid: false, falseValue: false});
                });

                await t.test('the table menu searches by name and opens a table', async () => {
                    await click('#open-tables');
                    assert.equal(await inPage(() => document.querySelector('#tables-panel').matches(':modal')), true);
                    assert.deepEqual(await inPage(() => [...document.querySelectorAll('#table-list summary')].map(item => item.textContent)), ['Ventas', 'Cocina', 'Inventario', 'Avanzado']);
                    assert.deepEqual(await inPage(() => [...document.querySelectorAll('#table-list details')].map(group => group.open)), [true, true, true, false]);
                    await click('#table-list summary');
                    assert.equal(await inPage(() => document.querySelector('#table-list details').open), false);
                    await inPage(() => {
                        const search = document.querySelector('#table-search');
                        search.value = 'ingred';
                        search.dispatchEvent(new Event('input'));
                    });
                    assert.deepEqual(await inPage(() => [...document.querySelectorAll('#table-list button')].filter(b => !b.hidden).map(b => b.textContent)),
                        ['Ingredientes', 'Ingredientes por movimiento']);
                    // Searching opens the areas with matches, even one closed by default, and hides the rest.
                    assert.deepEqual(await inPage(() => [...document.querySelectorAll('#table-list details')].filter(group => !group.hidden)
                        .map(group => ({area: group.querySelector('summary').textContent, open: group.open}))), [{area: 'Cocina', open: true}, {area: 'Avanzado', open: true}]);
                    await openTable('ingredientes', 'Ingredientes');
                    assert.equal(await inPage(() => document.querySelector('#tables-panel').open), false);
                    assert.equal(await rowCount(), 10);
                });

                await t.test('column filters narrow the rows and can be removed', async () => {
                    await inPage(() => {
                        document.querySelector('[aria-label^="Filtrar por columnas"]').click();
                        const code = document.querySelector('.column-filters [name=cod_ing]');
                        code.closest('fieldset').previousElementSibling.querySelector('input').click(); // enables the code filter
                        code.value = 'I201';
                        document.querySelector('.column-filters form').requestSubmit();
                    });
                    await waitFor(() => !document.querySelector('.column-filters') && document.querySelectorAll('tbody tr').length === 1);
                    assert.equal(await valueOf('tbody [name=cod_ing]'), 'I201');

                    await inPage(() => {
                        document.querySelector('[aria-label^="Filtrar por columnas"]').click();
                        [...document.querySelectorAll('.column-filters button')].find(b => b.textContent === 'Quitar filtros').click();
                        document.querySelector('.column-filters form').requestSubmit();
                    });
                    await waitFor(() => !document.querySelector('.column-filters') && document.querySelectorAll('tbody tr').length === 10);
                });

                await t.test('on a short phone screen the sheet scrolls inside a fixed frame', async () => {
                    await resize(390, 500);
                    await inPage(() => {
                        const scroll = document.querySelector('.table-scroll');
                        scroll.scrollTop = 100;
                        scroll.scrollLeft = 100;
                    });
                    await waitFor(() => document.querySelector('.table-scroll').scrollTop > 0);
                    const geometry = await inPage(() => {
                        const scroll = document.querySelector('.table-scroll'), bounds = scroll.getBoundingClientRect();
                        return {overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                            header: Math.abs(document.querySelector('thead th').getBoundingClientRect().top - bounds.top),
                            selection: Math.abs(document.querySelector('tbody .selection-col').getBoundingClientRect().left - bounds.left),
                            actions: Math.abs(document.querySelector('tbody .row-actions').getBoundingClientRect().right - bounds.right),
                            controls: document.querySelector('.sheet-controls').getBoundingClientRect().bottom <= bounds.top,
                            bottom: innerHeight - bounds.bottom, horizontal: scroll.scrollWidth > scroll.clientWidth};
                    });
                    assert.equal(geometry.overflow, false, 'the page itself does not scroll sideways');
                    assert.equal(geometry.controls, true, 'the controls stay above the sheet');
                    assert.equal(geometry.horizontal, true, 'the sheet scrolls sideways');
                    // The header, selection column and actions column stay stuck to the frame edges.
                    for (const key of ['header', 'selection', 'actions']) assert.ok(geometry[key] <= 2, JSON.stringify(geometry));
                    assert.ok(geometry.bottom <= 10, JSON.stringify(geometry));
                    // Row buttons are labelled and big enough to touch.
                    assert.equal(await inPage(() => [...document.querySelectorAll('tbody button')]
                        .filter(b => !b.hidden).every(b => b.getAttribute('aria-label') && b.getBoundingClientRect().height >= 44)), true);
                });

                await t.test('a pinned column stays next to the row selectors on every screen size', async () => {
                    await click('th[data-column=nombre] .column-pin');
                    await waitFor(() => document.querySelector('th.pinned-col')?.dataset.column === 'nombre');
                    assert.equal(await inPage(() => document.querySelectorAll('th[aria-sort=ascending], th[aria-sort=descending]').length), 0,
                        'pinning does not sort');
                    await inPage(() => {
                        const scroll = document.querySelector('.table-scroll');
                        scroll.scrollLeft = scroll.scrollWidth;
                        scroll.scrollTop = 100;
                    });
                    await waitFor(() => Math.abs(document.querySelector('tbody .pinned-col').getBoundingClientRect().left -
                        document.querySelector('tbody .selection-col').getBoundingClientRect().right) < 2);
                    const pinnedFits = () => document.querySelector('tbody .pinned-col').getBoundingClientRect().right <
                        document.querySelector('tbody .row-actions').getBoundingClientRect().left && document.documentElement.scrollWidth <= document.documentElement.clientWidth;
                    assert.equal(await inPage(pinnedFits), true);
                    await resize(320, 700);
                    await waitFor(pinnedFits);
                    await checkHeaderControls();
                    await resize(1440, 900);
                    await waitFor(() => {
                        const scroll = document.querySelector('.table-scroll');
                        return document.querySelector('#workspace').classList.contains('docked') && scroll.scrollWidth <= scroll.clientWidth;
                    });
                    await resize(390, 500);
                });

                await t.test('paging, editing and adding keep the pinned column', async () => {
                    await click('.pagination [aria-label=Siguiente]');
                    await waitFor(() => document.querySelector('tbody [name=cod_ing]')?.value === 'I011');
                    assert.equal(await valueOf('tbody .pinned-col [name=nombre]'), 'Ingrediente 11');

                    // Saving an edited pinned cell writes it to the database.
                    await inPage(() => {
                        const input = document.querySelector('tbody .pinned-col [name=nombre]');
                        input.value = 'Edited while pinned';
                        input.dispatchEvent(new Event('change', {bubbles: true}));
                    });
                    await click('tbody tr [aria-label=Guardar]');
                    await until(async () => (await pool.query("SELECT nombre FROM ssot.ingredientes WHERE cod_ing='I011'")).rows[0]?.nombre === 'Edited while pinned');
                    await waitFor(() => !document.querySelector('#workspace').disabled &&
                        document.querySelector('tbody .pinned-col [name=nombre]')?.value === 'Edited while pinned');

                    // Moving the pin keeps what was typed in a new row.
                    await click('[aria-label="Agregar fila"]');
                    await setValue('tr.new-row [name=nombre]', 'Keep draft');
                    await click('th[data-column=cod_ing] .column-pin');
                    assert.equal(await valueOf('tr.new-row [name=nombre]'), 'Keep draft');
                    assert.equal(await inPage(() => document.querySelectorAll('th.pinned-col').length), 1);
                    assert.equal(await inPage(() => document.querySelector('tr.new-row .pinned-col').dataset.column), 'cod_ing');
                    await click('tr.new-row [aria-label=Cancelar]');
                    await click('#confirm-ok');
                    await waitFor(() => !document.querySelector('tr.new-row'));

                    // Sorting keeps the pin; unpinning restores the API column order.
                    await click('th[data-column=cod_ing] .column-label');
                    await waitFor(() => document.querySelector('th[data-column=cod_ing]').getAttribute('aria-sort') === 'ascending' &&
                        document.querySelector('tbody [name=cod_ing]')?.value === 'I001');
                    await click('th[data-column=cod_ing] .column-pin');
                    assert.equal(await inPage(() => document.querySelectorAll('.pinned-col').length), 0);
                    assert.deepEqual(await inPage(() => [...document.querySelectorAll('thead [data-column]')].map(cell => cell.dataset.column)),
                        ['cod_ing', 'nombre', 'unidad', 'unidad_compra']);
                });

                await t.test('arrows show hidden columns and scroll to them', async () => {
                    const arrowsAre = (left, right) => waitFor((left, right) => {
                        const enabled = direction => !document.querySelector(`.scroll-cue[data-direction=${direction}]`).disabled;
                        return enabled('left') === left && enabled('right') === right;
                    }, left, right);
                    const scrollTo = position => inPage(position => {
                        const scroll = document.querySelector('.table-scroll');
                        scroll.scrollLeft = position === 'middle' ? (scroll.scrollWidth - scroll.clientWidth) / 2 : position;
                    }, position);

                    await scrollTo(0);
                    await arrowsAre(false, true);
                    assert.equal(await inPage(() => getComputedStyle(document.querySelector('.scroll-cue[data-direction=right]')).visibility), 'visible');
                    await checkHeaderControls();
                    await click('.scroll-cue[data-direction=right]');
                    await waitFor(() => document.querySelector('.table-scroll').scrollLeft > 0 && !document.querySelector('.scroll-cue[data-direction=left]').disabled);
                    await scrollTo('middle');
                    await arrowsAre(true, true);
                    await checkHeaderControls();
                    await scrollTo(1e6);
                    await arrowsAre(true, false);
                    await checkHeaderControls();
                    await click('.scroll-cue[data-direction=left]');
                    await waitFor(() => !document.querySelector('.scroll-cue[data-direction=right]').disabled);
                });

                await t.test('on a wide screen the table menu becomes a sidebar when its labels fit', async () => {
                    if (process.env.UI_SCREENSHOT) {
                        const {data} = await send('Page.captureScreenshot');
                        await writeFile(process.env.UI_SCREENSHOT, Buffer.from(data, 'base64'));
                    }
                    // Escape closes the table menu.
                    await click('#open-tables');
                    await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
                    await waitFor(() => !document.querySelector('#tables-panel').open);

                    // Wide enough for the drawer, the four ingredient columns and the action labels.
                    await resize(1920, 900);
                    await waitFor(() => document.querySelector('#workspace').classList.contains('docked'));
                    assert.equal(await isVisible('#open-tables'), false);
                    assert.equal(await inPage(() => document.querySelector('#tables-panel').matches(':modal')), false);
                    assert.equal(await inPage(() => {
                        const scroll = document.querySelector('.table-scroll');
                        return scroll.scrollWidth <= scroll.clientWidth;
                    }), true);
                    assert.equal(await inPage(() => getComputedStyle(document.querySelector('tbody .row-actions .action-label')).display !== 'none'), true,
                        'action buttons show their text');
                    await waitFor(() => [...document.querySelectorAll('.scroll-cue')].every(button => getComputedStyle(button).display === 'none'));

                    // Long API labels must make docking depend on content, not just screen size.
                    await inPage(() => { document.querySelector('#table-list [data-entity=ingredientes]').textContent = 'A very long table label '.repeat(20); });
                    await waitFor(() => !document.querySelector('#workspace').classList.contains('docked'));
                    await resize(390, 844);
                    await waitFor(() => !document.querySelector('#open-tables').hidden);
                });

                await t.test('on phones, sheets with data scroll inside their frame, never the page', async () => {
                    for (const [entity, heading] of [['platos', 'Platos'], ['pedidos', 'Pedidos']]) {
                        await openTable(entity, heading);
                        for (const width of [320, 390]) {
                            await resize(width, 844);
                            const bounds = await inPage(() => ({page: document.documentElement.scrollWidth,
                                sheet: document.querySelector('.table-scroll').scrollWidth,
                                clipped: document.querySelector('.table-scroll').clientWidth}));
                            assert.ok(bounds.page <= width, JSON.stringify({entity, width, ...bounds}));
                            assert.ok(bounds.sheet > bounds.clipped);
                            await inPage(() => {
                                const scroll = document.querySelector('.table-scroll');
                                scroll.scrollLeft = (scroll.scrollWidth - scroll.clientWidth) / 2;
                            });
                            await waitFor(() => [...document.querySelectorAll('.scroll-cue')].every(button => !button.disabled));
                            await checkHeaderControls();
                        }
                        if (process.env.UI_SCREENSHOT) {
                            const {data} = await send('Page.captureScreenshot');
                            await writeFile(`${process.env.UI_SCREENSHOT}.${entity}.png`, Buffer.from(data, 'base64'));
                        }
                    }
                });

                await t.test("an order's review dialog lists its dishes, labelled by name", async () => {
                    await resize(1440, 900);
                    await click('tbody .row-actions [aria-label="Ver datos actuales"]');
                    const section = 'dialog.review-dialog[open] .related-rows[data-entity=pedido_platos]';
                    await waitFor(section => !!document.querySelector(`${section} tbody tr`), section);
                    assert.deepEqual(await inPage(section => {
                        const node = document.querySelector(section);
                        return [node.querySelector('summary').textContent, ...[...node.querySelectorAll('tbody td')].map(cell => cell.textContent)];
                    }, section), ['Platos por pedido · pedido', 'EMP — Empanadas', '120', '900']);
                    await inPage(() => [...document.querySelectorAll('dialog.review-dialog button')].find(b => b.textContent === 'Cerrar').click());
                    await waitFor(() => !document.querySelector('dialog.review-dialog'));
                });

                await t.test('the account dialog opens, and an expired session returns to an empty login', async () => {
                    await click('#manage-account');
                    assert.equal(await inPage(() => document.querySelector('#account').matches(':modal')), true);
                    assert.equal(await isVisible('#account-management'), true);
                    assert.equal(await isVisible('#authentication'), false);

                    await click('#close-account');
                    await inPage(() => { window.dispatchEvent(new Event('sessionexpired')); });
                    assert.equal(await isVisible('#authentication'), true);
                    assert.equal(await isVisible('#identity-form'), true);
                    assert.equal(await isVisible('#workspace'), false);
                    assert.equal(await valueOf('#login-user'), '');
                    assert.equal(await dialogIsOpen(), false);
                });

                await t.test('the public page confirms the order first and offers an optional customer account', async () => {
                    await send('Page.navigate', {url: `${server.url}/pedido.html`});
                    await until(() => evaluate("return !!document.querySelector('.card.service')"));
                    await evaluate(`document.querySelector('.card.service').click(); document.querySelector('#menu-siguiente').click();
                        document.querySelector('#personas').value = '12'; document.querySelector('#fecha').value = '2030-01-15T20:00';
                        document.querySelector('#paso-evento').requestSubmit();
                        const contact = document.querySelector('#paso-contacto');
                        if (!contact.elements.cliente_nombre_pila.required || !contact.elements.cliente_apellido.required) {
                            throw new Error('Nombre y apellido deben ser obligatorios.');
                        }
                        for (const [name, value] of Object.entries({
                            cliente_nombre_pila: 'Laura', cliente_apellido: 'García', cliente_email: 'laura@example.com',
                            cliente_telefono: '1', direccion: 'Calle 2'
                        })) contact.elements[name].value = value;
                        contact.requestSubmit();`);
                    assert.equal(await evaluate("return !document.querySelector('#paso-resumen').hidden"), true);
                    assert.match(await evaluate("return document.querySelector('#resumen .total').textContent"), /12\.000/);
                    await evaluate("document.querySelector('#confirmar').click()");
                    await until(() => evaluate("return !document.querySelector('#paso-listo').hidden && document.querySelector('#cuenta-dialog').open"));
                    const code = await evaluate("return document.querySelector('#codigo').textContent");
                    assert.deepEqual((await pool.query('SELECT estado, total, personas, cliente_id FROM ssot.pedidos WHERE id = $1', [code])).rows,
                        [{estado: 'Pendiente', total: 12000, personas: 12, cliente_id: null}]);
                    await evaluate("document.querySelector('#omitir-cuenta').click()");
                    await until(() => evaluate("return !document.querySelector('#cuenta-dialog').open"));
                    await evaluate("document.querySelector('#abrir-cuenta').click()");
                    await until(() => evaluate("return document.querySelector('#cuenta-dialog').open"));
                    await evaluate("document.querySelector('[data-cuenta=registro]').click()");
                    await evaluate(`const account = document.querySelector('#cuenta-registro');
                        account.elements.email.value = 'laura@example.com';
                        account.elements.contrasena.value = 'customer-test-password';
                        if (account.elements.nombre || account.elements.apellido) throw new Error('El registro no debe volver a pedir nombre y apellido.');
                        account.requestSubmit();`);
                    await until(() => evaluate("return location.pathname === '/inicio' && !document.querySelector('#inicio-con-sesion').hidden"));
                    assert.equal(await evaluate("return document.querySelector('#inicio-perfil-pendiente').hidden"), true);
                    assert.equal(await evaluate("return !document.querySelector('#cliente-nav').hidden"), true);
                    assert.deepEqual((await pool.query("SELECT nombre, apellido FROM ssot.clientes WHERE email = 'laura@example.com'")).rows,
                        [{nombre: 'Laura', apellido: 'García'}]);
                    // The account view shows before its request linking the new order finishes.
                    await until(async () => (await pool.query('SELECT cliente_id FROM ssot.pedidos WHERE id = $1', [code])).rows[0].cliente_id !== null);
                    assert.deepEqual((await pool.query('SELECT estado, total, personas, cliente_id FROM ssot.pedidos WHERE id = $1', [code])).rows,
                        [{estado: 'Pendiente', total: 12000, personas: 12,
                            cliente_id: (await pool.query("SELECT id FROM ssot.clientes WHERE email = 'laura@example.com'")).rows[0].id}]);
                    assert.deepEqual((await pool.query('SELECT * FROM ssot.pedido_invitados WHERE pedido = $1', [code])).rows, []);
                    assert.deepEqual((await pool.query('SELECT cod_plato, porciones FROM ssot.pedido_platos WHERE pedido = $1', [code])).rows, [{cod_plato: 'EMP', porciones: 36}]);
                    await send('Page.reload');
                    await until(() => evaluate("return !document.querySelector('#inicio-con-sesion').hidden && document.querySelector('#inicio-identidad').textContent.includes('laura@example.com')"));
                    assert.equal(await evaluate("return !!JSON.parse(localStorage.getItem('ssot2026.customer-session'))?.token"), true);
                    await evaluate("document.querySelector('#inicio-pedidos button').click()");
                    await until(() => evaluate("return !document.querySelector('#paso-menu').hidden"));
                    assert.deepEqual(await evaluate(`return {
                        servicio: document.querySelector('.card.service[aria-pressed=true] h3').textContent,
                        personas: document.querySelector('#personas').value,
                        email: document.querySelector('#paso-contacto').elements.cliente_email.value,
                        nombreReadOnly: document.querySelector('#paso-contacto').elements.cliente_nombre_pila.readOnly,
                        apellidoReadOnly: document.querySelector('#paso-contacto').elements.cliente_apellido.readOnly,
                        nombre: document.querySelector('#paso-contacto').elements.cliente_nombre_pila.value,
                        apellido: document.querySelector('#paso-contacto').elements.cliente_apellido.value,
                        emailReadOnly: document.querySelector('#paso-contacto').elements.cliente_email.readOnly,
                        fecha: document.querySelector('#fecha').value
                    }`), {
                        servicio: 'Cóctel', personas: '12', email: 'laura@example.com',
                        nombreReadOnly: true, apellidoReadOnly: true, nombre: 'Laura', apellido: 'García',
                        emailReadOnly: true, fecha: '',
                    });
                    await evaluate("document.querySelector('#cliente-nav a').click()");
                    await until(() => evaluate("return location.pathname === '/inicio' && !document.querySelector('#cliente-nav').hidden"));
                    await evaluate("document.querySelector('#inicio-pedidos button').click()");
                    await until(() => evaluate("return !document.querySelector('#paso-menu').hidden"));
                    await evaluate(`document.querySelector('#menu-siguiente').click();
                        const fecha = document.querySelector('#fecha');
                        const minimo = new Date();
                        minimo.setHours(0, 0, 0, 0);
                        minimo.setDate(minimo.getDate() + 3);
                        const pad = n => String(n).padStart(2, '0');
                        const fechaEsperada = minimo.getFullYear() + '-' + pad(minimo.getMonth() + 1) + '-' + pad(minimo.getDate()) + 'T00:00';
                        if (fecha.min !== fechaEsperada) throw new Error('El mínimo debe ser el día calendario que completa los tres días.');
                        const anterior = new Date(minimo);
                        anterior.setDate(anterior.getDate() - 1);
                        fecha.value = anterior.getFullYear() + '-' + pad(anterior.getMonth() + 1) + '-' + pad(anterior.getDate()) + 'T23:59';
                        if (fecha.reportValidity()) throw new Error('Se aceptó una fecha anterior al mínimo.');
                        fecha.value = fechaEsperada;
                        if (!fecha.reportValidity()) throw new Error('Se rechazó el límite de tres días.');
                        document.querySelector('#fecha').value = '2030-01-16T20:00';
                        document.querySelector('#paso-evento').requestSubmit();
                        document.querySelector('#paso-contacto').requestSubmit();
                        document.querySelector('#confirmar').click();`);
                    await until(() => evaluate("return !document.querySelector('#paso-listo').hidden && !document.querySelector('#cuenta-dialog').open"));
                    const repeatedCode = await evaluate("return document.querySelector('#codigo').textContent");
                    assert.deepEqual((await pool.query('SELECT estado, total, personas FROM ssot.pedidos WHERE id = $1', [repeatedCode])).rows,
                        [{estado: 'Pendiente', total: 12000, personas: 12}]);
                    const revokedToken = await evaluate("return JSON.parse(localStorage.getItem('ssot2026.customer-session')).token");
                    await evaluate("document.querySelector('#cliente-logout').click()");
                    await until(() => evaluate("return !document.querySelector('#inicio-sin-sesion').hidden && document.querySelector('#cliente-nav').hidden && !localStorage.getItem('ssot2026.customer-session')"));
                    assert.equal(await evaluate(`return fetch('/api/public/auth/me', {
                        headers: {Authorization: 'Bearer ${revokedToken}'}
                    }).then(response => response.status)`), 401);
                });

                await t.test('the page threw no JavaScript errors', () => {
                    assert.deepEqual(errors, []);
                });
            });
        } finally {
            await server.close();
        }
    });
});
