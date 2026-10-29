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
import {datosDeContacto, exportables, exportarTablas} from './exportar.js';
import {localDateTime} from './value-types.js';
import type {CatalogoResponse, ComprasResponse, EgresoSugerido, EstadisticasResponse, EstadoPedidoResponse, MovimientoResponse,
    ExportablesResponse, MovimientoResumen, NuevoPedidoResponse, OpcionesInventario, PedidoPendiente, TipoMovimiento, Unidad} from './catering-contract.js';

type Db = Pick<Pool, 'query' | 'connect'>;
type EstadoPedido = StoredRow<'pedidos'>['estado'];
const T = {
    ingredientes: entityTable('ingredientes'), unidades: entityTable('unidades'), platos: entityTable('platos'), recetas: entityTable('recetas'),
    servicios: entityTable('servicios'), servicio_platos: entityTable('servicio_platos'),
    pedidos: entityTable('pedidos'), pedido_platos: entityTable('pedido_platos'),
    movimientos: entityTable('movimientos'), movimiento_platos: entityTable('movimiento_platos'),
    movimiento_ingredientes: entityTable('movimiento_ingredientes'),
};
const pedidos = completeEntity(myContext, myEntities.pedidos);
const pedidoPlatos = completeEntity(myContext, myEntities.pedido_platos);
const movimientos = completeEntity(myContext, myEntities.movimientos);
const movimientoPlatos = completeEntity(myContext, myEntities.movimiento_platos);
const movimientoIngredientes = completeEntity(myContext, myEntities.movimiento_ingredientes);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// With `confirmar` false the work runs and is rolled back, to preview its result.
async function enTransaccion<T>(db: Db, work: (client: PoolClient) => Promise<T>, confirmar = true): Promise<T> {
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query(confirmar ? 'COMMIT' : 'ROLLBACK');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

const unidades = async (db: Pick<Pool, 'query'>): Promise<Unidad[]> =>
    (await db.query<Unidad>(`SELECT cod_unidad, nombre, base, factor FROM ${T.unidades} ORDER BY base, factor, nombre`)).rows;

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
        SELECT i.cod_ing, i.nombre, i.unidad, i.unidad_compra, i.stock_actual AS stock,
               CEIL(a.necesidad)::int AS necesidad,
               CEIL(a.acum - a.necesidad)::int AS consumo_previo,
               CEIL(GREATEST(0, a.acum - i.stock_actual))::int AS faltante,
               CEIL(GREATEST(0, a.acum - i.stock_actual) - GREATEST(0, a.acum - a.necesidad - i.stock_actual))::int AS comprar
        FROM acumulado a JOIN ${T.ingredientes} i ON i.cod_ing = a.cod_ing
        WHERE a.pedido = $1
        ORDER BY i.nombre, i.cod_ing`, [id]);
    return {ingredientes: rows, unidades: await unidades(db)};
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
        SELECT i.cod_ing, i.nombre, i.unidad, i.unidad_compra, i.stock_actual AS stock,
               CEIL(n.periodo)::int AS necesidad,
               CEIL(n.previo)::int AS consumo_previo,
               CEIL(GREATEST(0, n.previo + n.periodo - i.stock_actual))::int AS faltante,
               CEIL(GREATEST(0, n.previo + n.periodo - i.stock_actual) - GREATEST(0, n.previo - i.stock_actual))::int AS comprar
        FROM por_ingrediente n JOIN ${T.ingredientes} i ON i.cod_ing = n.cod_ing
        WHERE n.periodo > 0
        ORDER BY i.nombre, i.cod_ing`, [desde, hasta]);
    return {ingredientes: rows, unidades: await unidades(db)};
}

