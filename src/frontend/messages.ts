import type {Problem} from 'system-definition';
import type {EntityInputColumn} from '../backend/browser-contract.js';

const typeNames: Readonly<Record<string, string>> = {
    text: 'texto',
    integer: 'un número entero',
    posInteger: 'un número entero mayor que 0',
    cantidad: 'un número entero mayor o igual que 0',
    posDecimal: 'un número mayor que 0',
    unidad: 'una opción de la lista',
    categoria: 'una opción de la lista',
    estadoPedido: 'una opción de la lista',
    tipoMovimiento: 'una opción de la lista',
    fechaHora: 'una fecha y hora válida',
    boolean: 'verdadero o falso',
    password: 'una contraseña válida',
};

const messages: Readonly<Record<string, (details: Problem['details']) => string>> = {
    'field.required': () => 'Este campo es obligatorio.',
    'field.notOfItsType': ({type}) => `Debe ser ${typeNames[type ?? ''] ?? 'un valor válido'}.`,
    'record.notAnObject': () => 'Los datos enviados no son válidos.',
};

export function messageOf(problem: Problem, constraints?: EntityInputColumn['constraints']): string {
    if (problem.messageKey === 'field.notOfItsType' && constraints?.options?.length) {
        return `Elegí una de estas opciones: ${constraints.options.join(', ')}.`;
    }
    return messages[problem.messageKey]?.(problem.details) ??
        (/^[\w.]+$/.test(problem.messageKey) ? 'El valor no es válido.' : problem.messageKey);
}
