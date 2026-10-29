import {crc32, deflateRawSync} from 'node:zlib';

/* A minimal Excel (.xlsx) writer, without libraries: a workbook is a zip of a few XML files.
   Text goes inline in each cell (no shared strings), numbers stay numbers, and the header row is bold and frozen. */
export type Celda = string | number | null;
export type Hoja = {nombre: string; columnas: readonly string[]; filas: readonly (readonly Celda[])[]};

// XML 1.0 forbids most control characters, even escaped.
const xml = (text: string): string => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[char]!);

// 0 → A, 25 → Z, 26 → AA.
function columna(index: number): string {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
}

function celda(valor: Celda, ref: string, estilo: string): string {
    if (valor === null || valor === '') return '';
    if (typeof valor === 'number' && Number.isFinite(valor)) return `<c r="${ref}"${estilo}><v>${valor}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${estilo}><is><t xml:space="preserve">${xml(String(valor))}</t></is></c>`;
}

function hoja({columnas, filas}: Hoja): string {
    const rows = [columnas, ...filas].map((fila, r) =>
        `<row r="${r + 1}">${fila.map((valor, c) => celda(valor, columna(c) + (r + 1), r === 0 ? ' s="1"' : '')).join('')}</row>`);
    const anchos = columnas.map((titulo, c) => Math.min(60, Math.max(8, titulo.length, ...filas.map(fila => String(fila[c] ?? '').length)) + 2));
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        `<cols>${anchos.map((ancho, c) => `<col min="${c + 1}" max="${c + 1}" width="${ancho}" customWidth="1"/>`).join('')}</cols>` +
        `<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

// Sheet names: at most 31 characters, none of []:*?/\, and unique in the workbook.
function nombres(hojas: readonly Hoja[]): string[] {
    const usados = new Set<string>();
    return hojas.map(({nombre}) => {
        const base = nombre.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Hoja';
        let candidato = base;
        for (let n = 2; usados.has(candidato.toLowerCase()); n++) candidato = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
        usados.add(candidato.toLowerCase());
        return candidato;
    });
}

// A zip with deflated entries: local headers, then the central directory and its end record.
function zip(archivos: readonly {nombre: string; datos: Buffer}[]): Buffer {
    const locales: Buffer[] = [];
    const centrales: Buffer[] = [];
    let offset = 0;
    for (const {nombre, datos} of archivos) {
        const name = Buffer.from(nombre, 'utf8');
        const comprimido = deflateRawSync(datos);
        const crc = crc32(datos);
        // Version 2.0, UTF-8 names, deflate, date 1980-01-01.
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comprimido.length, 18);
        local.writeUInt32LE(datos.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        local.copy(central, 8, 6, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        locales.push(local, name, comprimido);
        centrales.push(central, name);
        offset += local.length + name.length + comprimido.length;
    }
    const directorio = Buffer.concat(centrales);
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0);
    fin.writeUInt16LE(archivos.length, 8);
    fin.writeUInt16LE(archivos.length, 10);
    fin.writeUInt32LE(directorio.length, 12);
    fin.writeUInt32LE(offset, 16);
    return Buffer.concat([...locales, directorio, fin]);
}

export function xlsx(hojas: readonly Hoja[]): Buffer {
    const titulos = nombres(hojas);
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const archivos: {nombre: string; contenido: string}[] = [
        {nombre: '[Content_Types].xml', contenido: header + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
            hojas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
            '</Types>'},
        {nombre: '_rels/.rels', contenido: header + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
        {nombre: 'xl/workbook.xml', contenido: header + `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets>` +
            titulos.map((titulo, i) => `<sheet name="${xml(titulo)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'},
        {nombre: 'xl/_rels/workbook.xml.rels', contenido: header + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            hojas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
            `<Relationship Id="rId${hojas.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`},
        // Style 0 is the default; style 1 is bold, for the header row. Excel requires the two default fills.
        {nombre: 'xl/styles.xml', contenido: header + `<styleSheet xmlns="${main}">` +
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
            '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'},
        ...hojas.map((h, i) => ({nombre: `xl/worksheets/sheet${i + 1}.xml`, contenido: hoja(h)})),
    ];
    return zip(archivos.map(({nombre, contenido}) => ({nombre, datos: Buffer.from(contenido, 'utf8')})));
}
