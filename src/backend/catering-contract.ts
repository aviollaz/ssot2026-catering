// Protocol of the catering endpoints, shared by the backend and both frontends.
import type {StoredRow} from './api-contract.js';

type Plato = StoredRow<'platos'>;
type Servicio = StoredRow<'servicios'>;
type Pedido = StoredRow<'pedidos'>;
type Ingrediente = StoredRow<'ingredientes'>;

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
export type CompraIngrediente = Pick<Ingrediente, 'cod_ing' | 'nombre' | 'unidad'> & {
    // necesidad: what this order (or period) uses; consumo_previo: what earlier confirmed orders use first;
    // faltante: what is missing for this order and the earlier ones together; comprar: this order's share of it.
    stock: number; necesidad: number; consumo_previo: number; faltante: number; comprar: number;
};
export type ComprasResponse = {ingredientes: CompraIngrediente[]};
export type EntregaResponse = {consumo: {cod_ing: string; cantidad: number}[]};
export type EstadisticasResponse = {
    porEstado: {estado: Pedido['estado']; pedidos: number}[];
    porMes: {mes: string; pedidos: number; facturacion: number; personas: number}[];
    platosMasPedidos: {cod_plato: string; nombre: string; porciones: number; pedidos: number}[];
};
