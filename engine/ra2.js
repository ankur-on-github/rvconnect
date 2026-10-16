// RFB Security Type 5 (RA2) and 129 (RA2_256) Encryption & Authentication Module
// Implements standard Diffie-Hellman key exchange with AES/DES ciphers for secure VNC connections.

const crypto = require('crypto');

function aesEcbEncryptBlock(key, block) {
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);
  return cipher.update(block);
}

function leftShift16(buf) {
  const out = Buffer.alloc(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const b = buf[i];
    out[i] = ((b << 1) | carry) & 0xff;
    carry = (b & 0x80) ? 1 : 0;
  }
  return { out, carry };
}

function getCmacSubkeys(key) {
  const L = aesEcbEncryptBlock(key, Buffer.alloc(16, 0));
  const { out: K1, carry: carry1 } = leftShift16(L);
  if (carry1) K1[15] ^= 0x87;
  const { out: K2, carry: carry2 } = leftShift16(K1);
  if (carry2) K2[15] ^= 0x87;
  return { K1, K2 };
}

function cmac(key, data) {
  const { K1, K2 } = getCmacSubkeys(key);
  let n = Math.ceil(data.length / 16);
  let complete = true;
  if (n === 0) {
    n = 1;
    complete = false;
  } else if (data.length % 16 !== 0) {
    complete = false;
  }

  const lastBlock = Buffer.alloc(16, 0);
  if (complete) {
    const block = data.subarray((n - 1) * 16, n * 16);
    for (let i = 0; i < 16; i++) lastBlock[i] = block[i] ^ K1[i];
  } else {
    const rem = data.subarray((n - 1) * 16);
    rem.copy(lastBlock);
    lastBlock[rem.length] = 0x80;
    for (let i = 0; i < 16; i++) lastBlock[i] ^= K2[i];
  }

  let Y = Buffer.alloc(16, 0);
  for (let i = 0; i < n - 1; i++) {
    const block = data.subarray(i * 16, (i + 1) * 16);
    const X = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) X[j] = Y[j] ^ block[j];
    Y = aesEcbEncryptBlock(key, X);
  }
  const X = Buffer.alloc(16);
  for (let j = 0; j < 16; j++) X[j] = Y[j] ^ lastBlock[j];
  return aesEcbEncryptBlock(key, X);
}

function eaxTag(key, tagNum, data) {
  const prefix = Buffer.alloc(16, 0);
  prefix[15] = tagNum;
  return cmac(key, Buffer.concat([prefix, data]));
}

function eaxDecrypt(key, nonce, header, ciphertext, expectedTag) {
  const tag0 = eaxTag(key, 0, nonce);
  const tag1 = eaxTag(key, 1, header);
  const tag2 = eaxTag(key, 2, ciphertext);
  const computedTag = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) computedTag[i] = tag0[i] ^ tag1[i] ^ tag2[i];

  if (expectedTag && !computedTag.equals(expectedTag)) {
    return null;
  }

  const cipherName = `aes-${key.length * 8}-ctr`;
  const decipher = crypto.createDecipheriv(cipherName, key, tag0);
  return decipher.update(ciphertext);
}

function eaxEncrypt(key, nonce, header, plaintext) {
  const tag0 = eaxTag(key, 0, nonce);
  const tag1 = eaxTag(key, 1, header);
  const cipherName = `aes-${key.length * 8}-ctr`;
  const cipher = crypto.createCipheriv(cipherName, key, tag0);
  const ciphertext = cipher.update(plaintext);
  const tag2 = eaxTag(key, 2, ciphertext);
  const tag = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) tag[i] = tag0[i] ^ tag1[i] ^ tag2[i];
  return { ciphertext, tag };
}

function wrapEaxMessage(key, msgIndex, payload) {
  const nonce = Buffer.alloc(16, 0);
  nonce.writeBigUInt64LE(BigInt(msgIndex), 0);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length, 0);
  const { ciphertext, tag } = eaxEncrypt(key, nonce, header, payload);
  return Buffer.concat([header, ciphertext, tag]);
}

