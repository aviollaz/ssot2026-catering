import type {EntityQuery} from '../backend/browser-contract.js';
import type {EgresoSugerido, MovimientoResponse, MovimientoResumen, NuevoMovimiento, OpcionesInventario} from '../backend/catering-contract.js';
import {ApiRequestError, cateringRequest, loadEntity} from './api.js';
import {actionButton, setActionLabel} from './action-button.js';
import {confirmAction} from './confirm.js';
import {element} from './dom.js';
import {loadReferenceSources, type LoadedReferenceSource} from './reference-sources.js';
import {createRowEditor, type Row, type RowEditor} from './row-editor.js';
import {fechaHora, numero, pesos, seccion, selectorUnidad, tabla, type CateringView} from './catering-ui.js';

type Tipo = NuevoMovimiento['tipo'];
type Linea = {platos?: Row; ingrediente?: NonNullable<NuevoMovimiento['ingredientes']>[number]};
const ayudas: Record<Tipo, string> = {
    Egreso: 'Los platos que realmente se hicieron. Su consumo se calcula con las recetas y se descuenta del stock. ' +
        'Si es de un pedido confirmado, el pedido pasa a Entregado.',
    Ingreso: 'Mercadería que entró (una compra). Se suma al stock en la unidad que elijas.',
    Merma: 'Mercadería perdida o vencida. Se resta del stock.',
    Ajuste: 'El stock que contaste en el depósito. Se guarda la diferencia con el stock del sistema.',
};
const relevantes = [null, 'movimientos', 'pedidos', 'pedido_platos', 'platos', 'ingredientes', 'unidades', 'recetas'];
// Now, in the fechaHora format of <input type="datetime-local">.
const ahora = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

// Compras opens this view with an order to deliver.
let pedidoPendiente: string | null = null;
export function egresoDePedido(id: string): void { pedidoPendiente = id; }

async function cargar(name: string) {
    const entity = await loadEntity(name, {page: 1} as EntityQuery);
    return {entity, sources: await loadReferenceSources(entity.foreignKeys)};
}

