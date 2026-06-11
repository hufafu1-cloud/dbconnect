// SSH 隧道：本地端口 → SSH 服务器 → 目标主机:端口（数据库）
// 每个启用 SSH 的连接持有一个隧道；本地起一个 127.0.0.1 随机端口的 TCP 服务，
// 每个进来的连接（连接池里的每条连接）都通过 forwardOut 建一条转发流。
const net = require('net');
const fs = require('fs');
const { Client } = require('ssh2');

/**
 * @param {object} ssh {host, port, user, authType:'password'|'key', password, keyFile, passphrase}
 * @param {string} dstHost 数据库主机（跳板机视角）
 * @param {number} dstPort 数据库端口
 * @returns {Promise<{localPort:number, close:Function}>}
 */
async function openTunnel(ssh, dstHost, dstPort) {
  if (!ssh.host) throw new Error('SSH 主机未填写');
  if (!ssh.user) throw new Error('SSH 用户名未填写');
  const conn = new Client();
  const connectCfg = {
    host: ssh.host,
    port: Number(ssh.port) || 22,
    username: ssh.user,
    readyTimeout: 12000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
  };
  if (ssh.authType === 'key') {
    if (!ssh.keyFile) throw new Error('未选择 SSH 私钥文件');
    try {
      connectCfg.privateKey = fs.readFileSync(ssh.keyFile);
    } catch (e) {
      throw new Error('读取私钥文件失败: ' + e.message);
    }
    if (ssh.passphrase) connectCfg.passphrase = ssh.passphrase;
  } else {
    connectCfg.password = ssh.password || '';
  }

  await new Promise((resolve, reject) => {
    conn.once('ready', resolve);
    conn.once('error', (e) => reject(new Error('SSH 连接失败: ' + (e && e.message || e))));
    try {
      conn.connect(connectCfg);
    } catch (e) {
      reject(new Error('SSH 连接失败: ' + e.message));
    }
  });
  // 就绪后的异常（网络抖动等）不要崩进程
  conn.on('error', () => {});

  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, dstHost, Number(dstPort), (err, stream) => {
      if (err) { sock.destroy(); return; }
      stream.on('error', () => { try { sock.destroy(); } catch (e) { /* ignore */ } });
      sock.on('close', () => { try { stream.close(); } catch (e) { /* ignore */ } });
      sock.pipe(stream).pipe(sock);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const localPort = server.address().port;

  let closed = false;
  return {
    localPort,
    close() {
      if (closed) return;
      closed = true;
      try { server.close(); } catch (e) { /* ignore */ }
      try { conn.end(); } catch (e) { /* ignore */ }
    },
  };
}

module.exports = { openTunnel };
