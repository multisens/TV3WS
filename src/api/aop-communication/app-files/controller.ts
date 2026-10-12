import { Request, Response } from 'express';
import fs from 'fs';
import service, { FileData } from './service';
import { returnError } from '../../../util';


// C.6.4.7, Tabela C.17 (p. 231-232; p. 249-250 do PDF). Correcao de 12/10
// (spec-1210-seguranca2, item 1):
// - o caminho nao sai do diretorio da aplicacao (service.resolvePath; regras
//   em util/safe-path.ts). Caminho recusado ou inexistente da 305, o codigo
//   da tabela para "the path indicated in <path> does not exist in the
//   application's filesystem" — antes, ../package.json devolvia o arquivo, e
//   o inexistente dava 404 {error:200} (ENOENT);
// - path e opcional ("[?path=<path>]"): omitido, a resposta e a estrutura de
//   primeiro nivel a partir da base, e diretorio tambem responde a listagem
//   (service.listDirectory). Antes, path omitido dava 105. path= vazio e a
//   propria base.
// O <appId> so e comparado com o da aplicacao corrente (validateAppId) e nao
// entra em caminho nenhum: nao ha como escapar por ele.
function GETAppFile(req:Request, res:Response) {
	if (!service.validateAppId(req.params.appid)) {
		returnError(res, 305, `appid ${req.params.appid}`);
		return;
	}

	const requested = req.query.path === undefined ? '' : req.query.path;
	const entry = service.resolvePath(requested);
	if (entry === undefined || !(entry.stat.isFile() || entry.stat.isDirectory())) {
		returnError(res, 305, `path ${String(requested)}`);
		return;
	}
	if (entry.stat.isDirectory()) {
		res.status(200).json(service.listDirectory(entry));
		return;
	}

	let file_data = service.getFile(entry);

	if ((file_data.type == 'video' || file_data.type == 'audio') && req.headers.range !== undefined) {
		const range:string = req.headers.range;
		replyStream(res, range, file_data);
	}
	else {
		replyFile(res, file_data);
	}
};


function replyFile(res:Response, file_data:FileData) {
	var file = fs.readFileSync(file_data.path, 'binary');
	res.setHeader('Content-Length', file_data.size);
	res.setHeader('Content-Type', file_data.mime);
	res.write(file, 'binary');
	res.end();
}


function replyStream(res:Response, range:string, file_data:FileData) {
	if (range) {
		const parts = range.replace(/bytes=/, "").split("-");
		const start = parseInt(parts[0], 10);
		const end = parts[1] ? parseInt(parts[1], 10) : file_data.size-1;
 	    
		const chunksize = (end-start)+1;
		const file = fs.createReadStream(file_data.path, {start, end});
		
		res.setHeader('Content-Range', `bytes ${start}-${end}/${file_data.size}`);
		res.setHeader('Accept-Ranges', 'bytes');
		res.setHeader('Content-Length', chunksize);
		res.setHeader('Content-Type', file_data.mime);
		
		res.writeHead(206);
		file.pipe(res);
	}
	else {
		res.setHeader('Content-Length', file_data.size);
		res.setHeader('Content-Type', file_data.mime);
		res.writeHead(200);
		fs.createReadStream(file_data.path).pipe(res);
	}
}


export default { GETAppFile }