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

function POSTUserList(req: Request, res: Response): void {
	service.getUserList(req.body)
	.then((response) => { res.status(200).json(response) })
	.catch((err) => returnError(res, 200, err?.message));
}

function GETUserAttribute(req: Request, res: Response): void {
	const uuid = req.params.userid;
	if (!uuid) {
		returnError(res, 105, 'userid');
		return;
	}

	if (Object.keys(req.query).length > 0) {
		const atname = req.query.attribute as string;
		service.getUserAttribute(uuid, atname)
		.then((response) => { res.status(200).json(response) })
		.catch((err) => returnError(res, 200, err?.message));
	}
	else {
		service.getUserAttribute(uuid)
		.then((response) => { res.status(200).json(response) })
		.catch((err) => returnError(res, 200, err?.message));
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


async function GETBroadcasterAttrs(req: Request, res: Response): Promise<void> {
    const { userid, serviceContextId } = req.params;
    if (!userid) {
        returnError(res, 105, 'userid');
        return;
    }
    const attrs = await service.getBroadcasterAttrs(userid, serviceContextId ?? 'current-service');
    res.status(200).json(attrs);
}

async function PUTBroadcasterAttrs(req: Request, res: Response): Promise<void> {
    const { userid, serviceContextId } = req.params;
    if (!userid) {
        returnError(res, 105, 'userid');
        return;
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        returnError(res, 101, 'request body must be a JSON object');
        return;
    }
    await service.setBroadcasterAttrs(userid, serviceContextId ?? 'current-service', req.body);
    res.sendStatus(200);
}


async function POSTCreateUser(req: Request, res: Response): Promise<void> {
    if (!req.body || typeof req.body !== 'object') {
        returnError(res, 105, 'request body');
        return;
    }
    try {
        const newUser = await service.createUser(req.body);
        res.status(201).json(newUser);
    } catch (err: any) {
        returnError(res, 101, err?.message);
    }
}


export default { GETCurrentUser, POSTCurrentUser, POSTUserList, GETUserAttribute, GETUserFile, GETBroadcasterAttrs, PUTBroadcasterAttrs, POSTCreateUser }
