import { defineTypes, type CoreFieldDef, completeCoreField, defineRecord,
    withRecords, defineEntity, defineEntities, captureSystemSnapshot,
    sqlTypes, type SqlTypeMapping,
    type Problem, type HumanProvider,
    withValidators
} from 'system-definition'
import { humanBehaviours } from "system-definition/examples";
import {appTypeDefs, appTypeBehaviours, inputConstraints} from './value-types.js';
export {migrationAuthoring} from './migration-authoring.js';

const myHumanBehaviours: HumanProvider<typeof appTypeDefs> = {...humanBehaviours};

type MyFieldDef = CoreFieldDef<typeof appTypeDefs> & {
    isName?: boolean
    label?: string
    description?: string
    maxLength?: number
    readable?: boolean
    visible?: boolean
    writable?: boolean
    inputName?: string
    inputType?: keyof typeof appTypeDefs
    transform?: 'username' | 'password' | null
    onCreate?: 'uuid' | 'empty-array' | 'now' | null
    onUpdate?: 'uuid' | null
    onPasswordChange?: 'empty-array' | null
}

const myTypes = defineTypes({
    types: appTypeDefs,
    behaviours: appTypeBehaviours,
    human: myHumanBehaviours,
    completeField: (fieldDef: MyFieldDef, name: string) => ({
        ...completeCoreField(fieldDef, name),
        isName     : fieldDef.isName ?? false,
        label      : fieldDef.label ?? name.replace(/_/g,' '),
        description: fieldDef.description ?? '',
        maxLength  : fieldDef.maxLength ?? 100,
        readable   : fieldDef.readable ?? true,
        visible    : fieldDef.visible ?? true,
        writable   : fieldDef.writable ?? true,
        inputName  : fieldDef.inputName ?? name,
        inputType  : fieldDef.inputType ?? fieldDef.type,
        inputConstraints: inputConstraints[fieldDef.inputType ?? fieldDef.type],
        transform  : fieldDef.transform ?? null,
        onCreate   : fieldDef.onCreate ?? null,
        onUpdate   : fieldDef.onUpdate ?? null,
        onPasswordChange: fieldDef.onPasswordChange ?? null,
    }),
})

// Stock and recipes stay in the base unit (g, ml, u); unidad_compra is only how it is shown and bought.
const ingrediente = defineRecord(myTypes,{
    cod_ing       :{ type:'text', label: 'Código' },
    nombre        :{ type:'text', label: 'Ingrediente', isName: true, nullable: false },
    unidad        :{ type:'unidad', label: 'Unidad base', nullable: false },
    // Editable by hand, which leaves no movement: Inventario shows the difference with the movement history.
    stock_actual  :{ type:'cantidad', label: 'Stock actual', nullable: false },
    unidad_compra :{ type:'text', label: 'Unidad de compra' },
})

// A conversion: one of this unit is `factor` of its base unit (1 kg = 1000 g, 1 bolsa = 25000 g).
const unidad_medida = defineRecord(myTypes,{
    cod_unidad :{ type:'text', label: 'Código' },
    nombre     :{ type:'text', label: 'Unidad', isName: true, nullable: false },
    base       :{ type:'unidad', label: 'Unidad base', nullable: false },
    factor     :{ type:'posDecimal', label: 'Equivale a (en unidad base)', nullable: false },
})

const plato = defineRecord(myTypes,{
    cod_plato        :{ type:'text', label: 'Código' },
    nombre           :{ type:'text', label: 'Plato', isName: true, nullable: false },
    descripcion      :{ type:'text', label: 'Descripción' },
    categoria        :{ type:'categoria', label: 'Categoría', nullable: false },
    porciones_receta :{ type:'posInteger', label: 'Porciones por receta', nullable: false },
    precio_porcion   :{ type:'posInteger', label: 'Precio por porción', nullable: false },
    activo           :{ type:'boolean', label: 'Activo', nullable: false },
})

// The quantity is for the whole recipe (porciones_receta portions), in the ingredient's unit.
const receta = defineRecord(myTypes,{
    cod_plato :{ type:'text', label: 'Plato' },
    cod_ing   :{ type:'text', label: 'Ingrediente' },
    cantidad  :{ type:'posDecimal', label: 'Cantidad por receta', nullable: false },
})

