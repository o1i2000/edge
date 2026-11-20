// device.js - the two ways to talk to a Progressor: real Bluetooth (Web Bluetooth) and a scripted demo.
import {
  SERVICE_UUID, DATA_UUID, CONTROL_UUID, CMD, createDecoder, decodeText, decodeU32,
} from './core.js';
import { mulberry32, scenarioForce } from './demo.js';

class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }
  emit(type, data) {
    (this.handlers[type] || []).forEach((fn) => fn(data));
  }
}

export class ProgressorBLE extends Emitter {
  constructor({ showAll = false } = {}) {
    super();
    this.showAll = showAll;
    this.decoder = createDecoder();
    this.pending = [];
    this.name = '';
  }
  static supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }
  async connect() {
    const options = this.showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ namePrefix: 'Progressor' }], optionalServices: [SERVICE_UUID] };
    this.dev = await navigator.bluetooth.requestDevice(options);
    this.name = this.dev.name || 'Progressor';
    this.dev.addEventListener('gattserverdisconnected', () => this.emit('disconnect'));
    await this._open();
  }
  async reconnect() {
    await this._open();
  }
  async _open() {
    const server = await this.dev.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.data = await service.getCharacteristic(DATA_UUID);
    this.ctrl = await service.getCharacteristic(CONTROL_UUID);
    this.data.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target.value));
    await this.data.startNotifications(); // must be on before the Progressor will send anything
  }
  _onData(dv) {
    const msg = this.decoder.decode(dv);
    if (msg.kind === 'samples') this.emit('samples', msg.samples);
    else if (msg.kind === 'lowPower') this.emit('lowPower');
    else if (msg.kind === 'response') {
      const entry = this.pending.shift();
      if (entry) {
        clearTimeout(entry.timer);
        entry.resolve(entry.decode(msg.payload));
      }
    }
  }
  async send(cmd) {
    const bytes = new Uint8Array([cmd]);
    try {
      await this.ctrl.writeValueWithResponse(bytes);
    } catch (err) {
      if (err?.name === 'NetworkError') throw err;
      await this.ctrl.writeValue(bytes);
    }
  }
  // Only commands that are known to answer (version, battery, error log) go through request();
  // replies carry no id, so these must be sent one at a time.
  request(cmd, decode, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const entry = { decode, resolve };
      const drop = () => (this.pending = this.pending.filter((e) => e !== entry));
      entry.timer = setTimeout(() => {
        drop();
        reject(new Error('The Progressor did not reply'));
      }, timeout);
      this.pending.push(entry);
      this.send(cmd).catch((err) => {
        clearTimeout(entry.timer);
        drop();
        reject(err);
      });
    });
  }
  tare() {
    return this.send(CMD.TARE);
  }
  start() {
    this.decoder.reset();
    return this.send(CMD.START);
  }
  stop() {
    return this.send(CMD.STOP);
  }
  version() {
    return this.request(CMD.GET_VERSION, decodeText);
  }
  battery() {
    return this.request(CMD.GET_BATTERY, decodeU32); // millivolts
  }
  sleep() {
    return this.send(CMD.SLEEP);
  }
  disconnect() {
    if (this.dev?.gatt?.connected) this.dev.gatt.disconnect();
  }
}

/** Same interface as ProgressorBLE, but it synthesises real packet bytes so the whole decode path is exercised. */
export class ProgressorSim extends Emitter {
  constructor({ speed = 1 } = {}) {
    super();
    this.speed = speed;
    this.name = 'Demo Progressor';
    this.decoder = createDecoder();
    this.timer = null;
  }
  async connect() {}
  async reconnect() {}
  async tare() {}
  async version() {
    return 'demo';
  }
  async battery() {
    return 2950;
  }
  async sleep() {
    await this.stop();
  }
  async start() {
    this.decoder.reset();
    this.rng = mulberry32(7);
    const hz = 80;
    const per = 8;
    let idx = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const dv = new DataView(new ArrayBuffer(2 + per * 8));
      dv.setUint8(0, 1);
      dv.setUint8(1, per * 8);
      for (let k = 0; k < per; k++, idx++) {
        const t = idx / hz;
        dv.setFloat32(2 + k * 8, scenarioForce(t, this.rng), true);
        dv.setUint32(6 + k * 8, Math.round(t * 1e6) >>> 0, true);
      }
      const msg = this.decoder.decode(dv);
      if (msg.kind === 'samples') this.emit('samples', msg.samples);
    }, (per / hz) * 1000 / this.speed);
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  disconnect() {
    clearInterval(this.timer);
    this.emit('disconnect');
  }
}
