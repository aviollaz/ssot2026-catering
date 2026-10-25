import {element} from './dom.js';

export const pesos = (value: number): string => `$ ${value.toLocaleString('es-AR')}`;
export const fechaHora = (value: string): string =>
    new Date(value).toLocaleString('es-AR', {dateStyle: 'medium', timeStyle: 'short'});

// A read-only HTML table; numbers use the local format.
export function tabla(headers: readonly string[], rows: readonly (readonly (string | number)[])[], vacio = 'Sin datos.'): HTMLElement {
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
            td.textContent = typeof value === 'number' ? value.toLocaleString('es-AR') : value;
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

// A view outside the generic spreadsheet. It returns how it reacts to live entity changes.
export type CateringView = {name: string; label: string; show: (content: HTMLElement) => Promise<(changed: string | null) => void>};
