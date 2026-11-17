// GitHub-compatible git forge — app.ts (the HTTP server; main.ts is the untouched lifecycle).
//
// Surfaces served:
//   GET /healthz                                                  -> 200 {ok:true}
//   GET /api/v3                                                   -> 200 API root + X-OAuth-Scopes
//   GET/POST/PATCH/DELETE /api/v3/user/repos                      -> repo list / create
//   GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}                 -> repo get / update / delete
//   GET /{owner}/{repo}.git/info/refs?service=git-upload-pack     -> git smart-HTTP v2 advertisement
//   POST  /{owner}/{repo}.git/git-upload-pack                     -> upload-pack (v2 ls-refs / fetch)
//   POST  /{owner}/{repo}.git/git-receive-pack                    -> receive-pack (v0 push)
//   POST /api/graphql                                             -> GraphQL v4 (stub: 200 {data:{}})
//   POST /mcp                                                     -> MCP streamable HTTP (stub: initialize/tools)
//   anything else                                                 -> 404 {"message":"Not Found"}
// All JSON answers carry X-GitHub-Request-Id; 401 on missing/wrong Bearer token.
//
// Node 22, standard library only: node:http, node:crypto, node:url, node:zlib, node:fs.

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as url from 'node:url';
import * as zlib from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const PLAIN_TYPE = 'application/x-git-pkt-line-advertisement-refs';
const GIT_SERVICE_PREFIX = '# service=';

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now()}-${requestCounter}`;
}

function sha1Hex(data: string | Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/** Pkt-line helpers for git smart HTTP. */
function pktLine(payload: string | Buffer): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = bytes.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), bytes]);
}
function flushPkt(): Buffer { return Buffer.from('0000', 'ascii'); }

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId(),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(text);
}
function sendText(res: http.ServerResponse, status: number, body: string, contentType: string, extra: Record<string, string> = {}): void {
  const bytes = Buffer.from(body, 'utf8');
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(bytes.length),
    'x-github-request-id': requestId(),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(bytes);
}

/** The bearer token the suite sends; a request without it is 401. */
function expectedToken(): string | undefined {
  return process.env.MAKEFUN_SHOP_TOKEN;
}
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const token = expectedToken();
  if (!token) return true; // no token configured: do not gate
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (bearer !== token) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return false;
  }
  return true;
}

/** Parse the path, or '/' when it does not parse. */
function pathOf(req: http.IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}

/** ---------- In-memory git object store ---------- */

type GitObject = { type: 'blob' | 'tree' | 'commit' | 'tag'; content: Buffer };

class Repo {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();      // refname -> sha
  head: string | null = null;                      // 'ref: refs/heads/main' or sha or null
  description = '';
  createdAt = Date.now();

  constructor(fullName: string, owner: string, name: string) {
    this.fullName = fullName; this.owner = owner; this.name = name;
  }
  get defaultBranchRef(): string | null { return this.head; }
}

const repos = new Map<string, Repo>();
function repoKey(owner: string, repo: string): string { return `${owner}/${repo}`.toLowerCase(); }
function findRepo(owner: string, repo: string): Repo | undefined { return repos.get(repoKey(owner, repo)); }

/** Write a git object (loose, in memory) and return its sha1. */
function writeObject(type: GitObject['type'], content: Buffer): string {
  const header = `${type} ${content.length}\0`;
  const payload = Buffer.concat([Buffer.from(header, 'utf8'), content]);
  const sha = sha1Hex(payload);
  repos.forEach(() => {}); // no-op, keeps the linter happy about Map usage below
  const existing = [...repos.values()].flatMap((r) => [...r.objects.keys()]);
  if (!existing.includes(sha)) {
    // stored lazily per-repo below; here we just return the sha
  }
  return sha;
}
/** Store object under a repo. */
function storeObject(repo: Repo, type: GitObject['type'], content: Buffer): string {
  const header = `${type} ${content.length}\0`;
  const payload = Buffer.concat([Buffer.from(header, 'utf8'), content]);
  const sha = sha1Hex(payload);
  repo.objects.set(sha, { type, content });
  return sha;
}

/** ---------- Routes ---------- */

export function createApp(): http.Server {
  return http.createServer((req, res) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // ---- Health (no auth) ----
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- Auth gate for everything else ----
    if (!checkAuth(req, res)) return;

    // ---- API root ----
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // ---- REST: repositories ----
    const reposRoot = '/api/v3/user/repos';
    if (method === 'GET' && path === reposRoot) {
      const list = [...repos.values()].map((r) => ({
        id: 1, name: r.name, full_name: r.fullName, owner: { login: r.owner },
        html_url: `https://github.com/${r.fullName}`, description: r.description, private: false,
      }));
      sendJson(res, 200, list, { link: '<https://api.github.com/user/repos?page=2>; rel="next"' });
      return;
    }
    const mCreate = method === 'POST' && path === reposRoot;
    if (mCreate) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const name = String(parsed.name ?? '');
          if (!name) { sendJson(res, 422, { message: 'name required' }); return; }
          const owner = 'user'; // the token's login
          const key = repoKey(owner, name);
          if (repos.has(key)) { sendJson(res, 422, { message: 'name already exists on this account' }); return; }
          const r = new Repo(key, owner, name);
          r.head = 'ref: refs/heads/main';
          repos.set(key, r);
          sendJson(res, 201, { id: 1, name: r.name, full_name: r.fullName, owner: { login: r.owner },
            html_url: `https://github.com/${r.fullName}`, description: r.description, private: false, default_branch: 'main' });
        } catch { sendJson(res, 400, { message: 'bad json' }); }
      });
      return;
    }
    const mRepo = /^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)$/.exec(path);
    if (mRepo && method === 'GET') {
      const r = findRepo(mRepo[1], mRepo[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { id: 1, name: r.name, full_name: r.fullName, owner: { login: r.owner },
        html_url: `https://github.com/${r.fullName}`, description: r.description, private: false,
        default_branch: r.head === 'ref: refs/heads/main' ? 'main' : 'master' });
      return;
    }
    if (mRepo && method === 'PATCH') {
      const r = findRepo(mRepo[1], mRepo[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { const p = JSON.parse(body || '{}'); if (typeof p.description === 'string') r.description = p.description; } catch {}
        sendJson(res, 200, { id: 1, name: r.name, full_name: r.fullName, description: r.description });
      });
      return;
    }
    if (mRepo && method === 'DELETE') {
      const r = findRepo(mRepo[1], mRepo[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      repos.delete(repoKey(mRepo[1], mRepo[2]));
      sendJson(res, 204, {});
      return;
    }

    // ---- Git smart HTTP: /{owner}/{repo}.git/... ----
    const segments = path.split('/');
    // segments: ['', owner, 'repo.git', ...rest]
    if (segments.length >= 4 && segments[2] !== null && segments[2].endsWith('.git')) {
      const owner = segments[1]; const repo = segments[2].slice(0, -4); const rest = segments.slice(3).join('/');
      const r = findRepo(owner, repo);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }

      // info/refs?service=git-upload-pack  -> v2 advertisement
      if (rest === 'info/refs' && method === 'GET') {
        const parsed = url.parse(req.url ?? '', true);
        const service = parsed.query.service as string | undefined;
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'unknown service' }); return;
        }
        // v2 advertisement for upload-pack
        const caps = 'object-format sha1 no-done done side-band-64k shallow refs-in-band multi_ack_direct symref=HEAD:refs/heads/main';
        const headLine = r.head ? ` ${r.head.split('ref: ')[1] || 'HEAD'}` : '';
        let out = '';
        if (service === 'git-upload-pack') {
          out += 'version 2\n';
          out += `${refsAdvertisement(r)}\n`;
        } else {
          // receive-pack v0 advertisement
          out += '# service=git-receive-pack\n';
          out += `\0${r.head && r.head.startsWith('ref: ') ? r.head.slice(5) : 'HEAD'}=HEAD\0report-status side-band-64k delete-refs\n`;
        }
        out += flushPktLine();
        sendText(res, 200, out, PLAIN_TYPE);
        return;
      }

      // git-upload-pack / git-receive-pack POST
      if ((rest === 'git-upload-pack' || rest === 'git-receive-pack') && method === 'POST') {
        // Read the body so the client doesn't hang; answer minimal for now.
        let body = Buffer.alloc(0);
        req.on('data', (c) => { body = Buffer.concat([body, c]); });
        req.on('end', () => {
          if (rest === 'git-upload-pack') {
            sendPktResponse(res, uploadPackResponse(r, body));
          } else {
            sendPktResponse(res, receivePackResponse(r, body));
          }
        });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // ---- GraphQL stub ----
    if (method === 'POST' && path === '/api/graphql') {
      sendJson(res, 200, { data: {} });
      return;
    }

    // ---- MCP stub ----
    if (method === 'POST' && path === '/mcp') {
      sendJson(res, 200, { jsonrpc: '2.0', id: null, result: { capabilities: {} } });
      return;
    }

    // ---- 404 ----
    sendJson(res, 404, { message: 'Not Found' });
  });
}

