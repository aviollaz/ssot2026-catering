import type {CompraIngrediente, ComprasResponse, PedidoPendiente, Unidad} from '../backend/catering-contract.js';
import {cateringRequest} from './api.js';
import {egresoDePedido} from './inventario.js';
import {element} from './dom.js';
import {fechaHora, numero, seccion, selectorUnidad, tabla, type CateringView} from './catering-ui.js';

const relevantes = [null, 'pedidos', 'pedido_platos', 'platos', 'recetas', 'ingredientes', 'unidades'];

/* The quantities come in the base unit. With other units of the same base, the row gets a selector,
   starting at the ingredient's purchase unit; "A comprar" is then rounded up to whole units. */
function filaCompras(i: CompraIngrediente, unidades: readonly Unidad[]): (string | number | Node)[] {
    const {select, factor} = selectorUnidad(i.unidad, unidades, i.unidad_compra);
    const valores = [i.stock, i.necesidad, i.consumo_previo, i.faltante];
    if (select.options.length === 1) return [i.nombre, i.unidad, ...valores, i.comprar];
    select.setAttribute('aria-label', `Unidad de ${i.nombre}`);
    const celdas = [...valores, i.comprar].map(() => document.createTextNode(''));
    const mostrar = () => {
        valores.forEach((valor, index) => { celdas[index]!.textContent = numero(valor / factor()); });
        celdas[4]!.textContent = factor() === 1 ? numero(i.comprar) : `${numero(Math.ceil(i.comprar / factor()))} (${numero(i.comprar)} ${i.unidad})`;
    };
    select.onchange = mostrar;
    mostrar();
    return [i.nombre, select, ...celdas];
}

function tablaCompras({ingredientes, unidades}: ComprasResponse, necesidad: string, vacio: string): HTMLElement {
    return tabla(['Ingrediente', 'Unidad', 'Stock', necesidad, 'Usan pedidos anteriores', 'Falta en total', 'A comprar'],
        ingredientes.map(i => filaCompras(i, unidades)), vacio);
}

async function show(content: HTMLElement, abrir: (name: string) => void): Promise<(changed: string | null) => void> {
    const status = element('p');
    status.className = 'catering-status';
    status.setAttribute('role', 'status');

    // By order: confirmed and pending orders (a pending one is a preview as if it were confirmed).
    const pedido = element('select');
    pedido.setAttribute('aria-label', 'Pedido');
    // Delivering is an Egreso with the dishes actually made, loaded in Inventario.
    const entregar = element('button', 'Registrar egreso');
    entregar.type = 'button';
    entregar.className = 'primary';
    const resultadoPedido = element('div');
    const barra = element('div');
    barra.className = 'toolbar';
    barra.append(pedido, entregar);
    const ayuda = element('p', 'El stock se asigna primero a los pedidos confirmados más tempranos. ' +
        '"Falta en total" es lo que falta para este pedido y los anteriores juntos; "A comprar" es la parte de este pedido ' +
        '(el resto ya figura en las compras de los anteriores). Los pendientes se calculan como si se confirmaran.');
    ayuda.className = 'muted';

    // By period: every confirmed order between two dates.
    const desde = element('input');
    const hasta = element('input');
    desde.type = hasta.type = 'date';
    desde.required = hasta.required = true;
    const hoy = new Date();
    desde.valueAsDate = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
    hasta.valueAsDate = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 30));
    const calcular = element('button', 'Calcular');
    calcular.type = 'submit';
    const periodo = element('form');
    periodo.className = 'toolbar';
    const label = (text: string, input: HTMLInputElement) => { const l = element('label', text + ' '); l.append(input); return l; };
    periodo.append(label('Desde', desde), label('Hasta', hasta), calcular);
    const resultadoPeriodo = element('div');

    const view = element('div');
    view.className = 'catering-view compras';
    view.append(element('h2', 'Compras'), status,
        seccion('Por pedido', barra, ayuda, resultadoPedido),
        seccion('Por período', periodo, resultadoPeriodo));
    content.replaceChildren(view);

    let pedidos: PedidoPendiente[] = [];
    async function cargarPedidos(): Promise<void> {
        const elegido = pedido.value;
        pedidos = await cateringRequest<PedidoPendiente[]>('/pedidos');
        pedido.replaceChildren(...pedidos.map(p =>
            new Option(`${fechaHora(p.fecha_evento)} · ${p.cliente_nombre} · ${p.personas} personas · ${p.estado}`, p.id)));
        if (pedidos.some(p => p.id === elegido)) pedido.value = elegido;
        await mostrarPedido();
    }
    async function mostrarPedido(): Promise<void> {
        const actual = pedidos.find(p => p.id === pedido.value);
        entregar.disabled = actual?.estado !== 'Confirmado';
        pedido.disabled = !actual;
        if (!actual) { resultadoPedido.replaceChildren(element('p', 'No hay pedidos pendientes ni confirmados.')); return; }
        const compras = await cateringRequest<ComprasResponse>(`/pedidos/${encodeURIComponent(actual.id)}/compras`);
        if (pedido.value === actual.id) resultadoPedido.replaceChildren(tablaCompras(compras, 'Necesita este pedido', 'Este pedido no usa ingredientes con receta cargada.'));
    }
    async function mostrarPeriodo(): Promise<void> {
        if (!periodo.reportValidity()) return;
        const query = new URLSearchParams({desde: desde.value, hasta: hasta.value});
        resultadoPeriodo.replaceChildren(tablaCompras(await cateringRequest<ComprasResponse>(`/compras?${query}`), 'Necesita el período',
            'No hay pedidos confirmados con recetas cargadas en este período.'));
    }
    const intentar = async (work: () => Promise<void>) => {
        try { await work(); }
        catch (error) {
            status.className = 'catering-status error';
            status.textContent = error instanceof Error ? error.message : 'No se pudo completar la operación.';
        }
    };

    pedido.onchange = () => { status.textContent = ''; void intentar(mostrarPedido); };
    periodo.onsubmit = event => { event.preventDefault(); void intentar(mostrarPeriodo); };
    entregar.onclick = () => {
        egresoDePedido(pedido.value);
        abrir('inventario');
    };

    await cargarPedidos();
    await mostrarPeriodo();
    return changed => {
        if (relevantes.includes(changed)) void intentar(async () => { await cargarPedidos(); await mostrarPeriodo(); });
    };
}

export const comprasView: CateringView = {name: 'compras', label: 'Compras', area: 'Inventario', show};