const servicio = defineRecord(myTypes,{
    cod_servicio   :{ type:'text', label: 'Código' },
    nombre         :{ type:'text', label: 'Servicio', isName: true, nullable: false },
    descripcion    :{ type:'text', label: 'Descripción' },
    precio_persona :{ type:'posInteger', label: 'Precio por persona', nullable: false },
    min_personas   :{ type:'posInteger', label: 'Mínimo de personas', nullable: false },
    activo         :{ type:'boolean', label: 'Activo', nullable: false },
})

const servicio_plato = defineRecord(myTypes,{
    cod_servicio          :{ type:'text', label: 'Servicio' },
    cod_plato             :{ type:'text', label: 'Plato' },
    porciones_por_persona :{ type:'posInteger', label: 'Porciones por persona', nullable: false },
})

const pedido = defineRecord(myTypes,{
    id               :{ type:'text', label: 'Código de pedido', writable: false as const, onCreate: 'uuid' as const },
    cliente_nombre   :{ type:'text', label: 'Cliente', isName: true, nullable: false },
    cliente_email    :{ type:'text', label: 'Email', nullable: false },
    cliente_telefono :{ type:'text', label: 'Teléfono', nullable: false },
    direccion        :{ type:'text', label: 'Dirección', nullable: false },
    fecha_evento     :{ type:'fechaHora', label: 'Fecha del evento', nullable: false },
    personas         :{ type:'posInteger', label: 'Personas', nullable: false },
    estado           :{ type:'estadoPedido', label: 'Estado', nullable: false },
    cod_servicio     :{ type:'text', label: 'Servicio' },
    total            :{ type:'posInteger', label: 'Total', nullable: false },
    observaciones    :{ type:'text', label: 'Observaciones' },
    creado           :{ type:'fechaHora', label: 'Creado', writable: false as const, onCreate: 'now' as const, nullable: false },
})

// Dishes and prices are copied into the order, so later menu or price changes do not alter it.
const pedido_plato = defineRecord(myTypes,{
    pedido         :{ type:'text', label: 'Pedido' },
    cod_plato      :{ type:'text', label: 'Plato' },
    porciones      :{ type:'posInteger', label: 'Porciones', nullable: false },
    precio_porcion :{ type:'posInteger', label: 'Precio por porción', nullable: false },
})

// A stock movement. Its quantities per ingredient are the stock ledger; an Egreso also keeps the dishes made.
const movimiento = defineRecord(myTypes,{
    id            :{ type:'text', label: 'Código', writable: false as const, onCreate: 'uuid' as const },
    fecha         :{ type:'fechaHora', label: 'Fecha', isName: true, nullable: false },
    tipo          :{ type:'tipoMovimiento', label: 'Tipo', isName: true, nullable: false },
    pedido        :{ type:'text', label: 'Pedido' },
    // What was actually charged, which may differ from the order's quoted total.
    facturado     :{ type:'cantidad', label: 'Facturado' },
    anula         :{ type:'text', label: 'Anula a' },
    observaciones :{ type:'text', label: 'Observaciones' },
})

const movimiento_plato = defineRecord(myTypes,{
    movimiento :{ type:'text', label: 'Movimiento' },
    cod_plato  :{ type:'text', label: 'Plato' },
    porciones  :{ type:'posInteger', label: 'Porciones hechas', nullable: false },
})

// Signed change of stock, in the ingredient's base unit.
const movimiento_ingrediente = defineRecord(myTypes,{
    movimiento :{ type:'text', label: 'Movimiento' },
    cod_ing    :{ type:'text', label: 'Ingrediente' },
    cantidad   :{ type:'integer', label: 'Cantidad (unidad base)', nullable: false },
})

