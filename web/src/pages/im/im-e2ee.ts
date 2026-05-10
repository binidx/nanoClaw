import {
  getDeviceKeys,
  getRoomKeys,
  uploadRoomKeys,
  upsertDeviceKey,
  type ImAttachment,
  type ImDeviceKey,
  type ImEncryptedEnvelope,
  type ImMessage,
} from './im-api';
import { getImSubtleCrypto } from './im-crypto';
import { createImUuid } from './im-random';

const DB_NAME = 'nanoclaw-im-e2ee';
const DB_VERSION = 1;
const DEVICE_STORE = 'devices';
const ROOM_STORE = 'rooms';
const DEVICE_ID_KEY = 'nanoclaw.im.e2ee.deviceId';
const DEVICE_RECORD_KEY = 'local';
const MESSAGE_ALGORITHM = 'AES-GCM-256';
const WRAP_ALGORITHM = 'ECDH-P256+HKDF-SHA256+A256GCM';
const UNREADABLE_TEXT =
  'This device does not have the room key for this encrypted message.';

interface LocalDeviceRecord {
  id: string;
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
}

interface RoomRecord {
  jid: string;
  rawKey: string;
}

interface WrappedRoomKey {
  version: number;
  senderDeviceId: string;
  senderPublicKey: JsonWebKey;
  iv: string;
  ciphertext: string;
}

export interface PlainAttachmentMeta {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  iv: string;
}

export interface ImE2eeUiState {
  enabled: boolean;
  roomKeyAvailable: boolean;
  badgeClass: 'plain' | 'secure' | 'warning';
  badgeText: string;
  headerText: string;
  composerPlaceholder: string;
  aiDisabledReason: string | null;
  historyBoundaryText: string | null;
  unreadableText: string;
}

export interface ImE2eeDeviceStatus {
  deviceId: string;
  currentDeviceRegistered: boolean;
  roomKeyAvailable: boolean;
  serverRoomKeyAvailable: boolean;
  memberDeviceCount: number;
  currentUserDeviceCount: number;
  latestDeviceUpdatedAt: string | null;
  latestRoomKeyCreatedAt: string | null;
}

interface PlainMessagePayload {
  text: string;
  attachments?: PlainAttachmentMeta[];
}

function textEncoder(): TextEncoder {
  return new TextEncoder();
}

function textDecoder(): TextDecoder {
  return new TextDecoder();
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]!);
  }
  return btoa(binary);
}

function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function randomBase64(bytes = 12): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64(data);
}

function getDeviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = createImUuid();
  window.localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

export function getLocalDeviceId(): string {
  return getDeviceId();
}

