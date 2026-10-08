/** Smooth knee with unity gain below threshold and a bounded asymptote. */
export function limitInPlace(samples: Float32Array, threshold: number): Float32Array {
  if (!(threshold > 0 && threshold < 1)) throw new RangeError('Limiter threshold must be between 0 and 1');
  const headroom = 1 - threshold;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!;
    const magnitude = Math.abs(x);
    if (magnitude > threshold) samples[i] = Math.sign(x) * (threshold + headroom * Math.tanh((magnitude - threshold) / headroom));
  }
  return samples;
}
