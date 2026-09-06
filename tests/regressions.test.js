'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Writable, PassThrough } = require('node:stream');
const fetch = require('node-fetch');
const { Settings } = require('luxon');

const Homey = { Device: class {}, Driver: class {}, App: class {} };
const root = path.resolve(__dirname, '..');
const quiet = { log() {}, error() {} };
const flush = () => new Promise(resolve => setImmediate(resolve));
function load(file, mocks = {}, globals = {}) {
  const filename = path.join(root, file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const overrides = { homey: Homey, ...mocks };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, URL, AbortController, Buffer,
    console: quiet, setTimeout, clearTimeout,
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
    ...globals,
  }, { filename });
  return module.exports;
}
function apiFixture(handler, globals) {
  const requests = [];
  const mockedFetch = Object.assign(async (url, options) => {
    requests.push({ url, options });
    return handler(url, options);
  }, { Response: fetch.Response });
  const { OctoprintAPI } = load('lib/octoprint.js', { './fetch': async () => ({ default: mockedFetch, Response: fetch.Response }) }, globals);
  return { API: OctoprintAPI, api: new OctoprintAPI({ address: 'https://printer.test', apikey: 'private-key' }), requests };
}
function deviceFixture(handler = () => { throw new Error('Unexpected network request'); }) {
  const fixture = apiFixture(handler);
  const Device = load('drivers/octoprint/device.js', { '../../lib/octoprint.js': { OctoprintAPI: fixture.API } });
  const device = new Device();
  const settings = {
    address: 'https://printer.test', apikey: 'private-key', snapshot_active: true,
    snapshot_url: '/webcam/?action=snapshot', stream_active: true, stream_mode: 'video_auto',
    stream_url: '/webcam/?action=stream', disable_webrtc_proxy: false, webrtc_data_channel: false,
    heated_bed: true, heated_chamber: true, pollInterval: 10,
  };
  const images = [], videos = [], logs = [], listeners = new Map(), values = new Map();
  const capabilities = new Set(require('../app.json').drivers[0].capabilities);
  const imageFactory = async () => {
    const image = { unregistered: 0, updates: 0, setStream(callback) { this.callback = callback; },
      async unregister() { this.unregistered++; }, async update() { this.updates++; } };
    images.push(image);
    return image;
  };
  const factories = {};
  for (const type of ['Other', 'WebRTC', 'HLS', 'DASH', 'RTSP', 'RTMP']) {
    factories['createVideo' + type] = async options => {
      const video = { type, options, unregistered: 0, async unregister() { this.unregistered++; },
        registerOfferListener(callback) { this.offer = callback; },
        registerVideoUrlListener(callback) { this.url = callback; } };
      videos.push(video);
      return video;
    };
  }
  Object.assign(device, {
    octoprint: fixture.api, _timers: new Set(),
    getSetting: key => settings[key], getSettings: () => ({ ...settings }),
    setSettings: async updates => Object.assign(settings, updates),
    getCapabilityValue: key => values.get(key) ?? null,
    setCapabilityValue: async (key, value) => values.set(key, value),
    hasCapability: key => capabilities.has(key),
    addCapability: async key => capabilities.add(key), removeCapability: async key => capabilities.delete(key),
    registerCapabilityListener: (key, callback) => listeners.set(key, callback),
    triggerCapabilityListener: (key, value) => listeners.get(key)(value),
    setCameraImage: async () => {}, setCameraVideo: async () => {},
    setAvailable: async () => {}, setUnavailable: async () => {},
    log: (...args) => logs.push(args), error: (...args) => logs.push(args),
    homey: { __: key => key, images: { createImage: imageFactory }, videos: factories, clock: { getTimezone: () => 'Europe/Prague' } },
    printer: { server: '1.10', state: 'Operational' },
  });
  return { ...fixture, device, settings, images, videos, logs, listeners, values, capabilities };
}
const response = (body, status = 200) => new fetch.Response(typeof body === 'object' && body !== null && typeof body.pipe !== 'function' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body, { status });

