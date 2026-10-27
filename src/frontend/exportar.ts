import type {EntityNamesResponse, EntityQuery} from '../backend/browser-contract.js';
import type {ExportablesResponse} from '../backend/catering-contract.js';
import {cateringDownload, cateringRequest} from './api.js';
import {element} from './dom.js';
import {porArea} from './menu.js';

const aviso = 'Pedidos incluye datos personales de los clientes (email, teléfono y dirección). Mandalos solo a quien los necesite.';

async function descargar(tablas: readonly string[], contacto: boolean, consulta?: EntityQuery): Promise<void> {
    const params = new URLSearchParams({tablas: tablas.join(','), ...contacto ? {contacto: '1'} : {},
        ...consulta ? {consulta: JSON.stringify(consulta)} : {}});
    const {blob, filename} = await cateringDownload(`/exportar?${params}`);
    const link = element('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

// The sheet on screen, with its search, column filters and sort, across every page. Contact data is left out.
export async function exportarPlanilla(name: string, {filter, where, sort, direction}: EntityQuery): Promise<void> {
    await descargar([name], false, {filter, where, ...sort ? {sort} : {}, direction} as EntityQuery);
}

// Several sheets into one workbook, chosen from the drawer's areas.
export async function exportarVarias(catalogo: EntityNamesResponse): Promise<void> {
    const exportables = await cateringRequest<ExportablesResponse>('/exportar/tablas');
    const dialog = element('dialog');
    dialog.className = 'review-dialog exportar-dialog';
    const form = element('form');
    form.method = 'dialog';
    const casillas: HTMLInputElement[] = [];
    const grupos = porArea(catalogo.filter(({name}) => exportables.some(tabla => tabla.name === name))).map(([area, entries]) => {
        const fieldset = element('fieldset');
        fieldset.append(element('legend', area), ...entries.map(({name, label}) => {
            const box = element('input');
            box.type = 'checkbox';
            box.value = name;
            casillas.push(box);
            const etiqueta = element('label');
            etiqueta.append(box, ` ${label}`);
            return etiqueta;
        }));
        return fieldset;
    });
    const contacto = element('input');
    contacto.type = 'checkbox';
    const contactoLabel = element('label');
    contactoLabel.append(contacto, ' Incluir datos de contacto de los clientes');
    const nota = element('p', aviso);
    nota.className = 'muted';
    const error = element('p');
    error.className = 'catering-status error';
    const cancelar = element('button', 'Cancelar');
    cancelar.type = 'button';
    cancelar.onclick = () => dialog.close();
    const aceptar = element('button', 'Descargar Excel');
    aceptar.type = 'submit';
    aceptar.className = 'primary';
    const acciones = element('div');
    acciones.className = 'actions';
    acciones.append(cancelar, aceptar);
    form.append(element('h2', 'Exportar a Excel'), element('p', 'Cada planilla elegida va en una hoja del mismo archivo.'),
        ...grupos, contactoLabel, nota, error, acciones);
    form.onsubmit = event => {
        event.preventDefault();
        const tablas = casillas.filter(box => box.checked).map(box => box.value);
        if (!tablas.length) { error.textContent = 'Elegí al menos una planilla.'; return; }
        aceptar.disabled = true;
        error.textContent = '';
        descargar(tablas, contacto.checked).then(() => dialog.close(), (reason: unknown) => {
            error.textContent = reason instanceof Error ? reason.message : 'No se pudo exportar.';
        }).finally(() => { aceptar.disabled = false; });
    };
    dialog.append(form);
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
}
