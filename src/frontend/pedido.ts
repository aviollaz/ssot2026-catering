// Public order page: no account, the order's uuid is the code to check it later.
import type {ApiError} from '../backend/browser-contract.js';
import type {CatalogoResponse, CatalogoServicio, EstadoPedidoResponse, NuevoPedido, NuevoPedidoResponse} from '../backend/catering-contract.js';
import {element} from './dom.js';
import {messageOf} from './messages.js';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const pesos = (value: number) => `$ ${value.toLocaleString('es-AR')}`;
const fechaHora = (value: string) => new Date(value).toLocaleString('es-AR', {dateStyle: 'full', timeStyle: 'short'});
const pasos = ['menu', 'evento', 'contacto', 'resumen', 'listo', 'consulta'] as const;
type Paso = typeof pasos[number];
const categorias = {Entrada: 'Entradas', Principal: 'Principales', Postre: 'Postres', Bebida: 'Bebidas', 'Finger food': 'Finger food'} as const;

const error = $<HTMLElement>('#error');
const personas = $<HTMLInputElement>('#personas');
const fecha = $<HTMLInputElement>('#fecha');
const contacto = $<HTMLFormElement>('#paso-contacto');

let catalogo: CatalogoResponse;
let modo: 'servicio' | 'carta' = 'servicio';
let servicio: CatalogoServicio | undefined;
const porciones = new Map<string, number>();

async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined ? {} : {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    if (!response.ok) {
        const failure = await response.json() as ApiError;
        throw new Error(failure.problems?.length ? failure.problems.map(problem => messageOf(problem)).join(' ') : failure.error);
    }
    return response.json() as Promise<T>;
}

function mostrar(paso: Paso): void {
    for (const id of pasos) $(`#paso-${id}`).hidden = id !== paso;
    const actual = pasos.indexOf(paso);
    for (const item of document.querySelectorAll<HTMLElement>('.steps li')) {
        const indice = pasos.indexOf(item.dataset['step'] as Paso);
        item.classList.toggle('active', indice === actual);
        item.classList.toggle('complete', indice < actual);
    }
    $('.steps').hidden = actual > 3;
    error.textContent = '';
    window.scrollTo({top: 0, behavior: 'smooth'});
}

// A local datetime-local value: the earliest event the catering accepts.
function minimoEvento(): string {
    const date = new Date(Date.now() + catalogo.anticipacionDias * 24 * 60 * 60 * 1000);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
}

function elegirModo(nuevo: typeof modo): void {
    modo = nuevo;
    for (const button of document.querySelectorAll<HTMLButtonElement>('.mode-switch button')) {
        button.setAttribute('aria-pressed', String(button.dataset['modo'] === modo));
    }
    $('#servicios').hidden = modo !== 'servicio';
    $('#carta').hidden = modo !== 'carta';
}

function tarjetasServicios(): void {
    $('#servicios').replaceChildren(...catalogo.servicios.map(s => {
        const card = element('button');
        card.type = 'button';
        card.className = 'card service';
        card.setAttribute('aria-pressed', String(servicio === s));
        const platos = element('ul');
        platos.append(...s.platos.map(p => element('li', p.porciones_por_persona > 1 ? `${p.nombre} × ${p.porciones_por_persona}` : p.nombre)));
        card.append(element('h3', s.nombre), element('p', s.descripcion ?? ''), platos,
            Object.assign(element('p', `${pesos(s.precio_persona)} por persona · desde ${s.min_personas} personas`), {className: 'price'}));
        card.onclick = () => { servicio = s; tarjetasServicios(); };
        return card;
    }));
    if (!catalogo.servicios.length) $('#servicios').append(element('p', 'Por ahora no hay menús armados disponibles.'));
}

function cartaPorCategoria(): void {
    $('#carta').replaceChildren(...Object.entries(categorias).flatMap(([categoria, titulo]) => {
        const platos = catalogo.platos.filter(p => p.categoria === categoria);
        if (!platos.length) return [];
        const grupo = element('div');
        grupo.className = 'cards';
        grupo.append(...platos.map(p => {
            const card = element('div');
            card.className = 'card dish';
            const cantidad = element('input');
            cantidad.type = 'number';
            cantidad.min = '0';
            cantidad.step = '1';
            cantidad.value = String(porciones.get(p.cod_plato) ?? 0);
            cantidad.setAttribute('aria-label', `Porciones de ${p.nombre}`);
            cantidad.oninput = () => {
                const value = cantidad.valueAsNumber;
                if (Number.isInteger(value) && value > 0) porciones.set(p.cod_plato, value);
                else porciones.delete(p.cod_plato);
                card.classList.toggle('selected', porciones.has(p.cod_plato));
            };
            card.classList.toggle('selected', porciones.has(p.cod_plato));
            const label = element('label', 'Porciones ');
            label.append(cantidad);
            card.append(element('h3', p.nombre), element('p', p.descripcion ?? ''),
                Object.assign(element('p', `${pesos(p.precio_porcion)} la porción`), {className: 'price'}), label);
            return card;
        }));
        return [element('h3', titulo), grupo];
    }));
}

