import fs from 'fs';
import core from '../../../core';
import path from 'path';
import { ResolvedPath, isInsideDir, resolveInsideDir } from '../../../util/safe-path';


export type FileData = {
	size: number,
	mime: string,
	type: string,
	name: string,
	path: string
}

const MIMES = new Map<string, string>([
	['.mpeg', 'video/mpeg'],
	['.mp4', 'video/mp4'],
	['.mp3', 'audio/mpeg'],
	['.ogg', 'audio/ogg'],
	['.txt', 'text/plain'],
	['.jpeg', 'image/jpeg'],
	['.jpg', 'image/jpeg'],
	['.png', 'image/png'],
	['.obj', 'model/obj']
]);

const TYPES = new Map<string, string>([
	['.mpeg', 'video'],
	['.mp4', 'video'],
	['.mp3', 'audio'],
	['.ogg', 'audio'],
	['.txt', 'text'],
	['.jpeg', 'image'],
	['.jpg', 'image'],
	['.png', 'image'],
	['.obj', 'model']
]);


function validateAppId(appid: string): boolean {
	return appid === core.app.id;
}


// Correcao de 12/10 (spec-1210-seguranca2, item 1): o caminho pedido e
// resolvido dentro do diretorio da aplicacao (core.app.url) e nao sai dele
// (regras em util/safe-path.ts). Antes, path.join(core.app.url, path) lia
// qualquer arquivo que o processo alcancasse (path=../package.json devolvia
// o package.json do tv3ws) e, sem diretorio da aplicacao conhecido
// (core.app.url vazio), lia relativo ao diretorio corrente do tv3ws.
// undefined = caminho recusado ou inexistente (o controller responde 305).
// PENDENTE (Joel): sem diretorio da aplicacao conhecido (core.app.url vazio:
// p.ex. depois da troca de servico e antes de aop/<sid>/<appId>/path) a
// resposta e 305, lendo a Tabela C.17 ("does not exist in the application's
// filesystem"); a outra leitura seria 200 (recurso da plataforma
// indisponivel).
function resolvePath(fpath: unknown): ResolvedPath | undefined {
	return resolveInsideDir(core.app.url, fpath);
}


function getFile(entry: ResolvedPath): FileData {
	const file_name = path.parse(entry.path).base;
	const file_ext = path.extname(file_name);

	return {
		size: entry.stat.size,
		mime: GetMime(file_ext),
		type: GetType(file_ext),
		name: file_name,
		path: entry.path
	}
}


// Listagem de diretorio da Tabela C.17 (p. 231; p. 249 do PDF): "If path is
// a directory, the response is formatted in JSON and contains the first-level
// structure of this directory" e "If the path is omitted, the response is
// formatted in JSON and contains the first-level structure of the application
// from its base directory", no formato
// {"files": [{"name", "size"}], "dirs": [{"name"}]}. Antes, path omitido dava
// 105 e diretorio dava 404 {error:200} (EISDIR).
// Escolhas da implementacao (a tabela nao trata): arquivo comum vai em
// "files" com o tamanho em bytes e diretorio em "dirs"; link simbolico entra
// pelo destino e so se o destino estiver dentro do diretorio da aplicacao (o
// mesmo que a leitura aceitaria); outros tipos (socket, fifo) e nomes com
// barra invertida (que a leitura recusa) ficam de fora; ordem por nome.
export type DirListing = {
	files: { name: string, size: number }[],
	dirs: { name: string }[]
}

function listDirectory(entry: ResolvedPath): DirListing {
	const files: DirListing['files'] = [];
	const dirs: DirListing['dirs'] = [];
	for (const dirent of fs.readdirSync(entry.path, { withFileTypes: true })) {
		const name = dirent.name;
		if (name.includes('\\')) continue;
		const full = path.join(entry.path, name);
		let stat: fs.Stats;
		if (dirent.isSymbolicLink()) {
			let real: string;
			try { real = fs.realpathSync(full); } catch { continue; }
			if (!isInsideDir(entry.base, real)) continue;
			stat = fs.statSync(real);
		}
		else if (dirent.isFile() || dirent.isDirectory()) {
			stat = fs.statSync(full);
		}
		else continue;
		if (stat.isFile()) files.push({ name, size: stat.size });
		else if (stat.isDirectory()) dirs.push({ name });
	}
	const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	return { files: files.sort(byName), dirs: dirs.sort(byName) };
}


function GetMime(file_ext: string): string {
	if (MIMES.has(file_ext)) {
		return MIMES.get(file_ext) as string;
	}
	else {
		return 'application/octet-stream';
	}
}


function GetType(file_ext: string): string {
	if (TYPES.has(file_ext)) {
		return TYPES.get(file_ext) as string;
	}
	else {
		return 'application';
	}
}

export default { validateAppId, resolvePath, getFile, listDirectory }