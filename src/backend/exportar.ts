import type {Pool} from 'pg';
import {completeEntity, type EntityInfo} from 'system-definition';
import {quotePgIdentifier as quote} from '@system-definition/postgres-migrations';
import {entityLabels, myContext, myEntities} from './system.js';
import type {EntityName} from './api-contract.js';
import {ApiFailure} from './api-errors.js';
import {allowedFields} from './column-security.js';
import {entityTable} from './entity-write.js';
import {querySql, readQuery} from './entity-query.js';
import {xlsx, type Celda, type Hoja} from './xlsx.js';

// Accounts never leave the system; customers' contact data is left out unless asked for.
const noExportables: readonly EntityName[] = ['usuarios'];
export const datosDeContacto: Partial<Record<EntityName, readonly string[]>> = {pedidos: ['cliente_email', 'cliente_telefono', 'direccion']};
const maxFilas = 50000;

const entidades = new Map<string, EntityInfo<typeof myContext>>(Object.values(myEntities)
    .map(definition => [definition.name, completeEntity(myContext, definition)]));

export function exportables(): EntityName[] {
    return (Object.keys(myEntities) as EntityName[]).filter(name => !noExportables.includes(name));
}

// For people reading a spreadsheet: references show the referenced name, booleans and dates read as words.
async function hoja(db: Pick<Pool, 'query'>, name: EntityName, consulta: unknown, contacto: boolean): Promise<Hoja> {
    const entity = entidades.get(name)!;
    const readable = allowedFields(entity, 'read');
    const query = readQuery(consulta ?? {}, readable);
    const values: unknown[] = [];
    const {predicates, order} = querySql(readable, entity.pk, query, value => { values.push(value); return `$${values.length}`; });
    const columnas = Object.values(readable).filter(field => field.visible && (contacto || !datosDeContacto[name]?.includes(field.name)));
    const {rows} = await db.query<Record<string, unknown>>(`SELECT ${columnas.map(field => quote(field.name)).join(', ')} FROM ${entityTable(name)} ` +
        `WHERE ${predicates.join(' AND ') || 'TRUE'} ORDER BY ${order} LIMIT ${maxFilas + 1}`, values);
    if (rows.length > maxFilas) throw new ApiFailure(400, `${entityLabels[name]} tiene más de ${maxFilas} filas: filtrala antes de exportar.`);

    const nombres = new Map<string, Map<string, string>>();
    for (const fk of Object.values(entity.fks)) {
        const target = entidades.get(fk.entity)!;
        const pairs = Object.entries(fk.fields);
        const descriptivos = Object.values(allowedFields(target, 'read')).filter(field => field.isName).map(field => field.name);
        if (pairs.length !== 1 || !descriptivos.length || !columnas.some(field => field.name === pairs[0]![0])) continue;
        const [source, destination] = pairs[0]!;
        const {rows: opciones} = await db.query<{clave: string; nombre: string}>(`SELECT ${quote(destination)}::text AS clave, ` +
            `concat_ws(' — ', ${descriptivos.map(field => `${quote(field)}::text`).join(', ')}) AS nombre FROM ${entityTable(fk.entity)}`);
        nombres.set(source, new Map(opciones.map(option => [option.clave, option.nombre])));
    }
    const celda = (field: (typeof columnas)[number], value: unknown): Celda => {
        if (value === null || value === undefined) return null;
        const nombre = nombres.get(field.name)?.get(String(value));
        if (nombre !== undefined) return nombre;
        if (typeof value === 'boolean') return value ? 'Sí' : 'No';
        if (field.type === 'fechaHora') return String(value).slice(0, 16).replace('T', ' ');
        return typeof value === 'number' ? value : String(value);
    };
    return {nombre: entityLabels[name], columnas: columnas.map(field => field.label),
        filas: rows.map(row => columnas.map(field => celda(field, row[field.name])))};
}

/* One sheet per table, in the order given. A single table may carry the sheet's own query (filter, column
   filters and sort), so what is exported is what is on screen, across every page. */
export async function exportarTablas(db: Pick<Pool, 'query'>, tablas: readonly string[], {consulta, contacto = false}: {consulta?: unknown; contacto?: boolean} = {}): Promise<Buffer> {
    if (!tablas.length || new Set(tablas).size !== tablas.length || tablas.some(name => !exportables().includes(name as EntityName))) {
        throw new ApiFailure(400, 'Elegí planillas exportables, cada una una sola vez.');
    }
    if (consulta !== undefined && tablas.length !== 1) throw new ApiFailure(400, 'Los filtros se aplican al exportar una sola planilla.');
    const hojas: Hoja[] = [];
    for (const name of tablas) hojas.push(await hoja(db, name as EntityName, consulta, contacto));
    return xlsx(hojas);
}
