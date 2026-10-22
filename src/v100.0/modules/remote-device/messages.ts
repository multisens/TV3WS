import { WebSocket } from 'ws';
import { ClientType } from '../../util/client';

// Close codes of the local connections refused or that lose the pair
export const CLOSE_DEVICE_BUSY = 4001;
export const CLOSE_DEVICE_UNAVAILABLE = 4002;
export const CLOSE_PREEMPTED = 4003;

// C.6.15.4, Table C.86: message to the device on each formation and end of
// a communication pair
export type PairNotice = {
    event: 'pairFormed' | 'pairEnded';
    clientType: ClientType;
};

// C.6.15.5: messages to the local client refused or that loses the pair
export type PairRefused = {
    event: 'pairRefused';
    reason: 'deviceBusy' | 'deviceUnavailable';
};

export type PairEnded = {
    event: 'pairEnded';
    reason: 'deviceUnavailable' | 'preemptedByAssociated';
};

// Sends the message as the last one on the connection and closes it with
// the code
export function sendAndClose(ws: WebSocket, message: PairRefused | PairEnded, code: number): void {
    ws.send(JSON.stringify(message));
    ws.close(code);
}