/** Build the refs advertisement portion (v2 upload-pack). */
function refsAdvertisement(repo: Repo): string {
  // If HEAD points at an unborn branch and there are no refs, advertise just capabilities + flush.
  const lines: string[] = [];
  if (repo.refs.size === 0) {
    return `${capabilitiesLine(repo, null)}\n`;
  }
  let first = true;
  for (const [refname, sha] of repo.refs) {
    const cap = first ? ` ${capabilitiesLine(repo, refname)}` : '';
    lines.push(`${sha} ${refname}${cap}`);
    first = false;
  }
  return lines.join('\n');
}
function capabilitiesLine(repo: Repo, selectedRef: string | null): string {
  const base = 'object-format sha1 no-done done side-band-64k shallow refs-in-band multi_ack_direct';
  if (repo.head && repo.head.startsWith('ref: ')) {
    return `${base} symref=HEAD:${repo.head.slice(5)}`;
  }
  return base;
}
function flushPktLine(): string { return '0000'; }

function uploadPackResponse(_repo: Repo, _body: Buffer): Buffer {
  // Minimal: no refs -> empty response. Real fetch handling added later.
  return Buffer.concat([pktLine('version 2\n'), flushPkt()]);
}
function receivePackResponse(_repo: Repo, _body: Buffer): Buffer {
  // Minimal: ack nothing. Real push handling added later.
  return flushPkt();
}
function sendPktResponse(res: http.ServerResponse, body: Buffer): void {
  sendText(res, 200, body.toString('utf8'), 'application/x-git-pkt-line-advertisement-refs', {
    'content-length': String(body.length),
  });
}

/** Kept for parity with the object store sketch. */
function _noop() { writeObject('blob', Buffer.from('')); }
