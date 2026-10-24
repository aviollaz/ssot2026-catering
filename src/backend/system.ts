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

const ingrediente = defineRecord(myTypes,{
    cod_ing      :{ type:'text', label: 'Código' },
    nombre       :{ type:'text', label: 'Ingrediente', isName: true, nullable: false },
    unidad       :{ type:'unidad', label: 'Unidad', nullable: false },
    stock_actual :{ type:'cantidad', label: 'Stock actual', nullable: false },
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
    cantidad  :{ type:'posInteger', label: 'Cantidad por receta', nullable: false },
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

export const myRecords = withRecords(myTypes, {ingrediente, plato, receta, servicio, servicio_plato, pedido, pedido_plato, usuario})

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

export const myContext = withValidators(myRecords, {validarPedido})

const ingredientes = defineEntity(myContext, {
    name: 'ingredientes',
    record: 'ingrediente',
    pk: ['cod_ing']
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

// Required by authentication, including the narrowly scoped anonymous login/recovery operations.
export const authenticationEntity = 'usuarios';
const usuarios = defineEntity(myContext, {
    name: authenticationEntity,
    record: 'usuario',
    pk: ['id'],
    uks: {usuario_unico: ['usuario']},
});

export const myEntities = defineEntities({pedidos, pedido_platos, platos, recetas, ingredientes, servicios, servicio_platos, usuarios})

// Presentation is app-owned metadata; browsers receive it through the API.
export const entityLabels = {
    pedidos: 'Pedidos', pedido_platos: 'Platos por pedido', platos: 'Platos', recetas: 'Recetas',
    ingredientes: 'Ingredientes', servicios: 'Servicios', servicio_platos: 'Platos por servicio', usuarios: 'Usuarios',
} satisfies Record<keyof typeof myEntities, string>;

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
    unidad: sqlTypes.text,
    categoria: sqlTypes.text,
    estadoPedido: sqlTypes.text,
    fechaHora: sqlTypes.timestamp,
    boolean: sqlTypes.boolean,
    password: sqlTypes.text,
} satisfies SqlTypeMapping<typeof ssot>;
