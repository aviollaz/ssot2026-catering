import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {databaseConfig} from './database.js';
import {loadTabData} from './tab-data.js';
import {cargarMovimientosEjemplo, cargarPedidosEjemplo} from './catering.js';

const pool = new Pool(databaseConfig);
try {
    const directory = process.argv[2] ?? fileURLToPath(new URL('../../examples/data/', import.meta.url));
    console.log(`Se cargaron ${await loadTabData(pool, directory)} filas.`);
    // Orders get a server-generated code, so they come from JSON through the public order logic.
    const pedidos = join(directory, 'pedidos.json');
    if (existsSync(pedidos)) console.log(`Se cargaron ${await cargarPedidosEjemplo(pool, pedidos)} pedidos de ejemplo.`);
    // Stock changes only through movements, so the initial stock is a count (Ajuste).
    const movimientos = join(directory, 'movimientos.json');
    if (existsSync(movimientos)) console.log(`Se cargaron ${await cargarMovimientosEjemplo(pool, movimientos)} movimientos de stock.`);
} catch (error) {
    console.error('No se cargaron los datos:', error instanceof Error ? error.message : 'Error desconocido.');
    process.exitCode = 1;
} finally { await pool.end(); }
