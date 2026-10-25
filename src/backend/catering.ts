import {readFile} from 'node:fs/promises';
import express, {type Express} from 'express';
import type {Pool, PoolClient} from 'pg';
import {completeEntity} from 'system-definition';
import {myContext, myEntities} from './system.js';
import type {EntityName, StoredRow} from './api-contract.js';
import {ApiFailure, apiErrorHandler, readObject} from './api-errors.js';
import {authenticationLimit, type Authentication} from './auth.js';
import {entityTable, insertPreparedRow, prepareEntityWrite} from './entity-write.js';
import {cateringConfig} from './catering-config.js';
import type {CatalogoResponse, ComprasResponse, EntregaResponse, EstadisticasResponse, EstadoPedidoResponse,
    NuevoPedidoResponse, PedidoPendiente} from './catering-contract.js';

type Db = Pick<Pool, 'query' | 'connect'>;
type EstadoPedido = StoredRow<'pedidos'>['estado'];
const T = {
    ingredientes: entityTable('ingredientes'), platos: entityTable('platos'), recetas: entityTable('recetas'),
    servicios: entityTable('servicios'), servicio_platos: entityTable('servicio_platos'),
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

// Ingredient need of each order: portions × recipe quantity / portions the recipe yields.
const necesidadSql = (condicion: string) => `
    SELECT pe.id AS pedido, pe.fecha_evento, r.cod_ing,
           SUM(pp.porciones * r.cantidad::numeric / pl.porciones_receta) AS necesidad
    FROM ${T.pedidos} pe
    JOIN ${T.pedido_platos} pp ON pp.pedido = pe.id
    JOIN ${T.platos} pl ON pl.cod_plato = pp.cod_plato
    JOIN ${T.recetas} r ON r.cod_plato = pp.cod_plato
    WHERE ${condicion}
    GROUP BY pe.id, pe.fecha_evento, r.cod_ing`;

/* Stock goes first to the earliest confirmed orders. With acum = the need of this order plus all
   earlier ones, the order buys only its own shortfall: max(0, acum − stock) − max(0, previous − stock).
   Delivered orders already left the stock; pending and cancelled ones reserve nothing. */
export async function comprasDePedido(db: Pick<Pool, 'query'>, id: string): Promise<ComprasResponse> {
    const existe = await db.query(`SELECT 1 FROM ${T.pedidos} WHERE id = $1`, [id]);
    if (!existe.rowCount) throw new ApiFailure(404, 'El pedido no existe.');
    const {rows} = await db.query(`
        WITH necesidad AS (${necesidadSql(`pe.estado = 'Confirmado' OR pe.id = $1`)}),
        acumulado AS (
            SELECT *, SUM(necesidad) OVER (PARTITION BY cod_ing ORDER BY fecha_evento, pedido) AS acum FROM necesidad
        )
        SELECT i.cod_ing, i.nombre, i.unidad, i.stock_actual AS stock,
               CEIL(a.necesidad)::int AS necesidad,
               CEIL(a.acum - a.necesidad)::int AS consumo_previo,
               CEIL(GREATEST(0, a.acum - i.stock_actual))::int AS faltante,
               CEIL(GREATEST(0, a.acum - i.stock_actual) - GREATEST(0, a.acum - a.necesidad - i.stock_actual))::int AS comprar
        FROM acumulado a JOIN ${T.ingredientes} i ON i.cod_ing = a.cod_ing
        WHERE a.pedido = $1
        ORDER BY i.nombre, i.cod_ing`, [id]);
    return {ingredientes: rows};
}

// The same allocation for every confirmed order of a period (both dates included).
export async function comprasDePeriodo(db: Pick<Pool, 'query'>, desde: string, hasta: string): Promise<ComprasResponse> {
    const {rows} = await db.query(`
        WITH necesidad AS (${necesidadSql(`pe.estado = 'Confirmado' AND pe.fecha_evento < $2::date + 1`)}),
        por_ingrediente AS (
            SELECT cod_ing,
                   COALESCE(SUM(necesidad) FILTER (WHERE fecha_evento < $1::date), 0) AS previo,
                   COALESCE(SUM(necesidad) FILTER (WHERE fecha_evento >= $1::date), 0) AS periodo
            FROM necesidad GROUP BY cod_ing
        )
        SELECT i.cod_ing, i.nombre, i.unidad, i.stock_actual AS stock,
               CEIL(n.periodo)::int AS necesidad,
               CEIL(n.previo)::int AS consumo_previo,
               CEIL(GREATEST(0, n.previo + n.periodo - i.stock_actual))::int AS faltante,
               CEIL(GREATEST(0, n.previo + n.periodo - i.stock_actual) - GREATEST(0, n.previo - i.stock_actual))::int AS comprar
        FROM por_ingrediente n JOIN ${T.ingredientes} i ON i.cod_ing = n.cod_ing
        WHERE n.periodo > 0
        ORDER BY i.nombre, i.cod_ing`, [desde, hasta]);
    return {ingredientes: rows};
}

// Marks a confirmed order as delivered and takes its consumption out of the stock, atomically.
export async function entregarPedido(db: Db, id: string): Promise<EntregaResponse> {
    return enTransaccion(db, async client => {
        const {rows} = await client.query<{estado: EstadoPedido}>(`SELECT estado FROM ${T.pedidos} WHERE id = $1 FOR UPDATE`, [id]);
        if (!rows[0]) throw new ApiFailure(404, 'El pedido no existe.');
        if (rows[0].estado !== 'Confirmado') throw new ApiFailure(409, 'Solo se pueden entregar pedidos confirmados.');
        // Stock never goes below 0: a missing purchase that was never loaded cannot be consumed twice.
        const consumo = await client.query<{cod_ing: string; cantidad: number}>(`
            UPDATE ${T.ingredientes} i SET stock_actual = GREATEST(0, i.stock_actual - c.cantidad)
            FROM (SELECT cod_ing, CEIL(necesidad)::int AS cantidad FROM (${necesidadSql('pe.id = $1')}) n) c
            WHERE i.cod_ing = c.cod_ing
            RETURNING c.cod_ing, c.cantidad`, [id]);
        await client.query(`UPDATE ${T.pedidos} SET estado = 'Entregado' WHERE id = $1`, [id]);
        return {consumo: consumo.rows.sort((a, b) => a.cod_ing.localeCompare(b.cod_ing))};
    });
}

export async function estadisticas(db: Pick<Pool, 'query'>): Promise<EstadisticasResponse> {
    const porEstado = await db.query(`SELECT estado, count(*)::int AS pedidos FROM ${T.pedidos} GROUP BY estado ORDER BY estado`);
    const porMes = await db.query(`
        SELECT to_char(fecha_evento, 'YYYY-MM') AS mes, count(*)::int AS pedidos,
               SUM(total)::float8 AS facturacion, SUM(personas)::int AS personas
        FROM ${T.pedidos} WHERE estado IN ('Confirmado', 'Entregado')
        GROUP BY mes ORDER BY mes`);
    const platos = await db.query(`
        SELECT pl.cod_plato, pl.nombre, SUM(pp.porciones)::int AS porciones, count(*)::int AS pedidos
        FROM ${T.pedido_platos} pp
        JOIN ${T.pedidos} pe ON pe.id = pp.pedido
        JOIN ${T.platos} pl ON pl.cod_plato = pp.cod_plato
        WHERE pe.estado <> 'Cancelado'
        GROUP BY pl.cod_plato, pl.nombre
        ORDER BY porciones DESC, pl.nombre
        LIMIT 10`);
    return {porEstado: porEstado.rows, porMes: porMes.rows, platosMasPedidos: platos.rows};
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

function readDate(value: unknown): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw new ApiFailure(400, 'Indicá las fechas como AAAA-MM-DD.');
    }
    return value;
}

