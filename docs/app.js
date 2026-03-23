const $ = (id) => document.getElementById(id);
const logEl = $('log');
const workflowOutputEl = $('workflowOutput');
const statusDot = $('statusDot');
const statusText = $('statusText');

function logLine(kind, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${kind}] `;
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  logEl.textContent += prefix + text + '\n\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function formatConsoleArgs(args) {
  return args.map((value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
      return value.stack || `${value.name}: ${value.message}`;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }).join(' ');
}

function installConsoleMirror() {
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        logLine(`console-${method}`, formatConsoleArgs(args));
      } catch (_) {
        original('Failed to mirror console output into page log');
      }
    };
  }

  window.addEventListener('error', (event) => {
    const detail = event.error?.stack || event.message || 'Unknown window error';
    logLine('window-error', detail);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? (event.reason.stack || `${event.reason.name}: ${event.reason.message}`)
      : formatConsoleArgs([event.reason]);
    logLine('unhandledrejection', reason);
  });
}

function setStatus(type, text) {
  statusDot.className = 'dot ' + (type || '');
  statusText.textContent = text;
}

function appendWorkflowLine(kind, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${kind}] `;
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  workflowOutputEl.textContent += prefix + text + '\n\n';
  workflowOutputEl.scrollTop = workflowOutputEl.scrollHeight;
}

function joinUnixPath(dir, name) {
  const cleanDir = String(dir || '').replace(/\/+$/, '');
  const cleanName = String(name || '').replace(/^\/+/, '');
  return `${cleanDir}/${cleanName}`;
}

function resolveResourceUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  return new URL(input, window.location.href).toString();
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

