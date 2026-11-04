import {completeEntity} from 'system-definition';
import {authenticationEntity, myContext, myEntities} from './system.js';
import {entityTable, insertPreparedRow, prepareEntityWrite} from './entity-write.js';
import {createRecoveryCodes} from './credentials.js';
import {asAuthentication, runAsTenant, type Db} from './tenant.js';
import type {EntityCreate, StoredRow} from './api-contract.js';

export type BootstrapResult = {created: false} | {created: true; usuario: string; codes: string[]};
type BootstrapCredentials = {username: string | undefined; password: string | undefined};
type Empresa = {codigo: string; nombre: string};

// The company of the first administrator, and of the example data.
export const empresaInicial: Empresa = {codigo: 'default', nombre: 'Mi empresa'};

/* Creates a company and its first administrator in one transaction. Used on the first startup and by
   `npm run tenant:create`. With `soloSiNoHayUsuarios`, does nothing when any company already has users. */
export async function crearEmpresa(db: Db, empresa: Empresa, credentials: BootstrapCredentials,
    {soloSiNoHayUsuarios = false} = {}): Promise<BootstrapResult> {
    const users = completeEntity(myContext, myEntities[authenticationEntity]);
    const empresas = completeEntity(myContext, myEntities.empresas);
    return runAsTenant(empresa.codigo, () => asAuthentication(async () => {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${entityTable(users.name)}:bootstrap`]);
            if (soloSiNoHayUsuarios && (await client.query(`SELECT 1 FROM ${entityTable(users.name)} LIMIT 1`)).rows.length) {
                await client.query('COMMIT');
                return {created: false};
            }
            if (!credentials.username || !credentials.password) {
                throw new Error(soloSiNoHayUsuarios ? 'Configurá AUTH_ADMIN_USERNAME y AUTH_ADMIN_PASSWORD para inicializar la tabla de usuarios vacía.'
                    : 'Indicá el usuario y la contraseña del administrador de la empresa.');
            }
            // The company may already exist (the tests create it); row-level security only shows this one.
            if (!(await client.query(`SELECT 1 FROM ${entityTable(empresas.name)}`)).rows.length) {
                await insertPreparedRow(client, empresas, await prepareEntityWrite(empresas, empresa, 'create'));
            }
            const input = {usuario: credentials.username, contrasena: credentials.password} satisfies EntityCreate<typeof authenticationEntity>;
            const row = await prepareEntityWrite(users, input, 'create');
            const recovery = createRecoveryCodes();
            Object.assign(row, {recuperacion_hashes: recovery.hashes} satisfies Partial<StoredRow<typeof authenticationEntity>>);
            await insertPreparedRow(client, users, row);
            await client.query('COMMIT');
            return {created: true, usuario: String(row[users.fields.usuario.name]), codes: recovery.codes};
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }));
}

export async function initializeUsers(db: Db, credentials: BootstrapCredentials = {
    username: process.env['AUTH_ADMIN_USERNAME'], password: process.env['AUTH_ADMIN_PASSWORD'],
}): Promise<BootstrapResult> {
    return crearEmpresa(db, empresaInicial, credentials, {soloSiNoHayUsuarios: true});
}

export function reportInitialization(result: BootstrapResult): void {
    if (result.created) console.log(`Usuario inicial creado: ${result.usuario}. Guardá estos códigos de recuperación; no se mostrarán de nuevo:\n${result.codes.join('\n')}`);
}