const usuario = defineRecord(myTypes, {
    id: {type: 'text', nullable: false, writable: false as const, visible: false as const, onCreate: 'uuid' as const},
    usuario: {type: 'text', label: 'Usuario', nullable: false, transform: 'username' as const},
    contrasena_hash: {type: 'text', nullable: false, label: 'Contraseña', readable: false as const,
        inputName: 'contrasena' as const, inputType: 'password' as const, transform: 'password' as const},
    recuperacion_hashes: {type: 'text', nullable: false, readable: false as const, writable: false as const,
        onCreate: 'empty-array' as const, onPasswordChange: 'empty-array' as const},
    version_sesion: {type: 'text', nullable: false, readable: false as const, writable: false as const,
        onCreate: 'uuid' as const, onUpdate: 'uuid' as const},
});

export const myRecords = withRecords(myTypes, {ingrediente, unidad_medida, plato, receta, servicio, servicio_plato, pedido, pedido_plato,
    movimiento, movimiento_plato, movimiento_ingrediente, usuario})

function validarPedido(pedido:{personas?:number | null, cliente_email?:string | null}){
    var problemas: Problem[] = []
    if (pedido.personas != null && pedido.personas < 1) problemas.push({
        field: 'personas',
        messageKey: 'el pedido debe ser para al menos 1 persona',
        severity: 'regular',
        details: {}
    } satisfies Problem)
    if (pedido.cliente_email != null && !/^[^@\s]+@[^@\s]+$/.test(pedido.cliente_email)) problemas.push({
        field: 'cliente_email',
        messageKey: 'el email del cliente no es válido',
        severity: 'regular',
        details: {}
    } satisfies Problem)
    return problemas;
}

// Only an Egreso (or its Anulación) belongs to an order, only an Egreso records what was charged,
// and only an Anulación points to the movement it reverses.
function validarMovimiento(movimiento:{tipo?:string | null, pedido?:string | null, facturado?:number | null, anula?:string | null}){
    var problemas: Problem[] = []
    const problema = (field: string, messageKey: string) => problemas.push({field, messageKey, severity: 'regular', details: {}} satisfies Problem)
    if (movimiento.tipo !== 'Egreso' && movimiento.tipo !== 'Anulación' && movimiento.pedido != null) problema('pedido', 'solo un egreso se asocia a un pedido')
    if (movimiento.tipo !== 'Egreso' && movimiento.facturado != null) problema('facturado', 'solo un egreso registra lo facturado')
    if ((movimiento.tipo === 'Anulación') !== (movimiento.anula != null)) problema('anula', 'una anulación indica el movimiento que anula, y solo ella')
    return problemas;
}

export const myContext = withValidators(myRecords, {validarPedido, validarMovimiento})

const ingredientes = defineEntity(myContext, {
    name: 'ingredientes',
    record: 'ingrediente',
    pk: ['cod_ing'],
    fks: {unidad_compra: {entity: 'unidades', fields: {unidad_compra: 'cod_unidad'}}}
})

const unidades = defineEntity(myContext, {
    name: 'unidades',
    record: 'unidad_medida',
    pk: ['cod_unidad']
})

const platos = defineEntity(myContext, {
    name: 'platos',
    record: 'plato',
    pk: ['cod_plato']
})

const recetas = defineEntity(myContext, {
    name: 'recetas',
    record: 'receta',
    pk: ['cod_plato', 'cod_ing'],
    fks: {plato: {entity: 'platos', fields: ['cod_plato']}, ingrediente: {entity: 'ingredientes', fields: ['cod_ing']}}
})

const servicios = defineEntity(myContext, {
    name: 'servicios',
    record: 'servicio',
    pk: ['cod_servicio']
})

const servicio_platos = defineEntity(myContext, {
    name: 'servicio_platos',
    record: 'servicio_plato',
    pk: ['cod_servicio', 'cod_plato'],
    fks: {servicio: {entity: 'servicios', fields: ['cod_servicio']}, plato: {entity: 'platos', fields: ['cod_plato']}}
})

const pedidos = defineEntity(myContext, {
    name: 'pedidos',
    record: 'pedido',
    pk: ['id'],
    fks: {servicio: {entity: 'servicios', fields: ['cod_servicio']}},
    validators: ['validarPedido']
})

const pedido_platos = defineEntity(myContext, {
    name: 'pedido_platos',
    record: 'pedido_plato',
    pk: ['pedido', 'cod_plato'],
    fks: {pedido: {entity: 'pedidos', fields: {pedido: 'id'}}, plato: {entity: 'platos', fields: ['cod_plato']}}
})

