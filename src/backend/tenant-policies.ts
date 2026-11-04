import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {completeEntity} from 'system-definition';
import {quotePgIdentifier as quote} from '@system-definition/postgres-migrations';
import {entityTenancy, myContext, myEntities, tenantField} from './system.js';
import {databaseSettings} from './database.js';
import {entityTable} from './entity-write.js';

/* Row-level security rules, generated from the SSOT's entityTenancy (system.ts): each table only shows and
   accepts the rows of the connection's company (app.tenant, set by tenant.ts).
   The SSOT migrations create tables, columns and keys but have no way to declare these rules, so this script
   runs right after them, in the same `migrations` container (compose.yaml). Running it again changes nothing. */
// NULLIF: a connection without a company (app.tenant = '') matches no row at all.
const company = `NULLIF(current_setting('app.tenant', true), '')`;
const duringLogin = `current_setting('app.authentication', true) = 'on'`;

export function tenantPolicies(): string[] {
    return Object.values(myEntities).flatMap(definition => {
        const entity = completeEntity(myContext, definition);
        const tenancy = entityTenancy[definition.name];
        const rule = {
            'company': `${quote(tenantField)} = ${company}`,
            'company-or-login': `(${quote(tenantField)} = ${company} OR ${duringLogin})`,
            // The company table is keyed by the company itself.
            'own-company': `${quote(entity.pk[0]!)} = ${company}`,
        }[tenancy];
        if (tenancy !== 'own-company' && !Object.hasOwn(entity.fields, tenantField)) {
            throw new Error(`${entity.name} is filtered by company but has no ${tenantField} column.`);
        }
        const table = entityTable(entity.name);
        return [
            `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
            `DROP POLICY IF EXISTS por_empresa ON ${table}`,
            `CREATE POLICY por_empresa ON ${table} USING (${rule}) WITH CHECK (${rule})`,
        ];
    });
}

// Run as the tables' owner: `node dist/backend/tenant-policies.js`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const pool = new Pool({...databaseSettings.database, ...databaseSettings.owner});
    try {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const statement of tenantPolicies()) await client.query(statement);
            await client.query('COMMIT');
            console.log('Reglas de seguridad por empresa aplicadas.');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally { client.release(); }
    } catch (error) {
        console.error('No se aplicaron las reglas por empresa:', error instanceof Error ? error.message : error);
        process.exitCode = 1;
    } finally { await pool.end(); }
}
