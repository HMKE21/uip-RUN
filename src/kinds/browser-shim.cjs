// Browser-style prompt() / alert() / confirm() for plain Node scripts, so code written for the browser console
// (e.g. `const name = prompt("Enter your name:")`) also runs in the sandbox terminal. Only defined when missing.
const fs = require('fs');

function readLine() {
  const one = Buffer.alloc(1);
  const bytes = [];
  for (;;) {
    let n = 0;
    try { n = fs.readSync(0, one, 0, 1, null); } catch (e) {
      if (e.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); continue; }
      if (e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    if (one[0] === 10) break;           // \n
    if (one[0] !== 13) bytes.push(one[0]); // ignore \r
  }
  if (bytes.length === 0 && n === 0) return null; // EOF with nothing typed
  return Buffer.from(bytes).toString('utf8');
}

if (typeof globalThis.prompt === 'undefined') {
  globalThis.prompt = (message = '', def) => {
    process.stdout.write(`${message}${def !== undefined && def !== '' ? ` [${def}]` : ''} `);
    const v = readLine();
    if (v === null) return null;
    return v === '' && def !== undefined ? String(def) : v;
  };
}
if (typeof globalThis.alert === 'undefined') {
  globalThis.alert = (message = '') => { process.stdout.write(`\n\u{1F514} ${message}\n`); };
}
if (typeof globalThis.confirm === 'undefined') {
  globalThis.confirm = (message = '') => {
    process.stdout.write(`${message} (y/n) `);
    const v = readLine();
    return v !== null && /^\s*(y|yes|ok|true|1|ن|نعم|اه|أه)/i.test(v);
  };
}
