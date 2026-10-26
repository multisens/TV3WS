import logger from '../logger';

// Logs the names and exits the process with 1 if any required variable is
// missing or blank.
export function assertEnv(required: string[]): void {
    const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
    if (missing.length > 0) {
        logger.error(`[boot] missing required env vars: ${missing.join(', ')}`);
        logger.error(`[boot] check docker-compose.yml or .env`);
        process.exit(1);
    }
}

// Returns the environment variable as a positive integer; throws if it is
// missing or is not a positive integer.
export function positiveIntFromEnv(name: string): number {
    const raw = process.env[name];
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got '${raw}'`);
    }
    return value;
}
