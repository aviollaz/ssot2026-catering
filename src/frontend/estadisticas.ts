import type {EstadisticasResponse} from '../backend/catering-contract.js';
import {cateringRequest} from './api.js';
import {element} from './dom.js';
import {pesos, seccion, tabla, type CateringView} from './catering-ui.js';

const mesLargo = (mes: string): string =>
    new Date(`${mes}-01T00:00`).toLocaleDateString('es-AR', {month: 'long', year: 'numeric'});

function tarjeta(titulo: string, valor: string): HTMLElement {
    const card = element('div');
    card.className = 'stat-card';
    card.append(element('span', titulo), element('strong', valor));
    return card;
}

async function render(view: HTMLElement): Promise<void> {
    const datos = await cateringRequest<EstadisticasResponse>('/estadisticas');
    const facturacion = datos.porMes.reduce((sum, mes) => sum + mes.facturacion, 0);
    const vendidos = datos.porMes.reduce((sum, mes) => sum + mes.pedidos, 0);
    const personas = datos.porMes.reduce((sum, mes) => sum + mes.personas, 0);
    const tarjetas = element('div');
    tarjetas.className = 'stat-cards';
    tarjetas.append(
        tarjeta('Pedidos', String(datos.porEstado.reduce((sum, estado) => sum + estado.pedidos, 0))),
        tarjeta('Facturación', pesos(facturacion)),
        tarjeta('Ticket promedio', vendidos ? pesos(Math.round(facturacion / vendidos)) : '—'),
        tarjeta('Personas', personas.toLocaleString('es-AR')),
    );
    const nota = element('p', 'Facturación y personas cuentan los pedidos confirmados y entregados, por mes del evento.');
    nota.className = 'muted';
    view.replaceChildren(element('h2', 'Estadísticas'), tarjetas, nota,
        seccion('Pedidos por estado', tabla(['Estado', 'Pedidos'], datos.porEstado.map(e => [e.estado, e.pedidos]))),
        seccion('Facturación por mes', tabla(['Mes', 'Pedidos', 'Facturación', 'Personas'],
            datos.porMes.map(m => [mesLargo(m.mes), m.pedidos, pesos(m.facturacion), m.personas]))),
        seccion('Platos más pedidos', tabla(['Plato', 'Porciones', 'Pedidos'],
            datos.platosMasPedidos.map(p => [p.nombre, p.porciones, p.pedidos]))));
}

async function show(content: HTMLElement): Promise<(changed: string | null) => void> {
    const view = element('div');
    view.className = 'catering-view';
    await render(view);
    content.replaceChildren(view);
    return changed => {
        if (changed === null || changed === 'pedidos' || changed === 'pedido_platos' || changed === 'platos') void render(view).catch(() => {});
    };
}

export const estadisticasView: CateringView = {name: 'estadisticas', label: 'Estadísticas', show};
