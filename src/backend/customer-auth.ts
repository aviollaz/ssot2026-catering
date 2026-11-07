import express, {type Express, type RequestHandler, type Response} from 'express';
import type {Pool} from 'pg';
import {jwtVerify, SignJWT} from 'jose';
import {randomUUID} from 'node:crypto';
import {completeEntity} from 'system-definition';
import {myContext, myEntities} from './system.js';
import {ApiFailure, apiErrorHandler, readObject} from './api-errors.js';
import {authenticationLimit} from './auth.js';
import {entitySql} from './entity-sql.js';
import {insertPreparedRow, prepareEntityWrite} from './entity-write.js';
import {readPassword, verifyPassword} from './credentials.js';
import type {CustomerLoginResponse, StoredRow} from './api-contract.js';

const entity = completeEntity(myContext, myEntities.clientes);
const sql = entitySql('clientes');
const column = sql.column;
const session = sql.select('id', 'email', 'version_sesion');
const credentials = sql.select(...session.fields, 'contrasena_hash');
type CustomerSession = Pick<StoredRow<'clientes'>, typeof session.fields[number]>;
export type AuthenticatedCustomer = {id: string; email: string};
const publicCustomer = ({id, email}: AuthenticatedCustomer): AuthenticatedCustomer => ({id, email});
export const customerPrincipal = (res: Response): AuthenticatedCustomer => {
    const customer = res.locals['customer'] as AuthenticatedCustomer | undefined;
    if (!customer) throw new ApiFailure(401, 'Iniciá sesión para continuar.');
    return customer;
};

function readEmail(value: unknown): string {
    const maxLength = entity.fields.email.maxLength;
    if (typeof value !== 'string') throw new ApiFailure(400, 'Ingresá un email válido.');
    const email = value.trim().toLowerCase();
    if (email.length > maxLength || !/^[^@\s]+@[^@\s]+$/.test(email)) {
        throw new ApiFailure(400, 'Ingresá un email válido.');
    }
    return email;
}

export function createCustomerAuthentication(pool: Pick<Pool, 'query'>, secret = process.env['JWT_SECRET'] ?? '') {
    if (Buffer.byteLength(secret) < 32) throw new Error('JWT_SECRET debe contener al menos 32 bytes aleatorios.');
    const key = new TextEncoder().encode(secret);
    const issuer = 'ssot2026', audience = 'ssot2026-customer-api';
    const expiresIn = 24 * 60 * 60;

    async function issueToken(customer: CustomerSession): Promise<CustomerLoginResponse> {
        const token = await new SignJWT({ver: customer.version_sesion, kind: 'customer'})
            .setProtectedHeader({alg: 'HS256', typ: 'JWT'}).setSubject(customer.id)
            .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(`${expiresIn}s`).sign(key);
        return {token, expiresIn, customer: publicCustomer(customer)};
    }

    const requireCustomer: RequestHandler = async (req, res, next) => {
        const token = /^Bearer ([^\s]+)$/.exec(req.header('authorization') ?? '')?.[1];
        if (!token) throw new ApiFailure(401, 'Iniciá sesión para continuar.');
        let identity: {id: string; version: string};
        try {
            const {payload} = await jwtVerify(token, key, {
                algorithms: ['HS256'], typ: 'JWT', issuer, audience, maxTokenAge: expiresIn,
                requiredClaims: ['sub', 'iat', 'exp', 'ver'],
            });
            if (typeof payload.sub !== 'string' || typeof payload['ver'] !== 'string' || payload['kind'] !== 'customer') {
                throw new Error('Invalid claims');
            }
            identity = {id: payload.sub, version: payload['ver']};
        } catch {
            throw new ApiFailure(401, 'La sesión venció o no es válida.');
        }
        const {rows} = await session.query(pool, `WHERE ${column('id')} = $1`, [identity.id]);
        const customer = rows[0];
        if (!customer || customer.version_sesion !== identity.version) throw new ApiFailure(401, 'La sesión venció o no es válida.');
        res.locals['customer'] = publicCustomer(customer);
        res.setHeader('Cache-Control', 'no-store');
        next();
    };

    const optionalCustomer: RequestHandler = async (req, res, next) => {
        if (!req.get('authorization')) { next(); return; }
        await requireCustomer(req, res, next);
    };

    return {issueToken, requireCustomer, optionalCustomer};
}

export type CustomerAuthentication = ReturnType<typeof createCustomerAuthentication>;
export function registerCustomerAuthApi(app: Express, pool: Pick<Pool, 'query'>, auth: CustomerAuthentication): void {
    const router = express.Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use(express.json({limit: '8kb'}));
    const limit = authenticationLimit();

    router.post('/register', limit, async (req, res) => {
        const body = readObject(req.body, ['email', 'contrasena']);
        const row = await prepareEntityWrite(entity, {email: readEmail(body['email']), contrasena: body['contrasena']}, 'create');
        await insertPreparedRow(pool, entity, row);
        const {id, email, version_sesion} = row;
        if (typeof id !== 'string' || typeof email !== 'string' || typeof version_sesion !== 'string') {
            throw new Error('No se pudo preparar la cuenta del cliente.');
        }
        res.status(201).json(await auth.issueToken({id, email, version_sesion}));
    });

    router.post('/login', limit, async (req, res) => {
        const body = readObject(req.body, ['email', 'contrasena']);
        let email: string, password: string;
        try {
            email = readEmail(body['email']);
            password = readPassword(body['contrasena']);
        } catch (error) {
            if (!(error instanceof ApiFailure)) throw error;
            throw new ApiFailure(401, 'No existe una cuenta con esas credenciales.');
        }
        const {rows} = await credentials.query(pool, `WHERE ${column('email')} = $1`, [email]);
        const customer = rows[0];
        const verified = await verifyPassword(password, customer?.contrasena_hash);
        if (!verified || !customer) throw new ApiFailure(401, 'No existe una cuenta con esas credenciales.');
        res.json(await auth.issueToken(customer));
    });

    router.get('/me', auth.requireCustomer, (_req, res) => { res.json(customerPrincipal(res)); });
    router.post('/logout', auth.requireCustomer, async (_req, res) => {
        await pool.query(`UPDATE ${sql.table} SET ${column('version_sesion')} = $1 WHERE ${column('id')} = $2`,
            [randomUUID(), customerPrincipal(res).id]);
        res.sendStatus(204);
    });
    router.use((_req, res) => { res.status(404).json({error: 'Operación desconocida.'}); });
    router.use(apiErrorHandler);
    app.use('/api/public/auth', router);
}