test('actual installed node-fetch loads from CommonJS and exports callable fetch and Response', async () => {
  const loaded = await require('../lib/fetch')();
  assert.equal(typeof loaded.default, 'function');
  assert.equal(await new loaded.Response('image').text(), 'image');
  // Exercise the real API with a data URL: no network, printer, or Homey access.
  const { OctoprintAPI } = require('../lib/octoprint');
  const api = new OctoprintAPI({ address: 'http://printer.test' });
  assert.equal(await api.request('data:text/plain,local-test', {}, res => res.text()), 'local-test');
});

test('POST awaits the HTTP response and accepts empty 204 and 200 responses', async () => {
  let release;
  const { api } = apiFixture(() => new Promise(resolve => { release = resolve; }));
  let done = false;
  const result = api.postData('/api/job', { command: 'cancel' }).then(value => { done = true; return value; });
  await flush();
  assert.equal(done, false);
  release(response(null, 204));
  assert.equal(await result, null);
  assert.equal(await apiFixture(() => response('', 200)).api.postData('/api/job', {}), null);
});

test('HTTP failures, network failures and invalid JSON reject with safe diagnostics', async () => {
  for (const status of [401, 409, 500]) {
    const { api } = apiFixture(() => response('secret response content', status));
    await assert.rejects(api.postData('/api/job', {}), error => error.status === status && !error.message.includes('secret response'));
  }
  const { api } = apiFixture(() => { const error = new Error('request https://user:password@cam.test/snapshot?token=secret failed private-key'); error.code = 'ECONNRESET'; throw error; });
  await assert.rejects(api.getData('/api/server'), error => error.code === 'ECONNRESET' && !/password|token=secret|private-key/.test(error.message));
  await assert.rejects(apiFixture(() => response('not json')).api.getData('/api/server'));
});

test('request deadline aborts a stalled fetch; dispose aborts outstanding requests', async () => {
  let deadline;
  const handler = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
    const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
  }));
  const { api } = apiFixture(handler, { setTimeout(callback) { deadline = callback; return 1; }, clearTimeout() {} });
  const pending = assert.rejects(api.getData('/api/server'), /timed out/);
  await flush();
  deadline();
  await pending;
  assert.equal(api._requests.size, 0);
  const other = apiFixture(handler).api;
  const disposed = assert.rejects(other.getData('/api/server'), /connection closed/);
  await flush();
  other.dispose();
  await disposed;
  await assert.rejects(other.getData('/api/server'), /connection closed/);
});

test('snapshot deadline covers a stalled body, and images enforce the 5 MB limit', async () => {
  let deadline;
  const source = new PassThrough();
  const { api } = apiFixture((url, { signal }) => {
    signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; source.destroy(error); });
    return response(source);
  }, { setTimeout(callback) { deadline = callback; return 1; }, clearTimeout() {} });
  const result = assert.rejects(api.getSnapshot('/snapshot'), /timed out/);
  await flush();
  deadline();
  await result;
  const large = apiFixture((url, options) => new fetch.Response(Buffer.alloc(5 * 1024 * 1024 + 1), { size: options.size })).api;
  await assert.rejects(large.getSnapshot('/snapshot'), /over limit/);
});

test('camera URLs preserve HTTPS, relative paths, absolute URLs and legacy host inputs', () => {
  const { api, API } = apiFixture();
  for (const [input, expected] of [
    ['', 'https://printer.test/webcam/?action=snapshot'],
    ['webcam/?action=snapshot', 'https://printer.test/webcam/?action=snapshot'],
    ['snapshot.jpg', 'https://printer.test/snapshot.jpg'],
    ['//camera.test/snapshot', 'https://camera.test/snapshot'],
    ['camera.local:8080/snapshot', 'https://camera.local:8080/snapshot'],
    ['192.168.1.10:8080/snapshot', 'https://192.168.1.10:8080/snapshot'],
    ['http://camera.test/snapshot', 'http://camera.test/snapshot'],
  ]) assert.equal(api.getWebcamUrl(input, '/webcam/?action=snapshot'), expected);
  assert.equal(API.redactUrl('rtsp://user:secret@camera.test/live?token=hidden#private'), 'rtsp://camera.test/live');
  assert.throws(() => new API({ address: 'ftp://printer.test' }), /HTTP/);
});

