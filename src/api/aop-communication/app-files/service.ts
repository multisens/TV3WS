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


// undefined = a refused or nonexistent path (305). Without a known directory
// (core.app.url empty, e.g. right after a service change), also undefined.
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


// First-level listing of Table C.17: {"files": [{"name", "size"}],
// "dirs": [{"name"}]}. Beyond what the table covers: a symbolic link counts
// by its target, only inside the base; sockets, fifos and names with a
// backslash are left out; ordered by name.
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