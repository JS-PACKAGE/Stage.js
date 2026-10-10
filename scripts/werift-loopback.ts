import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from 'werift';
import { loadConfig, samplesPerFrame } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { MixerCounters } from '../src/metrics.ts';
import { MixerClock } from '../src/mixer/MixerClock.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { opusCodec } from '../src/transport/peerHost.ts';
import { WeriftMediaTransport } from '../src/transport/WeriftMediaTransport.ts';
import { OpusEncoder, OpusDecoder } from '../src/transport/opus.ts';
// Optional argv[2] = rtc.mediaWorkers, so both the in-process and the sharded peer hosts get exercised.
const config = loadConfig('config.example.yaml'); config.rtc.serverIceServers = [];
if (process.argv[2] !== undefined) config.rtc.mediaWorkers = Number(process.argv[2]);
const mixer = new RoomMixer({ ...config.audio, ...config.audio.mixer, ...config.audio.jitter });
const clients = new Map<string, RTCPeerConnection>();
const transport = new WeriftMediaTransport(config, { onLocalCandidate() {} }, silentLogger);
const encoder = new OpusEncoder(config.audio);
let timer: NodeJS.Timeout | undefined;
try {
  let audienceEnergy = 0, selfEnergy = 0, received = 0, rejectedFrames = 0;
  mixer.addSource('speaker');
  transport.addPublisher('room', 'speaker', pcm => mixer.push('speaker', pcm));
  transport.addPublisher('room', 'blocked', () => { rejectedFrames++; });
  transport.setMixedStream('room', mixer);
  const tracks = new Map<string, MediaStreamTrack>();
  for (const id of ['speaker', 'audience', 'blocked']) {
    const client = new RTCPeerConnection({ codecs: { audio: [opusCodec(config.audio)], video: [] }, iceServers: [] }); clients.set(id, client);
    const decoder = new OpusDecoder(config.audio.sampleRate);
    client.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => {
      const samples = decoder.decode(packet.payload);
      const energy = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
      if (id === 'audience') { audienceEnergy = Math.max(audienceEnergy, energy); received++; }
      if (id === 'speaker') selfEnergy = Math.max(selfEnergy, energy);
    }));
    if (id === 'audience') client.addTransceiver('audio', { direction: 'recvonly' });
    else { const track = new MediaStreamTrack({ kind: 'audio' }); tracks.set(id, track); client.addTransceiver(track, { direction: 'sendrecv' }); }
    await client.setLocalDescription(await client.createOffer());
    // Browsers put no SSRC in a recvonly offer; werift does. Strip it so the server first learns the
    // SSRC on renegotiation, exactly as with Chrome (regression: promoted speaker's uplink was dropped).
    const sdp = id === 'audience' ? client.localDescription!.sdp.split('\r\n').filter(l => !/^a=(ssrc|ssrc-group|msid):/.test(l)).join('\r\n') : client.localDescription!.sdp;
    const answer = await transport.negotiate('room', id, { type: 'offer', sdp }, { allowUplink: id === 'speaker' });
    await client.setRemoteDescription(answer); transport.subscribe('room', id);
  }
  const deadline = performance.now() + 15000;
  while ([...clients.values()].some(pc => pc.connectionState !== 'connected')) { if (performance.now() > deadline) throw new Error('ICE connection timed out'); await sleep(50); }
  let seq = 0, timestamp = 0;
  const pcm = Float32Array.from({ length: samplesPerFrame(config.audio) }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / config.audio.sampleRate));
  timer = setInterval(() => {
    const payload = encoder.encode(pcm);
    for (const [id, track] of tracks) {
      const sender = clients.get(id)!.getSenders()[0]!;
      track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: sender.codec!.payloadType, sequenceNumber: seq & 65535, timestamp, ssrc: sender.ssrc }), payload));
    }
    seq++; timestamp += Math.round(48000 * config.audio.frameMs / 1000);
  }, config.audio.frameMs);
  mixer.start(new MixerClock(config.audio.frameMs, new MixerCounters())); await sleep(1800);
  assert.ok(received > 20, `received only ${received} packets`);
  assert.ok(audienceEnergy > 0.001, `audience audio silent (${audienceEnergy})`);
  assert.ok(selfEnergy < 0.00001, `mix-minus leaked own audio (${selfEnergy})`);
  assert.equal(rejectedFrames, 0);
  const blockedStats = await clients.get('blocked')!.getStats();
  let blockedPacketsSent = 0;
  for (const stat of blockedStats.values()) {
    if (stat.type === 'outbound-rtp' && 'packetsSent' in stat && typeof stat.packetsSent === 'number') blockedPacketsSent += stat.packetsSent;
  }
  assert.ok(blockedPacketsSent > 20, 'Blocked peer did not actually transmit illicit RTP');
  // Renegotiate the existing audience peer onto stage: uplink must actually be routed (audience → speaker),
  // then stop again once demoted.
  const audience = clients.get('audience')!;
  const transceiver = audience.getTransceivers()[0]!;
  const promotedTrack = new MediaStreamTrack({ kind: 'audio' });
  await transceiver.sender.replaceTrack(promotedTrack);
  let promotedFrames = 0;
  transport.addPublisher('room', 'audience', () => { promotedFrames++; });
  const sendPromoted = async (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      promotedTrack.writeRtp(new RtpPacket(new RtpHeader({ payloadType: transceiver.sender.codec!.payloadType, sequenceNumber: seq++ & 65535, timestamp, ssrc: transceiver.sender.ssrc }), encoder.encode(pcm)));
      timestamp += Math.round(48000 * config.audio.frameMs / 1000);
      await sleep(config.audio.frameMs);
    }
  };
  const renegotiate = async (allowUplink: boolean) => {
    transceiver.direction = allowUplink ? 'sendrecv' : 'recvonly';
    await audience.setLocalDescription(await audience.createOffer());
    await audience.setRemoteDescription(await transport.negotiate('room', 'audience', { type: 'offer', sdp: audience.localDescription!.sdp }, { allowUplink }));
  };
  await renegotiate(true);
  await sendPromoted(600);
  assert.ok(promotedFrames > 10, `promoted speaker uplink not routed after renegotiation (${promotedFrames} frames)`);
  await renegotiate(false);
  const framesAtDemotion = promotedFrames;
  await sendPromoted(300);
  assert.equal(promotedFrames, framesAtDemotion, 'demoted participant uplink still reaches the mixer');
  // ICE restart from the client side (what StageClient does after 3 s of `disconnected`): the server
  // peer must notice the new ufrag, re-run ICE on the same PeerConnection and keep delivering audio.
  const speaker = clients.get('speaker')!;
  const packetsBeforeRestart = received;
  const restartOffer = await speaker.createOffer({ iceRestart: true });
  await speaker.setLocalDescription(restartOffer);
  await speaker.setRemoteDescription(await transport.negotiate('room', 'speaker', { type: 'offer', sdp: speaker.localDescription!.sdp }, { allowUplink: true }));
  const restartDeadline = performance.now() + 10000;
  while (speaker.connectionState !== 'connected') { if (performance.now() > restartDeadline) throw new Error('ICE restart did not reconnect'); await sleep(50); }
  const audienceBefore = received;
  audienceEnergy = 0;
  await sleep(600);
  assert.ok(received > audienceBefore + 10 && audienceEnergy > 0.001, `audience lost the speaker after their ICE restart (${received - audienceBefore} packets, energy ${audienceEnergy})`);
  console.log(`PASS mediaWorkers=${config.rtc.mediaWorkers} packets=${received} audienceEnergy=${audienceEnergy.toFixed(6)} selfEnergy=${selfEnergy.toFixed(6)} blockedPacketsSent=${blockedPacketsSent} blockedFrames=${rejectedFrames}; renegotiation promotedFrames=${promotedFrames}; iceRestart packetsAfter=${received - packetsBeforeRestart} PASS`);
} catch (error) { console.error('FAIL', error); process.exitCode = 1; }
finally {
  clearInterval(timer); mixer.stop();
  await transport.close(); await Promise.all([...clients.values()].map(client => client.close()));
}
