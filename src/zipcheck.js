// Inspects an uploaded project zip BEFORE it is handed to `unzip` inside the container (central directory only, no extraction).
// Refuses: non-zips, zip64/multi-disk, too many entries, huge declared size (zip bomb), absolute / `..` / backslash / control-char names
// (zip-slip), encrypted entries.
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

export function inspectZip(buf, { maxFiles = 30000, maxBytes = 600 * 1024 * 1024, maxNameLen = 512 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Error('multi-disk zip files are not supported');
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new Error('zip64 archives are not supported');
  if (total > maxFiles) throw new Error(`too many files in the project (${total} > ${maxFiles})`);
  if (cdOff + cdSize > eocd) throw new Error('corrupt zip file');

  let pos = cdOff; let bytes = 0; let files = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CEN_SIG) throw new Error('corrupt zip file');
    const flags = buf.readUInt16LE(pos + 8);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    if (nameLen === 0 || nameLen > maxNameLen) throw new Error('unsafe file name in the project');
    if (pos + 46 + nameLen > buf.length) throw new Error('corrupt zip file');
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (flags & 0x1) throw new Error('encrypted zip entries are not supported');
    // eslint-disable-next-line no-control-regex
    if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f]/.test(name) || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`unsafe file name in the project: ${JSON.stringify(name.slice(0, 80))}`);
    }
    if (usize === 0xffffffff) throw new Error('zip64 entries are not supported');
    bytes += usize; files++;
    if (bytes > maxBytes) throw new Error('the project is too large once unpacked');
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { files, bytes };
}
