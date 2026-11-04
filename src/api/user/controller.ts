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
	const response = await service.getUserList(req.body);
	res.status(200).json(response);
}

// C.6.14.2: with an attribute in the query, its value as plain text;
// without, JSON with every attribute (basic and broadcaster) in the given
// service context. Business errors (300, 305, 405) are thrown as ApiError.
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
	.then((access) => {
		// Owner profile of the avatar not visible to the current service: 405
		// (Table C.75).
		if (access === 'no-consent') {
			returnError(res, 405, path);
		}
		else if (access !== 'granted') {
			returnError(res, 305, path);
		}
		else {
			// Path outside USER_THUMBS or nonexistent: 305 (Table C.75).
			const file_data = service.getFile(path);
			if (file_data === undefined) {
				returnError(res, 305, path);
				return;
			}

			res.setHeader('Content-Length', file_data.size);
			res.setHeader('Content-Type', file_data.mime);
			res.setHeader('Content-Disposition', `attachment; filename=${file_data.name}`);
			res.write(file_data.file, 'binary');
			res.end();
		}
	})
	.catch((err) => returnError(res, 200, err?.message));
}


// C.6.14.5: the value '' removes the attribute; answers the JSON of the
// changed attributes.
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

export default { GETCurrentUser, POSTCurrentUser, POSTUserList, GETUserAttribute, GETUserFile, POSTUserAttributes }
