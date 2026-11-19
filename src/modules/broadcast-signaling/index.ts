import { z } from 'zod';
import logger from '../../logger';
import mqttClient, { TOPICS } from '../../mqtt-client';

// The tuned service and its BALD and S-TSID, kept from the retained topics of
// the acquisition. An empty message deletes the retained one.

export type SignaledFile = {
    location: string;
    contentType: string;
    transferLength: number;
};

// ATSC A/331, A.3.3.2: only the members read here.
const FileSchema = z.object({
    'Content-Location': z.string().min(1),
    'Content-Type': z.string().min(1),
    'Transfer-Length': z.int().nonnegative(),
    appContextIdList: z.array(z.string()).optional(),
});

const StsidSchema = z.object({
    RS: z.array(z.object({
        LS: z.array(z.object({
            SrcFlow: z.object({
                EFDT: z.object({
                    'FDT-Instance': z.object({
                        appContextIdList: z.array(z.string()).optional(),
                        File: z.array(FileSchema),
                    }),
                }),
            }),
        })),
    })),
});
type Stsid = z.infer<typeof StsidSchema>;

// ABNT NBR 25608, 10.1.2, Table 10: only the members read here.
const BaldSchema = z.object({
    EntryPackage: z.array(z.object({
        appId: z.string().min(1),
        appContextId: z.string().min(1),
    })),
});
type Bald = z.infer<typeof BaldSchema>;

const TunedSchema = z.object({
    serviceId: z.int().nonnegative(),
});

let tunedServiceId: number | undefined;
let bald: Bald | undefined;
let stsid: Stsid | undefined;

// The serviceId of the tuned service; undefined when none is tuned.
export function currentServiceId(): number | undefined {
    return tunedServiceId;
}

// The appContextId of the first entry of the BALD of the tuned service with
// the appId; undefined when the BALD has none.
export function appContextIdOf(appId: string): string | undefined {
    const entry = bald?.EntryPackage.find((candidate) => candidate.appId === appId);
    return entry?.appContextId;
}

// The files of the S-TSID of the tuned service whose appContextIdList, of
// the flow and of the file together, has the appContextId.
export function filesOfContext(appContextId: string): SignaledFile[] {
    const files: SignaledFile[] = [];
    const flows = (stsid?.RS ?? []).flatMap((session) => session.LS);
    for (const flow of flows) {
        const instance = flow.SrcFlow.EFDT['FDT-Instance'];
        const flowContexts = instance.appContextIdList ?? [];
        for (const file of instance.File) {
            const contexts = [...flowContexts, ...(file.appContextIdList ?? [])];
            if (!contexts.includes(appContextId)) {
                continue;
            }
            files.push({
                location: file['Content-Location'],
                contentType: file['Content-Type'],
                transferLength: file['Transfer-Length'],
            });
        }
    }
    return files;
}

function onTuned(message: string): void {
    const serviceId = message === '' ? undefined : parseMessage(TOPICS.tuned, TunedSchema, message)?.serviceId;
    if (serviceId === tunedServiceId) {
        return;
    }
    if (tunedServiceId !== undefined) {
        mqttClient.removeTopicHandler(fragmentTopic(TOPICS.bald, tunedServiceId), onBald);
        mqttClient.removeTopicHandler(fragmentTopic(TOPICS.stsid, tunedServiceId), onStsid);
    }
    tunedServiceId = serviceId;
    bald = undefined;
    stsid = undefined;
    if (serviceId !== undefined) {
        mqttClient.addTopicHandler(fragmentTopic(TOPICS.bald, serviceId), onBald);
        mqttClient.addTopicHandler(fragmentTopic(TOPICS.stsid, serviceId), onStsid);
    }
}

function onBald(message: string): void {
    bald = message === '' ? undefined : parseMessage(TOPICS.bald, BaldSchema, message);
}

function onStsid(message: string): void {
    stsid = message === '' ? undefined : parseMessage(TOPICS.stsid, StsidSchema, message);
}

// An invalid message is logged and taken as absent.
function parseMessage<T extends z.ZodType>(topic: string, schema: T, message: string): z.infer<T> | undefined {
    try {
        return schema.parse(JSON.parse(message));
    } catch (err) {
        logger.error(`[broadcast-signaling] invalid message in ${topic}: ${(err as Error).message}`);
        return undefined;
    }
}

function fragmentTopic(topic: string, serviceId: number): string {
    return mqttClient.parseTopic(topic, { serviceId: String(serviceId) });
}

mqttClient.addTopicHandler(TOPICS.tuned, onTuned);
