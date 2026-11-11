import {readFile} from 'node:fs/promises';
import express, {type Express} from 'express';
import type {Pool, PoolClient} from 'pg';
import {completeEntity} from 'system-definition';
import {myContext, myEntities} from './system.js';
import type {EntityName, StoredRow} from './api-contract.js';
import {ApiFailure, apiErrorHandler, readObject} from './api-errors.js';
import {authenticationLimit} from './auth.js';
import {entityTable, insertPreparedRow, prepareEntityWrite} from './entity-write.js';
import {cateringConfig} from './catering-config.js';
import type {CatalogoResponse, EstadoPedidoResponse, NuevoPedidoResponse} from './catering-contract.js';

type Db = Pick<Pool, 'query' | 'connect'>;
type EstadoPedido = StoredRow<'pedidos'>['estado'];
const T = {
    platos: entityTable('platos'), servicios: entityTable('servicios'), servicio_platos: entityTable('servicio_platos'),
    pedidos: entityTable('pedidos'), pedido_platos: entityTable('pedido_platos'),
};
const pedidos = completeEntity(myContext, myEntities.pedidos);
const pedidoPlatos = completeEntity(myContext, myEntities.pedido_platos);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function enTransaccion<T>(db: Db, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

export async function catalogo(db: Pick<Pool, 'query'>): Promise<CatalogoResponse> {
    const platos = await db.query(`
        SELECT cod_plato, nombre, descripcion, categoria, precio_porcion FROM ${T.platos}
        WHERE activo ORDER BY nombre, cod_plato`);
    const servicios = await db.query(`
        SELECT s.cod_servicio, s.nombre, s.descripcion, s.precio_persona, s.min_personas,
               COALESCE(json_agg(json_build_object('cod_plato', p.cod_plato, 'nombre', p.nombre,
                   'porciones_por_persona', sp.porciones_por_persona) ORDER BY p.nombre)
                   FILTER (WHERE p.cod_plato IS NOT NULL), '[]') AS platos
        FROM ${T.servicios} s
        LEFT JOIN ${T.servicio_platos} sp ON sp.cod_servicio = s.cod_servicio
        LEFT JOIN ${T.platos} p ON p.cod_plato = sp.cod_plato AND p.activo
        WHERE s.activo
        GROUP BY s.cod_servicio
        ORDER BY s.precio_persona, s.nombre`);
    return {platos: platos.rows, servicios: servicios.rows, anticipacionDias: cateringConfig.anticipacionDias};
}

type Linea = {cod_plato: string; porciones: number; precio_porcion: number};

/* Creates an order and its dishes in one transaction, validated by the SSOT. The total always comes
   from the server's prices. A service copies its dishes (personas × porciones_por_persona) and is
   charged per person; an à la carte order is charged per portion. */
export async function crearPedido(db: Db, body: unknown, opciones: {estado?: EstadoPedido; ahora?: Date | null} = {}): Promise<NuevoPedidoResponse> {
    const cliente = ['cliente_nombre', 'cliente_email', 'cliente_telefono', 'direccion', 'fecha_evento', 'personas'];
    const input = readObject(body, cliente, ['observaciones', 'cod_servicio', 'platos']);
    if (Object.hasOwn(input, 'cod_servicio') === Object.hasOwn(input, 'platos')) {
        throw new ApiFailure(400, 'Elegí un servicio o armá el pedido plato por plato.');
    }
    const pedido = await prepareEntityWrite(pedidos, {
        ...Object.fromEntries(cliente.map(name => [name, input[name]])),
        observaciones: input['observaciones'] ?? null,
        cod_servicio: input['cod_servicio'] ?? null,
        estado: opciones.estado ?? 'Pendiente',
        total: 1, // validated as a placeholder, replaced below
    }, 'create');
    const personas = pedido['personas'] as number;
    const ahora = opciones.ahora === undefined ? new Date() : opciones.ahora;
    if (ahora && Date.parse(pedido['fecha_evento'] as string) < ahora.getTime() + cateringConfig.anticipacionDias * 24 * 60 * 60 * 1000) {
        throw new ApiFailure(400, `El evento tiene que ser con al menos ${cateringConfig.anticipacionDias} días de anticipación.`);
    }
    return enTransaccion(db, async client => {
        let lineas: Linea[];
        let total: number;
        if (pedido['cod_servicio'] !== null) {
            const {rows: [servicio]} = await client.query<{precio_persona: number; min_personas: number}>(
                `SELECT precio_persona, min_personas FROM ${T.servicios} WHERE cod_servicio = $1 AND activo`, [pedido['cod_servicio']]);
            if (!servicio) throw new ApiFailure(400, 'El servicio elegido no existe o no está disponible.');
            if (personas < servicio.min_personas) throw new ApiFailure(400, `Este servicio es para un mínimo de ${servicio.min_personas} personas.`);
            lineas = (await client.query<Linea>(`
                SELECT sp.cod_plato, sp.porciones_por_persona * $2::int AS porciones, p.precio_porcion
                FROM ${T.servicio_platos} sp JOIN ${T.platos} p ON p.cod_plato = sp.cod_plato
                WHERE sp.cod_servicio = $1 AND p.activo ORDER BY sp.cod_plato`, [pedido['cod_servicio'], personas])).rows;
            if (!lineas.length) throw new ApiFailure(400, 'El servicio elegido no tiene platos disponibles.');
            total = servicio.precio_persona * personas;
        } else {
            lineas = await lineasALaCarta(client, input['platos']);
            total = lineas.reduce((sum, linea) => sum + linea.porciones * linea.precio_porcion, 0);
        }
        pedido['total'] = total;
        await insertPreparedRow(client, pedidos, pedido);
        for (const linea of lineas) {
            await insertPreparedRow(client, pedidoPlatos, await prepareEntityWrite(pedidoPlatos, {pedido: pedido['id'], ...linea}, 'create'));
        }
        return {id: pedido['id'] as string, total};
    });
}

async function lineasALaCarta(client: PoolClient, value: unknown): Promise<Linea[]> {
    if (!Array.isArray(value) || value.length === 0 || value.length > cateringConfig.maxPlatosPorPedido) {
        throw new ApiFailure(400, `Elegí entre 1 y ${cateringConfig.maxPlatosPorPedido} platos.`);
    }
    const items = value.map(item => readObject(item, ['cod_plato', 'porciones']));
    const codigos = items.map(item => item['cod_plato']);
    if (codigos.some(codigo => typeof codigo !== 'string') || new Set(codigos).size !== codigos.length) {
        throw new ApiFailure(400, 'Cada plato se elige una sola vez.');
    }
    const {rows} = await client.query<{cod_plato: string; precio_porcion: number}>(
        `SELECT cod_plato, precio_porcion FROM ${T.platos} WHERE activo AND cod_plato = ANY($1::text[])`, [codigos]);
    const precios = new Map(rows.map(row => [row.cod_plato, row.precio_porcion]));
    return items.map(item => {
        const precio = precios.get(item['cod_plato'] as string);
        if (precio === undefined) throw new ApiFailure(400, `El plato ${String(item['cod_plato'])} no existe o no está disponible.`);
        if (!myContext.behaviours.posInteger.check(item['porciones'])) throw new ApiFailure(400, 'Las porciones tienen que ser un número entero mayor que 0.');
        return {cod_plato: item['cod_plato'] as string, porciones: item['porciones'], precio_porcion: precio};
    });
}

// Example orders go through the same validation, without the anticipation rule, in their given state.
export async function cargarPedidosEjemplo(db: Db, file: string): Promise<number> {
    const ejemplos = JSON.parse(await readFile(file, 'utf8')) as {estado: EstadoPedido}[];
    for (const {estado, ...pedido} of ejemplos) await crearPedido(db, pedido, {estado, ahora: null});
    return ejemplos.length;
}

function readId(value: unknown): string {
    if (typeof value !== 'string' || !uuid.test(value)) throw new ApiFailure(404, 'El pedido no existe.');
    return value;
}

export function registerPublicApi(app: Express, pool: Db, publish: (name: EntityName) => void = () => {}): void {
    // Without login: the catalog, placing an order and checking it by its secret code (the uuid).
    const pub = express.Router();
    pub.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    pub.use(express.json({limit: '16kb'}));
    pub.get('/catalogo', async (_req, res) => { res.json(await catalogo(pool)); });
    pub.post('/pedidos', authenticationLimit(), async (req, res) => {
        const result = await crearPedido(pool, req.body);
        publish('pedidos');
        publish('pedido_platos');
        res.status(201).json(result);
    });
    pub.get('/pedidos/:id', async (req, res) => {
        const {rows} = await pool.query<EstadoPedidoResponse>(
            `SELECT estado, fecha_evento, personas, total FROM ${T.pedidos} WHERE id = $1`, [readId(req.params['id'])]);
        if (!rows[0]) throw new ApiFailure(404, 'El pedido no existe.');
        res.json(rows[0]);
    });
    pub.use((_req, res) => { res.status(404).json({error: 'Operación desconocida.'}); });
    pub.use(apiErrorHandler);
    app.use('/api/public', pub);
}
