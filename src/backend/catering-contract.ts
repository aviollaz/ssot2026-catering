// Protocol of the catering endpoints, shared by the backend and both frontends.
import type {StoredRow} from './api-contract.js';

type Plato = StoredRow<'platos'>;
type Servicio = StoredRow<'servicios'>;
type Pedido = StoredRow<'pedidos'>;
type Ingrediente = StoredRow<'ingredientes'>;
export type Unidad = StoredRow<'unidades'>;

// Public, without login: only fields a customer may see.
export type CatalogoPlato = Pick<Plato, 'cod_plato' | 'nombre' | 'descripcion' | 'categoria' | 'precio_porcion'>;
export type CatalogoServicio = Pick<Servicio, 'cod_servicio' | 'nombre' | 'descripcion' | 'precio_persona' | 'min_personas'> & {
    platos: {cod_plato: string; nombre: string; porciones_por_persona: number}[];
};
export type CatalogoResponse = {platos: CatalogoPlato[]; servicios: CatalogoServicio[]; anticipacionDias: number};

export type PedidoCliente = Pick<Pedido, 'cliente_nombre' | 'cliente_email' | 'cliente_telefono' | 'direccion' |
    'fecha_evento' | 'personas' | 'observaciones'>;
// Either a service or an à la carte list of dishes.
export type NuevoPedido = PedidoCliente & ({cod_servicio: string} | {platos: {cod_plato: string; porciones: number}[]});
export type NuevoPedidoResponse = {id: string; total: number};
export type EstadoPedidoResponse = Pick<Pedido, 'estado' | 'fecha_evento' | 'personas' | 'total'>;

// Admin.
export type PedidoPendiente = Pick<Pedido, 'id' | 'cliente_nombre' | 'fecha_evento' | 'personas' | 'estado'>;
export type CompraIngrediente = Pick<Ingrediente, 'cod_ing' | 'nombre' | 'unidad' | 'unidad_compra'> & {
    // necesidad: what this order (or period) uses; consumo_previo: what earlier confirmed orders use first;
    // faltante: what is missing for this order and the earlier ones together; comprar: this order's share of it.
    stock: number; necesidad: number; consumo_previo: number; faltante: number; comprar: number;
};
// Quantities are in each ingredient's base unit; `unidades` lets the browser show them in any other.
export type ComprasResponse = {ingredientes: CompraIngrediente[]; unidades: Unidad[]};

// Inventory. Quantities in requests may use any unit of the ingredient's base; responses are in the base unit.
export type TipoMovimiento = StoredRow<'movimientos'>['tipo'];
export type NuevoMovimiento = {
    tipo: Exclude<TipoMovimiento, 'Anulación'>; fecha?: string; observaciones?: string | null;
    // Egreso only: the dishes actually made, and optionally the confirmed order they belong to and what was charged.
    pedido?: string | null; facturado?: number | null; platos?: {cod_plato: string; porciones: number}[];
    // Ingreso and Merma: the quantity that came in or was lost; Ajuste: the counted stock.
    ingredientes?: {cod_ing: string; cantidad: number; cod_unidad?: string}[];
};
// The stock changes actually applied (the stock never goes below 0).
export type MovimientoResponse = {id: string; ingredientes: {cod_ing: string; cantidad: number}[]};
export type OpcionesInventario = {
    pedidos: PedidoPendiente[];
    platos: Pick<Plato, 'cod_plato' | 'nombre'>[];
    // historial: the sum of the ingredient's movements. The stock can be edited by hand without a movement, so they may differ.
    ingredientes: (Pick<Ingrediente, 'cod_ing' | 'nombre' | 'unidad' | 'stock_actual' | 'unidad_compra'> & {historial: number})[];
    unidades: Unidad[];
};
// Tables that can go to Excel; `contacto` marks those holding customers' contact data.
export type ExportablesResponse = {name: string; contacto: boolean}[];
export type EgresoSugerido = {platos: {cod_plato: string; nombre: string; porciones: number}[]; facturado: number};
export type MovimientoResumen = Pick<StoredRow<'movimientos'>, 'id' | 'fecha' | 'tipo' | 'pedido' | 'facturado' | 'anula' | 'observaciones'> & {
    cliente_nombre: string | null; anulado: boolean;
    platos: {nombre: string; porciones: number}[];
    ingredientes: {nombre: string; unidad: Ingrediente['unidad']; cantidad: number}[];
};
export type EstadisticasResponse = {
    porEstado: {estado: Pedido['estado']; pedidos: number}[];
    porMes: {mes: string; pedidos: number; facturacion: number; personas: number}[];
    platosMasPedidos: {cod_plato: string; nombre: string; porciones: number; pedidos: number}[];
};
