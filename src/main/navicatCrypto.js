const crypto = require('crypto');
const { TextDecoder } = require('util');
const { Blowfish } = require('egoroof-blowfish');

const V2_KEY = Buffer.from('libcckeylibcckey', 'ascii');
const V2_IV = Buffer.from('libcciv libcciv ', 'ascii');
const V1_KEY = crypto.createHash('sha1').update('3DC5CA39', 'ascii').digest();

function xorBytes(left, right) {
  if (left.length !== right.length) throw new Error('Navicat 密码分组长度无效');
  const result = Buffer.allocUnsafe(left.length);
  for (let i = 0; i < left.length; i += 1) result[i] = left[i] ^ right[i];
  return result;
}

function v1Cipher() {
  return new Blowfish(V1_KEY, Blowfish.MODE.ECB, Blowfish.PADDING.NULL);
}

function encryptV1Block(cipher, block) {
  const result = Buffer.from(cipher.encode(block));
  if (result.length !== 8) throw new Error('Navicat V1 加密分组无效');
  return result;
}

function decryptV1Block(cipher, block) {
  const decoded = Buffer.from(cipher.decode(block, Blowfish.TYPE.UINT8_ARRAY));
  if (decoded.length > 8) throw new Error('Navicat V1 解密分组无效');
  if (decoded.length === 8) return decoded;
  return Buffer.concat([decoded, Buffer.alloc(8 - decoded.length)]);
}

function decryptV1(ciphertext) {
  const cipher = v1Cipher();
  let currentVector = encryptV1Block(cipher, Buffer.alloc(8, 0xff));
  const chunks = [];
  const fullLength = ciphertext.length - (ciphertext.length % 8);
  for (let offset = 0; offset < fullLength; offset += 8) {
    const block = ciphertext.subarray(offset, offset + 8);
    chunks.push(xorBytes(decryptV1Block(cipher, block), currentVector));
    currentVector = xorBytes(currentVector, block);
  }
  if (fullLength < ciphertext.length) {
    currentVector = encryptV1Block(cipher, currentVector);
    const tail = ciphertext.subarray(fullLength);
    chunks.push(xorBytes(tail, currentVector.subarray(0, tail.length)));
  }
  return Buffer.concat(chunks);
}

function decryptV2(ciphertext) {
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error('Navicat V2 密文长度无效');
  const decipher = crypto.createDecipheriv('aes-128-cbc', V2_KEY, V2_IV);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decodePlaintext(bytes) {
  const plaintext = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(plaintext)) {
    throw new Error('Navicat 密码解密结果包含无效控制字符');
  }
  return plaintext;
}

function decodeV1Plaintext(bytes) {
  if (bytes.some((value) => value > 0x7f)) throw new Error('Navicat V1 解密结果不是 ASCII 密码');
  return decodePlaintext(bytes);
}

function decryptNavicatSecret(value) {
  const encrypted = String(value === undefined || value === null ? '' : value).trim();
  if (!encrypted) return { plaintext: '', version: 'none' };
  if (!/^[0-9a-f]+$/i.test(encrypted) || encrypted.length % 2 !== 0) {
    throw new Error('Navicat 密文不是有效的十六进制数据');
  }
  const ciphertext = Buffer.from(encrypted, 'hex');
  try { return { plaintext: decodeV1Plaintext(decryptV1(ciphertext)), version: 'v1' }; }
  catch (v1Error) {
    if (ciphertext.length % 16 === 0) {
      try { return { plaintext: decodePlaintext(decryptV2(ciphertext)), version: 'v2' }; }
      catch (v2Error) { throw new Error(`Navicat 密码自动解密失败：${v2Error.message}`); }
    }
    throw new Error(`Navicat 密码自动解密失败：${v1Error.message}`);
  }
}

module.exports = { decryptNavicatSecret };