test('snapshot failure stays visible instead of silently fetching a different camera', async () => {
  const { api, requests } = apiFixture(() => response('', 404));
  await assert.rejects(api.getSnapshot('/custom-snapshot'), /404/);
  assert.equal(requests.length, 1);
});

test('authenticated snapshot URLs use Basic authentication without exposing credentials to fetch URLs', async () => {
  const { api, requests } = apiFixture(() => response('image'));
  await api.getSnapshot('http://user:password@camera.test/snapshot?token=secret');
  assert.equal(requests[0].url, 'http://camera.test/snapshot?token=secret');
  assert.equal(requests[0].options.headers.Authorization, 'Basic ' + Buffer.from('user:password').toString('base64'));
});

test('durations are timezone independent, support 31+ days, and zero progress is finite', async () => {
  const { api } = apiFixture(() => response({ job: { file: { name: 'test.gcode' }, estimatedPrintTime: 3600 }, progress: { completion: 0, printTime: 0, printTimeLeft: 0 } }));
  const previousZone = Settings.defaultZone;
  try {
    for (const zone of ['Europe/Prague', 'America/New_York', 'UTC']) {
      Settings.defaultZone = zone;
      const job = await api.getPrinterJob('Europe/Prague');
      assert.equal(job.estimate_hms, '01:00:00');
      assert.equal(job.completion_time_calculated, 0);
      assert.equal(job.time, '0h 0m 0s');
    }
    assert.equal(api.formatDuration(32 * 86400 + 3661, true), '32d 01:01:01');
    assert.equal(api.formatDuration(null), null);
  } finally { Settings.defaultZone = previousZone; }
});

test('unconnected printer 409 remains recoverable; other telemetry errors propagate', async () => {
  const { api } = apiFixture(() => response('', 409));
  assert.equal(Object.keys(await api.getPrinterTemps()).length, 0);
  const failed = apiFixture(() => response('', 401)).api;
  await assert.rejects(failed.getPrinterTemps(), /401/);
  await assert.rejects(failed.getServerState(), /401/);
});

test('driver delivers repeated and cross-device events, including estimated end time', async () => {
  const Driver = load('drivers/octoprint/driver.js', { '../../lib/octoprint.js': {} });
  const driver = new Driver();
  const calls = [], actions = new Map(), conditions = new Map();
  driver.log = driver.error = () => {};
  driver.homey = { flow: {
    getDeviceTriggerCard: id => ({ trigger: async (device, tokens) => calls.push({ id, device, tokens }) }),
    getActionCard: id => ({ registerRunListener: fn => actions.set(id, fn) }),
    getConditionCard: id => ({ registerRunListener: fn => conditions.set(id, fn) }),
  } };
  await driver.onInit();
  await driver.triggerBedCooledDown('A', null, null);
  await driver.triggerBedCooledDown('A', null, null);
  await driver.triggerBedCooledDown('B', null, null);
  await driver.triggerEstimatedEndTime('A', { time: 'tomorrow' }, null);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].id, 'estimated_end_time_changed');
  for (const card of require('../app.json').flow.actions) assert(actions.has(card.id), card.id);
  for (const card of require('../app.json').flow.conditions) assert(conditions.has(card.id), card.id);
  let target;
  await actions.get('target_temperature_set_chamber')({ device: { targetTemperatureChamberRunListener: async args => { target = args.target_temperature; } }, target_temperature: 50 });
  assert.equal(target, 50);
});

test('pairing verifies authenticated printer access and rejects a wrong API key', async () => {
  const { API } = apiFixture(url => url.endsWith('/api/server') ? response({ version: '1.10' }) : response('', 401));
  const Driver = load('drivers/octoprint/driver.js', { '../../lib/octoprint.js': { OctoprintAPI: API } });
  const driver = new Driver(); driver.log = () => {};
  const handlers = new Map();
  await driver.onPair({ setHandler: (event, fn) => handlers.set(event, fn) });
  await handlers.get('showView')('start');
  await assert.rejects(handlers.get('addOctoprint')({ address: 'http://printer.test', apikey: 'bad' }), /401/);
});

