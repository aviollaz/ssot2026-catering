import type {EntityName, EntityQuery, EntityResponse} from '../backend/browser-contract.js';
import type {Row} from './row-editor.js';
import {loadEntity} from './api.js';
import {element} from './dom.js';
import {entityPage} from './entity-query.js';
import {referenceOptions} from './foreign-keys.js';
import {pesos, tabla} from './catering-ui.js';

// Every row of an entity that matches `where`, across pages, through the generic API.
async function rowsWhere(name: EntityName, where: Row): Promise<{entity: EntityResponse; rows: Row[]}> {
    const rows: Row[] = [];
    for (let page = 1; ; page++) {
        const query = {where, page} as EntityQuery;
        const entity = await loadEntity(name, query);
        const result = entityPage(entity, query);
        rows.push(...result.rows);
        if (rows.length >= result.matched || !result.rows.length) return {entity, rows};
    }
}

/* Every dish of one order, for its details dialog, instead of searching its rows in "Platos por pedido".
   Columns, labels and the dish names come from the SSOT metadata, as in the sheet. */
export async function pedidoPlatos(pedido: Row): Promise<HTMLElement> {
    const {entity, rows} = await rowsWhere('pedido_platos', {pedido: pedido['id']!});
    const toPedido = entity.foreignKeys.find(fk => fk.entity === 'pedidos')!;
    const toPlato = entity.foreignKeys.find(fk => fk.entity === 'platos')!;
    const platos = await rowsWhere(toPlato.entity, {});
    const nombres = new Map(referenceOptions(toPlato, platos.rows).map(option => [JSON.stringify(option.values), option.label]));
    const plato = (row: Row) => JSON.stringify(Object.fromEntries(Object.keys(toPlato.fields).map(field => [field, row[field]])));
    // The order's own key is implied; the dish key is replaced by its label.
    const columns = entity.columns.filter(column => !(column.name in toPedido.fields) && !(column.name in toPlato.fields));

    const section = element('section');
    section.append(element('h3', 'Platos del pedido'),
        tabla([entity.columns.find(column => column.name in toPlato.fields)!.label, ...columns.map(column => column.label)],
            rows.map(row => [nombres.get(plato(row)) ?? plato(row), ...columns.map(column => row[column.name] as string | number)]),
            'Este pedido no tiene platos.'),
        // A service is charged per person, so its total is not the sum of the dishes.
        element('p', `Total del pedido: ${pesos(Number(pedido['total']))}` +
            (pedido['cod_servicio'] == null ? '' : ' (servicio: precio por persona × cantidad de personas)')));
    return section;
}