function clearStoredClientKey(ip) {
  localStorage.removeItem(storageKey(ip));
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

class WebOsSsapBridge {
  constructor() {
    this.proxy = null;
    this.ip = '';
    this.port = '3000';
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

  async connect(ip, port) {
    this.ip = ip.trim();
    const pageIsHttps = window.location.protocol === 'https:';
    const desiredPort = String(port || '3000');
    this.port = pageIsHttps && desiredPort === '3000' ? '3001' : desiredPort;
    this.connected = false;
    this.registered = false;
    await this.ensureProxy();
    const protocol = this.port === '3001' ? 'wss' : 'ws';
    const url = `${protocol}://${this.ip}:${this.port}`;
    logLine('info', { action: 'connect', pageProtocol: window.location.protocol, socketUrl: url });
    if (pageIsHttps && this.port !== '3001') {
      logLine('warn', 'HTTPS page detected. ws:// is blocked, so the port was switched to 3001.');
    }
    setStatus('warn', 'Connecting …');
    this.proxy.send({ type: 'connect', url });
  }

  disconnect() {
    if (this.proxy) this.proxy.send({ type: 'close' });
  }

  handleProxyMessage(type, payload) {
    if (type === 'open') {
      this.connected = true;
      setStatus('warn', 'Connected, registering …');
      logLine('ws', 'WebSocket opened');
      this.register();
      return;
    }
    if (type === 'close') {
      this.connected = false;
      this.registered = false;
      setStatus('', 'Disconnected');
      logLine('ws-close', payload);
      return;
    }
    if (type === 'error') {
      setStatus('err', 'Error');
      logLine('ws-error', payload);
      return;
    }
    if (type === 'message') {
      try {
        const msg = JSON.parse(payload.data);
        logLine('recv', msg);
        if (msg.type === 'registered') {
          this.registered = true;
          setStatus('ok', 'Registered');
          const clientKey = msg.payload && msg.payload['client-key'];
          if (clientKey) {
            setStoredClientKey(this.ip, clientKey);
            logLine('auth', `Stored client key for ${this.ip}`);
          }
        }
        if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') {
          setStatus('warn', 'Confirm pairing on TV');
        }
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          if (!this.pending.get(msg.id).__keepAlive) this.pending.delete(msg.id);
        }
      } catch (error) {
        logLine('recv-raw', payload.data);
      }
    }
  }

  nextId(prefix = 'req') {
    return `${prefix}_${this.reqId++}`;
  }

  sendRaw(message) {
    if (!this.proxy) throw new Error('Proxy is not initialized');
    this.proxy.send({ type: 'send', data: JSON.stringify(message) });
    logLine('send', message);
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
            appId: 'com.example.ssap.install.bridge',
            created: '2026-03-23',
            permissions: [
              'TEST_SECURE', 'READ_RUNNING_APPS', 'READ_LGE_SDX', 'READ_NOTIFICATIONS', 'SEARCH',
              'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING',
              'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_CURRENT_CHANNEL',
              'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST',
              'READ_POWER_STATE', 'READ_COUNTRY_INFO'
            ],
            vendorId: 'com.example'
          },
          permissions: [
            'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED',
            'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING',
            'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS',
            'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_NETWORK_STATE', 'READ_RUNNING_APPS',
            'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST', 'READ_POWER_STATE', 'READ_COUNTRY_INFO'
          ],
          signatures: [{ signatureVersion: 1, signature: 'install-bridge-local-demo' }]
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

function buildPromptPayload(targetUri, targetPayload, alertMessage, phase) {
  const callback = { uri: targetUri, params: targetPayload };
  const payload = {
    title: 'SSAP Install Bridge',
    message: alertMessage,
    buttons: [{ label: 'OK', focus: true }],
    onclose: { uri: 'luna://com.webos.notification/closeAllAlerts', params: {} },
    onfail: { uri: 'luna://com.webos.notification/closeAllAlerts', params: {} }
  };
  if (phase === 'onclose') payload.onclose = callback;
  if (phase === 'onfail') payload.onfail = callback;
  if (phase === 'button') payload.buttons = [{ label: 'Run', focus: true, onclick: targetUri, params: targetPayload }];
  return payload;
}

function extractAlertId(createResponse) {
  let alertId = createResponse?.payload?.alertId || createResponse?.payload?.alert_id || createResponse?.payload?.id;
  if (!alertId && createResponse?.payload && typeof createResponse.payload === 'object') {
    for (const [key, value] of Object.entries(createResponse.payload)) {
      if (/alert/i.test(key) && typeof value === 'string') alertId = value;
    }
  }
  return alertId;
}

async function sendPromptAction({ targetUri, targetPayload, alertMessage, phase, logKind = 'prompt-action' }) {
  const createPayload = buildPromptPayload(targetUri, targetPayload, alertMessage, phase);
  logLine(logKind, { action: 'createAlert', phase, targetUri, targetPayload });
  const createResponse = await bridge.request('ssap://system.notifications/createAlert', createPayload);
  const alertId = extractAlertId(createResponse);
  if (alertId) {
    logLine(logKind, { action: 'closeAlert', alertId });
    await bridge.request('ssap://system.notifications/closeAlert', { alertId });
  } else {
    logLine(logKind, 'No alertId found. The callback may need to be triggered manually.');
  }
  return createResponse;
}

function updateWorkflowInstallPath() {
  const installPath = joinUnixPath($('workflowTargetDir').value.trim(), $('workflowFilename').value.trim());
  $('workflowInstallPath').value = installPath;
  return installPath;
}

function getWorkflowWaitMs() {
  const seconds = Number($('workflowWaitSeconds').value || 10);
  return Math.max(0, seconds) * 1000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildToastTestRequest() {
  return {
    targetUri: 'luna://com.webos.notification/createToast',
    targetPayload: { message: $('testToastMessage').value.trim() || 'Bridge check complete' },
    alertMessage: $('testAlertMessage').value.trim() || 'Bridge check',
    phase: $('testPhase').value,
    logKind: 'quick-check'
  };
}

function buildWorkflowDownloadRequest() {
  const target = resolveResourceUrl($('workflowUrl').value);
  const targetDir = $('workflowTargetDir').value.trim();
  const targetFilename = $('workflowFilename').value.trim();
  if (!target) throw new Error('IPK URL is required');
  if (!targetDir) throw new Error('Download target directory is required');
  if (!targetFilename) throw new Error('Filename is required');
  updateWorkflowInstallPath();
  return {
    targetUri: 'luna://com.webos.service.downloadmanager/download',
    targetPayload: {
      target,
      targetDir,
      targetFilename
    },
    alertMessage: $('workflowDownloadAlertMessage').value.trim() || 'Prepare package transfer',
    phase: $('workflowPhase').value,
    logKind: 'workflow-download'
  };
}

function buildWorkflowInstallRequest() {
  const appId = $('workflowAppId').value.trim();
  const ipkPath = updateWorkflowInstallPath();
  const installMode = $('workflowInstallMode').value;
  if (!appId) throw new Error('App ID is required');
  if (!ipkPath) throw new Error('Local IPK path is required');
  return {
    targetUri: `luna://com.webos.appInstallService/${installMode}`,
    targetPayload: {
      id: appId,
      ipkUrl: ipkPath,
      subscribe: true
    },
    alertMessage: $('workflowInstallAlertMessage').value.trim() || 'Prepare package install',
    phase: $('workflowPhase').value,
    logKind: 'workflow-install'
  };
}

function buildWorkflowLaunchRequest() {
  const appId = $('workflowAppId').value.trim();
  if (!appId) throw new Error('App ID is required');
  return {
    targetUri: 'luna://com.webos.applicationManager/launch',
    targetPayload: { id: appId },
    alertMessage: $('workflowLaunchAlertMessage').value.trim() || 'Open installed app',
    phase: $('workflowPhase').value,
    logKind: 'workflow-launch'
  };
}

async function runWorkflow() {
  const waitMs = getWorkflowWaitMs();
  const waitSeconds = waitMs / 1000;
  workflowOutputEl.textContent = '';
  appendWorkflowLine('workflow', 'Starting workflow');

  appendWorkflowLine('workflow', 'Step 1/3: request download');
  const downloadResponse = await sendPromptAction(buildWorkflowDownloadRequest());
  appendWorkflowLine('workflow-download-response', downloadResponse);

  if (waitMs > 0) {
    appendWorkflowLine('workflow', `Waiting ${waitSeconds}s before install`);
    await delay(waitMs);
  }

  appendWorkflowLine('workflow', 'Step 2/3: request install');
  const installResponse = await sendPromptAction(buildWorkflowInstallRequest());
  appendWorkflowLine('workflow-install-response', installResponse);

  if (waitMs > 0) {
    appendWorkflowLine('workflow', `Waiting ${waitSeconds}s before launch`);
    await delay(waitMs);
  }

  appendWorkflowLine('workflow', 'Step 3/3: request launch');
  const launchResponse = await sendPromptAction(buildWorkflowLaunchRequest());
  appendWorkflowLine('workflow-launch-response', launchResponse);
  appendWorkflowLine('workflow', 'Workflow finished');
}

function applyWorkflowPreset(preset) {
  if (preset === 'hbchannel') {
    $('workflowUrl').value = 'https://azoffshowy.github.io/ssap-install-bridge/resources/org.webosbrew.hbchannel_0.7.3_all.ipk';
    $('workflowTargetDir').value = '/media/internal/downloads';
    $('workflowFilename').value = 'org.webosbrew.hbchannel_0.7.3_all.ipk';
    $('workflowAppId').value = 'org.webosbrew.hbchannel';
    $('workflowPhase').value = 'onclose';
    $('workflowWaitSeconds').value = '10';
    $('workflowInstallMode').value = 'dev/install';
    $('workflowDownloadAlertMessage').value = 'Prepare Homebrew Channel package';
    $('workflowInstallAlertMessage').value = 'Prepare Homebrew Channel install';
    $('workflowLaunchAlertMessage').value = 'Open Homebrew Channel';
  } else {
    $('workflowUrl').value = 'https://azoffshowy.github.io/ssap-install-bridge/resources/com.palmdts.devmode.ipk';
    $('workflowTargetDir').value = '/media/internal/downloads';
    $('workflowFilename').value = 'com.palmdts.devmode.ipk';
    $('workflowAppId').value = 'com.palmdts.devmode';
    $('workflowPhase').value = 'onclose';
    $('workflowWaitSeconds').value = '10';
    $('workflowInstallMode').value = 'install';
    $('workflowDownloadAlertMessage').value = 'Prepare Developer Mode package';
    $('workflowInstallAlertMessage').value = 'Prepare Developer Mode install';
    $('workflowLaunchAlertMessage').value = 'Open Developer Mode';
  }
  updateWorkflowInstallPath();
}

$('connectBtn').addEventListener('click', async () => {
  const ip = $('tvIp').value.trim();
  const port = $('port').value;
  if (!ip) return logLine('error', 'Please enter a TV IP');
  try {
    if (window.location.protocol === 'https:' && port === '3000') {
      $('port').value = '3001';
      logLine('info', 'HTTPS page detected, automatically using wss:// on port 3001');
    }
    await bridge.connect(ip, $('port').value);
  } catch (error) {
    setStatus('err', 'Error');
    logLine('error', error.message || String(error));
  }
});

$('disconnectBtn').addEventListener('click', () => bridge.disconnect());
$('openCertBtn').addEventListener('click', () => {
  const ip = $('tvIp').value.trim();
  if (!ip) return logLine('error', 'Please enter a TV IP');
  const certUrl = `https://${ip}:3001/`;
  window.open(certUrl, '_blank', 'noopener,noreferrer');
  logLine('info', `Opened certificate tab: ${certUrl}`);
});
$('clearKeyBtn').addEventListener('click', () => {
  const ip = $('tvIp').value.trim();
  if (!ip) return logLine('error', 'No TV IP is set');
  clearStoredClientKey(ip);
  logLine('info', `Cleared client key for ${ip}`);
});
$('sendToastTestBtn').addEventListener('click', async () => {
  try {
    const response = await sendPromptAction(buildToastTestRequest());
    logLine('quick-check-response', response);
  } catch (error) {
    logLine('error', error.message || String(error));
  }
});
$('runWorkflowBtn').addEventListener('click', async () => {
  try {
    await runWorkflow();
  } catch (error) {
    appendWorkflowLine('workflow-error', error.message || String(error));
    logLine('error', error.message || String(error));
  }
});
$('loadToastTestExampleBtn').addEventListener('click', () => {
  $('testAlertMessage').value = 'Bridge check';
  $('testToastMessage').value = 'Bridge check complete';
  $('testPhase').value = 'onclose';
});
$('loadWorkflowExampleBtn').addEventListener('click', () => {
  applyWorkflowPreset($('workflowPreset').value);
});
$('clearLogBtn').addEventListener('click', () => { logEl.textContent = ''; });

(() => {
  installConsoleMirror();
  const savedIp = localStorage.getItem('webos-last-ip') || '';
  const pageIsHttps = window.location.protocol === 'https:';
  if (pageIsHttps) $('port').value = '3001';
  if (savedIp) $('tvIp').value = savedIp;
  $('tvIp').addEventListener('change', () => localStorage.setItem('webos-last-ip', $('tvIp').value.trim()));
  $('tvIp').addEventListener('keyup', () => localStorage.setItem('webos-last-ip', $('tvIp').value.trim()));
  $('workflowPreset').addEventListener('change', () => applyWorkflowPreset($('workflowPreset').value));
  $('workflowTargetDir').addEventListener('input', updateWorkflowInstallPath);
  $('workflowFilename').addEventListener('input', updateWorkflowInstallPath);
  applyWorkflowPreset($('workflowPreset').value);
  workflowOutputEl.textContent = '';
  logLine('info', 'Ready');
})();
