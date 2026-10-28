import * as dotenv from 'dotenv';
import { assertEnv } from './util';

const REQUIRED_ENV = [
    'MQTT_HOST',
    'REDIS_HOST',
    'JWT_SECRET',
    'JWT_ISSUER',
    'USER_THUMBS',
    'HTTP_PORT',
    'HTTPS_PORT',
    'WS_PORT_MIN',
    'WS_PORT_MAX',
    'LISTEN_ATTEMPTS',
    'MAX_REGISTRATIONS',
    'PING_INTERVAL_MS',
];

// Loads .env and stops the process if a required variable is missing; runs
// when the module loads, before the modules that read the environment.
dotenv.config();
assertEnv(REQUIRED_ENV);
