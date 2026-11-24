// Public catalog and status page; customer accounts are optional.
import type {ApiError, AuthenticatedCustomer, CustomerLoginResponse} from '../backend/browser-contract.js';
import type {CatalogoResponse, CatalogoServicio, EstadoPedidoResponse, NuevoPedido, NuevoPedidoResponse, PedidoCuenta,
    PedidoCanceladoResponse, PedidoLinkResponse, PedidoRepeticion} from '../backend/catering-contract.js';
import {element} from './dom.js';
import {messageOf} from './messages.js';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const pesos = (value: number) => `$ ${value.toLocaleString('es-AR')}`;
const fechaHora = (value: string) => new Date(value).toLocaleString('es-AR', {dateStyle: 'full', timeStyle: 'short'});
const pasos = ['menu', 'evento', 'contacto', 'resumen', 'listo', 'consulta', 'inicio'] as const;
type Paso = typeof pasos[number];
const categorias = {Entrada: 'Entradas', Principal: 'Principales', Postre: 'Postres', Bebida: 'Bebidas', 'Finger food': 'Finger food'} as const;
const customerSessionKey = 'ssot2026.customer-session';

const error = $<HTMLElement>('#error');
const personas = $<HTMLInputElement>('#personas');
const fecha = $<HTMLInputElement>('#fecha');
const contacto = $<HTMLFormElement>('#paso-contacto');

let catalogo: CatalogoResponse;
let tokenCliente: string | undefined;
let clienteActual: AuthenticatedCustomer | undefined;
let pedidoConfirmadoId: string | undefined;
let modo: 'servicio' | 'carta' = 'servicio';
let servicio: CatalogoServicio | undefined;
const porciones = new Map<string, number>();

