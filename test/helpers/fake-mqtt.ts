// Duble do src/mqtt-client.ts para os testes que carregam o core real (e o
// app.ts inteiro): mesma interface (default + TOPICS + client), sem broker.
// deliver(topico, mensagem) chama os tratadores registrados, como a chegada
// de uma mensagem do broker.
type Handler = (m: string, t?: string) => void | Promise<void>;

export const TOPICS = {
    current_user: 'aop/currentUser',
    services: 'aop/services',
    current_service: 'aop/currentService',
    current_app: 'aop/:serviceId/currentApp',
    app_path: 'aop/:serviceId/:appId/path',
    app_nodes: 'aop/:serviceId/:appId/doc/nodes',
    app_doc: 'aop/:serviceId/:appId/doc',
    devices: 'aop/devices',
};

export function createFakeMqtt() {
    const handlers = new Map<string, Handler[]>();
    const published: [string, string][] = [];

    const mqttClient = {
        addTopicHandler(t: string, f: Handler) { handlers.set(t, [...(handlers.get(t) ?? []), f]); },
        removeTopicHandler(t: string, f: Handler) {
            const list = (handlers.get(t) ?? []).filter(h => h !== f);
            if (list.length > 0) handlers.set(t, list); else handlers.delete(t);
        },
        publish(t: string, m: string) { published.push([t, m]); },
        parseTopic(topic: string, params: Record<string, string>) {
            return topic.split('/').map(p => (p.startsWith(':') && p.substring(1) in params ? params[p.substring(1)] : p)).join('/');
        },
    };
    const client = {
        on() { /* sem broker */ },
        subscribe() { /* sem broker */ },
        unsubscribe() { /* sem broker */ },
        publish(t: string, m: string) { published.push([t, m]); },
    };

    async function deliver(topic: string, message: string): Promise<void> {
        for (const h of handlers.get(topic) ?? []) await h(message, topic);
    }

    return { mqttClient, client, handlers, published, deliver };
}
