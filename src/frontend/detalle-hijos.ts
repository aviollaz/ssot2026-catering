import type {EntityCreate, EntityKey, EntityName, EntityQuery, EntityResponse, EntityUpdate} from '../backend/browser-contract.js';
import {ApiRequestError, createRow, deleteRows, loadEntity, updateRow} from './api.js';
import {actionButton} from './action-button.js';
import {confirmAction} from './confirm.js';
import {element} from './dom.js';
import {entityPage} from './entity-query.js';
import {loadReferenceSources} from './reference-sources.js';
import {createRowEditor, type Row, type RowEditor} from './row-editor.js';

// Every row (and its version) of an entity that matches `where`, across pages, through the generic API.
async function rowsWhere(name: EntityName, where: Row): Promise<{entity: EntityResponse; rows: {row: Row; version: string}[]}> {
    const rows: {row: Row; version: string}[] = [];
    for (let page = 1; ; page++) {
        const query = {where, page} as EntityQuery;
        const entity = await loadEntity(name, query);
        const result = entityPage(entity, query);
        rows.push(...result.rows.map(row => ({row, version: entity.versions[entity.rows.indexOf(row)]!})));
        if (rows.length >= result.matched || !result.rows.length) return {entity, rows};
    }
}

/* One child table of a row (such as a dish's recipe) as a small sheet: its rows save on change, like the
   main sheet. The link to the parent comes from the child's foreign key; a read-only child is only listed. */
async function detalleHijos(padre: EntityResponse, fila: Row, hija: EntityName): Promise<HTMLElement> {
    const section = element('section');
    section.className = 'detalle-hijos';
    const titulo = element('h3');
    const contenido = element('div');
    const status = element('p');
    status.className = 'catering-status';
    status.setAttribute('role', 'status');
    section.append(titulo, contenido, status);
    const informar = (texto: string, error = false) => {
        status.className = error ? 'catering-status error' : 'catering-status';
        status.textContent = texto;
    };
    const toPadre = (await loadEntity(hija, {page: 1} as EntityQuery)).foreignKeys.find(fk => fk.entity === padre.name)!;
    // The parent's key, in the child's own column names.
    const clave = Object.fromEntries(Object.entries(toPadre.fields).map(([source, target]) => [source, fila[target]!])) as Row;

    async function render(): Promise<void> {
        const {entity, rows} = await rowsWhere(hija, clave);
        titulo.textContent = entity.label;
        const sources = await loadReferenceSources(entity.foreignKeys.filter(fk => fk.entity !== padre.name));
        const key = (row: Row) => Object.fromEntries(entity.pk.map(name => [name, row[name]])) as EntityKey;
        const visibles = (editor: RowEditor) => editor.cells.filter(cell => !(cell.name in toPadre.fields));

        const table = element('table');
        table.className = 'catering-table detalle-table';
        const header = table.createTHead().insertRow();
        for (const cell of visibles(createRowEditor(entity, sources, undefined, false))) header.append(element('th', cell.label));
        if (!entity.readOnly) header.append(element('th'));
        const body = table.createTBody();
        const agregarFila = (editor: RowEditor): HTMLTableRowElement => {
            const tr = body.insertRow();
            for (const cell of visibles(editor)) tr.insertCell().append(cell.field);
            return tr;
        };
        const guardar = async (editor: RowEditor, previa?: {row: Row; version: string}) => {
            editor.problems([]);
            if (!editor.valid()) return;
            const row = {...editor.read(), ...clave};
            try {
                if (previa) await updateRow(entity.name, {key: key(previa.row), row, version: previa.version} as EntityUpdate);
                else await createRow(entity.name, row as EntityCreate);
                await render();
                informar('Guardado');
            } catch (error) {
                if (error instanceof ApiRequestError) editor.problems(error.problems);
                informar(error instanceof Error ? error.message : 'No se pudo guardar.', true);
            }
        };

        for (const previa of rows) {
            const editor = createRowEditor(entity, sources, previa.row, !entity.readOnly);
            const tr = agregarFila(editor);
            if (entity.readOnly) {
                for (const field of tr.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) field.disabled = true;
                continue;
            }
            for (const cell of visibles(editor)) cell.field.addEventListener('change', () => void guardar(editor, previa));
            tr.insertCell().append(actionButton('Quitar', 'delete', () => void (async () => {
                if (!await confirmAction({title: `Quitar de ${entity.label}`, message: '¿Quitar esta fila? Esta acción no se puede deshacer.',
                    confirmText: 'Quitar', danger: true})) return;
                try {
                    await deleteRows(entity.name, [key(previa.row)]);
                    await render();
                    informar('Fila quitada.');
                } catch (error) { informar(error instanceof Error ? error.message : 'No se pudo quitar.', true); }
            })(), 'danger'));
        }

        const agregar = actionButton('Agregar fila', 'add', () => {
            const editor = createRowEditor(entity, sources, clave);
            const tr = agregarFila(editor);
            tr.className = 'new-row';
            tr.insertCell().append(actionButton('Guardar', 'save', () => void guardar(editor), 'primary'));
            agregar.hidden = true;
        }, 'primary');
        contenido.replaceChildren(table, ...rows.length ? [] : [element('p', 'Todavía no hay filas.')], ...entity.readOnly ? [] : [agregar]);
    }
    await render();
    return section;
}

// Details of one row: its fields, read-only, and its child tables (entityDetails in the SSOT).
export async function abrirDetalle(entity: EntityResponse, fila: Row): Promise<void> {
    const dialog = element('dialog');
    dialog.className = 'review-dialog detalle-dialog';
    // The first text that is not the key, such as a dish's name or an order's customer.
    const nombre = entity.columns.filter(column => !entity.pk.includes(column.name)).map(column => fila[column.name])
        .find(value => typeof value === 'string' && value !== '');
    const close = element('button', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Cerrar');
    close.onclick = () => dialog.close();
    const header = element('div');
    header.className = 'dialog-header';
    header.append(element('h2', `${entity.label}: ${String(nombre ?? '')}`), close);
    dialog.append(header);
    const campos = element('table');
    const body = campos.createTBody();
    for (const column of entity.columns) {
        const tr = body.insertRow();
        tr.append(element('th', column.label));
        const value = fila[column.name];
        tr.insertCell().textContent = value == null ? '—' : String(value);
    }
    dialog.onclose = () => dialog.remove();
    dialog.append(campos, ...await Promise.all(entity.children.map(hija => detalleHijos(entity, fila, hija))));
    document.body.append(dialog);
    dialog.showModal();
}