async function show(content: HTMLElement): Promise<(changed: string | null) => void> {
    const status = element('p');
    status.className = 'catering-status';
    status.setAttribute('role', 'status');
    const informar = (texto: string, error = false) => {
        status.className = error ? 'catering-status error' : 'catering-status';
        status.textContent = texto;
    };
    let opciones = await cateringRequest<OpcionesInventario>('/inventario');
    // The movement and the dishes made use the SSOT's own editors.
    const movimientos = await cargar('movimientos');
    const platosHechos = await cargar('movimiento_platos');
    // Only confirmed orders can be delivered; an Anulación is made only from the history.
    const fuentesMovimiento = (): LoadedReferenceSource[] => movimientos.sources.filter(source => source.reference.name !== 'anula')
        .map(source => source.reference.entity === 'pedidos' ? {...source, rows: source.rows.filter(row => row['estado'] === 'Confirmado')} : source);

    const ayuda = element('p');
    ayuda.className = 'muted';
    const cabecera = element('div');
    cabecera.className = 'toolbar inventario-cabecera';
    const lineas = element('table');
    lineas.className = 'catering-table detalle-table';
    const agregar = actionButton('Agregar línea', 'add', () => { nuevaLinea(); });
    const vistaPrevia = element('div');
    const simular = element('button', 'Vista previa');
    simular.type = 'button';
    const registrar = element('button', 'Registrar');
    registrar.type = 'submit';
    registrar.className = 'primary';
    const botones = element('div');
    botones.className = 'toolbar';
    botones.append(simular, registrar);
    const formulario = element('form');
    formulario.className = 'inventario-form';
    formulario.append(cabecera, ayuda, lineas, agregar, botones, vistaPrevia);
    const diferencias = element('div');
    const historial = element('div');
    const view = element('div');
    view.className = 'catering-view inventario';
    view.append(element('h2', 'Inventario'), status, seccion('Registrar movimiento', formulario),
        seccion('Diferencia con el historial', diferencias), seccion('Últimos movimientos', historial));
    content.replaceChildren(view);

    let movimiento!: RowEditor;
    let lectores: (() => Linea)[] = [];
    const tipo = () => movimiento.read()['tipo'] as Tipo;
    const campo = (name: string) => movimiento.cells.find(cell => cell.name === name)!.field;

    // An Egreso lists dishes with the SSOT editor; the others list an ingredient, a quantity and its unit.
    function nuevaLinea(inicial?: Row): void {
        const tr = lineas.tBodies[0]!.insertRow();
        if (tipo() === 'Egreso') {
            const editor = createRowEditor(platosHechos.entity, platosHechos.sources.filter(source => source.reference.entity !== 'movimientos'), inicial);
            for (const cell of editor.cells.filter(cell => cell.name !== 'movimiento')) tr.insertCell().append(cell.field);
            lectores.push(() => tr.isConnected ? {platos: editor.read()} : {});
        } else {
            const ingrediente = element('select');
            ingrediente.required = true;
            ingrediente.setAttribute('aria-label', 'Ingrediente');
            ingrediente.append(new Option('Elegí…', ''), ...opciones.ingredientes.map(i => new Option(i.nombre, i.cod_ing)));
            const cantidad = element('input');
            cantidad.type = 'number';
            cantidad.required = true;
            cantidad.step = 'any';
            cantidad.min = tipo() === 'Ajuste' ? '0' : '0.001';
            cantidad.setAttribute('aria-label', tipo() === 'Ajuste' ? 'Stock contado' : 'Cantidad');
            const [celdaIngrediente, celdaCantidad, celdaUnidad, celdaStock] = [tr.insertCell(), tr.insertCell(), tr.insertCell(), tr.insertCell()];
            celdaIngrediente.append(ingrediente);
            celdaCantidad.append(cantidad);
            let unidad = selectorUnidad('', [], null);
            // The units follow the ingredient, starting at its purchase unit, with its current stock in that unit.
            const actualizar = (cambioIngrediente: boolean) => {
                const elegido = opciones.ingredientes.find(i => i.cod_ing === ingrediente.value);
                if (cambioIngrediente) {
                    unidad = selectorUnidad(elegido?.unidad ?? '', opciones.unidades, elegido?.unidad_compra ?? null);
                    unidad.select.setAttribute('aria-label', 'Unidad');
                    unidad.select.onchange = () => actualizar(false);
                    celdaUnidad.replaceChildren(...elegido ? [unidad.select] : []);
                }
                celdaStock.className = 'muted';
                celdaStock.textContent = elegido ? `Stock: ${numero(elegido.stock_actual / unidad.factor())}` : '';
            };
            ingrediente.onchange = () => actualizar(true);
            lectores.push(() => tr.isConnected ? {ingrediente: {cod_ing: ingrediente.value, cantidad: Number(cantidad.value),
                cod_unidad: unidad.select.value}} : {});
        }
        tr.insertCell().append(actionButton('Quitar', 'delete', () => { tr.remove(); }, 'danger'));
    }

    function leer(): NuevoMovimiento {
        const encabezado = Object.fromEntries(Object.entries(movimiento.read()).filter(([name]) => name !== 'anula'));
        const leidas = lectores.map(leerLinea => leerLinea());
        return {...encabezado, ...tipo() === 'Egreso'
            ? {platos: leidas.flatMap(l => l.platos ? [{cod_plato: l.platos['cod_plato'] as string, porciones: l.platos['porciones'] as number}] : [])}
            : {ingredientes: leidas.flatMap(l => l.ingrediente ? [l.ingrediente] : [])}} as NuevoMovimiento;
    }

    // A new form for the chosen type and values. An order prefills its quoted dishes and total.
    async function reiniciar(valores: Row = {fecha: ahora(), tipo: 'Egreso'}): Promise<void> {
        const pedido = valores['tipo'] === 'Egreso' ? valores['pedido'] : null;
        const sugerido = pedido ? await cateringRequest<EgresoSugerido>(`/pedidos/${encodeURIComponent(String(pedido))}/egreso`) : null;
        movimiento = createRowEditor(movimientos.entity, fuentesMovimiento(), {...valores, pedido: pedido ?? null,
            facturado: sugerido ? sugerido.facturado : valores['tipo'] === 'Egreso' ? valores['facturado'] ?? null : null});
        cabecera.replaceChildren(...movimiento.cells.filter(cell => cell.name !== 'anula').map(cell => cell.field));
        campo('tipo').querySelector('option[value="Anulación"]')?.remove();
        const egreso = tipo() === 'Egreso';
        for (const name of ['pedido', 'facturado']) campo(name).hidden = !egreso;
        campo('tipo').addEventListener('change', () => void intentar(() => reiniciar(movimiento.read())));
        campo('pedido').addEventListener('change', () => void intentar(() => reiniciar(movimiento.read())));
        ayuda.textContent = ayudas[tipo()];
        lineas.replaceChildren();
        const header = lineas.createTHead().insertRow();
        for (const texto of egreso ? ['Plato', 'Porciones hechas', ''] : ['Ingrediente', tipo() === 'Ajuste' ? 'Stock contado' : 'Cantidad', 'Unidad', '', '']) {
            header.append(element('th', texto));
        }
        lineas.createTBody();
        lectores = [];
        setActionLabel(agregar, egreso ? 'Agregar plato' : 'Agregar ingrediente');
        vistaPrevia.replaceChildren();
        if (sugerido) for (const plato of sugerido.platos) nuevaLinea({cod_plato: plato.cod_plato, porciones: plato.porciones});
        else nuevaLinea();
        editando = false;
    }

    function mostrarCambios({ingredientes}: MovimientoResponse): HTMLElement {
        return tabla(['Ingrediente', 'Cambio de stock', 'Unidad'], ingredientes.map(cambio => {
            const ingrediente = opciones.ingredientes.find(i => i.cod_ing === cambio.cod_ing);
            return [ingrediente?.nombre ?? cambio.cod_ing, (cambio.cantidad > 0 ? '+' : '') + numero(cambio.cantidad), ingrediente?.unidad ?? ''];
        }), 'No cambia el stock (los platos no tienen receta, o el stock ya era ese).');
    }

    // Stock edited by hand leaves no movement: this shows how much of it the history does not explain.
    function mostrarDiferencias(): void {
        const nota = element('p', 'El stock se puede editar a mano en Ingredientes, y eso no deja movimiento. ' +
            'Acá figura cuánto stock no explica el historial de movimientos.');
        nota.className = 'muted';
        diferencias.replaceChildren(nota, tabla(['Ingrediente', 'Stock actual', 'Según movimientos', 'Sin registrar', 'Unidad'],
            opciones.ingredientes.filter(i => i.stock_actual !== i.historial).map(i => [i.nombre, i.stock_actual, i.historial,
                (i.stock_actual > i.historial ? '+' : '') + numero(i.stock_actual - i.historial), i.unidad]),
            'El stock de todos los ingredientes coincide con su historial.'));
    }

    async function cargarHistorial(): Promise<void> {
        const recientes = await cateringRequest<MovimientoResumen[]>('/movimientos');
        historial.replaceChildren(tabla(['Fecha', 'Tipo', 'Pedido', 'Detalle', 'Facturado', ''], recientes.map(m => {
            const detalle = [...m.platos.map(p => `${p.nombre}: ${numero(p.porciones)} porc.`),
                ...m.ingredientes.map(i => `${i.nombre}: ${i.cantidad > 0 ? '+' : ''}${numero(i.cantidad)} ${i.unidad}`)].join(' · ');
            const estado: Node = m.anulado ? element('span', 'Anulado') : m.tipo === 'Anulación' ? element('span', '')
                : actionButton('Anular', 'cancel', () => void anular(m), 'danger');
            return [fechaHora(m.fecha), m.tipo, m.cliente_nombre ?? '—', [detalle, m.observaciones].filter(Boolean).join(' — ') || '—',
                m.facturado == null ? '—' : pesos(m.facturado), estado];
        }), 'Todavía no hay movimientos.'));
    }

    const intentar = async (work: () => Promise<void>) => {
        try { await work(); }
        catch (error) {
            if (error instanceof ApiRequestError) movimiento.problems(error.problems);
            informar(error instanceof Error ? error.message : 'No se pudo completar la operación.', true);
        }
    };
    async function recargar(): Promise<void> {
        opciones = await cateringRequest<OpcionesInventario>('/inventario');
        movimientos.sources = await loadReferenceSources(movimientos.entity.foreignKeys);
        mostrarDiferencias();
        await cargarHistorial();
    }
    async function anular(m: MovimientoResumen): Promise<void> {
        if (!await confirmAction({title: 'Anular movimiento', message: `¿Anular este ${m.tipo.toLowerCase()} del ${fechaHora(m.fecha)}? ` +
            'Se registra un movimiento inverso' + (m.pedido ? ' y el pedido vuelve a Confirmado.' : '.'), confirmText: 'Anular', danger: true})) return;
        await intentar(async () => {
            await cateringRequest(`/movimientos/${encodeURIComponent(m.id)}/anular`, 'POST');
            informar('Movimiento anulado.');
            await recargar();
            await reiniciar();
        });
    }

    simular.onclick = () => void intentar(async () => {
        if (!formulario.reportValidity()) return;
        vistaPrevia.replaceChildren(element('h4', 'Así cambiaría el stock'),
            mostrarCambios(await cateringRequest<MovimientoResponse>('/movimientos/simular', 'POST', leer())));
    });
    formulario.onsubmit = event => {
        event.preventDefault();
        void intentar(async () => {
            const nuevo = leer();
            const cliente = opciones.pedidos.find(p => p.id === nuevo.pedido)?.cliente_nombre;
            if (!await confirmAction({title: `Registrar ${nuevo.tipo.toLowerCase()}`, message: '¿Registrar este movimiento? Se actualizará el stock' +
                (cliente ? ` y el pedido de ${cliente} pasará a Entregado.` : '.'), confirmText: 'Registrar', danger: false})) return;
            const resultado = await cateringRequest<MovimientoResponse>('/movimientos', 'POST', nuevo);
            informar(`${nuevo.tipo} registrado. Cambió el stock de ${resultado.ingredientes.length} ingredientes.`);
            await recargar();
            await reiniciar();
            vistaPrevia.replaceChildren(element('h4', 'Cambios aplicados'), mostrarCambios(resultado));
        });
    };

    let editando = false;
    formulario.addEventListener('input', () => { editando = true; });
    await reiniciar({fecha: ahora(), tipo: 'Egreso', pedido: opciones.pedidos.some(p => p.id === pedidoPendiente) ? pedidoPendiente : null});
    pedidoPendiente = null;
    mostrarDiferencias();
    await cargarHistorial();
    return changed => {
        // Live changes refresh the lists and the history, never a form being filled in.
        if (relevantes.includes(changed)) void intentar(async () => { await recargar(); if (!editando) await reiniciar(); });
    };
}

export const inventarioView: CateringView = {name: 'inventario', label: 'Inventario', area: 'Inventario', show};
