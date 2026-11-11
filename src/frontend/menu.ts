/* Order of the ☰ areas. Each sheet's area comes from the SSOT (entityAreas); areas missing here go last,
   so a new area never hides a sheet. */
export const areas: readonly {titulo: string; cerrada?: boolean}[] = [
    {titulo: 'Ventas'}, {titulo: 'Cocina'}, {titulo: 'Inventario'},
    // Link tables, also listed in their parent's "Ver datos actuales"; kept to see them all at once.
    {titulo: 'Avanzado', cerrada: true},
];

const posicion = (area: string): number => {
    const index = areas.findIndex(({titulo}) => titulo === area.split('/')[0]);
    return index < 0 ? areas.length : index;
};

// Entries grouped by area, in menu order; within an area they keep the catalog's order.
export function porArea<T extends {area: string}>(entries: readonly T[]): [string, T[]][] {
    const grupos = new Map<string, T[]>();
    for (const entry of entries) grupos.set(entry.area, [...grupos.get(entry.area) ?? [], entry]);
    return [...grupos].sort(([a], [b]) => posicion(a) - posicion(b));
}

export const cerrada = (area: string): boolean => areas.some(({titulo, cerrada}) => titulo === area && cerrada === true);