export function buildImE2eeUiState(input: {
  enabled: boolean;
  roomKeyAvailable?: boolean;
  t: (key: string) => string;
}): ImE2eeUiState {
  if (!input.enabled) {
    return {
      enabled: false,
      roomKeyAvailable: false,
      badgeClass: 'plain',
      badgeText: input.t('im.未加密'),
      headerText: input.t('im.普通会话'),
      composerPlaceholder: input.t('im.输入消息，Enter 发送，可粘贴或拖拽文件'),
      aiDisabledReason: null,
      historyBoundaryText: null,
      unreadableText: input.t(
        'im.此设备缺少房间密钥，暂时无法读取这条加密消息。',
      ),
    };
  }
  const roomKeyAvailable = input.roomKeyAvailable !== false;
  return {
    enabled: true,
    roomKeyAvailable,
    badgeClass: roomKeyAvailable ? 'secure' : 'warning',
    badgeText: roomKeyAvailable
      ? input.t('im.端到端加密')
      : input.t('im.密钥缺失'),
    headerText: roomKeyAvailable
      ? input.t('im.此会话仅从开启后开始保护。')
      : input.t('im.此设备缺少房间密钥，收到密钥后会自动重试解密。'),
    composerPlaceholder: roomKeyAvailable
      ? input.t('im.输入端到端加密消息')
      : input.t('im.等待房间密钥同步后再发送'),
    aiDisabledReason: input.t('im.端到端加密会话中 AI 协作不可用。'),
    historyBoundaryText: input.t(
      'im.历史消息不会回填加密，开启后发送的消息才受保护。',
    ),
    unreadableText: input.t(
      'im.此设备缺少房间密钥，暂时无法读取这条加密消息。',
    ),
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_STORE))
        db.createObjectStore(DEVICE_STORE);
      if (!db.objectStoreNames.contains(ROOM_STORE))
        db.createObjectStore(ROOM_STORE, { keyPath: 'jid' });
    };
    request.onerror = () =>
      reject(request.error || new Error('Failed to open E2EE store'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function idbGet<T>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    req.onsuccess = () => resolve(req.result as T | undefined);
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(
  storeName: string,
  value: unknown,
  key?: IDBValidKey,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req =
      key === undefined
        ? tx.objectStore(storeName).put(value)
        : tx.objectStore(storeName).put(value, key);
    req.onerror = () =>
      reject(req.error || new Error('IndexedDB write failed'));
    tx.onerror = () =>
      reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

async function ensureLocalDevice(): Promise<LocalDeviceRecord> {
  const deviceId = getDeviceId();
  const existing = await idbGet<LocalDeviceRecord>(
    DEVICE_STORE,
    DEVICE_RECORD_KEY,
  );
  if (existing?.privateKey && existing.publicKey && existing.id === deviceId) {
    return existing;
  }
  const subtle = getImSubtleCrypto();
  const pair = (await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const publicKey = await subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
  const privateKey = await subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const record: LocalDeviceRecord = {
    id: deviceId,
    privateKey,
    publicKey,
  };
  await idbPut(DEVICE_STORE, record, DEVICE_RECORD_KEY);
  return record;
}

export async function ensureRegisteredDevice(): Promise<LocalDeviceRecord> {
  const device = await ensureLocalDevice();
  await upsertDeviceKey(device.id, JSON.stringify(device.publicKey));
  return device;
}

async function importAesKey(raw: BufferSource): Promise<CryptoKey> {
  return getImSubtleCrypto().importKey('raw', raw, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function getRoomKey(jid: string): Promise<CryptoKey | null> {
  const record = await idbGet<RoomRecord>(ROOM_STORE, jid);
  if (!record?.rawKey) return null;
  return importAesKey(base64ToBuffer(record.rawKey));
}

async function storeRoomKey(jid: string, key: CryptoKey): Promise<void> {
  const raw = await getImSubtleCrypto().exportKey('raw', key);
  await idbPut(ROOM_STORE, { jid, rawKey: bytesToBase64(raw) });
}

async function createRoomKey(jid: string): Promise<CryptoKey> {
  const key = await getImSubtleCrypto().generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  await storeRoomKey(jid, key);
  return key;
}

async function importPeerPublicKey(
  publicKeyJson: string | JsonWebKey,
): Promise<CryptoKey> {
  const jwk =
    typeof publicKeyJson === 'string'
      ? (JSON.parse(publicKeyJson) as JsonWebKey)
      : publicKeyJson;
  return getImSubtleCrypto().importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

async function deriveWrappingKey(input: {
  jid: string;
  privateKey: CryptoKey;
  peerPublicKey: CryptoKey;
  targetUserId: string;
  targetDeviceId: string;
}): Promise<CryptoKey> {
  const subtle = getImSubtleCrypto();
  const bits = await subtle.deriveBits(
    { name: 'ECDH', public: input.peerPublicKey },
    input.privateKey,
    256,
  );
  const hkdfKey = await subtle.importKey('raw', bits, 'HKDF', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder().encode(`nanoclaw-im-room-key:${input.jid}`),
      info: textEncoder().encode(
        `${input.targetUserId}:${input.targetDeviceId}`,
      ),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function wrapRoomKeyForDevice(input: {
  jid: string;
  roomKey: CryptoKey;
  localDevice: LocalDeviceRecord;
  device: ImDeviceKey;
}): Promise<{
  userId: string;
  deviceId: string;
  wrappedKey: string;
  algorithm: string;
}> {
  const subtle = getImSubtleCrypto();
  const peerPublicKey = await importPeerPublicKey(input.device.public_key);
  const wrappingKey = await deriveWrappingKey({
    jid: input.jid,
    privateKey: input.localDevice.privateKey,
    peerPublicKey,
    targetUserId: input.device.user_id,
    targetDeviceId: input.device.device_id,
  });
  const iv = base64ToBuffer(randomBase64());
  const rawRoomKey = await subtle.exportKey('raw', input.roomKey);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    rawRoomKey,
  );
  const wrapped: WrappedRoomKey = {
    version: 1,
    senderDeviceId: input.localDevice.id,
    senderPublicKey: input.localDevice.publicKey,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
  return {
    userId: input.device.user_id,
    deviceId: input.device.device_id,
    wrappedKey: JSON.stringify(wrapped),
    algorithm: WRAP_ALGORITHM,
  };
}

async function tryUnwrapRoomKey(input: {
  jid: string;
  localDevice: LocalDeviceRecord;
  userId: string;
  deviceId: string;
  wrappedKey: string;
}): Promise<CryptoKey | null> {
  try {
    const subtle = getImSubtleCrypto();
    const wrapped = JSON.parse(input.wrappedKey) as WrappedRoomKey;
    const peerPublicKey = await importPeerPublicKey(wrapped.senderPublicKey);
    const wrappingKey = await deriveWrappingKey({
      jid: input.jid,
      privateKey: input.localDevice.privateKey,
      peerPublicKey,
      targetUserId: input.userId,
      targetDeviceId: input.deviceId,
    });
    const raw = await subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBuffer(wrapped.iv) },
      wrappingKey,
      base64ToBuffer(wrapped.ciphertext),
    );
    const roomKey = await importAesKey(raw);
    await storeRoomKey(input.jid, roomKey);
    return roomKey;
  } catch {
    return null;
  }
}

export async function ensureRoomKeyFromServer(
  jid: string,
  currentUserId: string,
): Promise<CryptoKey | null> {
  const existing = await getRoomKey(jid);
  if (existing) return existing;
  const localDevice = await ensureRegisteredDevice();
  const res = await getRoomKeys(jid, localDevice.id);
  for (const row of res.keys) {
    const key = await tryUnwrapRoomKey({
      jid,
      localDevice,
      userId: currentUserId,
      deviceId: localDevice.id,
      wrappedKey: row.wrapped_key,
    });
    if (key) return key;
  }
  return null;
}

export async function getImE2eeDeviceStatus(
  jid: string,
  currentUserId: string,
): Promise<ImE2eeDeviceStatus> {
  const localDevice = await ensureRegisteredDevice();
  const [deviceRes, roomKey] = await Promise.all([
    getDeviceKeys(jid),
    ensureRoomKeyFromServer(jid, currentUserId),
  ]);
  const roomKeyRes = await getRoomKeys(jid, localDevice.id);
  const currentUserDevices = deviceRes.keys.filter(
    (device) => device.user_id === currentUserId,
  );
  const sortedDeviceUpdates = deviceRes.keys
    .map((device) => device.updated_at)
    .filter(Boolean)
    .sort();
  const sortedRoomKeyDates = roomKeyRes.keys
    .map((key) => key.created_at)
    .filter(Boolean)
    .sort();
  const latestDeviceUpdatedAt =
    sortedDeviceUpdates[sortedDeviceUpdates.length - 1] ?? null;
  const latestRoomKeyCreatedAt =
    sortedRoomKeyDates[sortedRoomKeyDates.length - 1] ?? null;
  return {
    deviceId: localDevice.id,
    currentDeviceRegistered: deviceRes.keys.some(
      (device) =>
        device.user_id === currentUserId && device.device_id === localDevice.id,
    ),
    roomKeyAvailable: Boolean(roomKey),
    serverRoomKeyAvailable: roomKeyRes.keys.length > 0,
    memberDeviceCount: deviceRes.keys.length,
    currentUserDeviceCount: currentUserDevices.length,
    latestDeviceUpdatedAt,
    latestRoomKeyCreatedAt,
  };
}

export async function createAndShareRoomKey(jid: string): Promise<void> {
  const localDevice = await ensureRegisteredDevice();
  const key = await createRoomKey(jid);
  const devices = (await getDeviceKeys(jid)).keys;
  const wrapped = await Promise.all(
    devices.map((device) =>
      wrapRoomKeyForDevice({
        jid,
        roomKey: key,
        localDevice,
        device,
      }),
    ),
  );
  if (wrapped.length > 0) {
    await uploadRoomKeys(jid, wrapped);
  }
}

export async function shareExistingRoomKey(jid: string): Promise<void> {
  const key = await getRoomKey(jid);
  if (!key) return;
  const localDevice = await ensureRegisteredDevice();
  const devices = (await getDeviceKeys(jid)).keys;
  const wrapped = await Promise.all(
    devices.map((device) =>
      wrapRoomKeyForDevice({
        jid,
        roomKey: key,
        localDevice,
        device,
      }),
    ),
  );
  if (wrapped.length > 0) await uploadRoomKeys(jid, wrapped);
}

export async function encryptMessagePayload(
  jid: string,
  currentUserId: string,
  text: string,
  attachments: PlainAttachmentMeta[] = [],
): Promise<ImEncryptedEnvelope> {
  let key = await ensureRoomKeyFromServer(jid, currentUserId);
  if (!key) {
    await createAndShareRoomKey(jid);
    key = await getRoomKey(jid);
  }
  if (!key) throw new Error(UNREADABLE_TEXT);
  const iv = base64ToBuffer(randomBase64());
  const aad = `im:${jid}`;
  const payload: PlainMessagePayload = { text, attachments };
  const ciphertext = await getImSubtleCrypto().encrypt(
    { name: 'AES-GCM', iv, additionalData: textEncoder().encode(aad) },
    key,
    textEncoder().encode(JSON.stringify(payload)),
  );
  return {
    version: 1,
    algorithm: MESSAGE_ALGORITHM,
    iv: bytesToBase64(iv),
    aad,
    ciphertext: bytesToBase64(ciphertext),
  };
}

async function decryptMessageEnvelope(
  jid: string,
  currentUserId: string,
  envelope: ImEncryptedEnvelope,
): Promise<PlainMessagePayload | null> {
  const key = await ensureRoomKeyFromServer(jid, currentUserId);
  if (!key) return null;
  try {
    const clear = await getImSubtleCrypto().decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBuffer(envelope.iv),
        additionalData: envelope.aad
          ? textEncoder().encode(envelope.aad)
          : undefined,
      },
      key,
      base64ToBuffer(envelope.ciphertext),
    );
    const parsed = JSON.parse(textDecoder().decode(clear)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    return {
      text: typeof rec.text === 'string' ? rec.text : '',
      attachments: Array.isArray(rec.attachments)
        ? rec.attachments.filter((item): item is PlainAttachmentMeta => {
            const att = item as Partial<PlainAttachmentMeta>;
            return Boolean(att?.id && att.fileName && att.mimeType && att.iv);
          })
        : [],
    };
  } catch {
    return null;
  }
}

export async function decryptMessages(
  jid: string,
  currentUserId: string,
  messages: ImMessage[],
): Promise<ImMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!message.encrypted) return message;
      const clear = await decryptMessageEnvelope(
        jid,
        currentUserId,
        message.encrypted,
      );
      if (!clear) {
        return {
          ...message,
          content: UNREADABLE_TEXT,
          e2eeError: UNREADABLE_TEXT,
        };
      }
      const byId = new Map(
        (clear.attachments || []).map((att) => [att.id, att]),
      );
      return {
        ...message,
        content: clear.text,
        attachments: (message.attachments || []).map((att) => {
          const meta = byId.get(att.id);
          if (!meta) return att;
          return {
            ...att,
            fileName: meta.fileName,
            mimeType: meta.mimeType,
            size: meta.size,
            encrypted: meta,
          };
        }),
      };
    }),
  );
}

export async function encryptAttachmentFile(
  jid: string,
  currentUserId: string,
  file: File,
): Promise<{ file: File; meta: PlainAttachmentMeta }> {
  let key = await ensureRoomKeyFromServer(jid, currentUserId);
  if (!key) {
    await createAndShareRoomKey(jid);
    key = await getRoomKey(jid);
  }
  if (!key) throw new Error(UNREADABLE_TEXT);
  const iv = base64ToBuffer(randomBase64());
  const ciphertext = await getImSubtleCrypto().encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder().encode(`im-file:${jid}:${file.name}`),
    },
    key,
    await file.arrayBuffer(),
  );
  const encryptedFile = new File([ciphertext], 'encrypted.bin', {
    type: 'application/octet-stream',
  });
  return {
    file: encryptedFile,
    meta: {
      id: '',
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      iv: bytesToBase64(iv),
    },
  };
}

export async function decryptAttachmentBlob(
  jid: string,
  currentUserId: string,
  attachment: ImAttachment,
): Promise<Blob> {
  if (!attachment.encrypted) throw new Error('Attachment is not encrypted');
  const key = await ensureRoomKeyFromServer(jid, currentUserId);
  if (!key) throw new Error(UNREADABLE_TEXT);
  const res = await fetch(attachment.url, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to download attachment');
  const clear = await getImSubtleCrypto().decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBuffer(attachment.encrypted.iv),
      additionalData: textEncoder().encode(
        `im-file:${jid}:${attachment.encrypted.fileName}`,
      ),
    },
    key,
    await res.arrayBuffer(),
  );
  return new Blob([clear], { type: attachment.encrypted.mimeType });
}
