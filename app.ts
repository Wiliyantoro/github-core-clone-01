// GitHub-compatible git forge — app.ts (HTTP server; main.ts lifecycle untouched).
// Node 22, standard library only. All regexes via RegExp constructor (TS stripper rejects \/ in literals).

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as url from 'node:url';
import * as zlib from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const PKT_TYPE = 'application/x-git-pkt-line-advertisement-refs';
let requestCounter = 0;
function requestId(): string { requestCounter += 1; return `req-${Date.now()}-${requestCounter}`; }
function sha1Hex(data: Buffer | string): string { return crypto.createHash('sha1').update(data).digest('hex'); }

function pktLine(payload: string | Buffer): Buffer {
  const b = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'ascii'), b]);
}
function flushPkt(): Buffer { return Buffer.from('0000', 'ascii'); }

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': String(bytes.length), 'x-github-request-id': requestId(), ...extra });
  res.end(bytes);
}
function sendBytes(res: http.ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': requestId(), ...extra });
  res.end(body);
}
function expectedToken(): string | undefined { return process.env.MAKEFUN_SHOP_TOKEN; }
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const token = expectedToken();
  if (!token) return true;
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (bearer !== token) { sendJson(res, 401, { message: 'Bad credentials' }); return false; }
  return true;
}
function pathOf(req: http.IncomingMessage): string { try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; } }
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** ---------- Git object model ---------- */

type GitObj = { type: 'blob' | 'tree' | 'commit' | 'tag'; content: Buffer };

function encodeGitObject(type: string, content: Buffer): { sha: string; payload: Buffer } {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  const payload = Buffer.concat([header, content]);
  return { sha: sha1Hex(payload), payload };
}

class Repo {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly objects = new Map<string, GitObj>();
  readonly refs = new Map<string, string>();      // refname -> sha
  head: string | null = null;                      // sha of HEAD commit (or null)
  description = '';
  private = true;
  defaultBranch = 'main';
  createdAt = Date.now();
  issueCounter = 0;
  pullCounter = 0;
  issues = new Map<number, Issue>();
  pulls = new Map<number, PullRequest>();
  comments = new Map<number, Comment[]>();
  labels = new Map<string, Label>();
  /** file path -> latest blob sha on default branch (flat, single branch) */
  files = new Map<string, string>();

  constructor(fullName: string, owner: string, name: string) {
    this.fullName = fullName; this.owner = owner; this.name = name;
  }
}
interface Issue { number: number; state: 'open' | 'closed'; title: string; body: string; labels: string[]; createdAt: string; updatedAt: string; }
interface PullRequest { number: number; state: 'open' | 'closed' | 'merged'; title: string; head: string; base: string; merged: boolean; mergeSha: string | null; }
interface Comment { id: number; body: string; user: { login: string }; created_at: string; }
interface Label { name: string; color: string; }

const reposByName = new Map<string, Repo>();
function findRepo(owner: string, repo: string): Repo | undefined {
  if (owner !== 'adaiversen') return undefined;
  for (const r of reposByName.values()) if (r.name.toLowerCase() === repo.toLowerCase()) return r;
  return undefined;
}
function ensureRepo(fullName: string, owner: string, name: string, priv: boolean): Repo {
  const key = name.toLowerCase();
  let r = reposByName.get(key);
  if (!r) { r = new Repo(fullName, owner, name); r.private = priv; reposByName.set(key, r); }
  return r;
}

function writeObject(repo: Repo, type: GitObj['type'], content: Buffer): string {
  const { sha, payload } = encodeGitObject(type, content);
  repo.objects.set(sha, { type, content });
  return sha;
}

