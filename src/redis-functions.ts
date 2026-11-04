import redis from './redis-client';

// The only write point of tv3ws to session:*, client:*, clients:*,
// user:{id}:broadcaster-attrs:{scid} and v100.0:remote-device:{handle}: FCALL
// of the tv30 functions, which check the schema and write atomically; data
// outside the schema gives a TV30SCHEMA error and nothing is written.
// numkeys 0: keys in the arguments.

function fcall(name: string, args: string[]): Promise<unknown> {
    return redis.call('FCALL', name, 0, ...args);
}

function fieldPairs(fields: Record<string, string>): string[] {
    return Object.keys(fields).sort().flatMap(k => [k, fields[k]]);
}

// session:current-user; empty for no current user.
export function sessionUser(id: string): Promise<unknown> {
    return fcall('tv30_session_user', [id]);
}

// session:current-service-id; empty for no current service.
export function sessionServiceId(sid: string): Promise<unknown> {
    return fcall('tv30_session_service_id', [sid]);
}

// session:current-service, rewritten whole (the five fields of Table C.8).
export function sessionService(fields: Record<string, string>): Promise<unknown> {
    return fcall('tv30_session_service', fieldPairs(fields));
}

// C.6.14.5: the value '' removes the attribute; the 20 MB limit is checked
// on the result. Returns the number of fields changed.
export async function broadcasterAttributes(id: string, scid: string, attributes: Record<string, string>): Promise<number> {
    return Number(await fcall('tv30_broadcaster_attributes', [id, scid, ...fieldPairs(attributes)]));
}

// client:{id}: adds or replaces fields (class, refreshToken, accessToken).
export function clientWrite(id: string, fields: Record<string, string>): Promise<unknown> {
    return fcall('tv30_client_write', [id, ...fieldPairs(fields)]);
}

// client:{id}, leaves clients:blocked and enters clients:authorized.
export function clientAuthorize(id: string, fields: Record<string, string>): Promise<unknown> {
    return fcall('tv30_client_authorize', [id, ...fieldPairs(fields)]);
}

// Leaves clients:authorized and enters clients:blocked (client:{id} stays).
export function clientBlock(id: string): Promise<unknown> {
    return fcall('tv30_client_block', [id]);
}

// Adds to clients:authorized an id that has client:{id} and is not blocked.
// Returns 1 if added, 0 otherwise.
export async function clientAddAuthorized(id: string): Promise<number> {
    return Number(await fcall('tv30_client_add_authorized', [id]));
}

// v100.0:remote-device:{handle}: rewrites the whole projection of the
// registry of version 100.0.
export function writeRemoteDeviceV100(handle: string, fields: Record<string, string>): Promise<unknown> {
    return fcall('tv30_v100_remote_device_write', [handle, ...fieldPairs(fields)]);
}

// Removes the projection of the registry of version 100.0.
export function removeRemoteDeviceV100(handle: string): Promise<unknown> {
    return fcall('tv30_v100_remote_device_remove', [handle]);
}

// Removes the projection of every registry of version 100.0.
export function clearRemoteDevicesV100(): Promise<unknown> {
    return fcall('tv30_v100_remote_devices_clear', []);
}