function pedido(): NuevoPedido {
    const datos = new FormData(contacto);
    const texto = (name: string) => String(datos.get(name) ?? '').trim();
    const cliente = {
        cliente_nombre: texto('cliente_nombre'), cliente_email: texto('cliente_email'),
        cliente_telefono: texto('cliente_telefono'), direccion: texto('direccion'),
        fecha_evento: fecha.value, personas: personas.valueAsNumber, observaciones: texto('observaciones') || null,
    };
    return modo === 'servicio'
        ? {...cliente, cod_servicio: servicio!.cod_servicio}
        : {...cliente, platos: [...porciones].map(([cod_plato, cantidad]) => ({cod_plato, porciones: cantidad}))};
}

function resumen(): void {
    const datos = pedido();
    const filas: [string, string][] = [];
    let total: number;
    if (modo === 'servicio') {
        filas.push([`${servicio!.nombre} · ${datos.personas} personas × ${pesos(servicio!.precio_persona)}`, pesos(servicio!.precio_persona * datos.personas)]);
        total = servicio!.precio_persona * datos.personas;
    } else {
        total = 0;
        for (const [codigo, cantidad] of porciones) {
            const plato = catalogo.platos.find(p => p.cod_plato === codigo)!;
            filas.push([`${plato.nombre} · ${cantidad} × ${pesos(plato.precio_porcion)}`, pesos(cantidad * plato.precio_porcion)]);
            total += cantidad * plato.precio_porcion;
        }
    }
    const detalle = element('dl');
    for (const [titulo, valor] of [['Fecha', fechaHora(datos.fecha_evento)], ['Personas', String(datos.personas)],
        ['Contacto', `${datos.cliente_nombre} · ${datos.cliente_email} · ${datos.cliente_telefono}`], ['Dirección', datos.direccion]]) {
        detalle.append(element('dt', titulo), element('dd', valor));
    }
    const lista = element('ul');
    lista.className = 'lines';
    for (const [titulo, valor] of filas) {
        const item = element('li');
        item.append(element('span', titulo), element('span', valor));
        lista.append(item);
    }
    const totalItem = element('li', '');
    totalItem.className = 'total';
    totalItem.append(element('span', 'Total'), element('span', pesos(total)));
    lista.append(totalItem);
    $('#resumen').replaceChildren(detalle, lista);
}

async function consultar(codigo: string): Promise<void> {
    mostrar('consulta');
    const resultado = $('#consulta-resultado');
    try {
        const estado = await api<EstadoPedidoResponse>(`/api/public/pedidos/${encodeURIComponent(codigo)}`);
        const detalle = element('dl');
        const badge = element('dd', estado.estado);
        badge.className = `badge ${estado.estado.toLowerCase()}`;
        detalle.append(element('dt', 'Estado'), badge);
        for (const [titulo, valor] of [['Fecha', fechaHora(estado.fecha_evento)], ['Personas', String(estado.personas)], ['Total', pesos(estado.total)]]) {
            detalle.append(element('dt', titulo), element('dd', valor));
        }
        resultado.replaceChildren(detalle);
    } catch (failure) {
        resultado.replaceChildren(element('p', failure instanceof Error ? failure.message : 'No pudimos consultar el pedido.'));
    }
}

async function iniciar(): Promise<void> {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
        button.onclick = () => mostrar(pasos[pasos.indexOf(button.closest<HTMLElement>('.step')!.id.slice(5) as Paso) - 1]!);
    }
    const codigo = new URLSearchParams(location.search).get('codigo');
    if (codigo) return consultar(codigo.trim());

    catalogo = await api<CatalogoResponse>('/api/public/catalogo');
    tarjetasServicios();
    cartaPorCategoria();
    for (const button of document.querySelectorAll<HTMLButtonElement>('.mode-switch button')) {
        button.onclick = () => elegirModo(button.dataset['modo'] as typeof modo);
    }
    $('#menu-siguiente').onclick = () => {
        if (modo === 'servicio' && !servicio) { error.textContent = 'Elegí uno de los menús.'; return; }
        if (modo === 'carta' && !porciones.size) { error.textContent = 'Indicá las porciones de al menos un plato.'; return; }
        personas.min = String(modo === 'servicio' ? servicio!.min_personas : 1);
        fecha.min = minimoEvento();
        $('#evento-ayuda').textContent = `Tomamos pedidos con al menos ${catalogo.anticipacionDias} días de anticipación` +
            (modo === 'servicio' ? ` y para ${servicio!.min_personas} personas o más.` : '.');
        mostrar('evento');
    };
    $<HTMLFormElement>('#paso-evento').onsubmit = event => { event.preventDefault(); mostrar('contacto'); };
    contacto.onsubmit = event => { event.preventDefault(); resumen(); mostrar('resumen'); };
    const confirmar = $<HTMLButtonElement>('#confirmar');
    confirmar.onclick = async () => {
        confirmar.disabled = true;
        try {
            const {id} = await api<NuevoPedidoResponse>('/api/public/pedidos', pedido());
            $('#codigo').textContent = id;
            $<HTMLAnchorElement>('#link-consulta').href = `/pedido?codigo=${encodeURIComponent(id)}`;
            mostrar('listo');
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : 'No pudimos registrar el pedido.';
        } finally { confirmar.disabled = false; }
    };
    mostrar('menu');
}

iniciar().catch(() => { error.textContent = 'No pudimos cargar el catálogo. Probá de nuevo en unos minutos.'; });