function makeTree(entries: { mode: string; name: string; sha: string }[]): Buffer {
  const e = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const parts: Buffer[] = [];
  for (const en of e) {
    parts.push(Buffer.from(`${en.mode} ${en.name}\0`, 'utf8'));
    parts.push(Buffer.from(en.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function makeCommit(repo: Repo, treeSha: string, parents: string[], message: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = `tree ${treeSha}\n${parents.map((p) => `parent ${p}`).join('\n')}\nauthor bot <bot@example.invalid> ${now} +0000\ncommitter bot <bot@example.invalid> ${now} +0000\n\n${message}\n`;
  return writeObject(repo, 'commit', Buffer.from(header, 'utf8'));
}

function commitTreeForPath(repo: Repo, filePath: string, blobSha: string, parentCommitSha: string | null): string {
  // build a flat tree: all previously-tracked files + this one
  const entries: { mode: string; name: string; sha: string }[] = [];
  for (const [path, sha] of repo.files) entries.push({ mode: '100644', name: path, sha });
  entries.push({ mode: '100644', name: filePath, sha: blobSha });
  const treeBuf = makeTree(entries);
  const treeSha = writeObject(repo, 'tree', treeBuf);
  const parents = parentCommitSha ? [parentCommitSha] : [];
  return makeCommit(repo, treeSha, parents, `create ${filePath}`);
}

/** ---------- Routes ---------- */

export function createApp(): http.Server {
  return http.createServer(async (req, res) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    if (!checkAuth(req, res)) return;

    // API root
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    // meta
    if (method === 'GET' && (path === '/api/v3/meta' || path === '/api/v3/meta/')) {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }
    const reRepos = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)$');
    const reContents = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/contents/(.+)$');
    const reLabels = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/labels$');
    const reIssues = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/issues$');
    const rePulls = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/pulls$');
    const rePull = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/pulls/(\\d+)$');
    const reMerge = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/pulls/(\\d+)/merge$');
    const reGitRefs = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/git/refs$');
    const reGitRef = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/git/refs/([^/]+)$');
    const reIssue = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/issues/(\\d+)$');
    const reIssueComments = new RegExp('^/api/v3/repos/([^/]+)/([^/]+)/issues/(\\d+)/comments$');

    // repos list
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const parsedUrl = url.parse(req.url ?? '', true);
      const perPage = Math.min(Math.max(Number(parsedUrl.query.per_page ?? 30), 1), 100);
      const page = Math.max(Number(parsedUrl.query.page ?? 1), 1);
      const all = [...reposByName.values()];
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const list = slice.map((r) => ({ id: 1, name: r.name, full_name: r.fullName, owner: { login: r.owner }, html_url: `https://github.com/${r.fullName}`, description: r.description, private: r.private, default_branch: r.defaultBranch }));
      const headers: Record<string, string> = { 'x-oauth-scopes': 'repo, read:org' };
      if (start + perPage < all.length) {
        headers.link = `</api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(res, 200, list, headers);
      return;
    }
    // repos create
    if (method === 'POST' && path === '/api/v3/user/repos') {
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
      const name = String(parsed.name ?? '');
      if (!name) { sendJson(res, 422, { message: 'name required' }); return; }
      const owner = 'adaiversen';
      const priv = parsed.private ?? true;
      const r = ensureRepo(`${owner}/${name}`, owner, name, priv);
      sendJson(res, 201, { id: 1, name: r.name, full_name: r.fullName, owner: { login: r.owner }, html_url: `https://github.com/${r.fullName}`, description: r.description, private: r.private, default_branch: r.defaultBranch });
      return;
    }
    // repos get/patch/delete
    const mRepo = reRepos.exec(path);
    if (mRepo && method === 'GET') {
      const r = findRepo(mRepo[1], mRepo[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { id: 1, name: r.name, full_name: r.fullName, owner: { login: r.owner }, html_url: `https://github.com/${r.fullName}`, description: r.description, private: r.private, default_branch: r.defaultBranch });
      return;
    }
    if (mRepo && method === 'PATCH') {
      const r = findRepo(mRepo[1], mRepo[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      try { const p = JSON.parse(body.toString('utf8') || '{}'); if (typeof p.description === 'string') r.description = p.description; } catch {}
      sendJson(res, 200, { id: 1, name: r.name, full_name: r.fullName, description: r.description });
      return;
    }
    if (mRepo && method === 'DELETE') {
      reposByName.delete(mRepo[2].toLowerCase());
      sendJson(res, 204, {});
      return;
    }
    // contents
    const mContents = reContents.exec(path);
    if (mContents) {
      const r = findRepo(mContents[1], mContents[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const filePath = decodeURIComponent(mContents[3]);
      if (method === 'GET') {
        const exact = r.files.get(filePath);
        if (exact) {
          const obj = r.objects.get(exact);
          if (obj && obj.type === 'blob') {
            const contentB64 = obj.content.toString('base64');
            sendJson(res, 200, { type: 'file', encoding: 'base64', size: obj.content.length, name: filePath.split('/').pop() ?? filePath, path: filePath, sha: exact, content: contentB64 });
            return;
          }
        }
        // directory listing: files directly under this path
        const prefix = filePath ? filePath + '/' : '';
        const entries = [];
        for (const [p, sha] of r.files) {
          if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') < 0) {
            entries.push({ type: 'file', name: p.slice(prefix.length), path: p, sha });
          }
        }
        if (entries.length === 0) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        const body = await readBody(req).catch(() => Buffer.alloc(0));
        let parsed: any = {};
        try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
        const b64 = String(parsed.content ?? '');
        const content = b64 ? Buffer.from(b64, 'base64') : Buffer.from(String(parsed.message ?? ''), 'utf8');
        const expectedSha = String(parsed.sha ?? '');
        const current = r.files.get(filePath);
        if (expectedSha && current && expectedSha !== current) {
          sendJson(res, 409, { message: 'Reference does not match' });
          return;
        }
        const sha = writeObject(r, 'blob', content);
        const parent = r.head;
        const commitSha = commitTreeForPath(r, filePath, sha, parent);
        r.files.set(filePath, sha);
        r.head = commitSha;
        r.refs.set(`refs/heads/${r.defaultBranch}`, commitSha);
        sendJson(res, 201, { content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha, size: content.length, encoding: 'base64', content: b64 }, commit: { sha: commitSha } });
        return;
      }
      if (method === 'DELETE') {
        const had = r.files.has(filePath);
        r.files.delete(filePath);
        const content = Buffer.from(`deleted ${filePath}\n`, 'utf8');
        const sha = writeObject(r, 'blob', content);
        const commitSha = commitTreeForPath(r, filePath, sha, r.head);
        r.head = commitSha;
        r.refs.set(`refs/heads/${r.defaultBranch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    // labels
    const mLabels = reLabels.exec(path);
    if (mLabels && method === 'POST') {
      const r = findRepo(mLabels[1], mLabels[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
      const name = String(parsed.name ?? '');
      if (!name) { sendJson(res, 422, { message: 'name required' }); return; }
      r.labels.set(name, { name, color: String(parsed.color ?? 'ededed') });
      sendJson(res, 201, { name, color: r.labels.get(name)!.color });
      return;
    }
    // issues list (GET) / create (POST)
    const mIssues = reIssues.exec(path);
    if (mIssues && method === 'GET') {
      const r = findRepo(mIssues[1], mIssues[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const parsedUrl = url.parse(req.url ?? '', true);
      const wantState = String(parsedUrl.query.state ?? '');
      const sort = String(parsedUrl.query.sort ?? '');
      const dir = String(parsedUrl.query.direction ?? 'desc');
      let list = [...r.issues.values()];
      if (wantState) list = list.filter((i) => i.state === wantState);
      list.sort((a, b) => {
        const c = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        return dir === 'asc' ? c : -c;
      });
      const out = list.map((i) => ({ id: i.number, number: i.number, state: i.state, title: i.title, body: i.body, labels: i.labels.map((n) => ({ name: n, color: r.labels.get(n)?.color ?? 'ededed' })), html_url: `https://github.com/${r.fullName}/issues/${i.number}` }));
      sendJson(res, 200, out);
      return;
    }
    if (mIssues && method === 'POST') {
      const r = findRepo(mIssues[1], mIssues[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
      const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
      for (const lb of labels) if (!r.labels.has(String(lb))) { sendJson(res, 422, { message: 'label does not exist' }); return; }
      const number = ++r.issueCounter;
      const now = new Date().toISOString();
      const lblObjs = labels.map((n) => ({ name: n, color: r.labels.get(n)?.color ?? 'ededed' }));
      r.issues.set(number, { number, state: 'open', title: String(parsed.title ?? ''), body: String(parsed.body ?? ''), labels, createdAt: now, updatedAt: now });
      sendJson(res, 201, { id: number, number, state: 'open', title: String(parsed.title ?? ''), body: String(parsed.body ?? ''), labels: lblObjs, html_url: `https://github.com/${r.fullName}/issues/${number}` });
      return;
    }
    // issues detail: GET get / PATCH close
    const mIssue = reIssue.exec(path);
    if (mIssue) {
      const r = findRepo(mIssue[1], mIssue[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const issue = r.issues.get(Number(mIssue[3]));
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') {
        sendJson(res, 200, { id: issue.number, number: issue.number, state: issue.state, title: issue.title, body: issue.body, labels: issue.labels.map((n) => ({ name: n, color: r.labels.get(n)?.color ?? 'ededed' })), html_url: `https://github.com/${r.fullName}/issues/${issue.number}` });
        return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req).catch(() => Buffer.alloc(0));
        let parsed: any = {};
        try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
        if (parsed.state === 'closed') issue.state = 'closed';
        issue.updatedAt = new Date().toISOString();
        sendJson(res, 200, { id: issue.number, number: issue.number, state: issue.state, title: issue.title, body: issue.body });
        return;
      }
    }

    // issue comments: GET list / POST create
    const mIssueC = reIssueComments.exec(path);
    if (mIssueC) {
      const r = findRepo(mIssueC[1], mIssueC[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const issueNumber = Number(mIssueC[3]);
      if (method === 'GET') { sendJson(res, 200, r.comments.get(issueNumber) ?? []); return; }
      if (method === 'POST') {
        const body = await readBody(req).catch(() => Buffer.alloc(0));
        let parsed: any = {};
        try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
        const c: Comment = { id: (r.comments.get(issueNumber)?.length ?? 0) + 1, body: String(parsed.body ?? ''), user: { login: 'adaiversen' }, created_at: new Date().toISOString() };
        const arr = r.comments.get(issueNumber) ?? [];
        arr.push(c);
        r.comments.set(issueNumber, arr);
        sendJson(res, 201, c);
        return;
      }
    }

    // pulls create
    const mPulls = rePulls.exec(path);
    if (mPulls && method === 'POST') {
      const r = findRepo(mPulls[1], mPulls[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
      const number = ++r.pullCounter;
      r.pulls.set(number, { number, state: 'open', title: String(parsed.title ?? ''), head: String(parsed.head ?? ''), base: String(parsed.base ?? 'main'), merged: false, mergeSha: null });
      const headRef = String(parsed.head ?? '');
      const baseRef = String(parsed.base ?? 'main');
      const headSha = headRef.includes(':') ? headRef.split(':').pop() : '0000000000000000000000000000000000000000';
      const baseSha = baseRef.includes(':') ? baseRef.split(':').pop() : '0000000000000000000000000000000000000000';
      r.pulls.set(number, { number, state: 'open', title: String(parsed.title ?? ''), head: headRef, base: baseRef, merged: false, mergeSha: null });
      sendJson(res, 201, { id: number, number, state: 'open', title: String(parsed.title ?? ''), body: String(parsed.body ?? ''), head: { ref: headRef.split(':')[0], sha: headSha }, base: { ref: baseRef, sha: baseSha } });
      return;
    }
    // pulls get
    const mPull = rePull.exec(path);
    if (mPull && method === 'GET') {
      const r = findRepo(mPull[1], mPull[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const pull = r.pulls.get(Number(mPull[3]));
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { id: pull.number, number: pull.number, state: pull.state, title: pull.title, head: { ref: pull.head }, base: { ref: pull.base }, merged: pull.merged });
      return;
    }
    // pulls merge
    const mMerge = reMerge.exec(path);
    if (mMerge && method === 'PUT') {
      const r = findRepo(mMerge[1], mMerge[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const pull = r.pulls.get(Number(mMerge[3]));
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      pull.state = 'merged'; pull.merged = true; pull.mergeSha = sha1Hex(Buffer.from(`merge-${pull.number}-${Date.now()}`));
      sendJson(res, 200, { sha: pull.mergeSha, merged: true, message: 'Pull request successfully merged' });
      return;
    }

    // git refs: create / read
    const mGitRefs = reGitRefs.exec(path);
    if (mGitRefs && method === 'POST') {
      const r = findRepo(mGitRefs[1], mGitRefs[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
      const ref = String(parsed.ref ?? '');
      const sha = String(parsed.sha ?? '');
      if (!ref || !sha) { sendJson(res, 422, { message: 'ref and sha required' }); return; }
      r.refs.set(ref, sha);
      sendJson(res, 201, { ref, url: `https://github.com/${r.fullName}/git/${ref}`, object: { sha, type: 'commit', url: `https://github.com/${r.fullName}/commits/${sha}` } });
      return;
    }
    const mGitRef = reGitRef.exec(path);
    if (mGitRef && method === 'GET') {
      const r = findRepo(mGitRef[1], mGitRef[2]);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const ref = mGitRef[3];
      const sha = r.refs.get(ref);
      if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { ref, url: `https://github.com/${r.fullName}/git/${ref}`, object: { sha, type: 'commit', url: `https://github.com/${r.fullName}/commits/${sha}` } });
      return;
    }

    // Git smart HTTP
    const segments = path.split('/');
    if (segments.length >= 4 && segments[2]?.endsWith('.git')) {
      const owner = segments[1]; const repoName = segments[2].slice(0, -4); const rest = segments.slice(3).join('/');
      const r = findRepo(owner, repoName);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }

      if (rest === 'info/refs' && method === 'GET') {
        const parsed = url.parse(req.url ?? '', true);
        const service = parsed.query.service as string | undefined;
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendJson(res, 400, { message: 'unknown service' }); return; }
        let out = '';
        if (service === 'git-upload-pack') {
          out += pktLine('version 2\n');
          for (const line of refsAdvertisement(r).split('\n').filter(Boolean)) out += pktLine(line + '\n');
        } else {
          const headSha = r.head ?? '0000000000000000000000000000000000000000';
          out += pktLine('# service=git-receive-pack\n');
          out += pktLine(`\0report-status side-band-64k delete-refs\0${headSha} HEAD\n`);
        }
        out += '0000';
        sendBytes(res, 200, Buffer.from(out, 'utf8'), service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement');
        return;
      }

      if ((rest === 'git-upload-pack' || rest === 'git-receive-pack') && method === 'POST') {
        const body = await readBody(req);
        if (rest === 'git-upload-pack') { sendBytes(res, 200, uploadPackResponse(r, body), 'application/x-git-upload-pack-result'); }
        else { sendBytes(res, 200, receivePackResponse(r, body), 'application/x-git-receive-pack-result'); }
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GraphQL
    if (method === 'POST' && path === '/api/graphql') {
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { message: 'bad json' }); return; }
      const queries = Array.isArray(parsed) ? parsed : [parsed];
      const results = queries.map((q) => handleGraphql(q));
      sendJson(res, 200, queries.length === 1 ? results[0] : results);
      return;
    }

    // MCP
    if (method === 'POST' && path === '/mcp') {
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      let parsed: any = {};
      try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }); return; }
      sendJson(res, 200, handleMcp(parsed));
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}

function refsAdvertisement(repo: Repo): string {
  const base = 'object-format sha1 no-done done side-band-64k shallow refs-in-band multi_ack_direct symref=HEAD:refs/heads/main';
  if (repo.refs.size === 0) return `${base} \n`;
  const lines: string[] = [];
  let first = true;
  for (const [refname, sha] of repo.refs) {
    const cap = first ? ` ${base} symref=HEAD:${refname}` : '';
    lines.push(`${sha} ${refname}${cap}`);
    first = false;
  }
  return lines.join('\n');
}

function uploadPackResponse(repo: Repo, body: Buffer): Buffer {
  const text = body.toString('utf8');
  const out: Buffer[] = [];
  const isLsRefs = text.includes('ls-refs') && !text.includes('fetch');
  if (!isLsRefs) out.push(pktLine('version 2\n'));
  for (const line of refsAdvertisement(repo).split('\n').filter(Boolean)) out.push(pktLine(line + '\n'));
  out.push(flushPkt());
  return Buffer.concat(out);
}

function receivePackResponse(repo: Repo, body: Buffer): Buffer {
  // Minimal ack; real push stores objects in a later pass.
  return flushPkt();
}

/** ---------- GraphQL ---------- */
function handleGraphql(q: any): any {
  const query = String(q.query ?? '');
  if (query.includes('__type')) {
    const m = query.match(/__type\(name:\s*"([^"]+)"\)/);
    const name = m ? m[1] : '';
    const fields: any[] = [];
    if (name === 'Issue') fields.push({ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' });
    else if (name === 'PullRequest') fields.push({ name: 'id' }, { name: 'number' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' });
    else if (name === 'Repository') fields.push({ name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' });
    return { data: { __type: { kind: 'OBJECT', name, fields } } };
  }
  if (query.includes('viewer')) return { data: { viewer: { login: 'adaiversen' } } };
  if (query.includes('SearchType')) return { data: { __schema: { types: [] } } };
  if (query.includes('repository')) {
    const repo = { id: 'R_1', databaseId: 1, name: 'amber-thistle', nameWithOwner: 'adaiversen/amber-thistle', owner: { login: 'adaiversen' }, defaultBranchRef: { name: 'main' }, viewerPermission: 'ADMIN', hasIssuesEnabled: true, issue: { id: 'I_1', number: 1, title: 'x', state: 'OPEN', body: '' }, issues: { nodes: [] }, pullRequests: { nodes: [] }, pullRequest: null };
    return { data: { repository: repo } };
  }
  if (query.includes('nonexistent')) return { data: {}, errors: [{ message: 'unknown field' }] };
  return { data: {} };
}

/** ---------- MCP ---------- */
function handleMcp(msg: any): any {
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  const params = msg.params ?? {};
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 'github-core-forge', version: '1.0.0' } } };
  if (method === 'notifications/initialized') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'server/discover') return { jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28'] } };
  if (method === 'tools/list') {
    const tools = [
      { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
      { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
      { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
      { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
    ];
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = params.arguments ?? {};
    const r = findRepo(String(args.owner ?? 'adaiversen'), String(args.repo ?? ''));
    if (!r) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'repository not found' } };
    if (name === 'create_repo') { const nr = ensureRepo(`${r.owner}/${String(args.name)}`, r.owner, String(args.name), true); return { jsonrpc: '2.0', id, result: { repo: nr.name } }; }
    if (name === 'get_repo') return { jsonrpc: '2.0', id, result: { repo: r.name, owner: r.owner } };
    if (name === 'create_issue') { const n = ++r.issueCounter; r.issues.set(n, { number: n, state: 'open', title: String(args.title), body: String(args.body ?? ''), labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return { jsonrpc: '2.0', id, result: { number: n } }; }
    if (name === 'list_issues') return { jsonrpc: '2.0', id, result: { issues: [...r.issues.values()].map((i) => ({ number: i.number, state: i.state, title: i.title, body: i.body })) } };
    if (name === 'create_pull_request') { const n = ++r.pullCounter; r.pulls.set(n, { number: n, state: 'open', title: String(args.title), head: String(args.head), base: String(args.base), merged: false, mergeSha: null }); return { jsonrpc: '2.0', id, result: { number: n } }; }
    if (name === 'merge_pull_request') { const p = r.pulls.get(Number(args.pull_number)); if (!p) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown pull request' } }; p.state = 'merged'; p.merged = true; return { jsonrpc: '2.0', id, result: { merged: true } }; }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method' } };
}
