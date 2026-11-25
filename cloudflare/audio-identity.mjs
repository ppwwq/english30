export function wantsAudioDigest(method, path, verify) {
  return method === 'HEAD' && verify === '1' && /^\/audio\/paper-[a-z0-9-]+\.mp3$/.test(path);
}

// A duration estimate can vary by decoder. Identify the bytes actually served
// without making the student download the full recording a second time.
export async function audioDigestHeaders(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    'X-English30-Audio-SHA256': hex,
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
    ETag: '"' + hex + '"',
  };
}
