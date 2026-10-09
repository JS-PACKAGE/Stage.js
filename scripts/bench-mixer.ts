import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { OpusEncoder } from '../src/transport/opus.ts';
import { RtpHeader, RtpPacket } from 'werift';
import { loadConfig, samplesPerFrame } from '../src/config.ts';
const config = loadConfig('config.example.yaml');
const rows: Record<string, number | string>[] = [];
for (const publishers of [3, 8]) {
  const mixer = new RoomMixer({ ...config.audio, ...config.audio.mixer, ...config.audio.jitter });
  const fullEncoder = new OpusEncoder(config.audio);
  const encoders = Array.from({ length: publishers }, () => new OpusEncoder(config.audio));
  const pcm = Array.from({ length: publishers }, (_, id) => Float32Array.from({ length: samplesPerFrame(config.audio) }, (_, i) => 0.08 * Math.sin(2 * Math.PI * (220 + id * 70) * i / config.audio.sampleRate) + 0.01 * (Math.random() * 2 - 1)));
  for (let i = 0; i < publishers; i++) mixer.addSource(String(i));
  const cpu: number[] = [], latency: number[] = [];
  let bytes = 0;
  let sequence = 0, timestamp = 0;
  for (let tick = 0; tick < 500; tick++) {
    const pushed = performance.now();
    for (let i = 0; i < publishers; i++) mixer.push(String(i), pcm[i]!);
    const start = performance.now();
    const frame = mixer.tick()!;
    const full = fullEncoder.encode(frame.full);
    for (let i = 0; i < 300 + publishers; i++) {
      const payload = i < publishers ? encoders[i]!.encode(frame.minus(String(i))!) : full;
      const packet = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: sequence & 65535, timestamp, ssrc: i + 1 }), payload);
      // Fake sink consumes serialized RTP, including real packetization work.
      bytes += packet.serialize().length;
    }
    sequence++; timestamp += Math.round(48000 * config.audio.frameMs / 1000);
    if (tick >= 20) { cpu.push(performance.now() - start); latency.push(performance.now() - pushed); }
  }
  cpu.sort((a, b) => a - b); latency.sort((a, b) => a - b);
  const p95 = latency[Math.floor(latency.length * 0.95)]!;
  rows.push({ publishers, subscribers: 300, 'CPU avg ms': +(cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(3), 'CPU p95 ms': +cpu[Math.floor(cpu.length * 0.95)]!.toFixed(3), 'push→packet p95 ms': +p95.toFixed(3), 'push→packet max ms': +latency.at(-1)!.toFixed(3), bytes, gate: latency.at(-1)! <= config.audio.mixer.latencyTargetMs ? 'PASS' : 'FAIL' });
}
console.table(rows);
if (rows.some(row => row.gate === 'FAIL')) process.exitCode = 1;