export function registerCateringApi(app: Express, pool: Db, auth: Authentication, publish: (name: EntityName) => void = () => {}): void {
    const admin = express.Router();
    admin.use(auth.requireUser);
    admin.use(express.json({limit: '8kb'}));
    admin.get('/pedidos', async (_req, res) => {
        const {rows} = await pool.query<PedidoPendiente>(`SELECT id, cliente_nombre, fecha_evento, personas, estado FROM ${T.pedidos}
            WHERE estado IN ('Pendiente', 'Confirmado') ORDER BY fecha_evento, id`);
        res.json(rows);
    });
    admin.get('/pedidos/:id/compras', async (req, res) => { res.json(await comprasDePedido(pool, readId(req.params['id']))); });
    admin.post('/pedidos/:id/entregar', async (req, res) => {
        const result = await entregarPedido(pool, readId(req.params['id']));
        publish('pedidos');
        publish('ingredientes');
        res.json(result);
    });
    admin.get('/compras', async (req, res) => {
        const query = readObject(req.query, ['desde', 'hasta']);
        res.json(await comprasDePeriodo(pool, readDate(query['desde']), readDate(query['hasta'])));
    });
    admin.get('/estadisticas', async (_req, res) => { res.json(await estadisticas(pool)); });
    admin.use((_req, res) => { res.status(404).json({error: 'Operación desconocida.'}); });
    admin.use(apiErrorHandler);
    app.use('/api/catering', admin);

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
