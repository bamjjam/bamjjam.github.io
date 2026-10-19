// My WebApp Studio 5.1 - optional Firebase/Firestore adapter.
// Public Firebase web configuration is loaded from firebase-config.js.
// No service-account key or GitHub token is ever used by this client.
const notify = (type, extra = {}) => window.dispatchEvent(new CustomEvent('portal-cloud', {detail: {type, ...extra}}));
const config = window.WEBAPP_FIREBASE_CONFIG;
const configured = !!(config && typeof config === 'object' && ['apiKey','projectId','appId','authDomain'].every(k=>typeof config[k]==='string' && config[k].trim() && !config[k].includes('YOUR_')));
let auth = null, db = null, user = null, offDoc = null, ref = null;
let activeWrites = 0, queue = Promise.resolve(), latestRemote = null;
const cloud = window.PortalCloud = {
  configured, ready:false,
  get user(){return user},
  get connected(){return !!user && !!ref},
  async login(){throw new Error('클라우드 초기화 중입니다.')},
  async logout(){throw new Error('클라우드 초기화 중입니다.')},
  async save(){throw new Error('클라우드 초기화 중입니다.')},
  async refresh(){throw new Error('클라우드 초기화 중입니다.')}
};
if (!configured) {
  cloud.ready = true;
  notify('unconfigured');
} else {
  // Explicit lazy import keeps the GitHub-only fallback functioning when no Firebase config exists.
  Promise.all([
    import('https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js')
  ]).then(async ([appMod, authMod, dbMod]) => {
    const app = appMod.initializeApp(config);
    auth = authMod.getAuth(app);
    db = dbMod.getFirestore(app);
    const {GoogleAuthProvider, signInWithPopup, signOut, setPersistence, browserLocalPersistence, onAuthStateChanged} = authMod;
    const {doc, onSnapshot, setDoc, serverTimestamp, getDocFromServer} = dbMod;
    // Personal-PC mode: keep Firebase sign-in across browser restarts.
    // A prior 5.0 session-only login is upgraded to persistent sign-in.
    await setPersistence(auth, browserLocalPersistence);
    cloud.ready = true;
    cloud.login = async () => { await signInWithPopup(auth, new GoogleAuthProvider()); };
    cloud.logout = async () => { await signOut(auth); };
    cloud.refresh = async () => {
      if (!ref) throw new Error('먼저 Google 계정으로 로그인해 주세요.');
      const snap = await getDocFromServer(ref);
      notify('snapshot', {exists:snap.exists(),settings:snap.exists()?snap.data()?.settings:null, user:{uid:user.uid,email:user.email}});
    };
    cloud.save = async settings => {
      if (!ref || !user) throw new Error('로그인이 필요합니다.');
      const target = ref;
      // Clone at call time, not at delayed send time, so the save status is honest.
      const copy = JSON.parse(JSON.stringify(settings));
      activeWrites++;
      notify('saving', {pending:activeWrites});
      const job = queue.catch(()=>{}).then(() => setDoc(target, {schema:5,settings:copy,updatedAt:serverTimestamp()}));
      queue = job;
      try {
        await job;
        activeWrites--;
        if (target===ref && activeWrites===0) {
          notify('saved');
          try { const snap=await getDocFromServer(ref); notify('snapshot',{exists:snap.exists(),settings:snap.exists()?snap.data()?.settings:null, user:{uid:user.uid,email:user.email}}); }
          catch(err) {notify('warning',{message:'저장은 완료됐지만 최신 자료를 다시 확인하지 못했습니다: '+err.message})}
        }
      } catch(err) {
        activeWrites--;
        notify('save-error', {message:err.message||String(err)});
        throw err;
      }
    };
    onAuthStateChanged(auth, u => {
      if (offDoc) {offDoc();offDoc=null}
      user = u;ref = null;activeWrites=0;queue=Promise.resolve();latestRemote=null;
      if (!u) { notify('signed-out'); return; }
      notify('connecting',{email:u.email});
      ref = doc(db, 'users', u.uid, 'studio', 'main');
      offDoc = onSnapshot(ref, snapshot => {
        if (snapshot.metadata.hasPendingWrites || activeWrites>0) return;
        latestRemote = snapshot.exists()?snapshot.data()?.settings:null;
        notify('snapshot',{exists:snapshot.exists(),settings:latestRemote,user:{uid:u.uid,email:u.email}});
      }, err=>notify('error',{message:'클라우드 자료를 읽을 수 없습니다: '+err.message}));
    }, err => notify('error',{message:'로그인 확인 오류: '+err.message}));
    notify('ready');
  }).catch(err => {cloud.ready=false;notify('error',{message:'Firebase 연결 모듈을 불러오지 못했습니다: '+err.message})});
}
