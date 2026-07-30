/* ============================================================
 * exif.js —— 轻量 EXIF 解析 + WGS84/GCJ02 坐标纠偏
 * 无任何外部依赖，可直接以 file:// 方式运行
 * ============================================================ */
(function (global) {
  'use strict';

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readValue(view, offset, type, count, little) {
    var vals = [];
    var i;
    switch (type) {
      case 1: // BYTE
      case 7: // UNDEFINED
        for (i = 0; i < count; i++) vals.push(view.getUint8(offset + i));
        break;
      case 2: // ASCII
        var s = '';
        for (i = 0; i < count; i++) {
          var c = view.getUint8(offset + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      case 3: // SHORT
        for (i = 0; i < count; i++) vals.push(view.getUint16(offset + i * 2, little));
        break;
      case 4: // LONG
        for (i = 0; i < count; i++) vals.push(view.getUint32(offset + i * 4, little));
        break;
      case 5: // RATIONAL
        for (i = 0; i < count; i++) {
          var n = view.getUint32(offset + i * 8, little);
          var d = view.getUint32(offset + i * 8 + 4, little);
          vals.push(d === 0 ? 0 : n / d);
        }
        break;
      case 6: // SBYTE
        for (i = 0; i < count; i++) vals.push(view.getInt8(offset + i));
        break;
      case 8: // SSHORT
        for (i = 0; i < count; i++) vals.push(view.getInt16(offset + i * 2, little));
        break;
      case 9: // SLONG
        for (i = 0; i < count; i++) vals.push(view.getInt32(offset + i * 4, little));
        break;
      case 10: // SRATIONAL
        for (i = 0; i < count; i++) {
          var sn = view.getInt32(offset + i * 8, little);
          var sd = view.getInt32(offset + i * 8 + 4, little);
          vals.push(sd === 0 ? 0 : sn / sd);
        }
        break;
      default:
        return null;
    }
    return count === 1 ? vals[0] : vals;
  }

  function readIFD(view, tiffStart, dirStart, little) {
    var res = {};
    if (dirStart + 2 > view.byteLength) return res;
    var entries = view.getUint16(dirStart, little);
    if (entries > 512) return res; // 防御异常数据
    for (var i = 0; i < entries; i++) {
      var e = dirStart + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      var tag = view.getUint16(e, little);
      var type = view.getUint16(e + 2, little);
      var count = view.getUint32(e + 4, little);
      var unit = TYPE_SIZE[type];
      if (!unit) continue;
      var total = unit * count;
      if (total > 1024 * 64) continue;
      var valOff = e + 8;
      if (total > 4) valOff = tiffStart + view.getUint32(e + 8, little);
      if (valOff < 0 || valOff + total > view.byteLength) continue;
      try {
        res[tag] = readValue(view, valOff, type, count, little);
      } catch (err) { /* 单个标签失败忽略 */ }
    }
    return res;
  }

  function dmsToDeg(dms, ref) {
    if (!dms) return null;
    var arr = Array.isArray(dms) ? dms : [dms, 0, 0];
    var d = arr[0] || 0, m = arr[1] || 0, s = arr[2] || 0;
    var deg = d + m / 60 + s / 3600;
    if (ref === 'S' || ref === 'W') deg = -deg;
    if (!isFinite(deg)) return null;
    return deg;
  }

  // "2024:05:01 12:30:44" -> Date
  function parseExifDate(str) {
    if (!str || typeof str !== 'string') return null;
    var m = str.trim().match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d;
  }

  function readTiff(view, tiffStart) {
    if (tiffStart + 8 > view.byteLength) return null;
    var bom = view.getUint16(tiffStart, false);
    var little;
    if (bom === 0x4949) little = true;
    else if (bom === 0x4d4d) little = false;
    else return null;
    if (view.getUint16(tiffStart + 2, little) !== 0x002a) return null;
    var ifd0Off = view.getUint32(tiffStart + 4, little);
    var ifd0 = readIFD(view, tiffStart, tiffStart + ifd0Off, little);

    var out = {
      make: ifd0[0x010f] || null,
      model: ifd0[0x0110] || null,
      orientation: ifd0[0x0112] || 1,
      dateTime: ifd0[0x0132] || null,
      width: null,
      height: null,
      lat: null,
      lng: null,
      altitude: null,
      dateTaken: null
    };

    // Exif SubIFD
    if (ifd0[0x8769]) {
      var exifIfd = readIFD(view, tiffStart, tiffStart + ifd0[0x8769], little);
      out.dateTaken = exifIfd[0x9003] || exifIfd[0x9004] || null;
      if (exifIfd[0xa002]) out.width = exifIfd[0xa002];
      if (exifIfd[0xa003]) out.height = exifIfd[0xa003];
    }

    // GPS IFD
    if (ifd0[0x8825]) {
      var gps = readIFD(view, tiffStart, tiffStart + ifd0[0x8825], little);
      var latRef = gps[1], lat = gps[2], lngRef = gps[3], lng = gps[4];
      var la = dmsToDeg(lat, latRef);
      var lo = dmsToDeg(lng, lngRef);
      if (la !== null && lo !== null && !(la === 0 && lo === 0)) {
        out.lat = la;
        out.lng = lo;
      }
      if (gps[6] != null) {
        var alt = Array.isArray(gps[6]) ? gps[6][0] : gps[6];
        out.altitude = gps[5] === 1 ? -alt : alt;
      }
      // GPS 日期时间兜底（UTC）
      if (!out.dateTaken && gps[29] && gps[7]) {
        var ds = String(gps[29]).replace(/:/g, '-');
        var ts = Array.isArray(gps[7]) ? gps[7] : [0, 0, 0];
        var gd = new Date(ds + 'T' +
          String(Math.floor(ts[0])).padStart(2, '0') + ':' +
          String(Math.floor(ts[1])).padStart(2, '0') + ':' +
          String(Math.floor(ts[2])).padStart(2, '0') + 'Z');
        if (!isNaN(gd.getTime())) out.dateTakenObj = gd;
      }
    }
    return out;
  }

  function fourcc(view, off) {
    if (off + 4 > view.byteLength) return '';
    return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  }

  /* ---------- JPEG：APP1 Exif 段 ---------- */
  function parseJpeg(view) {
    var offset = 2;
    var len = view.byteLength;
    while (offset < len - 4) {
      if (view.getUint8(offset) !== 0xff) { offset++; continue; }
      var marker = view.getUint8(offset + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break; // 进入图像数据
      var size = view.getUint16(offset + 2, false);
      if (size < 2) break;
      if (marker === 0xe1 && offset + 10 < len) {
        if (view.getUint32(offset + 4, false) === 0x45786966 && view.getUint16(offset + 8, false) === 0x0000) {
          return readTiff(view, offset + 10);
        }
      }
      offset += 2 + size;
    }
    return null;
  }

  /* ---------- PNG：eXIf 数据块（TIFF 裸数据） ---------- */
  function parsePng(view) {
    var pos = 8, len = view.byteLength;
    while (pos + 8 <= len) {
      var clen = view.getUint32(pos, false);
      var ctype = fourcc(view, pos + 4);
      if (ctype === 'eXIf') return readTiff(view, pos + 8);
      if (ctype === 'IEND') break;
      pos += 12 + clen; // len + type + data + crc
    }
    return null;
  }

  /* ---------- WebP：RIFF EXIF 块 ---------- */
  function parseWebp(view) {
    var pos = 12, len = view.byteLength;
    while (pos + 8 <= len) {
      var cc = fourcc(view, pos);
      var csize = view.getUint32(pos + 4, true); // RIFF 为小端
      var data = pos + 8;
      if (cc === 'EXIF') {
        var t = data;
        if (view.getUint32(data, false) === 0x45786966) t = data + 6; // 兼容带 "Exif\0\0" 前缀
        return readTiff(view, t);
      }
      pos = data + csize + (csize & 1);
    }
    return null;
  }

  /* ---------- HEIC/HEIF（iPhone 默认格式）：ISO BMFF 盒结构 ---------- */
  function readUintN(view, off, n) {
    var v = 0;
    for (var i = 0; i < n; i++) v = v * 256 + view.getUint8(off + i);
    return v;
  }

  function findExifItemId(view, start, end) {
    var ver = view.getUint8(start);
    var pos, count;
    if (ver === 0) { count = view.getUint16(start + 4, false); pos = start + 6; }
    else { count = view.getUint32(start + 4, false); pos = start + 8; }
    for (var i = 0; i < count && pos + 8 <= end; i++) {
      var bsize = view.getUint32(pos, false);
      if (bsize < 8) break;
      if (fourcc(view, pos + 4) === 'infe') {
        var v = view.getUint8(pos + 8);
        var p = pos + 12;
        var id;
        if (v >= 3) { id = view.getUint32(p, false); p += 4; }
        else { id = view.getUint16(p, false); p += 2; }
        p += 2; // item_protection_index
        if (fourcc(view, p) === 'Exif') return id;
      }
      pos += bsize;
    }
    return -1;
  }

  function ilocFind(view, start, end, wantId) {
    var ver = view.getUint8(start);
    var p = start + 4;
    var b1 = view.getUint8(p), b2 = view.getUint8(p + 1);
    var offSize = b1 >> 4, lenSize = b1 & 15, baseSize = b2 >> 4;
    var idxSize = (ver === 1 || ver === 2) ? (b2 & 15) : 0;
    p += 2;
    var count;
    if (ver < 2) { count = view.getUint16(p, false); p += 2; }
    else { count = view.getUint32(p, false); p += 4; }
    for (var i = 0; i < count && p < end; i++) {
      var id;
      if (ver < 2) { id = view.getUint16(p, false); p += 2; }
      else { id = view.getUint32(p, false); p += 4; }
      var method = 0;
      if (ver === 1 || ver === 2) { method = view.getUint16(p, false) & 15; p += 2; }
      p += 2; // data_reference_index
      var base = readUintN(view, p, baseSize); p += baseSize;
      var extCount = view.getUint16(p, false); p += 2;
      var first = null;
      for (var e = 0; e < extCount; e++) {
        if (idxSize) p += idxSize;
        var eo = readUintN(view, p, offSize); p += offSize;
        var el = readUintN(view, p, lenSize); p += lenSize;
        if (e === 0) first = { offset: base + eo, length: el };
      }
      if (id === wantId && method === 0 && first) return first;
    }
    return null;
  }

  function parseHeif(view) {
    var len = view.byteLength;
    var pos = 0, metaStart = -1, metaEnd = -1;
    while (pos + 8 <= len) {
      var size = view.getUint32(pos, false);
      var type = fourcc(view, pos + 4);
      var hdr = 8;
      if (size === 1) {
        if (pos + 16 > len) break;
        size = view.getUint32(pos + 8, false) * 4294967296 + view.getUint32(pos + 12, false);
        hdr = 16;
      } else if (size === 0) size = len - pos;
      if (size < hdr) break;
      if (type === 'meta') { metaStart = pos + hdr + 4; metaEnd = Math.min(pos + size, len); break; }
      pos += size;
    }
    if (metaStart < 0) return null;

    var exifId = -1, iloc = null;
    pos = metaStart;
    while (pos + 8 <= metaEnd) {
      var bsize = view.getUint32(pos, false);
      if (bsize < 8) break;
      var btype = fourcc(view, pos + 4);
      if (btype === 'iinf') exifId = findExifItemId(view, pos + 8, pos + bsize);
      else if (btype === 'iloc') iloc = { start: pos + 8, end: pos + bsize };
      pos += bsize;
    }
    if (exifId < 0 || !iloc) return null;
    var loc = ilocFind(view, iloc.start, iloc.end, exifId);
    if (!loc || loc.offset + 8 > len) return null;

    // Exif item 数据 = u32 tiff偏移 + ("Exif\0\0") + TIFF
    var toff = view.getUint32(loc.offset, false);
    var tiff = loc.offset + 4 + toff;
    var bom = (tiff + 4 <= len) ? view.getUint16(tiff, false) : 0;
    if (bom !== 0x4949 && bom !== 0x4d4d) {
      // 容错：在 item 数据前部扫描 TIFF 头
      var scanEnd = Math.min(loc.offset + Math.min(loc.length, 64), len - 4);
      for (var s = loc.offset; s < scanEnd; s++) {
        var w = view.getUint16(s, false);
        if ((w === 0x4949 && view.getUint16(s + 2, true) === 0x2a) ||
            (w === 0x4d4d && view.getUint16(s + 2, false) === 0x2a)) { tiff = s; break; }
      }
    }
    return readTiff(view, tiff);
  }

  function finish(r) {
    if (r) r.takenDate = parseExifDate(r.dateTaken) || parseExifDate(r.dateTime) || r.dateTakenObj || null;
    return r;
  }

  /** 解析图片 ArrayBuffer 中的 EXIF（按文件头嗅探：JPEG / PNG / WebP / HEIC・HEIF） */
  function parse(buffer) {
    try {
      var view = new DataView(buffer);
      if (view.byteLength < 12) return null;
      if (view.getUint16(0, false) === 0xffd8) return finish(parseJpeg(view));
      if (view.getUint32(0, false) === 0x89504e47) return finish(parsePng(view));
      if (fourcc(view, 0) === 'RIFF' && fourcc(view, 8) === 'WEBP') return finish(parseWebp(view));
      if (fourcc(view, 4) === 'ftyp') return finish(parseHeif(view));
      return null;
    } catch (e) {
      return null;
    }
  }

  /* ---------------- WGS84 -> GCJ02 (高德/火星坐标) ---------------- */
  var PI = Math.PI;
  var A = 6378245.0;
  var EE = 0.00669342162296594323;

  function outOfChina(lng, lat) {
    return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
  }
  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }
  /** @returns [lng, lat] GCJ02 */
  function wgs84ToGcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLng, lat + dLat];
  }

  global.ExifLite = { parse: parse, parseExifDate: parseExifDate, wgs84ToGcj02: wgs84ToGcj02 };
})(window);
