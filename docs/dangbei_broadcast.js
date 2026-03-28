const $ = (id) => document.getElementById(id);

const logEl = $('guidedLog');
const statusDot = $('guidedStatusDot');
const statusText = $('guidedStatusText');

const CONNECT_TIMEOUT_MS = 7000;

const state = {
  ip: '',
  connectionAttempt: 0,
  connectOutcome: 'idle',
  waitingForPairing: false,
  hadStoredClientKey: false,
  registerHintTimer: null
};

function logLine(kind, data) {
  const prefix = `[${kind}] `;
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  logEl.textContent += prefix + text + '\n\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function logError(error) {
  if (error instanceof Error) {
    logLine('error', error.stack || `${error.name}: ${error.message}`);
  } else {
    logLine('error', String(error));
  }
}

function setStatus(type, text) {
  statusDot.className = 'dot ' + (type || '');
  statusText.textContent = text;
}

function setStepState(activeStep) {
  const steps = ['stepConnect', 'stepPair', 'stepWorkflow'];
  const activeIndex = steps.indexOf(activeStep);
  steps.forEach((id, index) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('active', 'done');
    if (index < activeIndex) el.classList.add('done');
    if (index === activeIndex) el.classList.add('active');
  });
}

function clearRegisterHintTimer() {
  if (state.registerHintTimer) {
    clearTimeout(state.registerHintTimer);
    state.registerHintTimer = null;
  }
}

function enterPairingWaitState() {
  state.waitingForPairing = true;
  setStepState('stepPair');
  setStatus('warn', 'Confirm on TV');
}

function leavePairingWaitState() {
  state.waitingForPairing = false;
}

function scheduleRegisterHint() {
  clearRegisterHintTimer();
  state.registerHintTimer = setTimeout(() => {
    if (state.connectOutcome !== 'pending' || bridge.registered) return;
    showModal({
      title: 'Registering Connection',
      body: 'The TV socket is open and the app is finishing SSAP registration with the stored client key.',
      primaryLabel: 'Retry Connect',
      secondaryLabel: 'Open Certificate Tab',
      dismissLabel: 'Keep Waiting',
      onPrimary: () => startGuidedFlow(),
      onSecondary: () => openCertificateTab(),
      onDismiss: () => {},
      hideSecondary: true
    });
  }, 900);
}

function storageKey(ip) {
  return `webos-ssap-client-key:${ip}`;
}

function getStoredClientKey(ip) {
  return localStorage.getItem(storageKey(ip)) || '';
}

function setStoredClientKey(ip, key) {
  localStorage.setItem(storageKey(ip), key);
}

function createWsProxy() {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    const proxyHtml = `<!doctype html><html><body><script>
      let ws = null;
      let parentOrigin = '*';
      function send(type, payload) { parent.postMessage({ __ssapProxy: true, type, payload }, parentOrigin); }
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.__ssapBridgeCmd) return;
        parentOrigin = event.origin || '*';
        if (msg.type === 'connect') {
          try {
            if (ws) { try { ws.close(); } catch (_) {} }
            ws = new WebSocket(msg.url);
            ws.onopen = () => send('open', {});
            ws.onclose = (ev) => send('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
            ws.onerror = () => send('error', { message: 'WebSocket error' });
            ws.onmessage = (ev) => send('message', { data: ev.data });
          } catch (err) { send('error', { message: err.message || String(err) }); }
        }
        if (msg.type === 'send') {
          try {
            if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Socket not open');
            ws.send(msg.data);
          } catch (err) { send('error', { message: err.message || String(err) }); }
        }
        if (msg.type === 'close') {
          try { if (ws) ws.close(); } catch (err) { send('error', { message: err.message || String(err) }); }
        }
      });
    <\/script></body></html>`;
    iframe.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(proxyHtml);
    iframe.onload = () => resolve({
      iframe,
      send(cmd) { iframe.contentWindow.postMessage({ __ssapBridgeCmd: true, ...cmd }, '*'); }
    });
    iframe.onerror = () => reject(new Error('Failed to load proxy iframe'));
    document.body.appendChild(iframe);
  });
}

class WebOsSsapBridge extends EventTarget {
  constructor() {
    super();
    this.proxy = null;
    this.ip = '';
    this.port = '3001';
    this.reqId = 1;
    this.pending = new Map();
    this.connected = false;
    this.registered = false;
    this.listenersBound = false;
  }

  async ensureProxy() {
    if (this.proxy) return;
    this.proxy = await createWsProxy();
    if (this.listenersBound) return;
    window.addEventListener('message', (event) => {
      if (event.source !== this.proxy.iframe.contentWindow) return;
      const msg = event.data;
      if (!msg || !msg.__ssapProxy) return;
      this.handleProxyMessage(msg.type, msg.payload);
    });
    this.listenersBound = true;
  }

