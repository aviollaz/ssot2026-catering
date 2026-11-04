import type {Express, Response, Request} from 'express';
import type {Authentication} from './auth.js';
import type {EntityName} from './api-contract.js';
import {apiErrorHandler} from './api-errors.js';
import {authenticationEntity} from './system.js';
import {currentTenant} from './tenant.js';

// The app runs one HTTP process. Only invalidation names, never row data, travel here, and only to the
// company whose rows changed. A change of users reaches everyone: it only makes them reconnect.
export function registerEntityEvents(app: Express, auth: Authentication) {
    const clients = new Map<Response, string>();
    const publish = (name: EntityName) => {
        const tenant = currentTenant();
        for (const [client, clientTenant] of clients) {
            if (name !== authenticationEntity && clientTenant !== tenant) continue;
            client.write(`data: ${JSON.stringify(name)}\n\n`);
            if (name === authenticationEntity) client.end();
        }
    };
    app.get('/api/events', auth.requireUser, (_req: Request, res: Response) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        clients.set(res, currentTenant());
        // Reconnection always invalidates the cache, including events missed offline.
        res.write('data: null\n\n');
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        const expiry = setTimeout(() => res.end(), Math.max(0, Number(res.locals['expiresAt']) - Date.now()));
        res.on('close', () => { clearInterval(heartbeat); clearTimeout(expiry); clients.delete(res); });
    }, apiErrorHandler);
    // Authentication operations can change the same users exposed by the CRUD API.
    app.use('/api/auth', (req, res, next) => {
        res.on('finish', () => { if (req.method === 'POST' && req.path !== '/login' && res.statusCode < 300) publish(authenticationEntity); });
        next();
    });
    return publish;
}