test('snapshot reuse, disable, re-enable and deletion clean up images', async () => {
  const { device, settings, images, videos, requests } = deviceFixture(() => response('image-bytes'));
  await device.configureCameras(settings);
  assert.equal(images.length, 1);
  await device.configureCameras(settings);
  assert.equal(images.length, 1);
  let data = '';
  await images[0].callback(new Writable({ write(chunk, encoding, callback) { data += chunk; callback(); } }));
  assert.equal(data, 'image-bytes');
  await device.configureCameras({ ...settings, snapshot_url: '/new' });
  assert.equal(images.length, 1);
  assert.equal(images[0].updates, 1);
  await device.configureCameras({ ...settings, snapshot_active: false });
  assert.equal(images[0].unregistered, 1);
  await assert.rejects(images[0].callback(new PassThrough()), /snapshot_failed/);
  assert.equal(requests.length, 1);
  await device.configureCameras(settings);
  assert.equal(images.length, 2);
  await device.onDeleted();
  assert.equal(images[1].unregistered, 1);
  assert.equal(videos[0].unregistered, 1);
  await device.onUninit();
  assert.equal(videos[0].unregistered, 1);
});

test('camera failures retry, and snapshot failure does not prevent video registration', async () => {
  const { device, settings, images, videos } = deviceFixture();
  device.setCameraImage = async () => { throw new Error('registration failed'); };
  await device.configureCameras(settings);
  assert.equal(images[0].unregistered, 1);
  assert.equal(videos.length, 1);
  device.setCameraImage = async () => {};
  await device.configureCameras();
  assert.equal(images.length, 2);
  await device.onUninit();
});

test('video settings use new values immediately, never request camera status, and redact logs', async () => {
  const { device, settings, videos, requests, logs } = deviceFixture();
  await device.configureCameras({ ...settings, stream_mode: 'custom', stream_url: 'rtsp://user:password@cam.test/live?token=secret' });
  assert.equal(videos[0].type, 'RTSP');
  assert.equal((await videos[0].url()).url, 'rtsp://user:password@cam.test/live?token=secret');
  assert.equal(requests.length, 0);
  assert(!/password|token=secret/.test(JSON.stringify(logs)));
  await device.onSettings({ oldSettings: settings, newSettings: { ...settings, stream_active: false, snapshot_active: false }, changedKeys: ['stream_active', 'snapshot_active'] });
  assert.equal(videos[0].unregistered, 1);
  await assert.rejects(videos[0].url(), /no longer active/);
});

test('invalid camera credentials in URLs are not exposed and do not block telemetry', async () => {
  const { device, settings, logs } = deviceFixture();
  await device.configureCameras({ ...settings, stream_mode: 'custom', stream_url: 'http://user:secret@[invalid' });
  assert(logs.some(entry => String(entry).includes('Invalid camera URL')));
  assert(!JSON.stringify(logs).includes('secret'));
  assert.throws(() => device.octoprint.getStreamUrl('http://user:secret@[invalid'), error => {
    assert.equal(error.message, 'Invalid camera URL');
    assert.equal(error.input, undefined);
    return true;
  });
  await device.onUninit();
});

test('camera configuration serializes concurrent updates without leaking instances', async () => {
  const { device, settings, images, videos } = deviceFixture();
  await Promise.all([device.configureCameras(settings), device.configureCameras(settings), device.configureCameras(settings)]);
  assert.equal(images.length, 1);
  assert.equal(videos.length, 1);
  await device.onUninit();
});

test('failed video attachment is cleaned up and retried', async () => {
  const { device, settings, videos } = deviceFixture();
  device.setCameraVideo = async () => { throw new Error('failed'); };
  await device.configureCameras(settings);
  assert.equal(videos[0].unregistered, 1);
  device.setCameraVideo = async () => {};
  await device.configureCameras();
  assert.equal(videos.length, 2);
  await device.onUninit();
});

