import logger from '../logger';

// Falha antes de qualquer inicializacao, em vez de erro confuso mais tarde no boot.
export function assertEnv(required: string[]): void {
    const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
    if (missing.length) {
        logger.error(`[boot] missing required env vars: ${missing.join(', ')}`);
        logger.error(`[boot] check docker-compose.yml or .env`);
        process.exit(1);
    }
}
