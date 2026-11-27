import { z } from 'zod';
import redis from '../../../redis-client';
import { integerServiceId } from '../../../util/service-id';

// The current service as the AoP writes it in the session: the fields of
// Table C.8 (ABNT NBR 25608, C.6.3.1).

export type CurrentService = {
    serviceContextId: string;
    serviceName?: string;
    serviceId?: number;
};

const SERVICE_ID_KEY = 'session:current-service-id';
const SERVICE_KEY = 'session:current-service';

const SessionServiceSchema = z.object({
    serviceContextId: z.string().min(1),
    serviceName: z.string(),
    serviceId: z.string(),
});

// The current service, or undefined without one: the id decides, as for the
// edge; the hash gives the other fields when it is of that service. An empty
// serviceName and a serviceId without an integer value are omitted
// (C.3.2.2).
export async function readCurrentService(): Promise<CurrentService | undefined> {
    const [serviceContextId, hash] = await Promise.all([redis.get(SERVICE_ID_KEY), redis.hgetall(SERVICE_KEY)]);
    if (!serviceContextId) {
        return undefined;
    }
    const service: CurrentService = { serviceContextId };
    if (hash.serviceContextId !== serviceContextId) {
        return service;
    }
    const stored = SessionServiceSchema.parse(hash);
    if (stored.serviceName !== '') {
        service.serviceName = stored.serviceName;
    }
    const serviceId = integerServiceId(stored.serviceId);
    if (serviceId !== undefined) {
        service.serviceId = serviceId;
    }
    return service;
}
