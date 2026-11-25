let opening;
function db() {
  return (opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('english30-confirmed-uploads', 1);
    r.onupgradeneeded = () => {
      const store = r.result.createObjectStore('jobs', { keyPath: 'saveId' });
      store.createIndex('owner', 'owner');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      opening = null;
      reject(r.error);
    };
  }));
}
async function action(mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('jobs', mode),
      r = run(tx.objectStore('jobs'));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || Error('待上传记录未能保存。'));
  });
}
export const jobsFor = (owner) =>
  action('readonly', (s) => s.index('owner').getAll(owner)).then((rows) =>
    rows.sort((a, b) => a.created - b.created || a.saveId.localeCompare(b.saveId)),
  );
export const putJob = (job) => action('readwrite', (s) => s.put(job));
export const putJobs = (jobs) =>
  action('readwrite', (s) => {
    for (const job of jobs) s.put(job);
  });
export const removeJob = (id) => action('readwrite', (s) => s.delete(id));