async function bloquearPedido(client: PoolClient, id: unknown, estado: EstadoPedido, error: string): Promise<void> {
    const {rows} = await client.query<{estado: EstadoPedido}>(`SELECT estado FROM ${T.pedidos} WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new ApiFailure(404, 'El pedido no existe.');
    if (rows[0].estado !== estado) throw new ApiFailure(409, error);
}

type LineaStock = {cod_ing: string; cantidad: number};

/* Applies signed stock changes, or for an Ajuste the counted stock, and records in the ledger what actually
   changed. Stock never goes below 0, so the ledger of an ingredient always adds up to its stock. */
async function aplicarStock(client: PoolClient, movimiento: string, lineas: readonly LineaStock[], contado: boolean): Promise<LineaStock[]> {
    const {rows} = await client.query<LineaStock>(`
        UPDATE ${T.ingredientes} i
        SET stock_actual = CASE WHEN $2 THEN l.cantidad ELSE GREATEST(0, i.stock_actual + l.cantidad) END
        FROM jsonb_to_recordset($1::jsonb) AS l(cod_ing text, cantidad int)
        WHERE i.cod_ing = l.cod_ing
        RETURNING i.cod_ing, new.stock_actual - old.stock_actual AS cantidad`, [JSON.stringify(lineas), contado]);
    if (rows.length !== lineas.length) throw new ApiFailure(400, 'Uno de los ingredientes no existe.');
    const cambios = rows.filter(row => row.cantidad !== 0).sort((a, b) => a.cod_ing.localeCompare(b.cod_ing));
    for (const linea of cambios) {
        await insertPreparedRow(client, movimientoIngredientes, await prepareEntityWrite(movimientoIngredientes, {movimiento, ...linea}, 'create'));
    }
    return cambios;
}

function readLineas(value: unknown, required: string[], optional: string[] = []): Record<string, unknown>[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > cateringConfig.maxLineasPorMovimiento) {
        throw new ApiFailure(400, `Cargá entre 1 y ${cateringConfig.maxLineasPorMovimiento} líneas.`);
    }
    const items = value.map(item => readObject(item, required, optional));
    const claves = items.map(item => item[required[0]!]);
    if (claves.some(clave => typeof clave !== 'string') || new Set(claves).size !== claves.length) {
        throw new ApiFailure(400, 'Cada plato o ingrediente se carga una sola vez.');
    }
    return items;
}

// Ingreso adds, Merma subtracts, Ajuste is the counted stock; each in any unit of the ingredient's base.
async function lineasIngredientes(client: PoolClient, tipo: TipoMovimiento, value: unknown): Promise<LineaStock[]> {
    const items = readLineas(value, ['cod_ing', 'cantidad'], ['cod_unidad']);
    const {rows: bases} = await client.query<{cod_ing: string; unidad: string}>(
        `SELECT cod_ing, unidad FROM ${T.ingredientes} WHERE cod_ing = ANY($1::text[])`, [items.map(item => item['cod_ing'])]);
    const {rows: unidades} = await client.query<Unidad>(
        `SELECT cod_unidad, nombre, base, factor FROM ${T.unidades} WHERE cod_unidad = ANY($1::text[])`, [items.map(item => item['cod_unidad'] ?? null)]);
    return items.map(item => {
        const base = bases.find(row => row.cod_ing === item['cod_ing']);
        if (!base) throw new ApiFailure(400, `El ingrediente ${String(item['cod_ing'])} no existe.`);
        const cantidad = item['cantidad'];
        if (typeof cantidad !== 'number' || !Number.isFinite(cantidad) || cantidad < 0 || (tipo !== 'Ajuste' && cantidad === 0)) {
            throw new ApiFailure(400, tipo === 'Ajuste' ? 'El stock contado no puede ser negativo.' : 'Las cantidades tienen que ser mayores que 0.');
        }
        const codigo = item['cod_unidad'] ?? base.unidad;
        const unidad = codigo === base.unidad ? {base: base.unidad, factor: 1} : unidades.find(row => row.cod_unidad === codigo);
        if (!unidad || unidad.base !== base.unidad) {
            throw new ApiFailure(400, `La unidad ${String(codigo)} no sirve para ${base.cod_ing}, que se mide en ${base.unidad}.`);
        }
        const enBase = Math.round(cantidad * unidad.factor);
        return {cod_ing: base.cod_ing, cantidad: tipo === 'Merma' ? -enBase : enBase};
    });
}

/* Records a stock movement and applies it in one transaction. An Egreso is loaded with the dishes actually
   made: its ingredients come from the recipes, and when it belongs to a confirmed order that order becomes
   Entregado. With `simular`, nothing is saved: it returns what the movement would change. */
export async function registrarMovimiento(db: Db, body: unknown, {simular = false} = {}): Promise<MovimientoResponse> {
    const input = readObject(body, ['tipo'], ['fecha', 'pedido', 'facturado', 'observaciones', 'platos', 'ingredientes']);
    const movimiento = await prepareEntityWrite(movimientos, {
        fecha: input['fecha'] ?? localDateTime(), tipo: input['tipo'], pedido: input['pedido'] ?? null,
        facturado: input['facturado'] ?? null, anula: null, observaciones: input['observaciones'] ?? null,
    }, 'create');
    const tipo = movimiento['tipo'] as TipoMovimiento;
    const egreso = tipo === 'Egreso';
    if (Object.hasOwn(input, egreso ? 'ingredientes' : 'platos') || !Object.hasOwn(input, egreso ? 'platos' : 'ingredientes')) {
        throw new ApiFailure(400, egreso ? 'Un egreso se carga con los platos que se hicieron.' : 'Cargá los ingredientes del movimiento.');
    }
    const id = movimiento['id'] as string;
    return enTransaccion(db, async client => {
        if (movimiento['pedido'] !== null) {
            await bloquearPedido(client, movimiento['pedido'], 'Confirmado', 'Solo se registra el egreso de pedidos confirmados.');
        }
        await insertPreparedRow(client, movimientos, movimiento);
        let lineas: LineaStock[];
        if (egreso) {
            const platos = readLineas(input['platos'], ['cod_plato', 'porciones']);
            const {rows: existentes} = await client.query<{cod_plato: string}>(
                `SELECT cod_plato FROM ${T.platos} WHERE cod_plato = ANY($1::text[])`, [platos.map(plato => plato['cod_plato'])]);
            for (const plato of platos) {
                if (!existentes.some(row => row.cod_plato === plato['cod_plato'])) throw new ApiFailure(400, `El plato ${String(plato['cod_plato'])} no existe.`);
                await insertPreparedRow(client, movimientoPlatos, await prepareEntityWrite(movimientoPlatos, {movimiento: id, ...plato}, 'create'));
            }
            // The same need as the purchases: portions × recipe quantity / portions the recipe yields.
            lineas = (await client.query<LineaStock>(`
                SELECT r.cod_ing, -CEIL(SUM(mp.porciones * r.cantidad::numeric / pl.porciones_receta))::int AS cantidad
                FROM ${T.movimiento_platos} mp
                JOIN ${T.platos} pl ON pl.cod_plato = mp.cod_plato
                JOIN ${T.recetas} r ON r.cod_plato = mp.cod_plato
                WHERE mp.movimiento = $1
                GROUP BY r.cod_ing`, [id])).rows;
        } else lineas = await lineasIngredientes(client, tipo, input['ingredientes']);
        const ingredientes = await aplicarStock(client, id, lineas, tipo === 'Ajuste');
        if (movimiento['pedido'] !== null) await client.query(`UPDATE ${T.pedidos} SET estado = 'Entregado' WHERE id = $1`, [movimiento['pedido']]);
        return {id, ingredientes};
    }, !simular);
}

/* Reverses a movement with a new Anulación instead of editing or deleting it. Annulling an order's Egreso
   returns that order to Confirmado, so its real delivery can be loaded again. */
export async function anularMovimiento(db: Db, id: string): Promise<MovimientoResponse> {
    return enTransaccion(db, async client => {
        const {rows: [original]} = await client.query<{tipo: TipoMovimiento; pedido: string | null}>(
            `SELECT tipo, pedido FROM ${T.movimientos} WHERE id = $1 FOR UPDATE`, [id]);
        if (!original) throw new ApiFailure(404, 'El movimiento no existe.');
        if (original.tipo === 'Anulación') throw new ApiFailure(409, 'Una anulación no se puede anular.');
        if ((await client.query(`SELECT 1 FROM ${T.movimientos} WHERE anula = $1`, [id])).rowCount) {
            throw new ApiFailure(409, 'Este movimiento ya está anulado.');
        }
        if (original.pedido !== null) await bloquearPedido(client, original.pedido, 'Entregado', 'El pedido de este egreso ya no está entregado.');
        const anulacion = await prepareEntityWrite(movimientos, {fecha: localDateTime(), tipo: 'Anulación', pedido: original.pedido,
            facturado: null, anula: id, observaciones: null}, 'create');
        await insertPreparedRow(client, movimientos, anulacion);
        const lineas = (await client.query<LineaStock>(
            `SELECT cod_ing, -cantidad AS cantidad FROM ${T.movimiento_ingredientes} WHERE movimiento = $1`, [id])).rows;
        const ingredientes = await aplicarStock(client, anulacion['id'] as string, lineas, false);
        if (original.pedido !== null) await client.query(`UPDATE ${T.pedidos} SET estado = 'Confirmado' WHERE id = $1`, [original.pedido]);
        return {id: anulacion['id'] as string, ingredientes};
    });
}

export async function opcionesInventario(db: Pick<Pool, 'query'>): Promise<OpcionesInventario> {
    return {
        pedidos: (await db.query<PedidoPendiente>(`SELECT id, cliente_nombre, fecha_evento, personas, estado FROM ${T.pedidos}
            WHERE estado = 'Confirmado' ORDER BY fecha_evento, id`)).rows,
        platos: (await db.query(`SELECT cod_plato, nombre FROM ${T.platos} ORDER BY nombre, cod_plato`)).rows,
        ingredientes: (await db.query(`SELECT i.cod_ing, i.nombre, i.unidad, i.stock_actual, i.unidad_compra,
                COALESCE((SELECT SUM(mi.cantidad) FROM ${T.movimiento_ingredientes} mi WHERE mi.cod_ing = i.cod_ing), 0)::int AS historial
            FROM ${T.ingredientes} i ORDER BY i.nombre, i.cod_ing`)).rows,
        unidades: await unidades(db),
    };
}

// The quoted dishes and total of an order, to start its Egreso from them.
export async function egresoSugerido(db: Pick<Pool, 'query'>, id: string): Promise<EgresoSugerido> {
    const {rows: [pedido]} = await db.query<{total: number}>(`SELECT total FROM ${T.pedidos} WHERE id = $1`, [id]);
    if (!pedido) throw new ApiFailure(404, 'El pedido no existe.');
    const {rows} = await db.query<EgresoSugerido['platos'][number]>(`
        SELECT pp.cod_plato, pl.nombre, pp.porciones FROM ${T.pedido_platos} pp JOIN ${T.platos} pl ON pl.cod_plato = pp.cod_plato
        WHERE pp.pedido = $1 ORDER BY pl.nombre, pp.cod_plato`, [id]);
    return {platos: rows, facturado: pedido.total};
}

// The latest movements, newest first, with their lines already named.
export async function historialMovimientos(db: Pick<Pool, 'query'>, limite = 50): Promise<MovimientoResumen[]> {
    return (await db.query<MovimientoResumen>(`
        SELECT m.id, m.fecha, m.tipo, m.pedido, m.facturado, m.anula, m.observaciones, pe.cliente_nombre,
               EXISTS (SELECT 1 FROM ${T.movimientos} a WHERE a.anula = m.id) AS anulado,
               COALESCE((SELECT json_agg(json_build_object('nombre', pl.nombre, 'porciones', mp.porciones) ORDER BY pl.nombre)
                   FROM ${T.movimiento_platos} mp JOIN ${T.platos} pl ON pl.cod_plato = mp.cod_plato WHERE mp.movimiento = m.id), '[]') AS platos,
               COALESCE((SELECT json_agg(json_build_object('nombre', i.nombre, 'unidad', i.unidad, 'cantidad', mi.cantidad) ORDER BY i.nombre)
                   FROM ${T.movimiento_ingredientes} mi JOIN ${T.ingredientes} i ON i.cod_ing = mi.cod_ing WHERE mi.movimiento = m.id), '[]') AS ingredientes
        FROM ${T.movimientos} m LEFT JOIN ${T.pedidos} pe ON pe.id = m.pedido
        ORDER BY m.fecha DESC, m.id
        LIMIT $1`, [limite])).rows;
}

// Example movements, such as the initial stock count, go through the same logic as the inventory view.
export async function cargarMovimientosEjemplo(db: Db, file: string): Promise<number> {
    const ejemplos = JSON.parse(await readFile(file, 'utf8')) as unknown[];
    for (const movimiento of ejemplos) await registrarMovimiento(db, movimiento);
    return ejemplos.length;
}

export async function estadisticas(db: Pick<Pool, 'query'>): Promise<EstadisticasResponse> {
    const porEstado = await db.query(`SELECT estado, count(*)::int AS pedidos FROM ${T.pedidos} GROUP BY estado ORDER BY estado`);
    const porMes = await db.query(`
        SELECT to_char(fecha_evento, 'YYYY-MM') AS mes, count(*)::int AS pedidos,
               SUM(COALESCE(egreso.facturado, total))::float8 AS facturacion, SUM(personas)::int AS personas
        FROM ${T.pedidos} pe
        -- A delivered order counts what its Egreso actually charged, when it was loaded.
        LEFT JOIN LATERAL (SELECT m.facturado FROM ${T.movimientos} m
            WHERE m.pedido = pe.id AND m.tipo = 'Egreso' AND pe.estado = 'Entregado'
              AND NOT EXISTS (SELECT 1 FROM ${T.movimientos} a WHERE a.anula = m.id)
            ORDER BY m.fecha DESC LIMIT 1) egreso ON true
        WHERE estado IN ('Confirmado', 'Entregado')
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

function readId(value: unknown, error = 'El pedido no existe.'): string {
    if (typeof value !== 'string' || !uuid.test(value)) throw new ApiFailure(404, error);
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
    admin.use(express.json({limit: '32kb'}));
    admin.get('/pedidos', async (_req, res) => {
        const {rows} = await pool.query<PedidoPendiente>(`SELECT id, cliente_nombre, fecha_evento, personas, estado FROM ${T.pedidos}
            WHERE estado IN ('Pendiente', 'Confirmado') ORDER BY fecha_evento, id`);
        res.json(rows);
    });
    admin.get('/pedidos/:id/compras', async (req, res) => { res.json(await comprasDePedido(pool, readId(req.params['id']))); });
    admin.get('/pedidos/:id/egreso', async (req, res) => { res.json(await egresoSugerido(pool, readId(req.params['id']))); });
    const publicarMovimiento = () => {
        for (const name of ['movimientos', 'movimiento_platos', 'movimiento_ingredientes', 'ingredientes', 'pedidos'] as const) publish(name);
    };
    admin.get('/inventario', async (_req, res) => { res.json(await opcionesInventario(pool)); });
    admin.get('/movimientos', async (_req, res) => { res.json(await historialMovimientos(pool)); });
    admin.post('/movimientos', async (req, res) => {
        const result = await registrarMovimiento(pool, req.body);
        publicarMovimiento();
        res.status(201).json(result);
    });
    admin.post('/movimientos/simular', async (req, res) => { res.json(await registrarMovimiento(pool, req.body, {simular: true})); });
    admin.post('/movimientos/:id/anular', async (req, res) => {
        const result = await anularMovimiento(pool, readId(req.params['id'], 'El movimiento no existe.'));
        publicarMovimiento();
        res.status(201).json(result);
    });
    admin.get('/compras', async (req, res) => {
        const query = readObject(req.query, ['desde', 'hasta']);
        res.json(await comprasDePeriodo(pool, readDate(query['desde']), readDate(query['hasta'])));
    });
    admin.get('/estadisticas', async (_req, res) => { res.json(await estadisticas(pool)); });
    admin.get('/exportar/tablas', (_req, res) => {
        res.json(exportables().map(name => ({name, contacto: !!datosDeContacto[name]})) satisfies ExportablesResponse);
    });
    admin.get('/exportar', async (req, res) => {
        const query = readObject(req.query, ['tablas'], ['consulta', 'contacto']);
        if (typeof query['tablas'] !== 'string' || (query['consulta'] !== undefined && typeof query['consulta'] !== 'string')) {
            throw new ApiFailure(400, 'Consulta inválida.');
        }
        let consulta: unknown;
        try { consulta = query['consulta'] === undefined ? undefined : JSON.parse(query['consulta']); }
        catch { throw new ApiFailure(400, 'Consulta inválida.'); }
        const archivo = await exportarTablas(pool, query['tablas'].split(','), {consulta, contacto: query['contacto'] === '1'});
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="catering-${localDateTime().slice(0, 10)}.xlsx"`);
        res.send(archivo);
    });
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
