/**
 * Antigravity-CN: 高精度无损 ASAR 注入补丁引擎 (Chromium Pickle 4 字节对齐标准规范)
 * Precision In-Place ASAR Modifier with Exact Chromium Pickle Alignment & Full SHA-256 Integrity
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

class PrecisionPatcher {
  /**
   * 精确修改 ASAR 中的指定文件并重新生成 ASAR 文件
   * @param {string} sourceAsarPath 原始 ASAR 路径 (如 app.asar.bak)
   * @param {string} targetAsarPath 输出 ASAR 路径 (如 app.asar)
   * @param {Object} fileReplacements 需替换/修改的文件映射 { 'dist/preload.js': (origContentBuf) => newContentBuf }
   */
  static patch(sourceAsarPath, targetAsarPath, fileReplacements) {
    if (!fs.existsSync(sourceAsarPath)) {
      throw new Error(`源 ASAR 文件不存在: ${sourceAsarPath}`);
    }

    const fd = fs.openSync(sourceAsarPath, 'r');
    const prefixBuf = Buffer.alloc(16);
    fs.readSync(fd, prefixBuf, 0, 16, 0);

    const origHeaderSize = prefixBuf.readUInt32LE(4);
    const jsonSize = prefixBuf.readUInt32LE(12);
    const baseOffset = 8 + origHeaderSize;

    const jsonBuf = Buffer.alloc(jsonSize);
    fs.readSync(fd, jsonBuf, 0, jsonSize, 16);

    const header = JSON.parse(jsonBuf.toString('utf8'));
    const asarFileSize = fs.statSync(sourceAsarPath).size;
    const bodySize = asarFileSize - baseOffset;
    const bodyBuf = Buffer.alloc(bodySize);
    fs.readSync(fd, bodyBuf, 0, bodySize, baseOffset);
    fs.closeSync(fd);

    // 收集 ASAR 中所有实体文件，按 offset 严格升序排序
    const fileList = [];
    function collectFiles(node, currentPath = '') {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const fullRel = currentPath ? `${currentPath}/${name}` : name;
        if (entry.files) {
          collectFiles(entry, fullRel);
        } else if (!entry.unpacked && entry.offset !== undefined) {
          fileList.push({
            path: fullRel,
            entry,
            offset: parseInt(entry.offset, 10),
            size: entry.size
          });
        }
      }
    }
    collectFiles(header);
    fileList.sort((a, b) => a.offset - b.offset);

    // 逐个处理并组装新的 body，重算 offset 与 SHA256 integrity
    const newFileBuffers = [];
    let currentOffset = 0;

    for (const file of fileList) {
      const origContent = bodyBuf.subarray(file.offset, file.offset + file.size);
      let finalContent = origContent;

      if (fileReplacements[file.path]) {
        const modifier = fileReplacements[file.path];
        finalContent = typeof modifier === 'function' ? modifier(origContent) : Buffer.from(modifier);

        file.entry.size = finalContent.length;
        const hash = crypto.createHash('sha256').update(finalContent).digest('hex');
        file.entry.integrity = {
          algorithm: 'SHA256',
          hash: hash,
          blockSize: 4194304,
          blocks: [hash]
        };
      }

      file.entry.offset = String(currentOffset);
      newFileBuffers.push(finalContent);
      currentOffset += finalContent.length;
    }

    const newJsonStr = JSON.stringify(header);
    const newJsonBuf = Buffer.from(newJsonStr, 'utf8');
    const newJsonSize = newJsonBuf.length;

    // Chromium Pickle 4 字节对其规范
    const paddingSize = (4 - (newJsonSize % 4)) % 4;
    const paddingBuf = Buffer.alloc(paddingSize, 0);

    const payloadSize = newJsonSize + paddingSize;
    const newHeaderSize = payloadSize + 8;

    const newPrefixBuf = Buffer.alloc(16);
    newPrefixBuf.writeUInt32LE(4, 0);
    newPrefixBuf.writeUInt32LE(newHeaderSize, 4);
    newPrefixBuf.writeUInt32LE(payloadSize + 4, 8);
    newPrefixBuf.writeUInt32LE(newJsonSize, 12);

    const tmpOut = targetAsarPath + '.tmp-' + Date.now();
    const outFd = fs.openSync(tmpOut, 'w');

    try {
      fs.writeSync(outFd, newPrefixBuf, 0, 16);
      fs.writeSync(outFd, newJsonBuf, 0, newJsonSize);
      if (paddingSize > 0) {
        fs.writeSync(outFd, paddingBuf, 0, paddingSize);
      }
      for (const buf of newFileBuffers) {
        if (buf.length > 0) {
          fs.writeSync(outFd, buf, 0, buf.length);
        }
      }
    } finally {
      fs.closeSync(outFd);
    }

    if (fs.existsSync(targetAsarPath)) {
      try { fs.unlinkSync(targetAsarPath); } catch (e) {}
    }
    fs.renameSync(tmpOut, targetAsarPath);
  }
}

module.exports = PrecisionPatcher;
