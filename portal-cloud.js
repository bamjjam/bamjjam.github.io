// My WebApp Studio 5.2 — conflict-aware Firebase synchronization.
// Compatible with the existing /users/{uid}/studio/main document and schema:5 security rule.
// No service-account credentials or GitHub tokens are used in the browser.
const notify = (type, extra = {}) => window.dispatchEvent(new CustomEvent('portal-cloud', {detail: {type, ...extra}}));
const config = window.WEBAPP_FIREBASE_CONFIG;
const configured = !!(config && typeof config === 'object' && ['apiKey','projectId','appId','authDomain'].every(k=>typeof config[k]==='string' && config[k].trim() && !config[k].includes('YOUR_')));
let auth = null, db = null, user = null, offDoc = null, ref = null;
let activeWrites = 0, queue = Promise.resolve();

const clone = x => JSON.parse(JSON.stringify(x));
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = v => Array.isArray(v) ? v : [];
const hasOwn = (obj,key) => Object.prototype.hasOwnProperty.call(obj,key);
const replace = x => ({kind:'replace',value:clone(x)});

// Produce a minimal patch from the last cloud version to this browser's edits.
// Per-project edits are merged; unrelated data from another computer is kept.
function diffSettings(base,changed) {
  base=object(base);changed=object(changed);
  const patch = {};
  for(const key of ['owner','pagesOnly']) if(!equal(base[key],changed[key])&&hasOwn(changed,key)) patch[key]=replace(changed[key]);
  for(const key of ['favorites','hidden']) {
    const b=new Set(list(base[key])), c=new Set(list(changed[key]));
    const add=[...c].filter(x=>!b.has(x)), remove=[...b].filter(x=>!c.has(x));
    if(add.length||remove.length)patch[key]={kind:'set',add,remove};
  }
  for(const key of ['edits','editBases','autoMetadata']) {
    const b=object(base[key]),c=object(changed[key]);const changes={};
    for(const id of new Set([...Object.keys(b),...Object.keys(c)])) {
      if(equal(b[id],c[id]))continue;
      if(!hasOwn(c,id))changes[id]={kind:'delete'};
      else if(key==='edits'&&hasOwn(b,id)&&object(c[id])===c[id]){
        const fieldChanges={};
        for(const field of new Set([...Object.keys(object(b[id])),...Object.keys(object(c[id]))])){
          if(equal(b[id]?.[field],c[id]?.[field]))continue;
          fieldChanges[field]=hasOwn(c[id],field)?replace(c[id][field]):{kind:'delete'};
        }
        changes[id]={kind:'fields',changes:fieldChanges};
      }else changes[id]=replace(c[id]);
    }
    if(Object.keys(changes).length)patch[key]={kind:'map',changes};
  }
  const b=new Map(list(base.manual).filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
  const c=new Map(list(changed.manual).filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
  const changes={};
  for(const id of new Set([...b.keys(),...c.keys()])){
    if(equal(b.get(id),c.get(id)))continue;
    changes[id]=c.has(id)?replace(c.get(id)):{kind:'delete'};
  }
  if(Object.keys(changes).length)patch.manual={kind:'manual',changes};
  return patch;
}
function applyPatch(remote,patch){
  const result=clone(object(remote));
  for(const [key,op] of Object.entries(patch)){
    if(op.kind==='replace'){result[key]=clone(op.value);continue;}
    if(op.kind==='set'){
      const set=new Set(list(result[key]));
      for(const v of op.remove)set.delete(v);
      for(const v of op.add)set.add(v);
      result[key]=[...set];
      continue;
    }
    if(op.kind==='map'){
      const current={...object(result[key])};
      for(const [id,change] of Object.entries(op.changes)){
        if(change.kind==='delete')delete current[id];
        else if(change.kind==='fields'){
          const fields={...object(current[id])};
          for(const [name,fieldChange] of Object.entries(change.changes)) {
            if(fieldChange.kind==='delete')delete fields[name];
            else fields[name]=clone(fieldChange.value);
          }
          current[id]=fields;
        }else current[id]=clone(change.value);
      }
      result[key]=current;continue;
    }
    if(op.kind==='manual'){
      const current=new Map(list(result.manual).filter(x=>x&&typeof x.id==='string').map(x=>[x.id,x]));
      for(const [id,change] of Object.entries(op.changes)){
        if(change.kind==='delete')current.delete(id);
        else current.set(id,clone(change.value));
      }
      result.manual=[...current.values()];
    }
  }
  return result;
}
function rebase(remote,base,local) {return applyPatch(remote,diffSettings(base,local));}

const cloud = window.PortalCloud = {
  configured,ready:false,rebase,
  get user(){return user},
  get connected(){return !!user && !!ref},
  async login(){throw new Error('클라우드 초기화 중입니다.')},
  async logout(){throw new Error('클라우드 초기화 중입니다.')},
  async save(){throw new Error('클라우드 초기화 중입니다.')},
  async refresh(){throw new Error('클라우드 초기화 중입니다.')}
};
if (!configured) {cloud.ready=true;notify('unconfigured');}
else {
  Promise.all([
    import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js')
  ]).then(async ([appMod,authMod,dbMod])=>{
    const app=appMod.initializeApp(config);
    auth=authMod.getAuth(app);
    db=dbMod.getFirestore(app);
    const {GoogleAuthProvider,signInWithPopup,signOut,setPersistence,browserLocalPersistence,onAuthStateChanged}=authMod;
    const {doc,onSnapshot,runTransaction,serverTimestamp,getDocFromServer}=dbMod;
    await setPersistence(auth,browserLocalPersistence);
    cloud.ready=true;
    cloud.login=async()=>{await signInWithPopup(auth,new GoogleAuthProvider());};
    cloud.logout=async()=>{await signOut(auth);};
    cloud.refresh=async()=>{
      if(!ref)throw new Error('먼저 Google 계정으로 로그인해 주세요.');
      const snapshot=await getDocFromServer(ref);
      notify('snapshot',{exists:snapshot.exists(),settings:snapshot.exists()?snapshot.data()?.settings:null,user:{uid:user.uid,email:user.email}});
    };
    cloud.save=async (settings,baseline={})=>{
      if(!ref||!user)throw new Error('로그인이 필요합니다.');
      const target=ref, identity=user.uid;
      const patch=diffSettings(clone(baseline),clone(settings));
      activeWrites++;
      notify('saving',{pending:activeWrites});
      const job=queue.catch(()=>{}).then(async()=>runTransaction(db,async transaction=>{
        const snapshot=await transaction.get(target);
        const remote=snapshot.exists()?snapshot.data()?.settings||{}:{};
        const merged=applyPatch(remote,patch);
        // If it is a first-time save, create schema:5 even for default settings.
        if(!snapshot.exists()||Object.keys(patch).length){
          transaction.set(target,{schema:5,settings:merged,updatedAt:serverTimestamp()});
        }
        return merged;
      }));
      queue=job;
      try{
        const merged=await job;
        activeWrites--;
        if(target===ref&&identity===user?.uid&&activeWrites===0)notify('saved');
        return merged;
      }catch(err){
        activeWrites--;
        notify('save-error',{message:err.message||String(err)});
        throw err;
      }
    };
    onAuthStateChanged(auth,u=>{
      if(offDoc){offDoc();offDoc=null;}
      user=u;ref=null;activeWrites=0;queue=Promise.resolve();
      if(!u){notify('signed-out');return;}
      notify('connecting',{email:u.email});
      ref=doc(db,'users',u.uid,'studio','main');
      const target=ref;
      offDoc=onSnapshot(target,snapshot=>{
        if(target!==ref||snapshot.metadata.hasPendingWrites||activeWrites>0)return;
        notify('snapshot',{exists:snapshot.exists(),settings:snapshot.exists()?snapshot.data()?.settings:null,user:{uid:u.uid,email:u.email}});
      },err=>notify('error',{message:'클라우드 자료를 읽을 수 없습니다: '+err.message}));
    },err=>notify('error',{message:'로그인 확인 오류: '+err.message}));
    notify('ready');
  }).catch(err=>{cloud.ready=false;notify('error',{message:'Firebase 연결 모듈을 불러오지 못했습니다: '+err.message});});
}
