import {boxType, commonTypeBehaviours, commonTypeDefs, notParsed, parsed, type TypeBehaviour, type TypeProvider} from 'system-definition';

const unidadValues = ['g', 'ml', 'u'] as const;
const categoriaValues = ['Entrada', 'Principal', 'Postre', 'Bebida', 'Finger food'] as const;
const estadoPedidoValues = ['Pendiente', 'Confirmado', 'Entregado', 'Cancelado'] as const;
// Anulación reverses an earlier movement, so the stock history is never rewritten.
const tipoMovimientoValues = ['Ingreso', 'Egreso', 'Merma', 'Ajuste', 'Anulación'] as const;

export const appTypeDefs = {
    ...commonTypeDefs,
    posInteger: {...commonTypeDefs.integer, minimum: 1},
    // Stock in the ingredient's base unit (g, ml, u).
    cantidad: {...commonTypeDefs.integer, minimum: 0},
    // Recipe quantities may be fractional (half an egg); stored as numeric.
    posDecimal: {tsType: boxType<number>(), minimum: 0},
    unidad: {tsType: boxType<typeof unidadValues[number]>(), values: unidadValues},
    categoria: {tsType: boxType<typeof categoriaValues[number]>(), values: categoriaValues},
    estadoPedido: {tsType: boxType<typeof estadoPedidoValues[number]>(), values: estadoPedidoValues},
    tipoMovimiento: {tsType: boxType<typeof tipoMovimientoValues[number]>(), values: tipoMovimientoValues},
    // Local date and time, as written by <input type="datetime-local">: YYYY-MM-DDTHH:MM, optionally :SS.
    fechaHora: {...commonTypeDefs.text},
    password: {...commonTypeDefs.text, minLength: 12, maxLength: 128},
};

const posIntegerBehaviour: TypeBehaviour<number> = {
    check: (value): value is number => commonTypeBehaviours.integer.check(value) && value >= appTypeDefs.posInteger.minimum,
    deserialize: text => {
        const result = commonTypeBehaviours.integer.deserialize(text);
        return result.ok && posIntegerBehaviour.check(result.value) ? result : notParsed('type.posInteger');
    },
    serialize: commonTypeBehaviours.integer.serialize,
};

const cantidadBehaviour: TypeBehaviour<number> = {
    check: (value): value is number => commonTypeBehaviours.integer.check(value) && value >= appTypeDefs.cantidad.minimum,
    deserialize: text => {
        const result = commonTypeBehaviours.integer.deserialize(text);
        return result.ok && cantidadBehaviour.check(result.value) ? result : notParsed('type.cantidad');
    },
    serialize: commonTypeBehaviours.integer.serialize,
};

// Greater than the minimum, so 0 is rejected; only plain decimals like 0.5, never '1e3' or ' 2 '.
const posDecimalBehaviour: TypeBehaviour<number> = {
    check: (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > appTypeDefs.posDecimal.minimum,
    deserialize: text => {
        if (!/^\d+(\.\d+)?$/.test(text)) return notParsed('type.posDecimal');
        const value = Number(text);
        return posDecimalBehaviour.check(value) ? parsed(value) : notParsed('type.posDecimal');
    },
    serialize: value => String(value),
};

// The server's local time in the fechaHora format, to the minute.
export function localDateTime(date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fechaHoraBehaviour: TypeBehaviour<string> = {
    check: (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) &&
        !Number.isNaN(Date.parse(value)),
    deserialize: text => fechaHoraBehaviour.check(text) ? parsed(text) : notParsed('type.fechaHora'),
    serialize: value => value,
};

function enumBehaviour<T extends readonly string[]>(values: T, name: string): TypeBehaviour<T[number]> {
    const check = (value: unknown): value is T[number] => typeof value === 'string' && values.includes(value);
    return {
        check,
        deserialize: text => check(text) ? parsed(text) : notParsed(`type.${name}`),
        serialize: value => value,
    };
}

export const passwordBehaviour: TypeBehaviour<string> = {
    check: (value): value is string => typeof value === 'string' &&
        value.length >= appTypeDefs.password.minLength && value.length <= appTypeDefs.password.maxLength,
    deserialize: text => passwordBehaviour.check(text) ? parsed(text) : notParsed('type.password'),
    serialize: value => value,
};

export const appTypeBehaviours = {
    ...commonTypeBehaviours,
    posInteger: posIntegerBehaviour,
    cantidad: cantidadBehaviour,
    posDecimal: posDecimalBehaviour,
    unidad: enumBehaviour(appTypeDefs.unidad.values, 'unidad'),
    categoria: enumBehaviour(appTypeDefs.categoria.values, 'categoria'),
    estadoPedido: enumBehaviour(appTypeDefs.estadoPedido.values, 'estadoPedido'),
    tipoMovimiento: enumBehaviour(appTypeDefs.tipoMovimiento.values, 'tipoMovimiento'),
    fechaHora: fechaHoraBehaviour,
    password: passwordBehaviour,
} satisfies TypeProvider<typeof appTypeDefs>;

export type InputConstraints = {
    minLength: number | null;
    maxLength: number | null;
    minimum?: number;
    options?: readonly string[];
};

export const inputConstraints = {
    text: {minLength: null, maxLength: null},
    integer: {minLength: null, maxLength: null},
    boolean: {minLength: null, maxLength: null},
    posInteger: {minLength: null, maxLength: null, minimum: appTypeDefs.posInteger.minimum},
    cantidad: {minLength: null, maxLength: null, minimum: appTypeDefs.cantidad.minimum},
    posDecimal: {minLength: null, maxLength: null, minimum: appTypeDefs.posDecimal.minimum},
    unidad: {minLength: null, maxLength: null, options: appTypeDefs.unidad.values},
    categoria: {minLength: null, maxLength: null, options: appTypeDefs.categoria.values},
    estadoPedido: {minLength: null, maxLength: null, options: appTypeDefs.estadoPedido.values},
    tipoMovimiento: {minLength: null, maxLength: null, options: appTypeDefs.tipoMovimiento.values},
    fechaHora: {minLength: null, maxLength: null},
    password: {minLength: appTypeDefs.password.minLength, maxLength: appTypeDefs.password.maxLength},
} satisfies Record<keyof typeof appTypeDefs, InputConstraints>;
