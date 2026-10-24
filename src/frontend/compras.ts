import type {ComprasResponse, EntregaResponse, PedidoPendiente} from '../backend/catering-contract.js';
import {cateringRequest} from './api.js';
import {confirmAction} from './confirm.js';
import {element} from './dom.js';
import {fechaHora, seccion, tabla, type CateringView} from './catering-ui.js';

const relevantes = [null, 'pedidos', 'pedido_platos', 'platos', 'recetas', 'ingredientes'];

function tablaCompras({ingredientes}: ComprasResponse, necesidad: string, vacio: string): HTMLElement {
    return tabla(['Ingrediente', 'Unidad', 'Stock', necesidad, 'Usan pedidos anteriores', 'A comprar'],
        ingredientes.map(i => [i.nombre, i.unidad, i.stock, i.necesidad, i.consumo_previo, i.comprar]), vacio);
}

async function show(content: HTMLElement): Promise<(changed: string | null) => void> {
    const status = element('p');
    status.className = 'catering-status';
    status.setAttribute('role', 'status');

    // By order: confirmed and pending orders (a pending one is a preview as if it were confirmed).
    const pedido = element('select');
    pedido.setAttribute('aria-label', 'Pedido');
    const entregar = element('button', 'Marcar entregado');
    entregar.type = 'button';
    entregar.className = 'primary';
    const resultadoPedido = element('div');
    const barra = element('div');
    barra.className = 'toolbar';
    barra.append(pedido, entregar);
    const ayuda = element('p', 'El stock se asigna primero a los pedidos confirmados más tempranos; ' +
        'cada pedido compra solo lo que le falta. Los pendientes se calculan como si se confirmaran.');
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
    entregar.onclick = () => void intentar(async () => {
        const actual = pedidos.find(p => p.id === pedido.value);
        if (!actual || !await confirmAction({title: 'Marcar entregado',
            message: `¿Marcar como entregado el pedido de ${actual.cliente_nombre}? Se descontará su consumo del stock.`,
            confirmText: 'Marcar entregado', danger: false})) return;
        const {consumo}: EntregaResponse = await cateringRequest(`/pedidos/${encodeURIComponent(actual.id)}/entregar`, 'POST');
        status.className = 'catering-status';
        status.textContent = `Pedido entregado. Se descontaron ${consumo.length} ingredientes del stock.`;
        await cargarPedidos();
        if (resultadoPeriodo.firstChild) await mostrarPeriodo();
    });

    await cargarPedidos();
    await mostrarPeriodo();
    return changed => {
        if (relevantes.includes(changed)) void intentar(async () => { await cargarPedidos(); await mostrarPeriodo(); });
    };
}

export const comprasView: CateringView = {name: 'compras', label: 'Compras', show};
