// 补齐 BoringSSL / OpenSSL 3 缺失的 DES 流模式（达梦握手需要）
//
// 达梦服务端在握手时协商通信加密算法，实测 DM8（V8）默认给出 **DES-CFB**。
// 而这两个运行时都拿不出这个算法：
//   · Electron 的 crypto 走 BoringSSL，单 DES 的 CFB/OFB 根本没编译进去
//     （getCiphers() 里只有 des-ecb / des-cbc / des-ede / des-ede3-cbc），报 "Unknown cipher"；
//   · 纯 Node 的 OpenSSL 3 把单 DES 划进了 legacy provider、默认不启用，
//     报 "error:0308010C:digital envelope routines::unsupported"。
// 于是 dmdb 在 createCipheriv('DES-CFB') 上抛错，登录报文加不了密，连接必然失败。
// Electron 侧无解可换：BoringSSL 没有 legacy provider，--openssl-legacy-provider 也不认。
//
// 这里补的是**模式**，不是算法——分组函数仍然交给 BoringSSL/OpenSSL：
//   · 优先用原生 des-ecb；
//   · 没有就退到 3DES-ECB，三段密钥填同一把 8 字节密钥：
//     EDE3(k,k,k) = E(D(E(x))) = E(x)，与单 DES 逐位等价。
// 外面套标准 CFB64 / OFB64 反馈（OpenSSL 的 DES-CFB 即 CFB64）。
// 输出已与 OpenSSL 的 des-ede3-cfb / des-ede3-ofb（三倍密钥）逐字节比对一致，
// 并用真实达梦实例验证过握手可以走通。
const crypto = require('crypto');

const BLOCK = 8;

// 只补这几个名字；其余算法一律原样交回原生实现
const MISSING_MODES = {
  'des-cfb': { keyBytes: 8, ede3: false, mode: 'cfb' },
  'des-ofb': { keyBytes: 8, ede3: false, mode: 'ofb' },
  'des-ede3-cfb': { keyBytes: 24, ede3: true, mode: 'cfb' },
  'des-ede3-ofb': { keyBytes: 24, ede3: true, mode: 'ofb' },
};

/**
 * 取一个可用的 DES/3DES 单块 ECB 加密原语。
 * 都拿不到时返回 null——调用方会退回原生实现，让它抛出自己的错误，
 * 而不是由这里编一个更含糊的说法。
 */
function ecbEncryptor(key, ede3) {
  const available = new Set(crypto.getCiphers());
  let name = null;
  let realKey = key;
  if (!ede3 && available.has('des-ecb')) {
    name = 'des-ecb';
  } else {
    name = ['des-ede3-ecb', 'des-ede3'].find((n) => available.has(n)) || null;
    if (name && !ede3) realKey = Buffer.concat([key, key, key]); // EDE3(k,k,k) ≡ 单 DES
  }
  if (!name) return null;
  return (block) => {
    const c = crypto.createCipheriv(name, realKey, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(block), c.final()]);
  };
}

/**
 * CFB64 / OFB64 的字节级实现，接口与 crypto.Cipheriv 对齐
 * （dmdb 只用到 setAutoPadding / update / final 三个方法）。
 *
 * 两种模式共用一个密钥流寄存器 reg，区别只在反馈什么：
 *   CFB：把密文字节喂回寄存器（解密时喂回的同样是密文，所以要分方向）；
 *   OFB：把密钥流自身喂回寄存器，与数据无关，加解密同构。
 */
function streamCipher(spec, key, iv, decrypt) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const E = ecbEncryptor(keyBuf, spec.ede3);
  if (!E) return null;
  const reg = Buffer.from(iv);
  if (reg.length !== BLOCK) return null;
  let ks = Buffer.alloc(BLOCK);
  let num = 0;
  return {
    setAutoPadding() { return this; }, // 流模式不涉及填充
    update(data) {
      const src = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const out = Buffer.alloc(src.length);
      for (let i = 0; i < src.length; i++) {
        if (num === 0) {
          ks = E(reg);
          if (spec.mode === 'ofb') ks.copy(reg);
        }
        out[i] = src[i] ^ ks[num];
        if (spec.mode === 'cfb') reg[num] = decrypt ? src[i] : out[i];
        num = (num + 1) % BLOCK;
      }
      return out;
    },
    final() { return Buffer.alloc(0); },
  };
}

/** 供自检使用：直接构造补位实现，不看运行时是否原生支持 */
function createShimCipher(algorithm, key, iv, decrypt) {
  const spec = MISSING_MODES[String(algorithm).toLowerCase()];
  return spec ? streamCipher(spec, key, iv, !!decrypt) : null;
}

let installed = false;

/**
 * 把缺失的模式挂到 crypto 上。幂等，且只拦截确实缺失的算法名——
 * 运行时本身支持的（比如纯 Node 上的 des-ede3-cfb）一律不碰。
 *
 * 补丁打在 crypto 模块对象上：dmdb 是在调用时才取 createCipheriv 的，
 * 因此这里在它建立连接前装好即可。
 */
function installMissingDesModes() {
  if (installed) return [];
  installed = true;
  const available = new Set(crypto.getCiphers());
  const patched = {};
  for (const [name, spec] of Object.entries(MISSING_MODES)) {
    if (!available.has(name)) patched[name] = spec;
  }
  const names = Object.keys(patched);
  if (!names.length) return names;

  const origCipher = crypto.createCipheriv;
  const origDecipher = crypto.createDecipheriv;
  const wrap = (orig, decrypt) => function createIv(algorithm, key, iv, ...rest) {
    const spec = typeof algorithm === 'string' ? patched[algorithm.toLowerCase()] : null;
    const shim = spec ? streamCipher(spec, key, iv, decrypt) : null;
    return shim || orig.call(this, algorithm, key, iv, ...rest);
  };
  crypto.createCipheriv = wrap(origCipher, false);
  crypto.createDecipheriv = wrap(origDecipher, true);
  return names;
}

module.exports = { installMissingDesModes, createShimCipher, MISSING_MODES };
