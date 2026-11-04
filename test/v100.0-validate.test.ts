// Middleware validateSchema of version 100.0 (src/v100.0/util/validate.ts),
// on an express app built here, with schemas that use refine and
// superRefine to carry the error code in params.error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import { z } from 'zod';
import { validateSchema } from '../src/v100.0/util/validate';
import { errorHandler } from '../src/util';

// at least one control field (as in C.6.16.3)
const ControlSchema = z.object({
    action: z.string().optional(),
    intensity: z.number().optional(),
}).refine(
    (body) => body.action !== undefined || body.intensity !== undefined,
    { message: 'no control field', params: { error: 105 } },
);

// value required by the eventType (as in C.6.4.9.1)
const EventSchema = z.object({
    eventType: z.string(),
    value: z.string().optional(),
}).superRefine((body, ctx) => {
    if (body.eventType === 'selection' && body.value === undefined) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'value', params: { error: 105 } });
    }
});

let server: Server;
let base = '';
before(async () => {
    const app = express();
    app.use(express.json());
    app.post('/control', validateSchema(ControlSchema), (req, res) => {
        res.json(req.body);
    });
    app.post('/event', validateSchema(EventSchema), (req, res) => {
        res.json(req.body);
    });
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function post(route: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
}

test('refine com params.error: responde o código do esquema, com a message', async () => {
    const r = await post('/control', {});
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 105);
    assert.ok(r.json.description.endsWith('no control field'), r.json.description);
});

test('superRefine com params.error num campo', async () => {
    const r = await post('/event', { eventType: 'selection' });
    assert.equal(r.json.error, 105);
    assert.ok(r.json.description.endsWith('value'), r.json.description);
});

test('o tipo é conferido antes da regra customizada: 101', async () => {
    const r = await post('/control', { action: 1 });
    assert.equal(r.json.error, 101);
    assert.ok(r.json.description.endsWith('action'), r.json.description);
});

test('corpo que não é objeto: 101', async () => {
    const r = await post('/control', []);
    assert.equal(r.json.error, 101);
});

test('corpo válido chega ao tratador sem campos desconhecidos', async () => {
    const control = await post('/control', { action: 'start', extra: 1 });
    assert.equal(control.status, 200);
    assert.deepEqual(control.json, { action: 'start' });
    const event = await post('/event', { eventType: 'presentation' });
    assert.deepEqual(event.json, { eventType: 'presentation' });
});