  async connect(ip, port = '3001') {
    this.ip = ip.trim();
    this.port = String(port || '3001');
    this.connected = false;
    this.registered = false;
    await this.ensureProxy();
    const url = `wss://${this.ip}:${this.port}`;
    setStatus('warn', 'Connecting …');
    this.proxy.send({ type: 'connect', url });
  }

  disconnect() {
    if (this.proxy) this.proxy.send({ type: 'close' });
  }

  handleProxyMessage(type, payload) {
    this.dispatchEvent(new CustomEvent(type, { detail: payload || {} }));
    if (type === 'open') {
      this.connected = true;
      setStatus('warn', 'Connected, registering …');
      this.register();
      return;
    }
    if (type === 'close') {
      this.connected = false;
      this.registered = false;
      setStatus('', 'Disconnected');
      return;
    }
    if (type === 'error') {
      setStatus('err', 'Connection failed');
      return;
    }
    if (type === 'message') {
      try {
        const msg = JSON.parse(payload.data);
        this.dispatchEvent(new CustomEvent('ssap-message', { detail: msg }));
        if (msg.type === 'registered') {
          this.registered = true;
          setStatus('ok', 'Registered');
          const clientKey = msg.payload && msg.payload['client-key'];
          if (clientKey) setStoredClientKey(this.ip, clientKey);
        }
        if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') {
          setStatus('warn', 'Confirm pairing on TV');
        }
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          if (!this.pending.get(msg.id).__keepAlive) this.pending.delete(msg.id);
        }
      } catch (_) {
        console.log('recv-raw', payload.data);
      }
    }
  }

  nextId(prefix = 'req') {
    return `${prefix}_${this.reqId++}`;
  }

  sendRaw(message) {
    if (!this.proxy) throw new Error('Proxy is not initialized');
    this.proxy.send({ type: 'send', data: JSON.stringify(message) });
    console.log('send', message);
  }

  register() {
    const id = this.nextId('register');
    const clientKey = getStoredClientKey(this.ip);
    const message = {
      id,
      type: 'register',
      payload: {
        forcePairing: false,
        pairingType: 'PROMPT',
        'client-key': clientKey || undefined,
        manifest: {
          manifestVersion: 1,
          appVersion: '1.0',
          signed: {
            appId: 'com.example.ssap.dangbei.lsmon',
            created: '2026-03-28',
            permissions: [
              'TEST_SECURE',
              'READ_RUNNING_APPS',
              'READ_NOTIFICATIONS',
              'READ_NETWORK_STATE',
              'READ_POWER_STATE',
              'READ_COUNTRY_INFO',
              'WRITE_NOTIFICATION_TOAST'
            ],
            vendorId: 'com.example'
          },
          permissions: [
            'LAUNCH',
            'APP_TO_APP',
            'CLOSE',
            'TEST_OPEN',
            'TEST_PROTECTED',
            'READ_APP_STATUS',
            'READ_NETWORK_STATE',
            'READ_RUNNING_APPS',
            'READ_POWER_STATE',
            'READ_COUNTRY_INFO',
            'WRITE_NOTIFICATION_TOAST'
          ],
          signatures: [{ signatureVersion: 1, signature: 'dangbei-lsmon-local-demo' }]
        }
      }
    };
    if (!clientKey) delete message.payload['client-key'];
    this.sendRaw(message);
  }

  request(uri, payload = {}, subscribe = false, timeoutMs = 15000) {
    if (!this.connected) throw new Error('Not connected');
    const id = this.nextId(subscribe ? 'sub' : 'call');
    const msg = { id, type: subscribe ? 'subscribe' : 'request', uri, payload };
    this.sendRaw(msg);
    return new Promise((resolve) => {
      const resolver = (response) => resolve(response);
      resolver.__keepAlive = subscribe;
      this.pending.set(id, resolver);
      if (!subscribe) {
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            resolve({ id, timeout: true });
          }
        }, timeoutMs);
      }
    });
  }
}

const bridge = new WebOsSsapBridge();

