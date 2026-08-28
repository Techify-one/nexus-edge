export const SOLETRANDO_PCM_SAMPLE_RATE = 16_000;

const mergeAndResample = (
  chunks: readonly Float32Array[],
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array => {
  const sourceLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const source = new Float32Array(sourceLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    source.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  if (sourceSampleRate === targetSampleRate) return source;

  const targetLength = Math.max(
    1,
    Math.round((source.length * targetSampleRate) / sourceSampleRate),
  );
  const target = new Float32Array(targetLength);
  const ratio = sourceSampleRate / targetSampleRate;
  for (let index = 0; index < targetLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.min(Math.floor(sourcePosition), source.length - 1);
    const rightIndex = Math.min(leftIndex + 1, source.length - 1);
    const fraction = sourcePosition - leftIndex;
    target[index] =
      source[leftIndex]! * (1 - fraction) + source[rightIndex]! * fraction;
  }
  return target;
};

const writeAscii = (view: DataView, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1)
    view.setUint8(offset + index, value.charCodeAt(index));
};

export function encodeMonoPcm16Wav(
  chunks: readonly Float32Array[],
  sourceSampleRate: number,
): Blob {
  if (
    !chunks.length ||
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0
  )
    throw new Error("PCM recording is empty.");
  const samples = mergeAndResample(
    chunks,
    sourceSampleRate,
    SOLETRANDO_PCM_SAMPLE_RATE,
  );
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SOLETRANDO_PCM_SAMPLE_RATE, true);
  view.setUint32(28, SOLETRANDO_PCM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(
      44 + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}

const ascii = (view: DataView, offset: number, length: number): string => {
  let value = "";
  for (let index = 0; index < length; index += 1)
    value += String.fromCharCode(view.getUint8(offset + index));
  return value;
};

export function extractMonoPcm16Wav(bytes: ArrayBuffer): ArrayBuffer {
  const view = new DataView(bytes);
  if (
    view.byteLength < 44 ||
    ascii(view, 0, 4) !== "RIFF" ||
    ascii(view, 8, 4) !== "WAVE"
  )
    throw new Error("Nova-3 requires PCM WAV audio.");

  let offset = 12;
  let validFormat = false;
  let pcm: ArrayBuffer | null = null;
  while (offset + 8 <= view.byteLength) {
    const chunkId = ascii(view, offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkLength;
    if (dataEnd > view.byteLength) throw new Error("Invalid WAV chunk length.");
    if (chunkId === "fmt " && chunkLength >= 16) {
      validFormat =
        view.getUint16(dataOffset, true) === 1 &&
        view.getUint16(dataOffset + 2, true) === 1 &&
        view.getUint32(dataOffset + 4, true) === SOLETRANDO_PCM_SAMPLE_RATE &&
        view.getUint16(dataOffset + 14, true) === 16;
    } else if (chunkId === "data" && chunkLength > 0) {
      pcm = bytes.slice(dataOffset, dataEnd);
    }
    offset = dataEnd + (chunkLength % 2);
  }
  if (!validFormat || !pcm)
    throw new Error("Nova-3 requires mono PCM WAV at 16 kHz.");
  return pcm;
}
