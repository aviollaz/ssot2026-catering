import {Pool} from 'pg';
import {createPostgresScratch, decodeSqlSsot, generateCreate, projectSsotSchema, quotePgIdentifier as quote} from '@system-definition/postgres-migrations';
import {databaseConfig, databaseSettings} from '../../dist/backend/database.js';
import {ssot, sqlMapping} from '../../dist/backend/system.js';
import {tenantPolicies} from '../../dist/backend/tenant-policies.js';
import {asAuthentication, runAsTenant, tenantPool} from '../../dist/backend/tenant.js';
import {empresaInicial} from '../../dist/backend/bootstrap.js';

const value = result => { if (!result.ok) throw new Error(JSON.stringify(result.problems)); return result.value; };

// The tables of the current SSOT, with the row-level security rules per company, as migrations + tenant-policies.js leave them.
export async function createSchema(handle) {
    const {schema} = databaseSettings.database;
    const desired = value(projectSsotSchema(value(decodeSqlSsot(ssot, sqlMapping)), schema));
    for (const sql of value(generateCreate(desired)).statements) await handle.session.query(sql.text, sql.values);
    for (const sql of tenantPolicies()) await handle.session.query(sql, []);
    await handle.session.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(databaseSettings.appUser.user)}`, []);
    await handle.session.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${quote(databaseSettings.appUser.user)}`, []);
}

/* Runs `work`, and everything it awaits, as the initial company seeing every user: like a request of
   that company's logged-in user, so backend functions and direct SQL checks only see its rows. */
export const asInitialCompany = work => runAsTenant(empresaInicial.codigo, () => asAuthentication(work));

export function scratchConfig(handle) {
    const config = {...databaseConfig, database: handle.id};
    if (config.connectionString) {
        const url = new URL(config.connectionString);
        url.pathname = '/' + handle.id;
        config.connectionString = url.toString();
    }
    return config;
}

// PR #6's isolated-database approach, using the current SSOT and database settings, with the initial company created.
export async function withTestDatabase(run) {
    const {schema} = databaseSettings.database;
    const scratch = createPostgresScratch({...databaseSettings.database, ...databaseSettings.initialUser}, [schema]);
    const handle = value(await scratch.create('clean-target'));
    let raw;
    try {
        await createSchema(handle);
        await handle.session.query(`INSERT INTO ${quote(schema)}.empresas (codigo, nombre) VALUES ($1, $2)`, [empresaInicial.codigo, empresaInicial.nombre]);
        const config = scratchConfig(handle);
        raw = new Pool(config);
        return await asInitialCompany(() => run({pool: tenantPool(raw), raw, config, handle}));
    } finally {
        await raw?.end();
        value(await scratch.destroy(handle));
    }
}