async function api<T>(path: string, body?: unknown, token?: string, method?: 'GET' | 'POST' | 'DELETE'): Promise<T> {
    const response = await fetch(path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
        cache: 'no-store',
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    if (!response.ok) {
        if (response.status === 401 && token === tokenCliente) clearCustomerSession();
        const failure = await response.json() as ApiError;
        throw new Error(failure.problems?.length ? failure.problems.map(problem => messageOf(problem)).join(' ') : failure.error);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

function clearCustomerSession(): void {
    const hadSession = tokenCliente !== undefined;
    tokenCliente = undefined;
    clienteActual = undefined;
    localStorage.removeItem(customerSessionKey);
    actualizarIdentidadCliente();
    if (hadSession) window.dispatchEvent(new Event('customersessionexpired'));
}

function saveCustomerSession(session: CustomerLoginResponse): void {
    tokenCliente = session.token;
    clienteActual = session.customer;
    localStorage.setItem(customerSessionKey, JSON.stringify({
        token: session.token,
        expiresAt: Date.now() + session.expiresIn * 1000,
    }));
    actualizarIdentidadCliente();
}

function actualizarIdentidadCliente(): void {
    const autenticado = Boolean(tokenCliente && clienteActual);
    $('#cliente-nav').hidden = !autenticado;
    const nombre = contacto.elements.namedItem('cliente_nombre_pila') as HTMLInputElement;
    const apellido = contacto.elements.namedItem('cliente_apellido') as HTMLInputElement;
    const email = contacto.elements.namedItem('cliente_email') as HTMLInputElement;
    nombre.readOnly = autenticado;
    apellido.readOnly = autenticado;
    email.readOnly = autenticado;
    if (autenticado && clienteActual) {
        email.value = clienteActual.email;
        if (clienteActual.nombre) nombre.value = clienteActual.nombre;
        if (clienteActual.apellido) apellido.value = clienteActual.apellido;
    }
}

async function restoreCustomerSession(): Promise<void> {
    const saved = localStorage.getItem(customerSessionKey);
    if (!saved) return;
    let session: {token?: unknown; expiresAt?: unknown};
    try { session = JSON.parse(saved) as {token?: unknown; expiresAt?: unknown}; }
    catch {
        clearCustomerSession();
        return;
    }
    if (typeof session.token !== 'string' || typeof session.expiresAt !== 'number' || session.expiresAt <= Date.now()) {
        clearCustomerSession();
        return;
    }
    tokenCliente = session.token;
    try { clienteActual = await api<AuthenticatedCustomer>('/api/public/auth/me', undefined, tokenCliente); }
    catch (failure) {
        if (tokenCliente) throw failure;
    }
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
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + catalogo.anticipacionDias);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00:00`;
}

function elegirModo(nuevo: typeof modo): void {
    modo = nuevo;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-modo]')) {
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
        cliente_nombre: `${texto('cliente_nombre_pila')} ${texto('cliente_apellido')}`.trim(),
        cliente_email: texto('cliente_email'),
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

function prepararRepeticion(repetido: PedidoRepeticion): void {
    const [nombre, ...apellido] = repetido.cliente_nombre.trim().split(/\s+/);
    for (const [name, value] of Object.entries({
        cliente_nombre_pila: nombre ?? '', cliente_apellido: apellido.join(' '), cliente_email: repetido.cliente_email,
        cliente_telefono: repetido.cliente_telefono, direccion: repetido.direccion,
        observaciones: repetido.observaciones ?? '',
    })) {
        (contacto.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value = value;
    }
    personas.value = String(repetido.personas);
    fecha.value = '';
    porciones.clear();
    servicio = undefined;
    if (repetido.cod_servicio) {
        servicio = catalogo.servicios.find(item => item.cod_servicio === repetido.cod_servicio);
        if (!servicio) throw new Error('El menú de este pedido ya no está disponible para repetirlo.');
        elegirModo('servicio');
    } else {
        const disponibles = new Set(catalogo.platos.map(plato => plato.cod_plato));
        if (repetido.platos.some(plato => !disponibles.has(plato.cod_plato))) {
            throw new Error('Algunos platos de este pedido ya no están disponibles para repetirlo.');
        }
        for (const plato of repetido.platos) porciones.set(plato.cod_plato, plato.porciones);
        elegirModo('carta');
        cartaPorCategoria();
    }
    tarjetasServicios();
}

async function mostrarPedidos(sesion: AuthenticatedCustomer): Promise<void> {
    if (!tokenCliente) throw new Error('Iniciá sesión para continuar.');
    $('#inicio-identidad').textContent = `Sesión iniciada como ${sesion.email}`;
    $('#inicio-sin-sesion').hidden = true;
    $('#inicio-con-sesion').hidden = false;
    const perfilPendiente = sesion.nombre === null || sesion.apellido === null;
    $('#inicio-perfil-pendiente').hidden = !perfilPendiente;
    $('#inicio-pedidos-panel').hidden = perfilPendiente;
    if (perfilPendiente) {
        $<HTMLFormElement>('#inicio-perfil-form').reset();
        return;
    }
    const aviso = $('#inicio-aviso');
    if (pedidoConfirmadoId) {
        try {
            const vinculo = await api<PedidoLinkResponse>(
                `/api/public/mis-pedidos/${encodeURIComponent(pedidoConfirmadoId)}`, {}, tokenCliente);
            aviso.hidden = vinculo.associated;
            aviso.textContent = vinculo.associated ? '' :
                'El pedido recién realizado no se asoció porque el email del pedido no coincide con el de tu cuenta.';
        } catch (failure) {
            aviso.hidden = false;
            aviso.textContent = failure instanceof Error ? failure.message : 'No pudimos asociar el pedido recién realizado.';
        }
        pedidoConfirmadoId = undefined;
    } else aviso.hidden = true;
    const pedidos = await api<PedidoCuenta[]>('/api/public/mis-pedidos', undefined, tokenCliente);
    $('#inicio-identidad').textContent = `Sesión iniciada como ${sesion.email}`;
    const lista = $('#inicio-pedidos');
    if (!pedidos.length) {
        lista.replaceChildren(element('p', 'Todavía no hay pedidos asociados a esta cuenta. Hacé un pedido con este mismo email para verlo acá.'));
    } else {
        lista.replaceChildren(...pedidos.map(item => {
            const tarjeta = element('article');
            const codigo = element('code', item.id);
            const consultar = element('a', 'Consultar estado');
            consultar.href = `/pedidos?codigo=${encodeURIComponent(item.id)}`;
            tarjeta.append(element('p', `Pedido del ${fechaHora(item.fecha_evento)}`), codigo,
                element('p', `${item.personas} personas · ${pesos(item.total)} · ${item.estado}`), consultar);
            const acciones = element('div');
            acciones.className = 'nav';
            const repetir = element('button', 'Repetir pedido');
            repetir.type = 'button';
            repetir.onclick = async () => {
                repetir.disabled = true;
                try {
                    const detalle = await api<PedidoRepeticion>(
                        `/api/public/mis-pedidos/${encodeURIComponent(item.id)}`, undefined, tokenCliente);
                    prepararRepeticion(detalle);
                    mostrar('menu');
                } catch (failure) {
                    $('#inicio-error').textContent = failure instanceof Error ? failure.message : 'No pudimos repetir el pedido.';
                } finally { repetir.disabled = false; }
            };
            acciones.append(repetir);
            if (item.estado === 'Pendiente') {
                const cancelar = element('button', 'Cancelar pedido');
                cancelar.type = 'button';
                cancelar.onclick = async () => {
                    if (!window.confirm('¿Querés cancelar este pedido pendiente?')) return;
                    cancelar.disabled = true;
                    try {
                        await api<PedidoCanceladoResponse>(`/api/public/mis-pedidos/${encodeURIComponent(item.id)}`,
                            undefined, tokenCliente, 'DELETE');
                        await mostrarPedidos(sesion);
                    } catch (failure) {
                        $('#inicio-error').textContent = failure instanceof Error ? failure.message : 'No pudimos cancelar el pedido.';
                    } finally { cancelar.disabled = false; }
                };
                acciones.append(cancelar);
            }
            tarjeta.append(acciones);
            return tarjeta;
        }));
    }
    $('#inicio-error').textContent = '';
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
    pedidoConfirmadoId = new URLSearchParams(location.search).get('pedido') ?? undefined;
    window.addEventListener('customersessionexpired', () => {
        actualizarIdentidadCliente();
        $('#inicio-con-sesion').hidden = true;
        $('#inicio-sin-sesion').hidden = false;
        $('#inicio-error').textContent = 'La sesión venció o ya no es válida. Iniciá sesión nuevamente.';
    });
    $('#cliente-logout').onclick = async () => {
        try {
            if (tokenCliente) await api<void>('/api/public/auth/logout', {}, tokenCliente);
        } catch (failure) {
            const message = failure instanceof Error ? failure.message : 'No pudimos cerrar la sesión en el servidor.';
            error.textContent = message;
            $('#inicio-error').textContent = message;
        } finally {
            clearCustomerSession();
            $('#inicio-con-sesion').hidden = true;
            $('#inicio-sin-sesion').hidden = false;
        }
    };
    await restoreCustomerSession();
    actualizarIdentidadCliente();
    if (codigo) return consultar(codigo.trim());
    if (tokenCliente && (!clienteActual?.nombre || !clienteActual.apellido) && location.pathname !== '/inicio') {
        location.assign('/inicio');
        return;
    }

    catalogo = await api<CatalogoResponse>('/api/public/catalogo');
    tarjetasServicios();
    cartaPorCategoria();
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-modo]')) {
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
    $<HTMLFormElement>('#paso-evento').onsubmit = event => {
        event.preventDefault();
        fecha.min = minimoEvento();
        if (!fecha.reportValidity()) return;
        mostrar('contacto');
    };
    contacto.onsubmit = event => {
        event.preventDefault();
        resumen();
        mostrar('resumen');
    };
    const seleccionarCuenta = (modoCuenta: 'login' | 'registro') => {
        if (modoCuenta === 'registro' && (!contacto.elements.namedItem('cliente_nombre_pila') ||
            !(contacto.elements.namedItem('cliente_nombre_pila') as HTMLInputElement).value.trim() ||
            !(contacto.elements.namedItem('cliente_apellido') as HTMLInputElement).value.trim())) {
            $('#cuenta-error').textContent = 'Para crear una cuenta, completá tu nombre y apellido en los datos del pedido.';
            return;
        }
        $('#cuenta-error').textContent = '';
        for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cuenta]')) {
            button.setAttribute('aria-pressed', String(button.dataset['cuenta'] === modoCuenta));
        }
        $('#cuenta-login').hidden = modoCuenta !== 'login';
        $('#cuenta-registro').hidden = modoCuenta !== 'registro';
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cuenta]')) {
        button.onclick = () => seleccionarCuenta(button.dataset['cuenta'] as 'login' | 'registro');
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('.toggle-password')) {
        button.onclick = () => {
            const input = button.parentElement!.querySelector<HTMLInputElement>('input')!;
            const visible = input.type === 'password';
            input.type = visible ? 'text' : 'password';
            button.querySelector('span')!.textContent = visible ? 'Ocultar' : 'Mostrar';
            button.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
            button.setAttribute('aria-pressed', String(visible));
        };
    }
    const cuentaDialog = $<HTMLDialogElement>('#cuenta-dialog');
    const cerrarCuenta = () => cuentaDialog.close();
    $('#cerrar-cuenta').onclick = cerrarCuenta;
    $('#omitir-cuenta').onclick = cerrarCuenta;
    const abrirCuenta = () => {
        if (!tokenCliente) {
            const email = String(new FormData(contacto).get('cliente_email') ?? '');
            ($<HTMLFormElement>('#cuenta-login').elements.namedItem('email') as HTMLInputElement).value = email;
            ($<HTMLFormElement>('#cuenta-registro').elements.namedItem('email') as HTMLInputElement).value = email;
            seleccionarCuenta('login');
        }
        cuentaDialog.showModal();
    };
    $('#abrir-cuenta').onclick = () => {
        if (tokenCliente) location.assign('/inicio');
        else abrirCuenta();
    };
    $('#abrir-cuenta-inicio').onclick = abrirCuenta;

    const cargarMisPedidos = async (sesion: CustomerLoginResponse) => {
        saveCustomerSession(sesion);
        if (location.pathname !== '/inicio') {
            const query = pedidoConfirmadoId ? `?pedido=${encodeURIComponent(pedidoConfirmadoId)}` : '';
            location.assign(`/inicio${query}`);
            return;
        }
        cuentaDialog.close();
        await mostrarPedidos(sesion.customer);
    };
    $<HTMLFormElement>('#cuenta-login').onsubmit = async event => {
        event.preventDefault();
        const datos = new FormData(event.currentTarget as HTMLFormElement);
        try {
            await cargarMisPedidos(await api<CustomerLoginResponse>('/api/public/auth/login', {
                email: datos.get('email'), contrasena: datos.get('contrasena'),
            }));
        } catch (failure) {
            $('#cuenta-error').textContent = failure instanceof Error ? failure.message : 'No pudimos iniciar sesión.';
        }
    };
    $<HTMLFormElement>('#cuenta-registro').onsubmit = async event => {
        event.preventDefault();
        const datos = new FormData(event.currentTarget as HTMLFormElement);
        const pedidoDatos = new FormData(contacto);
        try {
            await cargarMisPedidos(await api<CustomerLoginResponse>('/api/public/auth/register', {
                email: datos.get('email'),
                nombre: pedidoDatos.get('cliente_nombre_pila'), apellido: pedidoDatos.get('cliente_apellido'),
                contrasena: datos.get('contrasena'),
            }));
        } catch (failure) {
            $('#cuenta-error').textContent = failure instanceof Error ? failure.message : 'No pudimos crear tu cuenta.';
        }
    };
    $<HTMLFormElement>('#inicio-perfil-form').onsubmit = async event => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
        button.disabled = true;
        try {
            const data = new FormData(form);
            clienteActual = await api<AuthenticatedCustomer>('/api/public/auth/profile', {
                nombre: data.get('nombre'), apellido: data.get('apellido'),
            }, tokenCliente);
            actualizarIdentidadCliente();
            await mostrarPedidos(clienteActual);
        } catch (failure) {
            $('#inicio-error').textContent = failure instanceof Error ? failure.message : 'No pudimos guardar tu perfil.';
        } finally { button.disabled = false; }
    };
    const confirmar = $<HTMLButtonElement>('#confirmar');
    confirmar.onclick = async () => {
        fecha.min = minimoEvento();
        if (fecha.value < fecha.min) {
            mostrar('evento');
            fecha.reportValidity();
            return;
        }
        confirmar.disabled = true;
        try {
            const {id} = await api<NuevoPedidoResponse>('/api/public/pedidos', pedido(), tokenCliente);
            pedidoConfirmadoId = id;
            $('#codigo').textContent = id;
            $<HTMLAnchorElement>('#link-consulta').href = `/pedidos?codigo=${encodeURIComponent(id)}`;
            mostrar('listo');
            if (tokenCliente) $('#abrir-cuenta').textContent = 'Ver mis pedidos';
            else abrirCuenta();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : 'No pudimos registrar el pedido.';
        } finally { confirmar.disabled = false; }
    };
    if (location.pathname === '/inicio') {
        mostrar('inicio');
        if (tokenCliente && clienteActual) await mostrarPedidos(clienteActual);
        else {
            $('#inicio-con-sesion').hidden = true;
            $('#inicio-sin-sesion').hidden = false;
        }
    } else mostrar('menu');
}

iniciar().catch(failure => {
    const message = failure instanceof Error ? failure.message : 'No pudimos cargar la información.';
    error.textContent = message;
    $('#inicio-error').textContent = message;
});