function showModal({ title, body, primaryLabel = 'Retry', secondaryLabel = 'Open Certificate Tab', dismissLabel = 'Close', onPrimary, onSecondary, onDismiss, hideSecondary = false, hideDismiss = false }) {
  $('guidedModalTitle').textContent = title;
  $('guidedModalBody').textContent = body;
  $('guidedModalPrimaryBtn').textContent = primaryLabel;
  $('guidedModalSecondaryBtn').textContent = secondaryLabel;
  $('guidedModalDismissBtn').textContent = dismissLabel;
  $('guidedModalSecondaryBtn').hidden = hideSecondary;
  $('guidedModalDismissBtn').hidden = hideDismiss;
  $('guidedModal').hidden = false;
  $('guidedModalPrimaryBtn').onclick = () => onPrimary && onPrimary();
  $('guidedModalSecondaryBtn').onclick = () => onSecondary && onSecondary();
  $('guidedModalDismissBtn').onclick = () => {
    if (onDismiss) onDismiss();
    hideModal();
  };
}

function hideModal() {
  $('guidedModal').hidden = true;
}

function openCertificateTab() {
  const ip = $('guidedTvIp').value.trim();
  if (!ip) return logLine('error', 'Please enter a TV IP');
  const certUrl = `https://${ip}:3001/`;
  window.open(certUrl, '_blank', 'noopener,noreferrer');
  logLine('info', `Opened certificate tab: ${certUrl}`);
}

function shouldOfferCertificateHelp() {
  return !state.hadStoredClientKey;
}

function resolveResourceUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  return new URL(input, window.location.href).toString();
}

function parseJsonField(id, fallback = {}) {
  const raw = ($(id).value || '').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${id}: ${error.message}`);
  }
}

function buildLaunchPayload() {
  const appId = $('dangbeiAppId').value.trim();
  const target = resolveResourceUrl($('dangbeiTargetUrl').value);
  const extraParams = parseJsonField('dangbeiParams', {});

  if (!appId) throw new Error('App id is required');
  if (!target) throw new Error('Target URL is required');

  return {
    id: appId,
    params: {
      ...extraParams,
      target
    }
  };
}

async function runLaunchProbe() {
  if (!bridge.registered) {
    throw new Error('Connect to the TV first');
  }

  const payload = buildLaunchPayload();
  logLine('request', {
    uri: 'ssap://system.launcher/launch',
    payload
  });

  const response = await bridge.request('ssap://system.launcher/launch', payload);
  if (response.timeout) {
    throw new Error('Dangbei launch timed out');
  }

  logLine('response', response.payload || response);
  return response;
}

function saveIp(value) {
  localStorage.setItem('webos-last-ip', value.trim());
}

function classifyFailure(reason) {
  if (reason === 'timeout') {
    return {
      title: 'TV Not Reachable',
      body: 'No successful WSS connection was established in time. The TV IP may be wrong, the TV may be offline, or port 3001 may not be reachable on the network.',
      status: 'Unreachable'
    };
  }
  return {
    title: 'WSS Connection Failed',
    body: 'The TV self-signed certificate has not been trusted yet.',
    status: 'Connection failed'
  };
}

async function startGuidedFlow() {
  const ip = $('guidedTvIp').value.trim();
  if (!ip) {
    logLine('error', 'Please enter a TV IP.');
    return;
  }

  state.connectionAttempt += 1;
  state.connectOutcome = 'pending';
  state.ip = ip;
  state.waitingForPairing = false;
  clearRegisterHintTimer();
  state.hadStoredClientKey = Boolean(getStoredClientKey(ip));
  saveIp(ip);
  bridge.disconnect();
  setStepState('stepConnect');
  setStatus('warn', 'Connecting …');
  logLine('connect', `Trying to reach TV at ${ip} over wss:// on port 3001.`);

  const attemptId = state.connectionAttempt;

  try {
    await bridge.connect(ip, '3001');
  } catch (error) {
    leavePairingWaitState();
    logError(error);
    const failure = classifyFailure('error');
    setStatus('err', failure.status);
    showModal({
      title: failure.title,
      body: failure.body,
      primaryLabel: 'Retry Connect',
      secondaryLabel: 'Open Certificate Tab',
      dismissLabel: 'Close',
      onPrimary: () => startGuidedFlow(),
      onSecondary: () => openCertificateTab(),
      hideSecondary: !shouldOfferCertificateHelp()
    });
    return;
  }

  setTimeout(() => {
    if (attemptId !== state.connectionAttempt) return;
    if (state.waitingForPairing) return;
    if (state.connectOutcome === 'pending' && !bridge.registered) {
      leavePairingWaitState();
      state.connectOutcome = 'failed';
      const failure = classifyFailure('timeout');
      setStatus('err', failure.status);
      logLine('error', 'TV did not answer in time. Check IP, network reachability, or certificate trust.');
      showModal({
        title: failure.title,
        body: failure.body,
        primaryLabel: 'Retry Connect',
        secondaryLabel: 'Open Certificate Tab',
        dismissLabel: 'Close',
        onPrimary: () => startGuidedFlow(),
        onSecondary: () => openCertificateTab(),
        hideSecondary: !shouldOfferCertificateHelp()
      });
      try {
        bridge.disconnect();
      } catch (_) {}
    }
  }, CONNECT_TIMEOUT_MS);
}

