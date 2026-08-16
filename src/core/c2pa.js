const SDK_VERSION = '0.13.0';
const SDK_URL = `https://cdn.jsdelivr.net/npm/@contentauth/c2pa-web@${SDK_VERSION}/+esm`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@contentauth/c2pa-web@${SDK_VERSION}/dist/resources/c2pa_bg.wasm`;

let c2paPromise;

function deepCollectStatuses(value, output = [], depth = 0) {
  if (!value || depth > 8) return output;
  if (Array.isArray(value)) {
    for (const item of value) deepCollectStatuses(item, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    if (/validation.*status|status.*validation/i.test(key) && Array.isArray(item)) {
      for (const status of item) {
        if (typeof status === 'string') output.push(status);
        else if (status && typeof status === 'object') {
          output.push(status.code || status.status || status.url || JSON.stringify(status));
        }
      }
    } else if (depth < 5) deepCollectStatuses(item, output, depth + 1);
  }
  return output;
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function getActiveManifest(store) {
  if (!store || typeof store !== 'object') return { id: null, manifest: null };
  const id = store.active_manifest || store.activeManifest || store.active_manifest_label || null;
  const manifests = store.manifests || store.manifest_store || {};
  return { id, manifest: id && manifests ? manifests[id] || null : null };
}

function claimGenerator(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const info = manifest.claim_generator_info || manifest.claimGeneratorInfo;
  if (Array.isArray(info) && info[0]) return info[0].name || info[0].version || null;
  return manifest.claim_generator || manifest.claimGenerator || null;
}

export async function loadC2paSdk() {
  if (typeof window === 'undefined') throw new Error('C2PA browser validation is not available in this environment.');
  if (!c2paPromise) {
    c2paPromise = import(SDK_URL).then(async (module) => {
      if (typeof module.createC2pa !== 'function') throw new Error('The C2PA SDK entry point was not found.');
      return module.createC2pa({ wasmSrc: WASM_URL });
    });
  }
  return c2paPromise;
}

export async function verifyC2pa(bytes, mimeType) {
  const c2pa = await loadC2paSdk();
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
  let reader;
  try {
    reader = await c2pa.reader.fromBlob(blob.type, blob);
    const store = await reader.manifestStore();
    if (!store) {
      return {
        sdkVersion: SDK_VERSION,
        status: 'unsigned',
        present: false,
        summary: 'No Content Credentials manifest was found.',
        store: null,
        validationCodes: []
      };
    }
    const { id, manifest } = getActiveManifest(store);
    const validationCodes = [...new Set(deepCollectStatuses(store).filter(Boolean))];
    const invalid = validationCodes.some((code) => /invalid|mismatch|failure|error|tamper|hardBinding/i.test(String(code)));
    return {
      sdkVersion: SDK_VERSION,
      status: invalid ? 'invalid' : 'valid',
      present: true,
      activeManifest: id,
      claimGenerator: claimGenerator(manifest),
      validationCodes,
      summary: invalid
        ? 'A manifest was found, but the SDK reported validation problems.'
        : 'A Content Credentials manifest was read without a reported validation failure.',
      store: safeJson(store)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/manifest|jumbf|not found|unsupported/i.test(message)) {
      return {
        sdkVersion: SDK_VERSION,
        status: 'unsigned',
        present: false,
        summary: 'No readable Content Credentials manifest was found.',
        error: message,
        validationCodes: []
      };
    }
    throw error;
  } finally {
    if (reader && typeof reader.free === 'function') await reader.free();
  }
}

export const C2PA_SDK_VERSION = SDK_VERSION;