class Ra2Session {
  constructor(secType = 5) {
    this.secType = secType;
    this.keyBits = (secType === 129 || secType === 130 || secType === 133) ? 256 : 128;
    this.hashAlg = this.keyBits === 256 ? 'sha256' : 'sha1';
    this.keyBytes = this.keyBits / 8; // 16 or 32

    // Generate local RSA key pair (2048 bits)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });
    this.privateKey = privateKey;
    this.clientPubKeyObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });

    const jwk = this.clientPubKeyObj.export({ format: 'jwk' });
    const rawN = Buffer.from(jwk.n, 'base64url');
    const rawE = Buffer.from(jwk.e, 'base64url');

    this.clientModulus = this._pad(rawN, 256);
    this.clientExponent = this._pad(rawE, 256);

    this.clientPublicKeyMsg = Buffer.alloc(516);
    this.clientPublicKeyMsg.writeUInt32BE(2048, 0);
    this.clientModulus.copy(this.clientPublicKeyMsg, 4);
    this.clientExponent.copy(this.clientPublicKeyMsg, 260);

    this.serverPublicKeyMsg = null;
    this.serverPubKeyObj = null;

    this.serverRandom = null;
    this.clientRandom = null;

    this.clientSessionKey = null;
    this.serverSessionKey = null;

    this.clientMsgIndex = 0;
    this.serverMsgIndex = 0;
    this.subtype = 1; // 1 = UserPasswd, 2 = Passwd
  }

  _pad(buf, len) {
    if (buf.length === len) return buf;
    if (buf.length < len) return Buffer.concat([Buffer.alloc(len - buf.length, 0), buf]);
    return buf.subarray(buf.length - len);
  }

  setServerPublicKey(data516) {
    this.serverPublicKeyMsg = Buffer.from(data516);
    const keyBits = data516.readUInt32BE(0);
    const keyBytes = Math.ceil(keyBits / 8);
    const mod = data516.subarray(4, 4 + keyBytes);
    const exp = data516.subarray(4 + keyBytes, 4 + keyBytes * 2);

    // Trim leading zeros from exponent for JWK
    let expStart = 0;
    while (expStart < exp.length - 1 && exp[expStart] === 0) expStart++;
    const trimmedExp = exp.subarray(expStart);

    this.serverPubKeyObj = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: mod.toString('base64url'),
        e: trimmedExp.toString('base64url')
      },
      format: 'jwk'
    });
  }

  handleServerEncryptedRandom(encBuf) {
    const clientPrivKeyObj = crypto.createPrivateKey({ key: this.privateKey, format: 'der', type: 'pkcs8' });
    this.serverRandom = crypto.privateDecrypt({
      key: clientPrivKeyObj,
      padding: crypto.constants.RSA_PKCS1_PADDING
    }, encBuf);

    this.clientRandom = crypto.randomBytes(this.keyBytes);
    const encClientRandom = crypto.publicEncrypt({
      key: this.serverPubKeyObj,
      padding: crypto.constants.RSA_PKCS1_PADDING
    }, this.clientRandom);

    const clientRandomMsg = Buffer.alloc(2 + encClientRandom.length);
    clientRandomMsg.writeUInt16BE(encClientRandom.length, 0);
    encClientRandom.copy(clientRandomMsg, 2);

    // Derive session keys
    this.clientSessionKey = crypto.createHash(this.hashAlg)
      .update(Buffer.concat([this.serverRandom, this.clientRandom]))
      .digest()
      .subarray(0, this.keyBytes);

    this.serverSessionKey = crypto.createHash(this.hashAlg)
      .update(Buffer.concat([this.clientRandom, this.serverRandom]))
      .digest()
      .subarray(0, this.keyBytes);

    return clientRandomMsg;
  }

  verifyServerHash(encPayload, mac) {
    const nonce = Buffer.alloc(16, 0);
    nonce.writeBigUInt64LE(BigInt(this.serverMsgIndex++), 0);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(encPayload.length, 0);

    const decrypted = eaxDecrypt(this.serverSessionKey, nonce, header, encPayload, mac);
    if (!decrypted) return false;

    const expectedServerHash = crypto.createHash(this.hashAlg)
      .update(Buffer.concat([this.serverPublicKeyMsg, this.clientPublicKeyMsg]))
      .digest();

    return decrypted.equals(expectedServerHash);
  }

  createClientHashMsg() {
    const clientHash = crypto.createHash(this.hashAlg)
      .update(Buffer.concat([this.clientPublicKeyMsg, this.serverPublicKeyMsg]))
      .digest();

    return wrapEaxMessage(this.clientSessionKey, this.clientMsgIndex++, clientHash);
  }

  decryptSubtype(encPayload, mac) {
    const nonce = Buffer.alloc(16, 0);
    nonce.writeBigUInt64LE(BigInt(this.serverMsgIndex++), 0);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(encPayload.length, 0);

    const decrypted = eaxDecrypt(this.serverSessionKey, nonce, header, encPayload, mac);
    if (!decrypted || decrypted.length < 1) return null;
    this.subtype = decrypted[0];
    return this.subtype;
  }

  createCredentialsMsg(username, password) {
    const uBuf = Buffer.from(username || '', 'utf8');
    const pBuf = Buffer.from(password || '', 'utf8');
    let creds;

    if (this.subtype === 2) {
      // Password only
      creds = Buffer.alloc(1 + pBuf.length);
      creds[0] = pBuf.length;
      pBuf.copy(creds, 1);
    } else {
      // Username + Password
      creds = Buffer.alloc(1 + uBuf.length + 1 + pBuf.length);
      creds[0] = uBuf.length;
      uBuf.copy(creds, 1);
      creds[1 + uBuf.length] = pBuf.length;
      pBuf.copy(creds, 2 + uBuf.length);
    }

    return wrapEaxMessage(this.clientSessionKey, this.clientMsgIndex++, creds);
  }

  decryptSecurityResult(encPayload, mac) {
    const nonce = Buffer.alloc(16, 0);
    nonce.writeBigUInt64LE(BigInt(this.serverMsgIndex++), 0);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(encPayload.length, 0);

    const decrypted = eaxDecrypt(this.serverSessionKey, nonce, header, encPayload, mac);
    if (!decrypted || decrypted.length < 4) {
      return { success: false, reason: 'Decryption failed or invalid SecurityResult length' };
    }

    const status = decrypted.readUInt32BE(0);
    if (status === 0) {
      return { success: true };
    }

    let reason = 'Authentication failed';
    if (decrypted.length >= 8) {
      const reasonLen = decrypted.readUInt32BE(4);
      reason = decrypted.subarray(8, 8 + reasonLen).toString('utf8');
    }
    return { success: false, reason };
  }

  wrapStreamData(buf) {
    // Splits plaintext into chunks of up to 16384 bytes, wrapped in EAX messages
    const chunks = [];
    const maxChunk = 16384;
    for (let offset = 0; offset < buf.length; offset += maxChunk) {
      const slice = buf.subarray(offset, Math.min(buf.length, offset + maxChunk));
      chunks.push(wrapEaxMessage(this.clientSessionKey, this.clientMsgIndex++, slice));
    }
    return Buffer.concat(chunks);
  }

  decryptIncomingMessage(encPayload, mac) {
    const nonce = Buffer.alloc(16, 0);
    nonce.writeBigUInt64LE(BigInt(this.serverMsgIndex++), 0);
    const header = Buffer.alloc(2);
    header.writeUInt16BE(encPayload.length, 0);

    return eaxDecrypt(this.serverSessionKey, nonce, header, encPayload, mac);
  }
}

module.exports = {
  Ra2Session,
  wrapEaxMessage,
  eaxDecrypt,
  eaxEncrypt
};

