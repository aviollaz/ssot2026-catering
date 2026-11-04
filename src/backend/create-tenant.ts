import {Pool} from 'pg';
import {databaseConfig} from './database.js';
import {crearEmpresa, reportInitialization} from './bootstrap.js';
import {tenantPool} from './tenant.js';

// npm run tenant:create -- <código> <nombre> <usuario> <contraseña>
// The code identifies the company, also in its public order page: /pedido?empresa=<código>.
const [codigo, nombre, usuario, contrasena] = process.argv.slice(2);
const pool = new Pool(databaseConfig);
try {
    if (!codigo || !nombre || !/^[a-z0-9-]{2,40}$/.test(codigo)) {
        throw new Error('Uso: npm run tenant:create -- <código> <nombre> <usuario> <contraseña>. El código va en minúsculas, números o guiones.');
    }
    reportInitialization(await crearEmpresa(tenantPool(pool), {codigo, nombre}, {username: usuario, password: contrasena}));
    console.log(`Empresa ${nombre} creada. Su página de pedidos es /pedido?empresa=${codigo}`);
} catch (error) {
    console.error('No se creó la empresa:', error instanceof Error ? error.message : 'Error desconocido.');
    process.exitCode = 1;
} finally {
    await pool.end();
}
