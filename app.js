/* ============================================================
 * 照片地图 · 时空轨迹 —— 单机版（免 Key）
 * 地图：Leaflet（本地 vendor/）+ 高德公开瓦片（无需注册）
 * 存储：sql.js（本地 vendor/）读写 SQLite .db
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量与全局状态 ---------------- */
  var VENDOR = 'vendor/';
  var THUMB_MAX = 200;          // 缩略图长边像素
  var REF_ZOOM = 15;            // 缩略图缩放参照层级
  var SCALE_EXP = 0.5;          // 随地图缩放的比例指数
  var SCALE_MIN = 0.28, SCALE_MAX = 3.2;
  var FALLBACK_UPSCALE = 5;     // 原图缺失时缩略图放大倍数

  var map = null;
  var stdLayer = null, satLayer = null, satRoadLayer = null;
  var isSatellite = false;
  var isMobile = false;

  var photos = [];              // {hash,name,path,takenTs,...,gLat,gLng,marker,el}
  var hashSet = Object.create(null);
  var db = null, SQL = null, dbHandle = null, dbDirty = false;
  var saveDirHandle = null;     // 保存目录句柄（File System Access API）

  var viewerOpen = false, viewerUrl = null, viewerOwnerEl = null;
  var player = { running: false, paused: false, idx: 0, list: [], timer: null, speed: 1, activeEl: null, activeMk: null };

  /* ---------------- 短工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(ts) {
    if (ts == null) return '未知时间';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function toLocalInput(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtSize(b) {
    if (b == null) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var old = $('toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (el.parentNode) el.remove(); }, ms || 2600);
  }

  function progress(title, cur, total, sub) {
    var p = $('progress');
    show(p);
    $('progTitle').textContent = title;
    $('progCount').textContent = total ? (cur + ' / ' + total) : '';
    $('progBar').style.width = total ? (cur / total * 100).toFixed(1) + '%' : '0%';
    $('progSub').textContent = sub || '';
  }
  function progressDone() { hide($('progress')); }

  /* ---------------- 哈希（优先 SHA-256，file:// 下自动降级） ---------------- */
  function fallbackHash(buf) {
    var u8 = new Uint8Array(buf);
    var h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
    for (var i = 0; i < u8.length; i++) {
      var b = u8[i];
      h1 = (h1 ^ b) >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (h2 + b) >>> 0; h2 = Math.imul(h2 ^ (h2 >>> 13), 2246822519) >>> 0;
      if ((i & 3) === 0) { h3 = (h3 ^ (b + i)) >>> 0; h3 = Math.imul(h3, 2654435761) >>> 0; }
      if ((i & 7) === 0) { h4 = (h4 ^ Math.imul(b + 1, i + 1)) >>> 0; h4 = Math.imul(h4, 3266489917) >>> 0; }
    }
    var hex = function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); };
    return 'f' + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(u8.length);
  }
  function sha256(buf) {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      return window.crypto.subtle.digest('SHA-256', buf).then(function (d) {
        var a = new Uint8Array(d), s = '';
        for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
        return s;
      }).catch(function () { return fallbackHash(buf); });
    }
    return Promise.resolve(fallbackHash(buf));
  }

  /* ============================================================
   * 一、地图初始化（Leaflet + 高德瓦片，免 Key）
   * ============================================================ */
  function tileLayer(url, opts) {
    return L.tileLayer(url, Object.assign({
      subdomains: ['1', '2', '3', '4'],
      minZoom: 3, maxZoom: 19, maxNativeZoom: 18,
      attribution: '© 高德地图'
    }, opts || {}));
  }

  function initMap() {
    map = L.map('map', {
      center: [39.90923, 116.397428],
      zoom: 12,
      zoomControl: false,        // 用自己的右下角控件
      attributionControl: true,
      zoomAnimation: true,
      wheelPxPerZoomLevel: 90
    });

    // 标准 2D 高清路网图
    stdLayer = tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}');
    // 卫星影像 + 路网标注
    satLayer = tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}');
    satRoadLayer = tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}');

    stdLayer.addTo(map);

    map.on('zoomend', updateAllScales);
    map.on('click', function () { closeViewer(); });

    $('btnZoomIn').addEventListener('click', function () { map.zoomIn(); });
    $('btnZoomOut').addEventListener('click', function () { map.zoomOut(); });
    $('btnLayer').addEventListener('click', toggleLayer);
    $('btnDevice').addEventListener('click', function () { setDevice(!isMobile, true); });
  }

  function toggleLayer() {
    isSatellite = !isSatellite;
    if (isSatellite) {
      map.removeLayer(stdLayer);
      satLayer.addTo(map);
      satRoadLayer.addTo(map);
      $('btnLayer').classList.add('on');
      toast('已切换到卫星影像');
    } else {
      map.removeLayer(satLayer);
      map.removeLayer(satRoadLayer);
      stdLayer.addTo(map);
      $('btnLayer').classList.remove('on');
      toast('已切换到标准地图');
    }
  }

  function setDevice(mobile, byUser) {
    isMobile = mobile;
    document.body.classList.toggle('is-mobile', isMobile);
    $('deviceBadge').textContent = isMobile ? '手机' : 'PC';
    if (byUser) toast(isMobile ? '已切换到手机形态：导入走相册多选' : '已切换到电脑形态：可按目录递归导入');
    if (map) setTimeout(function () { map.invalidateSize(); }, 60);
  }

  /* ============================================================
   * 二、数据库（sql.js，本地 vendor/）
   * ============================================================ */
  // file:// 协议下浏览器禁止 fetch 本地 .wasm（唯一源策略），
  // 因此双击打开时自动降级到纯 JS 的 asm.js 构建，功能一致、仅初始化稍慢。
  var IS_FILE = location.protocol === 'file:';

  function loadSqlJs() {
    if (SQL) return Promise.resolve(SQL);
    return new Promise(function (resolve, reject) {
      function boot() {
        window.initSqlJs({ locateFile: function (f) { return VENDOR + f; } })
          .then(function (m) { SQL = m; resolve(SQL); })
          .catch(function (e) {
            // wasm 拉取失败（多见于 file://）→ 再试 asm.js
            if (IS_FILE) { reject(e); return; }
            inject(VENDOR + 'sql-asm.js', boot, function () { reject(e); });
          });
      }
      function inject(src, ok, fail) {
        var s = document.createElement('script');
        s.src = src; s.onload = ok; s.onerror = fail;
        document.head.appendChild(s);
      }
      if (window.initSqlJs) { boot(); return; }
      inject(VENDOR + (IS_FILE ? 'sql-asm.js' : 'sql-wasm.js'), boot, function () {
        reject(new Error('数据库引擎加载失败，请确认 vendor 目录完整'));
      });
    });
  }

  var SCHEMA =
    'CREATE TABLE IF NOT EXISTS photos(' +
    ' id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    ' hash TEXT UNIQUE NOT NULL,' +
    ' name TEXT,' +
    ' path TEXT,' +
    ' taken_at TEXT,' +
    ' taken_ts INTEGER,' +
    ' lat REAL, lng REAL, alt REAL,' +
    ' width INTEGER, height INTEGER,' +
    ' size INTEGER,' +
    ' thumb TEXT, thumb_w INTEGER, thumb_h INTEGER,' +
    ' imported_at TEXT);' +
    'CREATE INDEX IF NOT EXISTS idx_ts ON photos(taken_ts);' +
    'CREATE INDEX IF NOT EXISTS idx_hash ON photos(hash);';

  function ensureDb() {
    return loadSqlJs().then(function () {
      if (!db) { db = new SQL.Database(); db.run(SCHEMA); }
      return db;
    });
  }

  function insertPhoto(p) {
    if (!db) return;
    try {
      db.run(
        'INSERT OR IGNORE INTO photos(hash,name,path,taken_at,taken_ts,lat,lng,alt,width,height,size,thumb,thumb_w,thumb_h,imported_at)' +
        ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [p.hash, p.name, p.path, p.takenStr, p.takenTs, p.lat, p.lng, p.alt,
         p.width, p.height, p.size, p.thumb, p.tw, p.th, new Date().toISOString()]
      );
      dbDirty = true;
    } catch (e) { console.warn('写库失败', e); }
  }

  function markDirty() {
    if (!dbDirty) return;
    var b = $('btnSave');
    show(b);
    b.classList.add('dirty');
  }

  /* ---------- 保存：目录直写 → 文件句柄 → 选择文件 → 下载，逐级降级 ---------- */
  function markSaved() {
    dbDirty = false;
    $('btnSave').classList.remove('dirty');
  }

  function tsName() {
    var d = new Date();
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  /* 首次操作时让用户选定项目目录（即 index.html 所在目录），之后所有加载/保存都默认到该目录 */
  function ensureProjectDir() {
    if (saveDirHandle) {
      // 已有句柄，校验权限
      return saveDirHandle.queryPermission({ mode: 'readwrite' }).then(function (v) {
        if (v === 'granted') return saveDirHandle;
        return saveDirHandle.requestPermission({ mode: 'readwrite' }).then(function (v2) {
          return v2 === 'granted' ? saveDirHandle : null;
        });
      }).catch(function () { return saveDirHandle; });
    }
    if (!window.showDirectoryPicker) return Promise.resolve(null);
    toast('请选择项目所在目录（含 index.html / photos.db），后续将默认使用此目录', 8000);
    return window.showDirectoryPicker({ mode: 'readwrite' }).then(function (h) {
      saveDirHandle = h;
      return h;
    }).catch(function () { return null; });
  }

  /* 写入项目目录：自动备份旧 photos.db 后覆盖新建 */
  function writeToDir(bytes) {
    var backupName = null;
    // 检查现有 photos.db，有则先备份
    return saveDirHandle.getFileHandle('photos.db').then(function (existing) {
      backupName = 'photos_' + tsName() + '.db';
      return existing.getFile().then(function (oldFile) {
        return oldFile.arrayBuffer();
      }).then(function (oldBuf) {
        return saveDirHandle.getFileHandle(backupName, { create: true }).then(function (bh) {
          return bh.createWritable().then(function (w) {
            return w.write(oldBuf).then(function () { return w.close(); });
          });
        });
      }).then(function () {
        // 删除旧 photos.db（下面新建）
        return saveDirHandle.removeEntry('photos.db');
      });
    }).catch(function () { /* 旧文件不存在，跳过备份 */ })
      .then(function () {
        // 写入新的 photos.db
        return saveDirHandle.getFileHandle('photos.db', { create: true });
      }).then(function (newHandle) {
        return newHandle.createWritable().then(function (w) {
          return w.write(bytes).then(function () { return w.close(); });
        });
      }).then(function () {
        markSaved();
        toast('已保存到 ' + saveDirHandle.name + '/photos.db' + (backupName ? '（旧版已备份 ' + backupName + '）' : ''), 8000);
      });
  }

  function writeToFileHandle(bytes) {
    return dbHandle.createWritable().then(function (w) {
      return w.write(bytes).then(function () { return w.close(); });
    }).then(function () {
      markSaved();
      toast('已保存到 ' + (dbHandle.name || 'photos.db'));
    });
  }

  function pickFileAndWrite(bytes) {
    var opts = {
      suggestedName: 'photos.db',
      types: [{ description: 'SQLite 数据库', accept: { 'application/octet-stream': ['.db'] } }]
    };
    if (saveDirHandle) opts.startIn = saveDirHandle;
    return window.showSaveFilePicker(opts).then(function (h) {
      dbHandle = h;
      return writeToFileHandle(bytes);
    });
  }

  function downloadDb(bytes) {
    var blob = new Blob([bytes || db.export()], { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'photos.db';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    markSaved();
    toast('已导出 photos.db，放到网页同目录即可被自动加载');
  }

  /* 统一保存入口 */
  function saveData() {
    if (!db) { toast('还没有数据可保存'); return Promise.resolve(); }
    var bytes = db.export();

    // 文件级降级：已有文件句柄直写 → 选择文件 → 下载
    function fallbackFile() {
      if (dbHandle) {
        return writeToFileHandle(bytes).catch(function (e) {
          console.warn('文件句柄写入失败，重新选择文件', e);
          dbHandle = null;
          return fallbackFile();
        });
      }
      if (window.showSaveFilePicker) return pickFileAndWrite(bytes);
      downloadDb(bytes);
      return Promise.resolve();
    }

    return ensureProjectDir().then(function (dirH) {
      if (dirH) return writeToDir(bytes);
      return fallbackFile();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;   // 用户取消选择，静默
      console.warn('保存失败，尝试降级保存', e);
      fallbackFile().catch(function (e2) {
        if (e2 && e2.name === 'AbortError') return;
        console.warn(e2);
        downloadDb(bytes);
      });
    });
  }

  /** 从字节载入数据库并合并 */
  function loadDbBytes(bytes) {
    return loadSqlJs().then(function () {
      var loaded = new SQL.Database(new Uint8Array(bytes));
      var res;
      try {
        res = loaded.exec('SELECT hash,name,path,taken_at,taken_ts,lat,lng,alt,width,height,size,thumb,thumb_w,thumb_h FROM photos');
      } catch (e) {
        loaded.close();
        throw new Error('这不是本工具生成的数据库');
      }
      if (!db) { db = new SQL.Database(); db.run(SCHEMA); }

      var added = 0, skipped = 0, noGeo = 0;
      var newOnes = [];
      if (res && res[0]) {
        var rows = res[0].values;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var p = {
            hash: r[0], name: r[1], path: r[2], takenStr: r[3], takenTs: r[4],
            lat: r[5], lng: r[6], alt: r[7], width: r[8], height: r[9], size: r[10],
            thumb: r[11], tw: r[12] || THUMB_MAX, th: r[13] || THUMB_MAX,
            file: null, fromDb: true
          };
          if (hashSet[p.hash]) { skipped++; continue; }
          hashSet[p.hash] = true;
          if (p.lat == null || p.lng == null) { noGeo++; continue; }
          insertPhoto(p);
          photos.push(p);
          addMarker(p);
          newOnes.push(p);
          added++;
        }
      }
      loaded.close();
      return { added: added, skipped: skipped, noGeo: noGeo, newOnes: newOnes };
    });
  }

  /* ============================================================
   * 三、照片解析：EXIF + 缩略图 + 哈希
   * ============================================================ */
  function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return decodeViaImg(file); });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('解码失败')); };
      img.src = url;
    });
  }

  function makeThumb(src) {
    var w = src.width || src.naturalWidth;
    var h = src.height || src.naturalHeight;
    if (!w || !h) return null;
    var ratio = Math.min(1, THUMB_MAX / Math.max(w, h));
    var tw = Math.max(1, Math.round(w * ratio));
    var th = Math.max(1, Math.round(h * ratio));
    var c = document.createElement('canvas');
    c.width = tw; c.height = th;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    if (src.close) { try { src.close(); } catch (e) {} }
    return { data: c.toDataURL('image/jpeg', 0.75), tw: tw, th: th, w: w, h: h };
  }

  function readBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  var IMG_RE = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i;

  // 浏览器解码不了的格式（如 Chrome 下的 HEIC）：给一张带文件名的占位缩略图，
  // GPS 点位照常上图，不丢数据。
  function placeholderThumb(name) {
    var c = document.createElement('canvas');
    c.width = 220; c.height = 220;
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 220, 220);
    g.addColorStop(0, '#dfe7f2'); g.addColorStop(1, '#c3cfe0');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 220, 220);
    ctx.fillStyle = '#8494ab';
    ctx.font = '600 64px -apple-system,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('📷', 110, 88);
    ctx.fillStyle = '#5c6b82';
    ctx.font = '600 20px -apple-system,sans-serif';
    var s = name.length > 16 ? name.slice(0, 15) + '…' : name;
    ctx.fillText(s, 110, 168);
    return { data: c.toDataURL('image/jpeg', 0.8), tw: 220, th: 220, w: 220, h: 220 };
  }

  function processFile(file) {
    var buf = null;
    return readBuffer(file).then(function (b) {
      buf = b;
      return sha256(buf);
    }).then(function (hash) {
      if (hashSet[hash]) return { dup: true };
      // 按文件头嗅探解析 EXIF（JPEG/PNG/WebP/HEIC 均支持），不再依赖扩展名
      var exif = ExifLite.parse(buf);
      buf = null;
      return decodeImage(file).then(function (src) {
        return makeThumb(src);
      }).catch(function () {
        return null;   // 解码失败（如 Chrome 遇 HEIC）→ 走占位图
      }).then(function (t) {
        if (!t) t = placeholderThumb(file.name);
        var takenDate = (exif && exif.takenDate) ? exif.takenDate : new Date(file.lastModified || Date.now());
        var hasExifTime = !!(exif && exif.takenDate);
        return {
          hash: hash,
          name: file.name,
          path: file.webkitRelativePath || file.name,
          takenTs: takenDate.getTime(),
          takenStr: fmtTime(takenDate.getTime()),
          approxTime: !hasExifTime,
          lat: exif ? exif.lat : null,
          lng: exif ? exif.lng : null,
          alt: exif ? exif.altitude : null,
          width: t.w, height: t.h, size: file.size,
          thumb: t.data, tw: t.tw, th: t.th,
          file: file
        };
      });
    });
  }

  /* ============================================================
   * 四、导入流程
   * ============================================================ */
  var importing = false;

  function handleFiles(fileList) {
    if (importing) { toast('正在导入中，请稍候'); return; }
    var files = [];
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var isImg = IMG_RE.test(f.name) || /^image\//i.test(f.type || '');
      if (isImg && f.size > 0) files.push(f);
    }
    if (!files.length) { toast('没有找到可识别的照片文件'); return; }

    importing = true;
    ensureDb().catch(function (e) {
      console.warn(e);
      toast('数据库组件不可用，本次仅在地图上展示（建议用启动脚本打开）', 8000);
    }).then(function () {
      return runImport(files);
    }).then(function (stat) {
      importing = false;
      progressDone();
      finishImport(stat);
    }).catch(function (e) {
      importing = false; progressDone();
      console.error(e);
      toast('导入出错：' + (e.message || e));
    });
  }

  function runImport(files) {
    var stat = { total: files.length, ok: 0, dup: 0, noGeo: 0, fail: 0 };
    var i = 0;
    var newOnes = [];

    function step() {
      if (i >= files.length) return Promise.resolve(stat);
      var f = files[i];
      progress('正在解析照片', i, files.length, (f.webkitRelativePath || f.name));
      return processFile(f).then(function (p) {
        if (p.dup) { stat.dup++; return; }
        hashSet[p.hash] = true;
        if (p.lat == null || p.lng == null) { stat.noGeo++; return; }
        insertPhoto(p);
        photos.push(p);
        addMarker(p);
        newOnes.push(p);
        stat.ok++;
      }).catch(function (e) {
        console.warn('跳过', f.name, e);
        stat.fail++;
      }).then(function () {
        i++;
        return new Promise(function (r) { setTimeout(r, 0); }).then(step);
      });
    }

    return step().then(function () {
      stat.newOnes = newOnes;
      return stat;
    });
  }

  function finishImport(stat) {
    var msg = '共导入 ' + stat.total + ' 张';
    var ext = [];
    if (stat.dup) ext.push(stat.dup + ' 张重复（根据哈希值判断）');
    if (stat.noGeo) ext.push(stat.noGeo + ' 张未提取到经纬度');
    if (stat.fail) ext.push(stat.fail + ' 张失败');
    if (ext.length) msg += '，' + ext.join('，');
    msg += '，实际导入 ' + stat.ok + ' 张。';
    toast(msg, 8000);

    updateStat();
    if (stat.newOnes && stat.newOnes.length) fitToPhotos(stat.newOnes);
    markDirty();
    if (saveDirHandle && dbDirty) saveData();
  }

  /* 加载 db 后的统一收尾：更新统计、定位到新照片、提示结果 */
  function reportLoad(r) {
    progressDone();
    updateStat();
    if (r.newOnes && r.newOnes.length) fitToPhotos(r.newOnes);
    var total = r.added + r.skipped + r.noGeo;
    var msg = '共加载 ' + total + ' 张';
    var ext = [];
    if (r.skipped) ext.push(r.skipped + ' 张重复（根据哈希值判断）');
    if (r.noGeo) ext.push(r.noGeo + ' 张未提取到经纬度');
    if (ext.length) msg += '，' + ext.join('，');
    msg += '，实际导入 ' + r.added + ' 张。';
    toast(msg, 8000);
  }

  function fitToPhotos(list) {
    if (!list.length) return;
    if (list.length === 1) {
      map.panTo([list[0].gLat, list[0].gLng]);
      if (map.getZoom() < 14) map.setZoom(16);
      return;
    }
    var b = L.latLngBounds(list.map(function (p) { return [p.gLat, p.gLng]; }));
    map.fitBounds(b, { padding: [100, 100], maxZoom: 17 });
  }

  /* 返回有拍摄时间的照片及其时间范围 [min, max]，无照片时 min/max 为 null */
  function photoTimeRange() {
    var withT = photos.filter(function (p) { return p.takenTs != null; });
    if (!withT.length) return { list: [], min: null, max: null };
    var min = Math.min.apply(null, withT.map(function (p) { return p.takenTs; }));
    var max = Math.max.apply(null, withT.map(function (p) { return p.takenTs; }));
    return { list: withT, min: min, max: max };
  }

  function updateStat() {
    var bar = $('statBar');
    if (!photos.length) { hide(bar); return; }
    show(bar);
    $('statTotal').textContent = photos.length;
    var tr = photoTimeRange();
    if (tr.list.length) {
      $('statRange').textContent = '· ' + fmtTime(tr.min).slice(0, 10) + ' 至 ' + fmtTime(tr.max).slice(0, 10);
    } else {
      $('statRange').textContent = '';
    }
  }

  /* ============================================================
   * 五、地图点位（缩略图标记）
   * ============================================================ */
  function currentScale() {
    var z = map ? map.getZoom() : REF_ZOOM;
    return clamp(Math.pow(2, (z - REF_ZOOM) * SCALE_EXP), SCALE_MIN, SCALE_MAX);
  }

  function addMarker(p) {
    var g = ExifLite.wgs84ToGcj02(p.lng, p.lat);   // 高德瓦片为 GCJ02，需纠偏
    p.gLng = g[0]; p.gLat = g[1];

    var el = document.createElement('div');
    el.className = 'pm' + (p.approxTime ? ' no-time' : '');
    el.style.setProperty('--s', currentScale());
    el.innerHTML = '<span class="pm-wobble"><span class="pm-box" style="display:block"><img alt=""></span></span>';
    el.querySelector('img').src = p.thumb;

    var icon = L.divIcon({ className: 'pm-icon', html: el, iconSize: [0, 0], iconAnchor: [0, 0] });
    var marker = L.marker([p.gLat, p.gLng], { icon: icon, riseOnHover: true });

    el.addEventListener('mouseenter', function () { if (!isMobile) openViewer(p, el); });
    el.addEventListener('mouseleave', function () { if (!isMobile && viewerOpen) closeViewer(); });
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (viewerOpen && viewerOwnerEl === el) { closeViewer(); return; }
      openViewer(p, el);
    });

    marker.addTo(map);
    p.marker = marker;
    p.el = el;
  }

  function updateAllScales() {
    var s = currentScale();
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      if (!p.el) continue;
      // 播放规则叠加：正在播放的点位始终是当前比例的 2 倍
      var mul = (p.el === player.activeEl) ? 2 : 1;
      p.el.style.setProperty('--s', s * mul);
    }
  }

  /* ============================================================
   * 六、大图查看器（悬停/点按弹出，不遮死底图）
   * ============================================================ */
  var viewerDom = null;
  var dismissBound = false;

  function buildViewer() {
    var box = document.createElement('div');
    box.id = 'viewer';
    box.innerHTML = '<div class="frame"><img id="viewerImg" alt=""></div><div id="viewerMeta"></div>';
    document.body.appendChild(box);
    return { box: box };
  }

  function dismissHandler(e) {
    if (viewerOwnerEl && e.target && e.target.closest && e.target.closest('.pm') === viewerOwnerEl) return;
    closeViewer();
  }
  function bindDismiss() {
    if (dismissBound) return;
    setTimeout(function () {
      if (!viewerOpen) return;
      document.addEventListener('click', dismissHandler, true);
      document.addEventListener('touchstart', dismissHandler, true);
      dismissBound = true;
    }, 0);
  }
  function unbindDismiss() {
    document.removeEventListener('click', dismissHandler, true);
    document.removeEventListener('touchstart', dismissHandler, true);
    dismissBound = false;
  }

  function openViewer(p, ownerEl) {
    if (viewerOpen) closeViewer();
    if (!viewerDom) viewerDom = buildViewer();
    else show(viewerDom.box);
    viewerOpen = true;
    viewerOwnerEl = ownerEl || null;
    bindDismiss();

    var img = $('viewerImg');
    var meta = $('viewerMeta');
    var warn = '';

    if (p.file) {
      viewerUrl = URL.createObjectURL(p.file);
      img.style.width = '';
      img.style.maxHeight = '';
      img.src = viewerUrl;
    } else {
      // 原图路径不存在：缩略图等比放大 5 倍展示，不报错
      img.src = p.thumb;
      img.style.width = (p.tw * FALLBACK_UPSCALE) + 'px';
      img.style.maxHeight = 'none';
      warn = '<div class="warn">原图不在本机 · 缩略图已放大 ' + FALLBACK_UPSCALE + ' 倍显示</div>';
    }

    meta.innerHTML =
      '<div class="n">' + escapeHtml(p.name) + '</div>' +
      '<div class="s">' + (p.approxTime ? '≈ ' : '') + fmtTime(p.takenTs) +
      '　' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) +
      (p.size ? '　' + fmtSize(p.size) : '') + '</div>' +
      (p.path && p.path !== p.name ? '<div class="s">' + escapeHtml(p.path) + '</div>' : '') +
      warn;
  }

  function closeViewer() {
    if (!viewerOpen || !viewerDom) return;
    viewerOpen = false;
    viewerOwnerEl = null;
    unbindDismiss();
    hide(viewerDom.box);
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  }

  /* ============================================================
   * 七、播放引擎（只平移视野，不动缩放级别）
   * ============================================================ */
  function updatePlayHint() {
    var tr = photoTimeRange();
    if (!tr.list.length) {
      $('playHint').innerHTML = '没有带拍摄时间的照片。';
      return;
    }
    var s = $('playStart').value, e = $('playEnd').value;
    var st = s ? new Date(s).getTime() : -Infinity;
    var et = e ? new Date(e).getTime() : Infinity;
    var inRange = tr.list.filter(function (p) { return p.takenTs >= st && p.takenTs <= et; });
    var msg = '当前时间范围内共 <b>' + inRange.length + '</b> 张照片';
    msg += '（总共 ' + tr.list.length + ' 张，全范围 ' + fmtTime(tr.min) + ' ~ ' + fmtTime(tr.max) + '）';
    $('playHint').innerHTML = msg;
  }

  function openPlayModal() {
    var tr = photoTimeRange();
    if (!tr.list.length) { toast('还没有可播放的照片，请先导入或加载数据'); return; }
    $('playStart').value = toLocalInput(tr.min);
    $('playEnd').value = toLocalInput(tr.max + 60000);
    updatePlayHint();
    show($('playModal'));
  }

  function startPlay() {
    var s = $('playStart').value, e = $('playEnd').value;
    var st = s ? new Date(s).getTime() : -Infinity;
    var et = e ? new Date(e).getTime() : Infinity;
    if (st > et) { toast('开始时间不能晚于结束时间'); return; }
    var speed = parseFloat($('playSpeed').value) || 1;

    var list = photos.filter(function (p) {
      return p.takenTs != null && p.takenTs >= st && p.takenTs <= et;
    }).sort(function (a, b) { return a.takenTs - b.takenTs; });

    if (!list.length) { toast('该时间范围内没有照片'); return; }

    hide($('playModal'));
    closeViewer();
    player.running = true;
    player.paused = false;
    player.idx = 0;
    player.list = list;
    player.speed = speed;
    show($('playHud'));
    setHudIcon(true);
    tickPlay();
  }

  function interval() { return Math.max(140, 1300 / player.speed); }

  function tickPlay() {
    if (!player.running) return;
    if (player.idx >= player.list.length) { stopPlay(true); return; }

    var p = player.list[player.idx];
    // 上一个恢复原比例
    if (player.activeEl) {
      player.activeEl.classList.remove('active', 'shake');
      player.activeEl.style.setProperty('--s', currentScale());
    }
    if (player.activeMk) player.activeMk.setZIndexOffset(0);

    // 当前：抖动 + 放大到当前比例的 2 倍
    if (p.el) {
      player.activeEl = p.el;
      player.activeMk = p.marker;
      p.el.classList.add('active');
      p.el.style.setProperty('--s', currentScale() * 2);
      p.marker.setZIndexOffset(2000);
      p.el.classList.remove('shake');
      void p.el.offsetWidth;   // 重新触发抖动动画
      p.el.classList.add('shake');
    }
    // 只平移视野让点位居中，绝不改缩放级别
    map.panTo([p.gLat, p.gLng], { animate: true, duration: Math.min(0.7, interval() / 1000 * 0.65) });

    $('hudName').textContent = p.name;
    $('hudTime').textContent = (p.approxTime ? '≈ ' : '') + fmtTime(p.takenTs) +
      '　·　' + (player.idx + 1) + ' / ' + player.list.length;
    $('hudBar').style.width = ((player.idx + 1) / player.list.length * 100) + '%';

    player.timer = setTimeout(function () {
      if (!player.running || player.paused) return;
      player.idx++;
      tickPlay();
    }, interval());
  }

  function pausePlay() {
    if (!player.running) return;
    player.paused = !player.paused;
    setHudIcon(!player.paused);
    if (!player.paused) { player.idx++; tickPlay(); }
    else clearTimeout(player.timer);
  }

  function setHudIcon(playing) {
    $('hudToggle').innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5-12-7.5Z"/></svg>';
  }

  function stopPlay(finished) {
    player.running = false;
    player.paused = false;
    clearTimeout(player.timer);
    if (player.activeEl) {
      player.activeEl.classList.remove('active', 'shake');
      player.activeEl = null;
    }
    if (player.activeMk) { player.activeMk.setZIndexOffset(0); player.activeMk = null; }
    updateAllScales();
    hide($('playHud'));
    if (finished) toast('播放结束，共 ' + player.list.length + ' 个点位');
  }

  /* ============================================================
   * 八、事件绑定
   * ============================================================ */
  function bindUI() {
    var menu = $('importMenu');

    $('btnImport').addEventListener('click', function (e) {
      e.stopPropagation();
      if (isMobile) { $('fileInput').click(); return; }
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', function () { hide(menu); });
    menu.addEventListener('click', function (e) {
      e.stopPropagation();
      var btn = e.target.closest('.menu-item');
      if (!btn) return;
      hide(menu);
      if (btn.dataset.act === 'dir') $('dirInput').click();
      else $('fileInput').click();
    });

    $('dirInput').addEventListener('change', function () {
      if (this.files && this.files.length) handleFiles(this.files);
      this.value = '';
    });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files.length) handleFiles(this.files);
      this.value = '';
    });

    $('btnLoad').addEventListener('click', function () {
      if (window.showOpenFilePicker) {
        pickDbFile();
      } else {
        $('dbInput').click();
      }
    });
    $('dbInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      progress('正在读取数据库', 0, 1, f.name);
      readBuffer(f).then(loadDbBytes).then(reportLoad).catch(function (e) {
        progressDone();
        toast('加载失败：' + (e.message || e), 8000);
      });
    });
    // 通过 File System Access API 选择 .db 文件，默认指向项目目录
    function pickDbFile() {
      ensureProjectDir().then(function () {
        var opts = {
          multiple: false,
          types: [{ description: 'SQLite 数据库', accept: { 'application/octet-stream': ['.db', '.sqlite', '.sqlite3'] } }]
        };
        if (saveDirHandle) opts.startIn = saveDirHandle;
        return window.showOpenFilePicker(opts);
      }).then(function (handles) {
        if (!handles || !handles[0]) return null;
        var handle = handles[0];
        return handle.getFile().then(function (file) {
          progress('正在读取数据库', 0, 1, file.name);
          return file.arrayBuffer();
        }).then(function (buf) {
          return loadDbBytes(buf);
        });
      }).then(function (r) {
        if (!r) return;
        reportLoad(r);
      }).catch(function (e) {
        progressDone();
        if (e && e.name === 'AbortError') return;
        toast('加载失败：' + (e.message || e), 8000);
      });
    }

    $('btnSave').addEventListener('click', function () { saveData(); });

    $('btnPlay').addEventListener('click', openPlayModal);
    $('playCancel').addEventListener('click', function () { hide($('playModal')); });
    $('playConfirm').addEventListener('click', startPlay);
    $('playStart').addEventListener('input', updatePlayHint);
    $('playEnd').addEventListener('input', updatePlayHint);
    $('playModal').addEventListener('click', function (e) {
      if (e.target === this) hide(this);
    });

    $('hudStop').addEventListener('click', function () { stopPlay(false); });
    $('hudToggle').addEventListener('click', pausePlay);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeViewer(); hide($('playModal')); if (player.running) stopPlay(false); }
      if (e.key === ' ' && player.running) { e.preventDefault(); pausePlay(); }
    });

    window.addEventListener('beforeunload', function (e) {
      if (dbDirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ============================================================
   * 九、启动
   * ============================================================ */
  function detectMobile() {
    return /Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(navigator.userAgent) ||
      (window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
  }

  function tryAutoLoadDb() {
    if (location.protocol === 'file:') return;   // file:// 下 fetch 受限，改走"加载数据"按钮
    fetch('photos.db', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) return null;
      return r.arrayBuffer();
    }).then(function (buf) {
      if (!buf || buf.byteLength < 100) return;
      return loadDbBytes(buf).then(function (r) {
        if (r.added) {
          updateStat();
          if (r.newOnes && r.newOnes.length) fitToPhotos(r.newOnes);
          toast('已自动加载同目录 photos.db：' + r.added + ' 张照片', 8000);
        }
      });
    }).catch(function () { /* 没有该文件则静默 */ });
  }

  function boot() {
    setDevice(detectMobile(), false);
    bindUI();
    initMap();
    tryAutoLoadDb();
    if (IS_FILE) {
      setTimeout(function () {
        toast('当前是双击打开（file:// 模式）：功能可用，但无法自动读取同目录 photos.db。建议用「启动-Mac.command / 启动-Windows.bat」打开，体验完整。', 8000);
      }, 1200);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