function handleRegistered() {
  clearRegisterHintTimer();
  leavePairingWaitState();
  state.connectOutcome = 'registered';
  setStatus('ok', 'Connected');
  setStepState('stepWorkflow');
  hideModal();
  logLine('connect', state.hadStoredClientKey
    ? 'Connected. Existing client key accepted.'
    : 'Connected. Pairing completed and the TV is ready.');
  logLine('ready', 'ls-monitor probe is ready. Press launch probe when you want to test the payload.');
}

bridge.addEventListener('open', () => {
  logLine('connect', 'TV reached. Starting SSAP registration.');
  if (!state.hadStoredClientKey) {
    enterPairingWaitState();
    logLine('pair', 'Waiting for confirmation on the TV screen.');
    showModal({
      title: 'Approve Pairing On TV',
      body: 'The browser reached the TV. If this is the first connection, confirm the pairing prompt on the TV now. This dialog stays here while the app waits for registration to complete.',
      primaryLabel: 'Retry Connect',
      secondaryLabel: 'Open Certificate Tab',
      dismissLabel: 'Keep Waiting',
      onPrimary: () => startGuidedFlow(),
      onSecondary: () => openCertificateTab(),
      onDismiss: () => {}
    });
  } else {
    logLine('pair', 'Using stored client key. Waiting for registration result.');
    scheduleRegisterHint();
  }
});

bridge.addEventListener('error', () => {
  clearRegisterHintTimer();
  leavePairingWaitState();
  if (bridge.registered) return;
  if (state.connectOutcome !== 'pending') return;
  state.connectOutcome = 'failed';
  const failure = classifyFailure('error');
  setStatus('err', failure.status);
  logLine('error', 'WSS connection failed. Most likely the TV certificate is not trusted yet, otherwise check IP and network.');
  try {
    bridge.disconnect();
  } catch (_) {}
  showModal({
    title: failure.title,
    body: failure.body,
    primaryLabel: 'Retry Connect',
    secondaryLabel: 'Open Certificate Tab',
    dismissLabel: 'Close',
    onPrimary: () => startGuidedFlow(),
    onSecondary: () => openCertificateTab(),
    hideSecondary: !shouldOfferCertificateHelp()
  });
});

bridge.addEventListener('close', () => {
  clearRegisterHintTimer();
  if (!bridge.registered) leavePairingWaitState();
});

bridge.addEventListener('ssap-message', (event) => {
  const msg = event.detail;
  if (msg.type === 'registered') {
    handleRegistered();
    return;
  }
  if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
    enterPairingWaitState();
    logLine('pair', 'Pairing prompt detected. Please accept it on the TV.');
    showModal({
      title: 'Pairing Prompt Detected',
      body: 'The TV asked for confirmation. Accept the prompt on the TV, then this page should continue automatically.',
      primaryLabel: 'Retry Connect',
      secondaryLabel: 'Open Certificate Tab',
      dismissLabel: 'Keep Waiting',
      onPrimary: () => startGuidedFlow(),
      onSecondary: () => openCertificateTab(),
      onDismiss: () => {}
    });
  }
});

$('guidedStartBtn').addEventListener('click', () => startGuidedFlow());
$('guidedRetryBtn').addEventListener('click', () => startGuidedFlow());
$('guidedOpenCertBtn').addEventListener('click', () => openCertificateTab());
$('guidedTvIp').addEventListener('change', () => saveIp($('guidedTvIp').value));
$('guidedTvIp').addEventListener('keyup', () => saveIp($('guidedTvIp').value));
$('guidedModalDismissBtn').addEventListener('click', () => hideModal());
$('dangbeiLaunchBtn').addEventListener('click', async () => {
  try {
    await runLaunchProbe();
  } catch (error) {
    logError(error);
  }
});

(() => {
  const savedIp = localStorage.getItem('webos-last-ip') || '';
  if (savedIp) $('guidedTvIp').value = savedIp;
  $('dangbeiAppId').value = 'com.webos.app.dangbei-overlay';
  $('dangbeiTargetUrl').value = resolveResourceUrl('./resources/dangbei_broadcast/');
  setStatus('', 'Idle');
  logLine('boot', 'dangbei broadcast page ready.');
  logLine('boot', 'Connect to the TV, then press launch probe.');
})();
