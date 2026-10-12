import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient, StageError } from '../src/index.ts';
import type { RoomStatePayload } from '../../../shared/protocol.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class Peer {
  static instances: Peer[] = [];
  connectionState = 'new';
  signalingState = 'stable';
  localDescription = null;
  closed = false;
  readonly replacements: unknown[] = [];
  readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, replaceTrack: async (track: unknown) => {
    this.replacements.push(track); this.transceiver.sender.track = track;
  } } };
  constructor() { Peer.instances.push(this); }
  addTransceiver() { return this.transceiver; }
  close() { this.closed = true; }
}
class Context {
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
  async resume() {}
  async close() {}
}
function stream() {
  const track = { enabled: true, stops: 0, stop() { this.stops++; } };
  return { track, value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream };
}
function state(onStage: boolean, id: string): RoomStatePayload {
  return { roomId: id, name: id, controllerId: 'host', speakers: [], hands: [], audienceCount: 0,
    codeRequired: false, limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live',
    me: { participantId: id, name: id, role: onStage ? 'speaker' : 'audience', onStage,
      handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 0 } };
}

describe('media task generation isolation', () => {
  let originals: Map<string, PropertyDescriptor | undefined>;
  let requests: ReturnType<typeof deferred<MediaStream>>[];
  let client: StageClient;
  let negotiations: number;
  beforeEach(() => {
    originals = new Map(['window', 'navigator', 'RTCPeerConnection', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    requests = []; Peer.instances = []; negotiations = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => {
      const request = deferred<MediaStream>(); requests.push(request); return request.promise;
    } } } });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    const audio = { volume: 1, muted: false, pause() {}, srcObject: null } as unknown as HTMLAudioElement;
    client = new StageClient({ url: 'ws://localhost/ws', audioElement: audio });
    client['negotiate'] = () => { negotiations++; };
  });
  afterEach(async () => {
    await client.disconnect();
    for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  });
  it('lets a replacement audience peer negotiate while the old microphone prompt is still pending', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    assert.equal(requests.length, 1);
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(false, 'new') }); await settle();
    assert.equal(Peer.instances.length, 2);
    assert.equal(Peer.instances[0]!.closed, true);
    assert.equal(negotiations, 1);
    assert.equal(Peer.instances[1]!.replacements.length, 1);
    const oldStream = stream(); requests[0]!.resolve(oldStream.value); await settle();
    assert.equal(oldStream.track.stops, 1);
    assert.equal(client['mic'], null);
    assert.equal(Peer.instances[1]!.replacements.length, 1);
  });

  it('stops a late old stream without stopping the replacement peer microphone', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(true, 'new') }); await settle();
    assert.equal(requests.length, 2);
    const current = stream(); requests[1]!.resolve(current.value); await settle();
    assert.equal(client['mic'], current.value);
    assert.equal(Peer.instances[1]!.transceiver.sender.track, current.track);
    const retired = stream(); requests[0]!.resolve(retired.value); await settle();
    assert.equal(retired.track.stops, 1);
    assert.equal(current.track.stops, 0);
    assert.equal(client['mic'], current.value);
    assert.equal(negotiations, 1);
  });

  it('ignores late permission rejection from a retired peer', async () => {
    const failures: unknown[] = [];
    client.on('micerror', event => failures.push(event.detail));
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(false, 'new') }); await settle();
    requests[0]!.reject(new DOMException('denied', 'NotAllowedError')); await settle();
    assert.deepEqual(failures, []);
    assert.equal(client['micFailed'], false);
    assert.equal(negotiations, 1);
  });

  it('rejects queued old device changes before they can mutate replacement preferences', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    const oldChange = client.setInputDevice('retired-device');
    const rejected = assert.rejects(oldChange, error => error instanceof StageError && error.code === 'disconnected');
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(false, 'new') }); await settle();
    await client.setInputDevice('current-device');
    await rejected;
    assert.equal(client['inputDeviceId'], 'current-device');
    assert.equal(requests.length, 1, 'cancelled queued change never asks for another microphone');
    const retired = stream(); requests[0]!.resolve(retired.value); await settle();
    assert.equal(retired.track.stops, 1);
    assert.equal(client['inputDeviceId'], 'current-device');
  });

  it('rejects an active old device permission wait promptly and disposes its late stream', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    const original = stream(); requests[0]!.resolve(original.value); await settle();
    const change = client.setInputDevice('retired-device'); await settle();
    assert.equal(requests.length, 2);
    const rejected = assert.rejects(change, error => error instanceof StageError && error.code === 'disconnected');
    await client.disconnect(); await rejected;
    assert.equal(original.track.stops, 1);
    await client['receive']({ type: 'room:state', ...state(false, 'new') }); await settle();
    await client.setInputDevice('current-device');
    const retired = stream(); requests[1]!.resolve(retired.value); await settle();
    assert.equal(retired.track.stops, 1);
    assert.equal(client['inputDeviceId'], 'current-device');
    assert.equal(client['mic'], null);
  });

  it('keeps same-peer device changes serialized', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'same') }); await settle();
    const original = stream(); requests[0]!.resolve(original.value); await settle();
    const first = client.setInputDevice('first'), second = client.setInputDevice('second'); await settle();
    assert.equal(requests.length, 2);
    const one = stream(); requests[1]!.resolve(one.value); await first; await settle();
    assert.equal(requests.length, 3);
    assert.equal(client['inputDeviceId'], 'first');
    const two = stream(); requests[2]!.resolve(two.value); await second;
    assert.equal(client['inputDeviceId'], 'second');
    assert.equal(original.track.stops, 1);
    assert.equal(one.track.stops, 1);
    assert.equal(two.track.stops, 0);
  });

  it('cleans up an old replaceTrack continuation without touching a newer microphone', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    const original = stream(); requests[0]!.resolve(original.value); await settle();
    const replace = deferred<void>();
    Peer.instances[0]!.transceiver.sender.replaceTrack = async () => replace.promise;
    const change = client.setInputDevice('retired-device'); await settle();
    const retired = stream(); requests[1]!.resolve(retired.value); await settle();
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(true, 'new') }); await settle();
    const current = stream(); requests[2]!.resolve(current.value); await settle();
    replace.resolve(); await change;
    assert.equal(retired.track.stops, 1);
    assert.equal(current.track.stops, 0);
    assert.equal(client['mic'], current.value);
    assert.notEqual(client['inputDeviceId'], 'retired-device');
  });


  it('does not report a retired syncMedia replaceTrack failure against a new peer', async () => {
    const failures: unknown[] = [];
    client.on('error', event => failures.push(event.detail));
    const gate = deferred<void>();
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    Peer.instances[0]!.transceiver.sender.replaceTrack = async () => gate.promise;
    const old = stream(); requests[0]!.resolve(old.value); await settle();
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(false, 'new') }); await settle();
    gate.reject(new Error('old peer closed')); await settle();
    assert.deepEqual(failures, []);
    assert.equal(negotiations, 1);
  });


  it('does not let old queued device work behind browser replaceTrack block or alter a new peer', async () => {
    await client['receive']({ type: 'room:state', ...state(true, 'old') }); await settle();
    const original = stream(); requests[0]!.resolve(original.value); await settle();
    const gate = deferred<void>();
    Peer.instances[0]!.transceiver.sender.replaceTrack = async () => gate.promise;
    const active = client.setInputDevice('old-active'); await settle();
    const retired = stream(); requests[1]!.resolve(retired.value); await settle();
    const queued = client.setInputDevice('old-queued');
    let settled = false;
    void queued.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(queued, error => error instanceof StageError && error.code === 'disconnected');
    await client.disconnect();
    await client['receive']({ type: 'room:state', ...state(false, 'new') }); await settle();
    await client.setInputDevice('current');
    assert.equal(Peer.instances[1]!.replacements.length, 1);
    assert.equal(settled, false, 'an already-running browser replaceTrack is not forcibly cancelled');
    gate.resolve(); await active; await rejected;
    assert.equal(client['inputDeviceId'], 'current');
    assert.equal(requests.length, 2);
    assert.equal(retired.track.stops, 1);
  });

});
