import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool, PoolClient} from 'pg';
import {tenantField} from './system.js';

/* Multi-tenant, in three pieces:
   1. The SSOT gives each shared table a hidden `tenant` column and declares how each table is filtered
      (tenantField and entityTenancy, system.ts).
   2. PostgreSQL row-level security only shows, and only lets write, the rows of the connection's
      `app.tenant` setting (tenant-policies.ts, generated from entityTenancy).
   3. This module remembers the company of the current request and sets `app.tenant` on every
      connection the request uses. Without a company it is '', and no row matches.
   So the rest of the backend queries the tables as if they held a single company. */

type Scope = {tenant: string; authentication: boolean};
const scopes = new AsyncLocalStorage<Scope>();

// Runs `work`, and everything it awaits, as the given company.
export function runAsTenant<T>(tenant: string, work: () => T): T {
    return scopes.run({tenant, authentication: false}, work);
}

/* Login and recovery look a user up by name before knowing their company, so while `work` runs the
   users table shows every company's users (its policy in tenant-policies.ts allows it). */
export function asAuthentication<T>(work: () => T): T {
    return scopes.run({tenant: currentTenant(), authentication: true}, work);
}

export function currentTenant(): string {
    return scopes.getStore()?.tenant ?? '';
}

export type Db = Pick<Pool, 'query' | 'connect'>;

// The pool the app uses: every connection it hands out is set to the current request's company.
export function tenantPool(pool: Pool): Db {
    // Set on every checkout, so a connection never keeps the company of the request that used it before.
    const connect = async (): Promise<PoolClient> => {
        const client = await pool.connect();
        const scope = scopes.getStore();
        try {
            await client.query(`SELECT set_config('app.tenant', $1, false), set_config('app.authentication', $2, false)`,
                [scope?.tenant ?? '', scope?.authentication ? 'on' : 'off']);
        } catch (error) {
            client.release(error as Error);
            throw error;
        }
        return client;
    };
    const query = async (text: string, values?: unknown[]) => {
        const client = await connect();
        try { return await client.query(text, values); } finally { client.release(); }
    };
    return {connect, query} as Db;
}

// The keys and references the browser sees: without the hidden column, which the database fills in.
export const withoutTenant = (names: readonly string[]): string[] => names.filter(name => name !== tenantField);
export const referencePairs = (fields: Readonly<Record<string, string>>): [string, string][] =>
    Object.entries(fields).filter(([source]) => source !== tenantField);
