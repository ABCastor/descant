// One causal authority for actions on shared reader threads. Original comments
// and create receipts are immutable; Git acknowledgement is a later boundary.
import { mayRead, readerThreadsByIds, type Env, type Person, type Thread } from './store.ts';
import { json, sameSite } from './web.ts';
import { isWriter } from './writers.ts';
import { ARTICLE_RE, PER_MINUTE, PER_DAY, readerMessage } from './rules.ts';
import { randomId, sha256Hex } from './session.ts';
export const REACTIONS = ['agree']; // the only reaction: a question is asked better as a reply
export interface Actor { kind: 'reader'|'founder-capability'; id: string }
interface Event { seq:number; id:string; actorKey:string; opId:string; requestHash:string; request:string; actor:string; target:string; threadId:number; path:string; slot:string; resultRev:number; state:string; created:string; gitDurable:number }
// JSON property order is transport detail, not a different operation.
const canonical = (v:any):any => Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
// Receipts retain the whole request, including extension fields and object keys.
// Reject values that JSON serialization or the UTF-8 Git importer would change.
function validActionJSON(value:any):boolean {
 const pending=[value];
 while(pending.length) {
  const v=pending.pop();
  if(typeof v==='string' && /[\uD800-\uDFFF]/u.test(v) || typeof v==='number' && !Number.isFinite(v))return false;
  if(v && typeof v==='object') {
   if(Array.isArray(v))pending.push(...v);
   else for(const [key,item] of Object.entries(v)) {if(/[\uD800-\uDFFF]/u.test(key))return false;pending.push(item);}
  }
 }
 return true;
}
const actorKey = (a:Actor) => (a.kind === 'reader' ? 'reader:' : 'founder:') + a.id;
const receipt = (e:Event, withRequest=true) => ({opId:e.opId,...(withRequest?{request:JSON.parse(e.request)}:{}),resultRev:e.resultRev,authority:'descant',gitDurable:!!e.gitDurable});
async function accessEpoch(env:Env, id:string, path:string) {
 const r=await env.DB.prepare('SELECT epoch FROM grant_generations WHERE personId=? AND path=?').bind(id,path).first<{epoch:number}>();
 return r?String(r.epoch):'';
}
export async function metadata(env:Env, actor:Actor, path:string) {
 const {results}=await env.DB.prepare('SELECT * FROM comment_actions WHERE actorKey=? AND path=? ORDER BY seq').bind(actorKey(actor),path).all<Event>();
 return {version:1,authority:'descant',actor,accessEpoch:actor.kind==='reader'?await accessEpoch(env,actor.id,path):'founder',reactionKeys:REACTIONS,receipts:results.map(e=>receipt(e))};
}
export type ActionSlotMap = Map<string,{rev:number;state:string}>;
export function actionSlotRows(thread:Thread,known:ActionSlotMap):[number,string,string][] {
 const t=thread as any, rows:[number,string,string][]=[];
 if(!known.has('status')) rows.push([Number(t.id),'status',JSON.stringify({done:t.done,status:t.status})]);
 for(const m of [t,...t.replies]) if(m.messageRef&&!known.has('message:'+m.messageRef)) rows.push([Number(t.id),'message:'+m.messageRef,JSON.stringify({text:m.text,withdrawn:false,original:{messageRef:m.messageRef,kind:m===t?'thread':'reply',text:m.text,author:m.author,by:m.by,created:m.created}})]);
 return rows;
}
function applyActions(t:any, slots:ActionSlotMap, actor?:Actor, immutableLegacy=false):void {
 const messages=[t,...t.replies], rows=[...slots.entries()].map(([slot,r])=>({slot,rev:r.rev,state:r.state}));
 const status=slots.get('status')!; Object.assign(t,JSON.parse(status.state)); t.statusActions={rev:status.rev,canResolve:actor?.kind==='founder-capability'};
 for(const m of messages) {
  if(!m.messageRef) continue;
  const row=slots.get('message:'+m.messageRef); if(!row) continue;
  const state=JSON.parse(row.state); const reactions:any={};
  for(const key of REACTIONS) {
   const own=actor && slots.get('reaction:'+m.messageRef+':'+actorKey(actor)+':'+key);
   const prefix='reaction:'+m.messageRef+':';
   const count=rows.filter(r=>r.slot.startsWith(prefix)&&r.slot.endsWith(':'+key)&&JSON.parse(r.state).active).length;
   reactions[key]={count,active:own?!!JSON.parse(own.state).active:false,rev:own?.rev??0};
  }
  const owns=!!actor && m.writer === actorKey(actor) && m.by==='human';
  m.actions={messageRef:m.messageRef,rev:row.rev,withdrawn:state.withdrawn,permissions:{edit:owns,withdraw:owns,react:!!actor},reactions};
  m.text=state.withdrawn?'Comment withdrawn.':state.text;
 }
 if(!immutableLegacy && t.legacyMessages) t.legacyMessages=t.legacyMessages.filter((m:any)=>(slots.get('message:'+m.commentId)?.rev??0)===0);
}
export async function projectActions(thread:Thread, actor:Actor|undefined, immutableLegacy:boolean, slots:ActionSlotMap):Promise<Thread> {
 if(!actor&&!slots.size)return thread;
 applyActions(thread,slots,actor,immutableLegacy);
 return thread;
}
export async function actionRoute(req:Request,env:Env,actor:Actor,person?:Person):Promise<Response> {
 if(actor.kind==='reader' && (!sameSite(req)||req.headers.get('Content-Type')?.split(';')[0]!=='application/json')) return json({ok:false,reason:'cross-site'},403);
 let b:any;try {const raw=await req.text();if(raw.length>24000)throw Error();b=JSON.parse(raw);if(!validActionJSON(b))throw Error();}catch{return json({ok:false,reason:'bad-request'},400);}
 if(!b||!ARTICLE_RE.test(b.path)||!/^\d{1,16}$/.test(b.threadId)||!/^[-A-Za-z0-9_]{1,100}$/.test(b.opId)||!Number.isSafeInteger(b.baseRev)||b.baseRev<0||!['edit','withdraw','restore','reaction','resolve','reopen'].includes(b.action))return json({ok:false,reason:'bad-request'},400);
 if(actor.kind==='reader' && b.reviewer_id!==actor.id)return json({ok:false,reason:'reviewer-identity-mismatch'},403);
 const key=actorKey(actor), hash=await sha256Hex(JSON.stringify(canonical(b)));
 const prior=await env.DB.prepare('SELECT * FROM comment_actions WHERE actorKey=? AND opId=?').bind(key,b.opId).first<Event>();
 const permitted=actor.kind==='reader'?!!(await mayRead(env.DB,actor.id,b.path)):!!(await env.DB.prepare('SELECT key FROM founders WHERE key=?').bind(actor.id).first());
 if(prior){if(prior.requestHash!==hash)return json({ok:false,reason:'operation-conflict'},409);if(!permitted)return json({ok:true,receipt:receipt(prior,false)});}
 if(!permitted)return json({ok:false,reason:'not-allowed'},403);
 const owner=await env.DB.prepare('SELECT personId FROM threads WHERE id=? AND path=?').bind(Number(b.threadId),b.path).first<{personId:string}>();
 if(!owner || actor.kind==='reader'&&owner.personId!==actor.id)return json({ok:false,reason:'not-allowed'},403);
 const current=(await readerThreadsByIds(env.DB,b.path,[Number(b.threadId)],actor)).find(t=>t.id===b.threadId) as any;
 if(!current)return json({ok:false,reason:'not-allowed'},403);
 const acknowledged=async(e:Event)=>{
  const stillPermitted=actor.kind==='reader'?!!await mayRead(env.DB,actor.id,b.path):!!await env.DB.prepare('SELECT key FROM founders WHERE key=?').bind(actor.id).first();
  return json({ok:true,receipt:receipt(e,stillPermitted),...(stillPermitted?{thread:(await readerThreadsByIds(env.DB,b.path,[Number(b.threadId)],actor)).find(t=>t.id===b.threadId)}:{})});
 };
 if(prior)return acknowledged(prior);
 const epoch=actor.kind==='reader'?await accessEpoch(env,actor.id,b.path):'founder';
 if(b.accessEpoch!==epoch)return json({ok:false,reason:'access-generation-changed'},403);
 const status=b.action==='resolve'||b.action==='reopen';
 const message=[current,...current.replies].find(m=>m.actions?.messageRef===b.messageRef);
 if(status && actor.kind!=='founder-capability'||!status&&!message)return json({ok:false,reason:'not-allowed'},403);
 if(!status&&b.action!=='reaction'&&!message.actions.permissions.edit)return json({ok:false,reason:'not-allowed'},403);
 if(b.action==='reaction'&&(!REACTIONS.includes(b.reaction)||typeof b.active!=='boolean'))return json({ok:false,reason:'bad-request'},400);
 let text:string|undefined;try{if(b.action==='edit')text=readerMessage(b.text);}catch{return json({ok:false,reason:'bad-request'},400);}
 const slot=status?'status':b.action==='reaction'?'reaction:'+b.messageRef+':'+key+':'+b.reaction:'message:'+b.messageRef;
 const initial=b.action==='reaction'?JSON.stringify({active:false}):actionSlotRows(current,new Map()).find(r=>r[1]===slot)?.[2];
 if(!initial)return json({ok:false,reason:'not-allowed'},403);
 await env.DB.prepare('INSERT OR IGNORE INTO comment_action_slots(threadId,slot,rev,state) VALUES(?,?,0,?)').bind(Number(b.threadId),slot,initial).run();
 const old=await env.DB.prepare('SELECT rev,state FROM comment_action_slots WHERE threadId=? AND slot=?').bind(Number(b.threadId),slot).first<{rev:number;state:string}>();
 if(!old||old.rev!==b.baseRev)return json({ok:false,reason:'stale-action',thread:current},409);
 let next=JSON.parse(old.state);
 let target:any=null;
 if(!status){
  const original=await env.DB.prepare('SELECT id,kind,text,name,created FROM comments WHERE id=? AND threadId=?').bind(b.messageRef,Number(b.threadId)).first<{id:string;kind:string;text:string;name:string;created:string}>();
  if(original){
   const same=await env.DB.prepare('SELECT id FROM comments WHERE threadId=? AND kind=? AND text=? AND name=? AND created=? ORDER BY seq').bind(Number(b.threadId),original.kind,original.text,original.name,original.created).all<{id:string}>();
   target={messageRef:original.id,kind:original.kind,text:original.text,author:original.name,by:'human',created:original.created,matchingIds:same.results.map(r=>r.id)};
  }else{
   const rootState=await env.DB.prepare('SELECT state FROM comment_action_slots WHERE threadId=? AND slot=?').bind(Number(b.threadId),'message:'+b.messageRef).first<{state:string}>();
   target=rootState?JSON.parse(rootState.state).original:JSON.parse(actionSlotRows(current,new Map()).find(r=>r[1]==='message:'+b.messageRef)?.[2]||'{}').original||null;
  }
 }
 if(status)next={done:b.action==='resolve',status:b.action==='resolve'?'answered':'open'};
 else if(b.action==='reaction')next={active:b.active};
 else if(b.action==='edit')next={...next,text};
 else next={...next,withdrawn:b.action==='withdraw'};
 const id=randomId('a',16), rev=old.rev+1, stamp=new Date().toISOString();
 // The first INSERT fails its NOT NULL guard if CAS, grant generation or rate
 // limit changed. Both receipt/event and projection update roll back together.
 const access=actor.kind==='reader'?"EXISTS(SELECT 1 FROM grants g JOIN grant_generations x ON x.personId=g.personId AND x.path=g.path JOIN articles a ON a.path=g.path WHERE g.personId=? AND g.path=? AND x.epoch=? AND a.markdown IS NOT NULL)":"EXISTS(SELECT 1 FROM founders WHERE key=?)";
 const args=actor.kind==='reader'?[actor.id,b.path,epoch]:[actor.id];
 try{await env.DB.batch([
 env.DB.prepare(`INSERT INTO comment_actions(id,actorKey,opId,requestHash,request,actor,target,threadId,path,slot,resultRev,state,created) VALUES(?,?,?,?,?,?,?,?,CASE WHEN (SELECT rev FROM comment_action_slots WHERE threadId=? AND slot=?)=? AND ${access} AND (SELECT COUNT(*) FROM comment_actions WHERE actorKey=? AND created>?)<${PER_MINUTE} AND (SELECT COUNT(*) FROM comment_actions WHERE actorKey=? AND created>?)<${PER_DAY} THEN ? ELSE NULL END,?,?,?,?)`).bind(id,key,b.opId,hash,JSON.stringify(b),JSON.stringify(person?{kind:actor.kind,id:actor.id,name:person.name,email:person.email}:actor),JSON.stringify(target),Number(b.threadId),Number(b.threadId),slot,b.baseRev,...args,key,new Date(Date.now()-60000).toISOString(),key,new Date(Date.now()-86400000).toISOString(),b.path,slot,rev,JSON.stringify(next),stamp),
 env.DB.prepare('UPDATE comment_action_slots SET rev=?,state=? WHERE threadId=? AND slot=? AND rev=?').bind(rev,JSON.stringify(next),Number(b.threadId),slot,b.baseRev)
 ]);}catch{
 const raced=await env.DB.prepare('SELECT * FROM comment_actions WHERE actorKey=? AND opId=?').bind(key,b.opId).first<Event>();
 if(raced&&raced.requestHash===hash)return acknowledged(raced);
 if(raced)return json({ok:false,reason:'operation-conflict'},409);
 if(actor.kind==='reader'&&await accessEpoch(env,actor.id,b.path)!==epoch)return json({ok:false,reason:'access-generation-changed'},403);
 if(actor.kind==='reader'&&!await mayRead(env.DB,actor.id,b.path)||actor.kind==='founder-capability'&&!await env.DB.prepare('SELECT key FROM founders WHERE key=?').bind(actor.id).first())return json({ok:false,reason:'not-allowed'},403);
 return json({ok:false,reason:'stale-action',thread:(await readerThreadsByIds(env.DB,b.path,[Number(b.threadId)],actor)).find(t=>t.id===b.threadId)},409);
 }
 const result=await env.DB.prepare('SELECT * FROM comment_actions WHERE id=?').bind(id).first<Event>();
 return acknowledged(result!);
}
export async function actionSync(req:Request,env:Env,url:URL):Promise<Response> {
 if(url.pathname==='/sync/action'&&req.method==='POST'){
  const raw=await req.text();let b:any;try{b=JSON.parse(raw)}catch{return json({ok:false},400)}
  if(!isWriter(env,b.who))return json({ok:false,reason:'not-allowed'},403);
  return actionRoute(new Request(req.url,{method:'POST',headers:req.headers,body:raw}),env,{kind:'founder-capability',id:b.who});
 }
 if(url.pathname==='/sync/actions'&&req.method==='GET'){
  const after=Number(url.searchParams.get('after')??'0');
  if(!Number.isSafeInteger(after)||after<0)return json({ok:false,reason:'bad-cursor'},400);
  const boundary=await env.DB.prepare('SELECT COALESCE(MAX(seq),0) n FROM comment_actions').first<{n:number}>();
  const through=Number(url.searchParams.get('through')??boundary!.n);
  if(!Number.isSafeInteger(through)||through<0)return json({ok:false,reason:'bad-cursor'},400);
  const {results}=await env.DB.prepare('SELECT * FROM comment_actions WHERE gitDurable=0 AND seq>? AND seq<=? ORDER BY seq LIMIT 101').bind(after,through).all<Event>();
  const page=results.slice(0,100);
  return json({actions:page.map(e=>({...e,request:JSON.parse(e.request),actor:JSON.parse(e.actor),target:JSON.parse(e.target),state:JSON.parse(e.state)})),cursor:page.at(-1)?.seq??after,through,more:results.length>100});
 }
 if(url.pathname==='/sync/actions/ack'&&req.method==='POST'){
  let b:any;try{b=await req.json()}catch{return json({ok:false},400)}
  const ids=(Array.isArray(b.stored)?b.stored:[]).slice(0,100).filter((id:unknown)=>typeof id==='string'&&/^a[0-9a-f]{32}$/.test(id));
  if(ids.length)await env.DB.prepare('UPDATE comment_actions SET gitDurable=1 WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).run();
  return json({ok:true});
 }
 if(url.pathname==='/sync/action-state'&&req.method==='GET'){
  const path=url.searchParams.get('path')??'',who=url.searchParams.get('who')??'';
  if(!isWriter(env,who)||!await env.DB.prepare('SELECT key FROM founders WHERE key=?').bind(who).first())return json({ok:false},403);
  const actor:Actor={kind:'founder-capability',id:who};
  const many=url.searchParams.get('threadIds');
  if(many!==null){
   let ids: number[];
   if(many==='all'||many==='*'||many===''){
    const {results:rows}=await env.DB.prepare('SELECT id FROM threads WHERE path=? ORDER BY createdAt, id LIMIT 91').bind(path).all<{id:number}>();
    if(rows.length>90)return json({ok:false,reason:'too-many-threads'},400);
    ids=rows.map(r=>r.id);
   }else{
    ids=[...new Set(many.split(',').filter(x=>/^\d{1,16}$/.test(x)))].map(Number);
    if(!ids.length||ids.length>90)return json({ok:false,reason:'bad-request'},400);
   }
   const found=await readerThreadsByIds(env.DB,path,ids,actor), byId=new Map(found.map(t=>[String(t.id),t]));
   return json({threads:ids.map(n=>({threadId:String(n),thread:byId.get(String(n))??null})),commentActions:await metadata(env,actor,path)});
  }
  const id=url.searchParams.get('threadId')??'';
  if(!/^\d{1,16}$/.test(id))return json({ok:false},404);
  const owner=await env.DB.prepare('SELECT personId FROM threads WHERE id=? AND path=?').bind(Number(id),path).first<{personId:string}>();
  if(!owner)return json({ok:false},404);
  return json({thread:(await readerThreadsByIds(env.DB,path,[Number(id)],actor)).find(t=>t.id===id),commentActions:await metadata(env,actor,path)});
 }
 return json({ok:false},404);
}