test('Auto avoids the unsupported Matroska proxy path and preserves direct video opt-out', async () => {
  const { device, settings, videos, requests, logs } = deviceFixture();
  await device.configureCameras({ ...settings, webrtc_data_channel: true });
  assert.equal(videos[0].type, 'Other');
  assert.equal(videos[0].options.disableWebRTCProxy, false);
  assert.equal(videos[0].offer, undefined);
  assert.equal((await videos[0].url()).url, 'https://printer.test/webcam/video.h264');
  assert.equal(requests.length, 0);
  assert.equal(logs.find(entry => entry[0] === 'Configuring stream video')[1].webrtcDataChannel, false);
  await device.configureCameras({ ...settings, disable_webrtc_proxy: true });
  assert.equal(videos[0].unregistered, 1);
  assert.equal(videos[1].type, 'Other');
  assert.equal(videos[1].options.disableWebRTCProxy, true);
  assert.equal((await videos[1].url()).url, 'https://printer.test/webcam/video');
  for (const [mode, type, endpoint] of [['mkv', 'Other', 'video.mkv'], ['mp4', 'Other', 'video.mp4'], ['hls', 'HLS', 'video.m3u8']]) {
    await device.configureCameras({ ...settings, stream_mode: mode });
    const video = videos.at(-1);
    assert.equal(video.type, type);
    assert.equal((await video.url()).url, `https://printer.test/webcam/${endpoint}`);
  }
  await device.onUninit();
});

test('WebRTC offer exchange uses the current endpoint and expected SDP contract', async () => {
  const { device, settings, videos, requests } = deviceFixture(() => response({ sdp: 'v=0\r\na=H264', id: 'stream1' }));
  await device.configureCameras({ ...settings, stream_mode: 'webrtc_native' });
  assert.equal(videos[0].options.dataChannel, false);
  const answer = await videos[0].offer('v=0\r\na=offer');
  assert.equal(answer.answerSdp, 'v=0\r\na=H264');
  assert.equal(answer.streamId, 'stream1');
  assert.equal(requests[0].url, 'https://printer.test/webcam/webrtc');
  assert.deepEqual(JSON.parse(requests[0].options.body), { type: 'offer', sdp: 'v=0\r\na=offer', keepAlive: false });
  await device.onUninit();
});

test('connection changes replace the client and restart only one polling loop', async () => {
  const { device, settings, api } = deviceFixture();
  let starts = 0;
  device.startPolling = () => { starts++; };
  await device.onSettings({ oldSettings: settings, newSettings: { ...settings, address: 'http://new.test', apikey: 'new-key' }, changedKeys: ['address', 'apikey'] });
  assert.equal(api._disposed, true);
  assert.equal(device.octoprint.address, 'http://new.test');
  assert.equal(device.octoprint.apikey, 'new-key');
  assert.equal(starts, 1);
  assert.equal(device.printer.state, null);
  await device.onUninit();
});

test('polling recovers after failures, remains single-instance, and stops promptly', async () => {
  const { device } = deviceFixture();
  device.configureCameras = async () => {};
  let calls = 0;
  device.pollOnce = async () => { calls++; if (calls === 1) throw new Error('temporary outage'); device.polling = false; };
  device.waitForPoll = async () => {};
  device.startPolling(); device.startPolling();
  await device._pollPromise;
  assert.equal(calls, 2);
  const other = deviceFixture().device;
  other.polling = true;
  const waiting = other.waitForPoll(60000);
  await other.stopPolling();
  await waiting;
  assert.equal(other._pollWake, null);
});

test('all command Flow listeners await delivery and propagate rejection', async () => {
  for (const [method, state, args] of [
    ['cancelPrintRunListener', 'Printing', {}], ['displayMessageRunListener', 'Operational', { message: 'hello' }],
    ['sendGcodeRunListener', 'Operational', { gcode: 'G28; G1 X1' }], ['homePrinterRunListener', 'Operational', { axis: 'X' }],
    ['moveAxisRunListener', 'Operational', { axis: 'X', position: 1 }], ['emergencyStopRunListener', 'Operational', {}],
    ['targetTemperatureBedRunListener', 'Operational', { target_temperature: 0 }], ['targetTemperatureToolRunListener', 'Operational', { target_temperature: 0 }],
    ['rebootRaspberryRunListener', 'Operational', {}], ['shutdownRaspberryRunListener', 'Offline', {}],
  ]) {
    const { device } = deviceFixture(); device.printer.state = state;
    let finish, done = false;
    device.octoprint.postData = () => new Promise(resolve => { finish = resolve; });
    const command = device[method](args).then(value => { done = true; return value; });
    await flush(); assert.equal(done, false, method);
    finish(null); assert.equal(await command, true, method);
    device.octoprint.postData = async () => { throw new Error('delivery failed'); };
    await assert.rejects(device[method](args), /delivery failed/, method);
  }
});

