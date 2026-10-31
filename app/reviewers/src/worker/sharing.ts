// Article-scoped sharing for the authenticated private-server bridge.
import { makeInvitation } from './admin.ts';
import { ARTICLE_RE, foldEmail, mayShare } from './rules.ts';
import { allArticles, founders, type Env } from './store.ts';
import { json } from './web.ts';

export async function sharing(req: Request, env: Env, url: URL): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 4096) return json({error:'The sharing request is too large.'},413);
  let data: Record<string,unknown>;
  try { data = JSON.parse(raw); } catch { return json({error:'Invalid sharing request.'},400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({error:'Invalid sharing request.'},400);
  const founder = String(data.founder || ''), path = String(data.path || '');
  if (!(await founders(env.DB)).some(f => f.key === founder)) return json({error:'Only a founder can manage sharing.'},403);
  if (!ARTICLE_RE.test(path)) return json({error:'Choose an article to share.'},400);
  const article = (await allArticles(env.DB)).find(a => a.path === path);
  if (!article) return json({error:'This article is not available for sharing yet.'},404);
  const allowed = mayShare(env, founder, article);
  if (data.action === 'invite') {
    if (!allowed) return json({error:'Only the owner can share this article.'},403);
    if (typeof data.label !== 'string' || typeof data.email !== 'string') return json({error:'Enter a name and email address.'},400);
    const made = await makeInvitation(env,url,founder,data.label.replace(/\s+/g,' ').trim(),foldEmail(data.email),[path]);
    if ('problems' in made) return json({error:made.problems.join(' ')},400);
    return json({ok:true,...made});
  }
  if (data.action !== 'read') return json({error:'Unknown sharing action.'},400);
  const [people,invitations] = await Promise.all([
    env.DB.prepare('SELECT p.id,p.name,p.email FROM people p JOIN grants g ON g.personId=p.id WHERE g.path=? ORDER BY p.name').bind(path).all(),
    env.DB.prepare('SELECT i.id,i.label,i.email,i.expiresAt FROM invites i JOIN invite_articles a ON a.inviteId=i.id WHERE a.path=? AND i.revokedAt IS NULL AND i.usesLeft>0 AND i.expiresAt>? ORDER BY i.createdAt DESC').bind(path,new Date().toISOString()).all(),
  ]);
  return json({ok:true,path,mayShare:allowed,people:people.results,invitations:invitations.results});
}
