import path from 'path';
import { filesOfContext } from '../../../modules/broadcast-signaling';
import { getApplicationFile } from '../../../modules/object-proxy';

// The filesystem of a Broadcaster Application (ABNT NBR 25608, C.6.4.7): the
// files of its Application Context ID in the S-TSID of the tuned service,
// received or not, and the parts of each entry package already received
// (ATSC A/331, A.3.3.4). Each file is read through the object proxy.

// Size in bytes by path, relative to the base of the application.
export type ContextTree = Map<string, number>;

// First-level listing of Table C.17, ordered by name.
export type DirListing = {
    files: { name: string; size: number }[];
    dirs: { name: string }[];
};

export type ResolvedPath =
    | { kind: 'file'; location: string }
    | { kind: 'dir'; listing: DirListing };

export type FileData = {
    status: 200 | 206;
    mime: string;
    body: Buffer;
    contentRange?: string;
};

const PACKAGE_TYPE = 'multipart/related';
const BOUNDARY_PARAMETER = /;\s*boundary="?([^";]+)"?/i;
const HEADER_END = '\r\n\r\n';
const CRLF = '\r\n';
const RANGE = /^bytes=(\d*)-(\d*)$/;
const DEFAULT_MIME = 'application/octet-stream';

const MIMES = new Map<string, string>([
    ['.html', 'text/html'],
    ['.htm', 'text/html'],
    ['.js', 'text/javascript'],
    ['.mjs', 'text/javascript'],
    ['.css', 'text/css'],
    ['.json', 'application/json'],
    ['.xml', 'application/xml'],
    ['.svg', 'image/svg+xml'],
    ['.txt', 'text/plain'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.mpeg', 'video/mpeg'],
    ['.mp4', 'video/mp4'],
    ['.m4s', 'video/iso.segment'],
    ['.mp3', 'audio/mpeg'],
    ['.ogg', 'audio/ogg'],
    ['.obj', 'model/obj'],
]);

// Media whose reading answers a Range request.
const RANGE_PREFIXES = ['video/', 'audio/'];

async function contextTree(appContextId: string): Promise<ContextTree> {
    const tree: ContextTree = new Map();
    for (const file of filesOfContext(appContextId)) {
        tree.set(file.location, file.transferLength);
        if (file.contentType !== PACKAGE_TYPE) {
            continue;
        }
        const response = await getApplicationFile(appContextId, file.location);
        if (response.status !== 200) {
            continue;
        }
        for (const [location, size] of packageParts(response.contentType, response.body)) {
            tree.set(location, size);
        }
    }
    return tree;
}

// The leading '/' is optional, and so is a trailing one on a directory;
// undefined for a path that is not in the tree. The base always exists.
function resolvePath(tree: ContextTree, requested: string): ResolvedPath | undefined {
    const location = requested.replace(/^\//, '');
    if (tree.has(location)) {
        return { kind: 'file', location };
    }
    const dir = location.replace(/\/$/, '');
    const prefix = dir === '' ? '' : `${dir}/`;
    const inside = [...tree.keys()].some((candidate) => candidate.startsWith(prefix));
    if (dir !== '' && !inside) {
        return undefined;
    }
    return { kind: 'dir', listing: listDirectory(tree, prefix) };
}

// undefined when the object proxy does not serve the file: not received and
// not in the Application Context Cache.
async function readFile(appContextId: string, location: string, range: string | undefined):
    Promise<FileData | undefined> {
    const response = await getApplicationFile(appContextId, location);
    if (response.status !== 200) {
        return undefined;
    }
    const mime = MIMES.get(path.extname(location).toLowerCase()) ?? DEFAULT_MIME;
    const ranged = range !== undefined && RANGE_PREFIXES.some((prefix) => mime.startsWith(prefix));
    if (!ranged) {
        return { status: 200, mime, body: response.body };
    }
    return rangeOf(mime, response.body, range);
}

function listDirectory(tree: ContextTree, prefix: string): DirListing {
    const files: DirListing['files'] = [];
    const dirs = new Set<string>();
    for (const [location, size] of tree) {
        if (!location.startsWith(prefix)) {
            continue;
        }
        const rest = location.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
            files.push({ name: rest, size });
        } else {
            dirs.add(rest.slice(0, slash));
        }
    }
    files.sort((one, other) => compareNames(one.name, other.name));
    const sortedDirs = [...dirs].sort(compareNames).map((name) => ({ name }));
    return { files, dirs: sortedDirs };
}

// The Content-Location and the size of each part of a multipart/related
// package (IETF RFC 2387); none without a boundary.
function packageParts(contentType: string, body: Buffer): [string, number][] {
    const boundary = BOUNDARY_PARAMETER.exec(contentType)?.[1];
    if (boundary === undefined) {
        return [];
    }
    const delimiter = Buffer.from(`--${boundary}`);
    const parts: [string, number][] = [];
    let start = body.indexOf(delimiter);
    while (start !== -1) {
        const afterDelimiter = start + delimiter.length;
        const next = body.indexOf(delimiter, afterDelimiter);
        if (next === -1) {
            break;
        }
        const part = body.subarray(afterDelimiter + CRLF.length, next - CRLF.length);
        const headerEnd = part.indexOf(HEADER_END);
        if (headerEnd !== -1) {
            const location = contentLocationOf(part.subarray(0, headerEnd).toString('latin1'));
            if (location !== undefined) {
                parts.push([location, part.length - headerEnd - HEADER_END.length]);
            }
        }
        start = next;
    }
    return parts;
}

function contentLocationOf(headers: string): string | undefined {
    for (const line of headers.split(CRLF)) {
        const colon = line.indexOf(':');
        if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === 'content-location') {
            return line.slice(colon + 1).trim();
        }
    }
    return undefined;
}

// A single range bytes=start-end, or bytes=-suffix; the whole body when the
// range cannot be satisfied in this form.
function rangeOf(mime: string, body: Buffer, range: string): FileData {
    const match = RANGE.exec(range);
    const size = body.length;
    if (match === null || (match[1] === '' && match[2] === '')) {
        return { status: 200, mime, body };
    }
    const suffix = match[1] === '';
    const start = suffix ? Math.max(size - Number(match[2]), 0) : Number(match[1]);
    const end = suffix || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start > end) {
        return { status: 200, mime, body };
    }
    return {
        status: 206,
        mime,
        body: body.subarray(start, end + 1),
        contentRange: `bytes ${start}-${end}/${size}`,
    };
}

function compareNames(one: string, other: string): number {
    if (one < other) {
        return -1;
    }
    if (one > other) {
        return 1;
    }
    return 0;
}

export default { contextTree, resolvePath, readFile };