test('capability controls propagate failures and chamber Flow uses the existing listener', async () => {
  const { device, listeners } = deviceFixture(() => response({ current: { state: 'Operational' } }));
  device.startPolling = () => {};
  await device.onInit();
  device.printer.server = '1.10'; device.printer.state = 'Operational';
  const sent = [];
  device.octoprint.postData = async (url, payload) => sent.push({ url, payload });
  assert.equal(await device.targetTemperatureChamberRunListener({ target_temperature: 0 }), true);
  assert.equal(sent[0].url, '/api/printer/chamber');
  assert.equal(sent[0].payload.target, 0);
  device.octoprint.postData = async () => { throw new Error('HTTP 500'); };
  for (const key of ['onoff', 'button.restart_octoprint', 'button.reboot_raspberry', 'button.shutdown_raspberry', 'target_temperature.bed', 'target_temperature.tool', 'target_temperature.chamber', 'emergency_stop_m112']) {
    await assert.rejects(listeners.get(key)(key.startsWith('target') ? 50 : true), /HTTP 500/, key);
  }
  await assert.rejects(device.targetTemperatureChamberRunListener({ target_temperature: 76 }), /invalid_value/);
  await device.onUninit();
  assert.equal(device._timers.size, 0);
});

test('mixed semicolon spacing splits every G-code without mutating Flow arguments', async () => {
  const { device } = deviceFixture();
  let body; device.octoprint.postData = async (url, data) => { body = data; };
  const args = { gcode: 'G28 ; G1 X1;G1 Y2; ' };
  await device.sendGcodeRunListener(args);
  assert.deepEqual(Array.from(body.commands), ['G28', 'G1 X1', 'G1 Y2']);
  assert.equal(args.gcode, 'G28 ; G1 X1;G1 Y2; ');
});

test('rounded telemetry does not repeatedly trigger and target zero still triggers', async () => {
  const { device, values, capabilities } = deviceFixture();
  capabilities.add('measure_temperature.bed');
  capabilities.add('target_temperature.bed');
  const calls = [];
  device.driver = new Proxy({}, { get: (target, name) => async () => calls.push(name) });
  device.octoprint.getPrinterTemps = async () => ({ bed: { actual: 20.3, target: 0 }, tool0: { actual: 25.4, target: 0 }, chamber: { actual: 23.4, target: 0 } });
  values.set('target_temperature.bed', 50);
  await device.setPrinterTemps();
  assert(calls.includes('triggerBedTarget'));
  const firstCount = calls.length;
  await device.setPrinterTemps();
  assert.equal(calls.length, firstCount);
});

test('every widget route has a handler and listDevices returns the app devices', async () => {
  const api = require('../widgets/octoprint/api.js');
  for (const name of Object.keys(require('../widgets/octoprint/widget.compose.json').api)) assert.equal(typeof api[name], 'function', name);
  const devices = [{ id: 'printerA', name: 'Printer A' }];
  assert.deepEqual(await api.listDevices({ homey: { app: { getAllOctoPrintDevices: () => devices } } }), devices);
});

test('app supports older Homey without dashboards and preserves zero temperatures', async () => {
  const App = load('app.js'); const app = new App(); app.log = () => {};
  app.homey = {};
  await app.onInit();
  app.homey.drivers = { getDriver: () => ({ getDevices: () => [{ getData: () => ({ id: 'a' }), getName: () => 'A', getCapabilityValue: () => 0 }] }) };
  assert.equal(app.getOctoPrintDeviceDataById('a').bedTemp, 0);
});