const movimientos = defineEntity(myContext, {
    name: 'movimientos',
    record: 'movimiento',
    pk: ['id'],
    fks: {pedido: {entity: 'pedidos', fields: {pedido: 'id'}}, anula: {entity: 'movimientos', fields: {anula: 'id'}}},
    validators: ['validarMovimiento']
})

const movimiento_platos = defineEntity(myContext, {
    name: 'movimiento_platos',
    record: 'movimiento_plato',
    pk: ['movimiento', 'cod_plato'],
    fks: {movimiento: {entity: 'movimientos', fields: {movimiento: 'id'}}, plato: {entity: 'platos', fields: ['cod_plato']}}
})

const movimiento_ingredientes = defineEntity(myContext, {
    name: 'movimiento_ingredientes',
    record: 'movimiento_ingrediente',
    pk: ['movimiento', 'cod_ing'],
    fks: {movimiento: {entity: 'movimientos', fields: {movimiento: 'id'}}, ingrediente: {entity: 'ingredientes', fields: ['cod_ing']}}
})

// Required by authentication, including the narrowly scoped anonymous login/recovery operations.
export const authenticationEntity = 'usuarios';
const usuarios = defineEntity(myContext, {
    name: authenticationEntity,
    record: 'usuario',
    pk: ['id'],
    uks: {usuario_unico: ['usuario']},
});

export const myEntities = defineEntities({pedidos, pedido_platos, platos, recetas, ingredientes, unidades, servicios, servicio_platos,
    movimientos, movimiento_platos, movimiento_ingredientes, usuarios})

// Presentation is app-owned metadata; browsers receive it through the API.
export const entityLabels = {
    pedidos: 'Pedidos', pedido_platos: 'Platos por pedido', platos: 'Platos', recetas: 'Recetas',
    ingredientes: 'Ingredientes', unidades: 'Unidades', servicios: 'Servicios', servicio_platos: 'Platos por servicio',
    movimientos: 'Movimientos de stock', movimiento_platos: 'Platos por movimiento', movimiento_ingredientes: 'Ingredientes por movimiento',
    usuarios: 'Usuarios',
} satisfies Record<keyof typeof myEntities, string>;

// Area of each sheet in the ☰ menu; "Area/Subarea" nests one inside another.
export const entityAreas = {
    pedidos: 'Ventas', servicios: 'Ventas', platos: 'Cocina', ingredientes: 'Cocina', unidades: 'Cocina',
    movimientos: 'Inventario', recetas: 'Avanzado', servicio_platos: 'Avanzado', pedido_platos: 'Avanzado',
    movimiento_platos: 'Avanzado', movimiento_ingredientes: 'Avanzado', usuarios: 'Avanzado',
} satisfies Record<keyof typeof myEntities, string>;

// Child tables shown and edited in a row's Detalle, such as a dish's recipe. Each one needs a foreign key to its parent.
export const entityDetails = {
    platos: ['recetas'], servicios: ['servicio_platos'], pedidos: ['pedido_platos'],
} satisfies Partial<Record<keyof typeof myEntities, readonly (keyof typeof myEntities)[]>>;

// Sheets that only the inventory endpoints write, so the stock history cannot be edited or deleted.
export const readOnlyEntities: readonly (keyof typeof myEntities)[] = ['movimientos', 'movimiento_platos', 'movimiento_ingredientes'];

const snapshot = captureSystemSnapshot(myContext, {
    systemId: 'ssot2026',
    entities: myEntities,
    records: myRecords.records,
});
if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.problems));
export const ssot = snapshot.value;

export const sqlMapping = {
    text: sqlTypes.text,
    integer: sqlTypes.integer,
    posInteger: sqlTypes.integer,
    cantidad: sqlTypes.integer,
    posDecimal: sqlTypes.numeric,
    unidad: sqlTypes.text,
    categoria: sqlTypes.text,
    estadoPedido: sqlTypes.text,
    tipoMovimiento: sqlTypes.text,
    fechaHora: sqlTypes.timestamp,
    boolean: sqlTypes.boolean,
    password: sqlTypes.text,
} satisfies SqlTypeMapping<typeof ssot>;
