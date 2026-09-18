/* Runs only after the server requests additional registration verification. */
self.onmessage = async function (event) {
  const challenge = event.data;
  const encoder = new TextEncoder();
  const deadline = Date.now() + 90000;
  for (let n = 0; n < 2000000 && Date.now() < deadline; n++) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(challenge.prefix + ':' + n)));
    if (hash[0] === 0 && hash[1] === 0) { self.postMessage({ id: challenge.id, nonce: String(n) }); return; }
  }
  self.postMessage({ error: '注册验证超时，请稍后再试' });
};
