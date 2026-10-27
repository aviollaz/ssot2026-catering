import type {Unidad} from '../backend/catering-contract.js';
import {element} from './dom.js';

export const pesos = (value: number): string => `$ ${value.toLocaleString('es-AR')}`;
export const numero = (value: number): string => value.toLocaleString('es-AR', {maximumFractionDigits: 2});

/* Quantities are stored in the ingredient's base unit (g, ml, u). These are the units it can be shown or
   bought in: the base unit first, then every conversion of that base, preselecting the purchase unit. */
export function selectorUnidad(base: string, unidades: readonly Unidad[], preferida: string | null): {select: HTMLSelectElement; factor: () => number} {
    const opciones: Unidad[] = [{cod_unidad: base, nombre: base, base: base as Unidad['base'], factor: 1},
        ...unidades.filter(u => u.base === base && u.cod_unidad !== base)];
    const select = element('select');
    select.append(...opciones.map(u => new Option(u.nombre, u.cod_unidad)));
    if (opciones.some(u => u.cod_unidad === preferida)) select.value = preferida!;
    return {select, factor: () => opciones.find(u => u.cod_unidad === select.value)!.factor};
}
export const fechaHora = (value: string): string =>
    new Date(value).toLocaleString('es-AR', {dateStyle: 'medium', timeStyle: 'short'});

// A read-only HTML table; numbers use the local format, and nodes (such as a unit selector) are inserted as they are.
export function tabla(headers: readonly string[], rows: readonly (readonly (string | number | Node)[])[], vacio = 'Sin datos.'): HTMLElement {
    if (!rows.length) return element('p', vacio);
    const table = element('table');
    table.className = 'catering-table';
    const head = table.createTHead().insertRow();
    for (const header of headers) {
        const th = element('th', header);
        th.scope = 'col';
        head.append(th);
    }
    const body = table.createTBody();
    for (const row of rows) {
        const tr = body.insertRow();
        for (const value of row) {
            const td = tr.insertCell();
            if (value instanceof Node) td.append(value);
            else td.textContent = typeof value === 'number' ? value.toLocaleString('es-AR') : value;
        }
    }
    const scroll = element('div');
    scroll.className = 'catering-table-scroll';
    scroll.append(table);
    return scroll;
}

export function seccion(titulo: string, ...children: Node[]): HTMLElement {
    const section = element('section');
    section.className = 'catering-card';
    section.append(element('h3', titulo), ...children);
    return section;
}

// A view outside the generic spreadsheet. It can open another view, and returns how it reacts to live entity changes.
export type CateringView = {name: string; label: string; area: string;
    show: (content: HTMLElement, abrir: (name: string) => void) => Promise<(changed: string | null) => void>};
