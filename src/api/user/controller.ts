import { Request, Response } from 'express';
import service from './service';
import { UserId } from './types';
import { returnError } from '../../util';


async function GETCurrentUser(req: Request, res: Response): Promise<void> {
	const id = await service.getCurrentUser();
	console.log(`pediu usuário e recebeu ${id}`);
    res.status(200).json({ id });
}

async function POSTCurrentUser(req: Request, res: Response): Promise<void> {
    const body: UserId = req.body;
    if (!body || !body.id) {
        returnError(res, 105, 'id');
        return;
    }
    await service.setCurrentUser(body.id);
    res.sendStatus(200);
}

async function POSTUserList(req: Request, res: Response): Promise<void> {
	// erros de negocio (300 sem servico ativo, 101 expressao invalida) sobem
	// como ApiError ate o errorHandler
	const response = await service.getUserList(req.body);
	res.status(200).json(response);
}

// C.6.14.2: com atributo na query -> valor em texto puro; sem -> JSON com
// todos os atributos (basicos + emissora) no contexto de servico informado.
// Erros de negocio (300/305/405) sobem como ApiError ate o errorHandler.
async function GETUserAttribute(req: Request, res: Response): Promise<void> {
	const uuid = req.params.userid;
	if (!uuid) {
		returnError(res, 105, 'userid');
		return;
	}

	const scid = (req.params as Record<string, string>).serviceContextId;
	const result = await service.getUserAttributes(uuid, scid, req.query as Record<string, unknown>);
	if (result.kind === 'text') {
		res.status(200).type('text/plain').send(result.value);
	} else {
		res.status(200).json(result.attrs);
	}
}

function GETUserFile(req: Request, res: Response): void {
    if (Object.keys(req.query).length == 0) {
		returnError(res, 105, 'path');
		return;
	}

	const path = req.query.path as string;
	service.checkConsent(path)
	.then((result) => {
		if (!result) {
			returnError(res, 305, path);
		}
		else {
			const file_data = service.getFile(path);

			res.setHeader('Content-Length', file_data.size);
			res.setHeader('Content-Type', file_data.mime);
			res.setHeader('Content-Disposition', `attachment; filename=${file_data.name}`);
			res.write(file_data.file, 'binary');
			res.end();
		}
	})
	.catch((err) => returnError(res, 200, err?.message));
}


// C.6.14.5: POST /tv3/{scid}/users/{user-id} escreve atributos de emissora
// (valor '' remove) e responde o JSON dos atributos alterados. Substitui o
// antigo PUT .../broadcaster-attrs, que estava fora da Tabela C.2 (item 24).
async function POSTUserAttributes(req: Request, res: Response): Promise<void> {
    const { userid } = req.params;
    if (!userid) {
        returnError(res, 105, 'userid');
        return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        returnError(res, 101, 'request body must be a JSON object');
        return;
    }
    const scid = (req.params as Record<string, string>).serviceContextId;
    const changed = await service.writeBroadcasterAttrs(userid, scid, req.body);
    res.status(200).json(changed);
}


// (POSTCreateUser saiu: criacao de perfil e funcao do gestor de perfis da
// plataforma — AoP POST /profile/create — nao endpoint das APIs de usuario)

export default { GETCurrentUser, POSTCurrentUser, POSTUserList, GETUserAttribute, GETUserFile, POSTUserAttributes }
