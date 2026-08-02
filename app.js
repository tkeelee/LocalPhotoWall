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

  /* 性能优化：低缩放用 Canvas 圆点，高缩放用缩略图 + 视口裁剪 */
  var ZOOM_THUMB = 14;          // >= 此层级渲染缩略图标记；< 此层级渲染 Canvas 圆点
  var VIEWPORT_PAD = 0.5;       // 视口外扩比例，避免平移时频繁增删
  var RENDER_BATCH = 60;        // 每帧批量创建的缩略图标记数
  var LOAD_BATCH = 200;         // 数据库加载每批处理的行数

  var map = null;
  var stdLayer = null, satLayer = null, satRoadLayer = null;
  var overLayers = {};            // 海外底图：id -> L.TileLayer（本地优先 / 远端兜底）
  var isSatellite = false;
  var inChinaNow = true;          // 地图中心是否在国内（国内用高德 / 海外用全球瓦片）
  var offlineReady = false;       // 是否已下载过本地瓦片（true 时海外优先读 tiles/）
  var isMobile = false;

  var photos = [];              // {hash,name,path,takenTs,...,gLat,gLng,marker,el}
  var hashSet = Object.create(null);
  var db = null, SQL = null, dbHandle = null, dbDirty = false;
  var saveDirHandle = null;     // 保存目录句柄（File System Access API）

  var viewerOpen = false, viewerUrl = null, viewerOwnerEl = null;
  var player = { running: false, paused: false, idx: 0, list: [], listSet: null, timer: null, speed: 1, activeEl: null, activeMk: null };

  /* 渲染层：高缩放用 thumbLayer(divIcon 缩略图 + 视口裁剪)，低缩放用 dotLayer(Canvas 圆点) */
  var thumbLayer = null, dotLayer = null, dotRenderer = null;
  var renderRaf = 0, scaleRaf = 0;
  var playerThumb = null;           // 播放时低缩放下当前照片的临时缩略图 marker

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
  var initGuard = false;   // 防止引导流程重复触发
  function toast(msg, ms) {
    var d = (ms === undefined || ms === null) ? 5000 : ms;
    var old = $('toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (el.parentNode) el.remove(); }, d);
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

  /* 海外底图配置（全球覆盖，免 Key，WGS84）。
     std 用 OSM 标准图（显示用）。离线下载功能已禁用（见下方注释块）；
     若日后启用下载，需把 std 换成支持 CORS 的源（如 CARTO Voyager）。
     id/ext 仅供本地瓦片路径使用，下载禁用时无影响。 */
  var OVER_CFG = [
    { id: 'std',   url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: ['a', 'b', 'c'], ext: 'png', attr: '© OpenStreetMap' },
    { id: 'sat',   url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', sub: [], ext: 'jpg', attr: '© Esri' },
    { id: 'label', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', sub: [], ext: 'png', attr: '' }
  ];

  /* 本地优先、远端兜底的瓦片层：
     已下载(offlineReady) → 先读 tiles/<id>/<z>/<x>/<y>.<ext>，404 再回源；
     未下载 → 直接回源，避免海量 404。 */
  function offlineTileLayer(cfg) {
    var opts = { minZoom: 3, maxZoom: 19, maxNativeZoom: 18, attribution: cfg.attr || '' };
    if (cfg.sub && cfg.sub.length) opts.subdomains = cfg.sub;
    var layer = L.tileLayer(cfg.url, opts);
    layer.createTile = function (coords, done) {
      var img = document.createElement('img');
      var local = 'tiles/' + cfg.id + '/' + coords.z + '/' + coords.x + '/' + coords.y + '.' + cfg.ext;
      var remote = layer.getTileUrl(coords);
      var triedRemote = false;
      img.onload = function () { done(null, img); };
      img.onerror = function () {
        if (!triedRemote) { triedRemote = true; img.src = remote; }
        else { done(new Error('tile'), img); }
      };
      if (offlineReady) img.src = local;
      else { triedRemote = true; img.src = remote; }
      return img;
    };
    return layer;
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

    // 标准 2D 高清路网图（仅国内有详情，海外为空白）
    stdLayer = tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}');
    // 卫星影像 + 路网标注（国内）
    satLayer = tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}');
    satRoadLayer = tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}');

    // 海外底图（全球覆盖，免 Key，WGS84 —— 海外点位不做 GCJ02 偏移，天然对齐）
    OVER_CFG.forEach(function (cfg) { overLayers[cfg.id] = offlineTileLayer(cfg); });
    // offlineReady = localStorage.getItem('pw_offline') === '1';   // 【离线下载已禁用】保持 false，始终走远端

    applyBasemap();   // 按 inChinaNow / isSatellite 决定显示哪套底图

    // 渲染层初始化：thumbLayer(divIcon 缩略图) / dotLayer(Canvas 圆点) 按缩放级别切换
    thumbLayer = L.layerGroup();
    dotLayer = L.layerGroup();
    dotRenderer = L.canvas({ padding: 0.5 });

    map.on('zoomend', function () { updateAllScales(); scheduleRender(); });
    map.on('moveend', function () { detectRegion(); scheduleRender(); });
    map.on('click', function () { closeViewer(); });

    $('btnZoomIn').addEventListener('click', function () { map.zoomIn(); });
    $('btnZoomOut').addEventListener('click', function () { map.zoomOut(); });
    $('btnLayer').addEventListener('click', toggleLayer);
    $('btnDevice').addEventListener('click', function () { setDevice(!isMobile, true); });

    // 右下角比例尺：随缩放/平移实时更新
    map.on('zoomend', updateScale);
    map.on('moveend', updateScale);
    updateScale();
    initSearchBox();
  }

  /* 右下角比例尺：按中心纬度 + 缩放级别计算地面尺度（Web Mercator），
     跟踪地图软件样式——标尺规整为 1/2/5×10ⁿ，下方标注实际距离。 */
  function updateScale() {
    var bar = $('scaleBar');
    if (!bar || !map) return;
    var lat = map.getCenter().lat;
    var zoom = map.getZoom();
    // 赤道分辨率（米/像素，zoom0）乘 cos(纬度) 得当前纬度每像素地面距离
    var mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    var targetPx = 80;                          // 标尺目标像素宽度
    var dist = niceScaleNumber(mpp * targetPx); // 规整为 1/2/5×10ⁿ
    var px = dist / mpp;
    bar.querySelector('.scale-line').style.width = Math.round(px) + 'px';
    bar.querySelector('.scale-label').textContent = formatScaleDist(dist);
  }
  function niceScaleNumber(v) {
    if (!(v > 0)) return 1;
    var exp = Math.floor(Math.log10(v));
    var base = Math.pow(10, exp);
    var f = v / base;
    var nf = f >= 5 ? 5 : (f >= 2 ? 2 : 1);
    return nf * base;
  }
  function formatScaleDist(m) {
    if (m >= 1000) {
      var km = m / 1000;
      return (km % 1 === 0 ? km : (Math.round(km * 10) / 10)) + ' km';
    }
    if (m >= 1) return m + ' m';
    return (Math.round(m * 100) / 100) + ' m';
  }

  /* 左上角地点搜索：本地数据集（省市区+5A景区，GCJ-02）优先 + OSM/镜像地球远程补充 */
  function initSearchBox() {
    var input = $('searchInput');
    var results = $('searchResults');
    var spin = $('searchSpin');
    if (!input || !map) return;

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function showLoading(on) { spin.classList.toggle('on', !!on); }
    function closeResults() { results.classList.add('hidden'); }

    var debounce = null;
    var reqSeq = 0;
    var items = [];

    /* 本地数据集：省市区三级 + 5A景区（均为 GCJ-02 坐标，无需纠偏）
       若数据文件未加载（file:// 缺失等），localData 为空，仅走远程搜索 */
    var localData = [];
    if (window.CHINA_PLACES) {
      window.CHINA_PLACES.forEach(function (p) {
        localData.push({ src: 'local', type: 'area', name: p.n, path: p.p, lng: p.lng, lat: p.lat, deep: p.d });
      });
    }
    if (window.SCENIC_5A) {
      window.SCENIC_5A.forEach(function (s) {
        localData.push({ src: 'local', type: 'scenic', name: s.n, path: s.p, lng: s.lng, lat: s.lat });
      });
    }

    function localSearch(q) {
      var ql = q.toLowerCase();
      var matched = [];
      for (var i = 0; i < localData.length; i++) {
        var d = localData[i];
        if (d.name.toLowerCase().indexOf(ql) >= 0 || d.path.toLowerCase().indexOf(ql) >= 0) {
          matched.push(d);
          if (matched.length >= 8) break;
        }
      }
      return matched;
    }

    // 远程地理编码：OSM 官方优先，镜像地球（国内可直连）作为降级
    var OSM_SEARCH = 'https://nominatim.openstreetmap.org/search';
    var MIRROR_SEARCH = 'https://api.mirror-earth.com/nominatim/search';
    var OSM_TIMEOUT = 5000;
    var osmSuspect = false;
    var osmRetryAt = 0;

    function renderEmpty(msg) {
      items = [];
      results.innerHTML = '<div class="search-empty">' + escapeHtml(msg) + '</div>';
      results.classList.remove('hidden');
    }

    /* 渲染合并结果：本地在前，远程在后 */
    function renderMerged(local, remote) {
      items = [];
      var html = '';
      if (local.length) {
        local.forEach(function (r) {
          var icon = r.type === 'scenic' ? '\uD83C\uDFDB' : '\uD83D\uDCCD';
          var typeLabel = r.type === 'scenic' ? '5A景区' : (r.deep === 0 ? '省份' : r.deep === 1 ? '城市' : '区县');
          var coord = r.lat.toFixed(5) + ', ' + r.lng.toFixed(5);
          html += '<div class="search-item" data-i="' + items.length + '">' +
            '<div class="search-title">' + icon + ' ' + escapeHtml(r.name) + '</div>' +
            '<div class="search-sub">' + escapeHtml(r.path) + ' \u00B7 ' + typeLabel + '</div>' +
            '<div class="search-coord">' + coord + '</div></div>';
          items.push(r);
        });
      }
      if (remote && remote.length) {
        if (local.length) {
          html += '<div class="search-empty" style="padding:5px 10px;font-size:11px;color:#9aa3b1">\u2014 \u5728\u7EBF\u641C\u7D22 \u2014</div>';
        }
        remote.forEach(function (r) {
          var a = r.address || {};
          var title = (r.display_name ? String(r.display_name).split(',')[0].trim() : '') || r.name || '未知地点';
          var main = a.city || a.town || a.county || a.state || '';
          var region = [a.state, a.country].filter(function (x) { return x && x !== main; }).join(' \u00B7 ');
          var coord = parseFloat(r.lat).toFixed(5) + ', ' + parseFloat(r.lon).toFixed(5);
          html += '<div class="search-item" data-i="' + items.length + '">' +
            '<div class="search-title">\uD83C\uDF10 ' + escapeHtml(title) + '</div>' +
            (region ? '<div class="search-sub">' + escapeHtml(region) + '</div>' : '') +
            '<div class="search-coord">' + coord + '</div></div>';
          items.push({ src: 'remote', lat: r.lat, lng: r.lon, name: title });
        });
      }
      showLoading(false);
      if (!items.length) { renderEmpty('无结果'); return; }
      results.innerHTML = html;
      results.classList.remove('hidden');
    }

    function doSearch(q) {
      var local = localSearch(q);
      if (local.length) renderMerged(local, null);   // 本地结果即时显示
      var useMirror = osmSuspect && Date.now() < osmRetryAt;
      searchProvider(q, useMirror, local);
    }

    function searchProvider(q, useMirror, local) {
      var id = ++reqSeq;
      if (!local.length) showLoading(true);
      var base = useMirror ? MIRROR_SEARCH : OSM_SEARCH;
      var url = base + '?format=jsonv2&q=' + encodeURIComponent(q) +
        '&limit=6&accept-language=zh-CN&addressdetails=1';
      var controller = ('AbortController' in window) ? new AbortController() : null;
      var timer = setTimeout(function () { if (controller) controller.abort(); }, useMirror ? 8000 : OSM_TIMEOUT);

      function finish() { clearTimeout(timer); }
      function failOnce(reason) {
        if (useMirror) {
          if (!local.length) {
            showLoading(false);
            renderEmpty(reason === 'rate' ? '搜索过于频繁，稍候再试' : '无结果 / 请求失败');
          }
          return;
        }
        osmSuspect = true; osmRetryAt = Date.now() + 60000;
        searchProvider(q, true, local);
      }

      var req = controller ? fetch(url, { signal: controller.signal }) : fetch(url);
      req.then(function (res) {
        if (id !== reqSeq) return;
        finish();
        if (res.status === 429) { failOnce('rate'); return; }
        if (!res.ok) { failOnce('fail'); return; }
        return res.json();
      }).then(function (data) {
        if (id !== reqSeq) return;
        if (data && data.length) {
          if (useMirror) { osmSuspect = true; osmRetryAt = Date.now() + 60000; }
          else { osmSuspect = false; }
          renderMerged(local, data);
        } else if (!useMirror) {
          searchProvider(q, true, local);
        } else {
          if (!local.length) { showLoading(false); renderEmpty('无结果 / 请求失败'); }
        }
      }).catch(function () {
        if (id !== reqSeq) return;
        finish();
        failOnce('fail');
      });
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      if (debounce) { clearTimeout(debounce); debounce = null; }
      if (q.length < 2) { closeResults(); showLoading(false); return; }
      debounce = setTimeout(function () { doSearch(q); }, 350);
    });

    results.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.search-item') : null;
      if (!el) return;
      var r = items[+el.getAttribute('data-i')];
      if (!r) return;
      var lat, lng, zoom;
      if (r.src === 'local') {
        lat = r.lat; lng = r.lng;   // GCJ-02，直接使用
        zoom = r.type === 'scenic' ? 13 : (r.deep === 0 ? 8 : r.deep === 1 ? 11 : 12);
      } else {
        lat = parseFloat(r.lat); lng = parseFloat(r.lng);
        if (inChina(lat, lng)) { var g = ExifLite.wgs84ToGcj02(lng, lat); lng = g[0]; lat = g[1]; }
        zoom = 14;
      }
      showLoading(false);
      map.setView([lat, lng], zoom);
      input.value = r.name || '';
      closeResults();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; closeResults(); }
    });
    input.addEventListener('blur', function () { setTimeout(closeResults, 150); });
  }

  /* 国内判定边界与 exif.js 的 outOfChina 一致：境外 GCJ02 转换为恒等，
     故海外用 WGS84 瓦片与照片点位天然对齐，无需纠偏。 */
  function inChina(lat, lng) {
    return lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55;
  }

  /* 按「国内/海外 × 标准/卫星」组合切换底图 */
  function applyBasemap() {
    [stdLayer, satLayer, satRoadLayer].forEach(function (l) {
      if (l && map.hasLayer(l)) map.removeLayer(l);
    });
    Object.keys(overLayers).forEach(function (k) {
      var l = overLayers[k];
      if (l && map.hasLayer(l)) map.removeLayer(l);
    });
    if (inChinaNow) {
      if (isSatellite) { satLayer.addTo(map); satRoadLayer.addTo(map); }
      else { stdLayer.addTo(map); }
    } else {
      if (isSatellite) { overLayers['sat'].addTo(map); overLayers['label'].addTo(map); }
      else { overLayers['std'].addTo(map); }
    }
  }

  /* 平移/缩放后，按地图中心判定是否需要切换国内↔海外底图 */
  function detectRegion() {
    var c = map.getCenter();
    var now = inChina(c.lat, c.lng);
    if (now !== inChinaNow) {
      inChinaNow = now;
      applyBasemap();
      toast(now ? '已切换：国内（高德地图）' : '已切换：海外（全球地图）');
    }
  }

  function toggleLayer() {
    isSatellite = !isSatellite;
    applyBasemap();
    $('btnLayer').classList.toggle('on', isSatellite);
    toast(isSatellite ? '已切换到卫星影像' : '已切换到标准地图');
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
      show($('btnSave'));   // 数据库就绪后始终显示备份按钮
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

  /* 首次操作时让用户选定项目目录（即 index.html 所在目录），之后所有加载/保存都默认到该目录。
     通过 showDirectoryPicker 的 id 参数让浏览器记忆授权目录，同时 localStorage 记录目录名用于提示。 */
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
    // 读取上次目录名用于提示（file:// 下 localStorage 可能禁用，try/catch 静默）
    var lastName = '';
    try { lastName = localStorage.getItem('pw_last_dir_name') || ''; } catch (e) {}
    if (lastName) {
      toast('建议选择上次的目录「' + lastName + '」（若仍可用）', 5000);
    } else {
      toast('请选择项目所在目录（含 index.html / photos.db），后续将默认使用此目录', 5000);
    }
    return window.showDirectoryPicker({ id: 'pw_project_dir', mode: 'readwrite' }).then(function (h) {
      saveDirHandle = h;
      // 记忆目录名与时间
      try {
        localStorage.setItem('pw_last_dir_name', h.name);
        localStorage.setItem('pw_last_dir_time', String(Date.now()));
      } catch (e) {}
      return h;
    }).catch(function () { return null; });
  }

  /* 检查是否存在持久化目标（工作目录句柄或文件句柄），用于导入/补录前置校验 */
  function hasPersistenceTarget() {
    return !!(saveDirHandle || dbHandle);
  }

  /* 生成备份文件名时间戳：YYMMDDHHMMSS（两位年份 + 月日时分秒） */
  function backupTsName() {
    var d = new Date();
    var yy = String(d.getFullYear()).slice(-2);
    return yy + pad(d.getMonth() + 1) + pad(d.getDate()) +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  /* 写入项目目录：直接覆盖 photos.db，不自动备份（备份仅由 backupDb 触发） */
  // silent=true 时不显示"已保存到..."提示，用于 finishImport/reportLoad 合并输出
  function writeToDir(bytes, silent) {
    // 直接覆盖写入 photos.db，不自动备份（备份仅由「备份数据库」按钮触发）
    return saveDirHandle.getFileHandle('photos.db', { create: true }).then(function (fh) {
      return fh.createWritable().then(function (w) {
        return w.write(bytes).then(function () { return w.close(); });
      });
    }).then(function () {
      markSaved();
      if (!silent) toast('已保存到 ' + saveDirHandle.name + '/photos.db', 5000);
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
  // silent=true 时不显示"已保存到..."提示，用于 finishImport/reportLoad 合并输出
  function saveData(silent) {
    if (!db) { if (!silent) toast('还没有数据可保存'); return Promise.resolve(); }
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
      if (!silent) downloadDb(bytes);
      return Promise.resolve();
    }

    return ensureProjectDir().then(function (dirH) {
      if (dirH) return writeToDir(bytes, silent);
      return fallbackFile();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;   // 用户取消选择，静默
      console.warn('保存失败，尝试降级保存', e);
      fallbackFile().catch(function (e2) {
        if (e2 && e2.name === 'AbortError') return;
        console.warn(e2);
        if (!silent) downloadDb(bytes);
      });
    });
  }

  /* 备份数据库：复制当前主库为 photos_YYMMDDHHMMSS_bak.db，不覆盖原文件 */
  function backupDb() {
    if (!db) { toast('还没有数据可备份'); return Promise.resolve(); }
    var bytes = db.export();
    var backupName = 'photos_' + backupTsName() + '_bak.db';
    return ensureProjectDir().then(function (dirH) {
      if (dirH) {
        return dirH.getFileHandle(backupName, { create: true }).then(function (fh) {
          return fh.createWritable().then(function (w) {
            return w.write(bytes).then(function () { return w.close(); });
          });
        }).then(function () {
          toast('已备份为 ' + backupName, 5000);
        });
      }
      // 降级：下载备份文件
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = backupName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('已导出备份 ' + backupName);
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      toast('备份失败：' + (e.message || e), 5000);
    });
  }

  /** 从字节载入数据库并合并（分批处理，避免大数据集卡死主线程） */
  /* 从内存 photos 移除指定 hash 的照片并清理其 marker/dot（用于"后载入为准"覆盖）*/
  function removePhotoEntry(hash) {
    for (var i = 0; i < photos.length; i++) {
      if (photos[i].hash === hash) {
        var old = photos[i];
        if (old.marker) { try { thumbLayer.removeLayer(old.marker); } catch (e) {} disposeThumbMarker(old); }
        if (old.dot) { try { dotLayer.removeLayer(old.dot); } catch (e) {} old.dot = null; }
        if (old.el === player.activeEl) { player.activeEl = null; }
        photos.splice(i, 1);
        return true;
      }
    }
    return false;
  }

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

      var rows = (res && res[0]) ? res[0].values : [];
      loaded.close();

      var stat = { added: 0, updated: 0, noGeo: 0, newOnes: [] };
      // 分批处理：每批 LOAD_BATCH 行，批间让出主线程，保持 UI 响应
      // 哈希冲突时"后载入为准"：移除旧 photos 项与 db 行，重新插入新数据
      function chunk(start) {
        var end = Math.min(start + LOAD_BATCH, rows.length);
        for (var i = start; i < end; i++) {
          var r = rows[i];
          var p = {
            hash: r[0], name: r[1], path: r[2], takenStr: r[3], takenTs: r[4],
            lat: r[5], lng: r[6], alt: r[7], width: r[8], height: r[9], size: r[10],
            thumb: r[11], tw: r[12] || THUMB_MAX, th: r[13] || THUMB_MAX,
            file: null, fromDb: true
          };
          var conflict = !!hashSet[p.hash];
          if (conflict) {
            // 后载入为准：移除旧内存项与 db 行，后续按新数据重新插入
            removePhotoEntry(p.hash);
            try { db.run('DELETE FROM photos WHERE hash=?', [p.hash]); } catch (e2) {}
            stat.updated++;
          } else {
            hashSet[p.hash] = true;
          }
          if (p.lat == null || p.lng == null) { stat.noGeo++; continue; }
          insertPhoto(p);
          preparePhoto(p);   // 只算坐标，不创建 marker（由 renderVisible 按需创建）
          photos.push(p);
          stat.newOnes.push(p);
          if (!conflict) stat.added++;
        }
        if (end < rows.length) {
          progress('正在加载数据库', end, rows.length, '已解析 ' + (stat.added + stat.updated) + ' 张');
          return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
            return chunk(end);
          });
        }
        return stat;
      }
      return chunk(0);
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
      toast('数据库组件不可用，本次仅在地图上展示（建议用启动脚本打开）', 5000);
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
        preparePhoto(p);   // 只算坐标，不创建 marker
        photos.push(p);
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
    updateStat();
    if (stat.newOnes && stat.newOnes.length) fitToPhotos(stat.newOnes);
    markDirty();
    scheduleRender();   // 显式触发渲染

    // 先静默写入数据库，再输出一条合并提示，避免连续 toast 覆盖
    saveData(true).then(function () {
      var msg = '共导入 ' + stat.total + ' 张';
      var ext = [];
      if (stat.dup) ext.push(stat.dup + ' 张重复（根据哈希值判断）');
      if (stat.noGeo) ext.push(stat.noGeo + ' 张未提取到经纬度');
      if (stat.fail) ext.push(stat.fail + ' 张失败');
      if (ext.length) msg += '，' + ext.join('，');
      msg += '，实际导入 ' + stat.ok + ' 张。';
      if (saveDirHandle) msg += ' 已保存到 ' + saveDirHandle.name + '/photos.db。';
      toast(msg, 5000);
    });
  }

  /* 加载 db 后的统一收尾：更新统计、定位到新照片、提示结果 */
  function reportLoad(r) {
    progressDone();
    updateStat();
    if (r.newOnes && r.newOnes.length) fitToPhotos(r.newOnes);
    markDirty();
    scheduleRender();
    var total = r.added + r.updated + r.noGeo;

    // 构建统计提示（静默保存后合并输出）
    var msg = '共加载 ' + total + ' 张';
    var ext = [];
    if (r.updated) ext.push(r.updated + ' 张哈希重复已覆盖（后载入为准）');
    if (r.noGeo) ext.push(r.noGeo + ' 张未提取到经纬度');
    if (ext.length) msg += '，' + ext.join('，');
    msg += '，实际导入 ' + r.added + ' 张';
    if (r.updated) msg += '、覆盖 ' + r.updated + ' 张';
    msg += '。';

    // 仅在有实际新增或覆盖时才持久化，避免全量重复时无谓写入
    var hasChange = r.added || r.updated;
    if (hasChange) {
      saveData(true).then(function () {
        if (saveDirHandle) msg += ' 已保存到 ' + saveDirHandle.name + '/photos.db。';
        toast(msg, 5000);
      });
    } else {
      toast(msg, 5000);
    }
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

  /* 仅计算 GCJ02 纠偏后的坐标，不创建任何 marker（由 renderVisible 按需创建） */
  function preparePhoto(p) {
    var g = ExifLite.wgs84ToGcj02(p.lng, p.lat);   // 高德瓦片为 GCJ02，需纠偏
    p.gLng = g[0]; p.gLat = g[1];
  }

  /* 创建 divIcon 缩略图 marker（高缩放模式用，由 thumbLayer 管理增删） */
  function createThumbMarker(p) {
    var el = document.createElement('div');
    el.className = 'pm' + (p.approxTime ? ' no-time' : '');
    // 播放中且不在本次播放列表：标记为 out（橙色边框 + 降低不透明度）
    if (player.running && player.listSet && !player.listSet[p.hash]) el.classList.add('pm-out');
    el.style.setProperty('--s', currentScale());

    var wob = document.createElement('span');
    wob.className = 'pm-wobble';
    var box = document.createElement('span');
    box.className = 'pm-box';
    box.style.display = 'block';
    var img = document.createElement('img');
    img.alt = '';
    img.src = p.thumb;
    box.appendChild(img);
    wob.appendChild(box);
    el.appendChild(wob);

    var icon = L.divIcon({ className: 'pm-icon', html: el, iconSize: [0, 0], iconAnchor: [0, 0] });
    var marker = L.marker([p.gLat, p.gLng], { icon: icon, riseOnHover: true });

    el.addEventListener('mouseenter', function () { if (!isMobile) openViewer(p, el); });
    el.addEventListener('mouseleave', function () { if (!isMobile && viewerOpen) scheduleViewerClose(); });
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (viewerOpen && viewerOwnerEl === el) { closeViewer(); return; }
      openViewer(p, el);
    });

    p.el = el;
    p.marker = marker;
    return marker;
  }

  /* 销毁缩略图 marker 的 DOM 引用（从 thumbLayer 移除时调用） */
  function disposeThumbMarker(p) {
    p.marker = null;
    p.el = null;
  }

  /* 创建 Canvas 圆点 marker（低缩放模式用，共享一个 canvas，性能极佳） */
  function createDotMarker(p) {
    // 播放中：本次播放的蓝色，非本次播放的橙色
    var inPlay = !(player.running && player.listSet && !player.listSet[p.hash]);
    var dot = L.circleMarker([p.gLat, p.gLng], {
      renderer: dotRenderer,
      radius: 4,
      weight: 1,
      color: '#ffffff',
      fillColor: inPlay ? '#2b6cff' : '#ff9500',
      fillOpacity: 0.85,
      interactive: true
    });
    dot.on('click', function (e) {
      L.DomEvent.stopPropagation(e);   // 阻止冒泡到 map.click，否则 viewer 会被立即关闭
      if (viewerOpen && viewerOwnerEl === dot) { closeViewer(); return; }
      openViewer(p, dot);
    });
    p.dot = dot;
    return dot;
  }

  /* rAF 防抖：平移/缩放过程中合并多次 moveend/zoomend */
  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(function () {
      renderRaf = 0;
      renderVisible();
    });
  }

  /* 核心渲染调度：高缩放用缩略图 + 视口裁剪，低缩放用 Canvas 圆点 */
  function renderVisible() {
    if (!map || !thumbLayer) return;
    var z = map.getZoom();
    var wantThumb = z >= ZOOM_THUMB;

    if (wantThumb) {
      /* —— 缩略图模式 —— */
      if (map.hasLayer(dotLayer)) map.removeLayer(dotLayer);
      // 清理 dot 模式下播放用的临时缩略图（thumb 模式下当前照片走正常 thumbLayer）
      clearPlayerThumb();
      if (!map.hasLayer(thumbLayer)) map.addLayer(thumbLayer);

      var bounds = map.getBounds().pad(VIEWPORT_PAD);

      // 先移除视口外的（跳过播放中当前照片）
      for (var i = 0; i < photos.length; i++) {
        var q = photos[i];
        if (!q.marker) continue;
        if (q.el === player.activeEl) continue;   // 播放中保留
        if (!bounds.contains([q.gLat, q.gLng])) {
          thumbLayer.removeLayer(q.marker);
          disposeThumbMarker(q);
        }
      }

      // 收集需要新增的
      var toAdd = [];
      for (var j = 0; j < photos.length; j++) {
        var p = photos[j];
        if (p.marker) continue;
        if (bounds.contains([p.gLat, p.gLng])) toAdd.push(p);
      }
      // 分批创建，避免单帧卡顿
      var k = 0;
      function batch() {
        var n = 0;
        while (k < toAdd.length && n < RENDER_BATCH) {
          var pp = toAdd[k++];
          if (pp.marker) continue;
          createThumbMarker(pp);
          thumbLayer.addLayer(pp.marker);
          n++;
        }
        if (k < toAdd.length) requestAnimationFrame(batch);
      }
      batch();
    } else {
      /* —— 圆点模式 —— */
      if (map.hasLayer(thumbLayer)) {
        thumbLayer.clearLayers();
        for (var m = 0; m < photos.length; m++) disposeThumbMarker(photos[m]);
      }
      // 始终为缺失的照片创建圆点并加入 dotLayer（支持增量加载）
      for (var n = 0; n < photos.length; n++) {
        var pp = photos[n];
        if (!pp.dot) { createDotMarker(pp); dotLayer.addLayer(pp.dot); }
        else if (!dotLayer.hasLayer(pp.dot)) dotLayer.addLayer(pp.dot);
      }
      if (!map.hasLayer(dotLayer)) map.addLayer(dotLayer);
      // 播放中：为当前照片叠加临时缩略图
      syncPlayerThumb();
    }
  }

  /* 播放时确保当前照片有可交互的缩略图 marker */
  function ensurePlayerMarker(p) {
    if (p.marker && p.el) return;
    createThumbMarker(p);
    if (map.getZoom() >= ZOOM_THUMB) {
      thumbLayer.addLayer(p.marker);
    } else {
      p.marker.addTo(map);
      playerThumb = p.marker;
    }
  }

  /* 释放上一张照片的播放 marker（仅 dot 模式下的临时 marker 需销毁） */
  function releasePlayerMarker(p) {
    if (!p) return;
    if (playerThumb && playerThumb === p.marker) {
      map.removeLayer(p.marker);
      disposeThumbMarker(p);
      playerThumb = null;
    }
  }

  /* dot 模式下为播放当前照片同步临时缩略图 */
  function syncPlayerThumb() {
    if (!player.running || player.idx >= player.list.length) { clearPlayerThumb(); return; }
    var p = player.list[player.idx];
    if (playerThumb && playerThumb.__p === p) return;
    clearPlayerThumb();
    createThumbMarker(p);
    p.el.classList.add('active');
    p.el.style.setProperty('--s', currentScale() * 2);
    p.marker.setZIndexOffset(2000);
    p.el.classList.remove('shake');
    void p.el.offsetWidth;
    p.el.classList.add('shake');
    p.marker.addTo(map);
    p.marker.__p = p;
    playerThumb = p.marker;
    player.activeEl = p.el;
    player.activeMk = p.marker;
  }

  function clearPlayerThumb() {
    if (!playerThumb) return;
    var p = playerThumb.__p;
    if (p && p.el) p.el.classList.remove('active', 'shake');
    if (p && p.marker) p.marker.setZIndexOffset(0);
    map.removeLayer(playerThumb);
    if (p) disposeThumbMarker(p);
    playerThumb = null;
  }

  function updateAllScales() {
    if (scaleRaf) return;
    scaleRaf = requestAnimationFrame(function () {
      scaleRaf = 0;
      var s = currentScale();
      for (var i = 0; i < photos.length; i++) {
        var p = photos[i];
        if (!p.el) continue;
        // 播放规则叠加：正在播放的点位始终是当前比例的 2 倍
        var mul = (p.el === player.activeEl) ? 2 : 1;
        p.el.style.setProperty('--s', s * mul);
      }
    });
  }

  /* ============================================================
   * 六、大图查看器（悬停/点按弹出，不遮死底图）
   * ============================================================ */
  var viewerDom = null;
  var viewerPhoto = null;    // 当前查看器打开的照片对象
  var dismissBound = false;
  var viewerCloseTimer = null;  // hover 延迟关闭计时器
  var VIEWER_HOVER_DELAY = 220;

  function buildViewer() {
    var box = document.createElement('div');
    box.id = 'viewer';
    box.innerHTML =
      '<div class="frame">' +
        '<button class="viewer-edit" id="viewerEditBtn" title="编辑文件名/路径" aria-label="编辑">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
        '</button>' +
        '<button class="viewer-del" id="viewerDelBtn" title="删除" aria-label="删除">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
        '</button>' +
        '<img id="viewerImg" alt="">' +
      '</div>' +
      '<div id="viewerMeta"></div>';
    document.body.appendChild(box);
    // 删除/编辑按钮只在此处绑定一次（openViewer 不再重复绑定，避免监听器累积）
    box.querySelector('#viewerDelBtn').addEventListener('click', function (ev) {
      ev.stopPropagation();   // 阻止冒泡，避免触发 dismissHandler
      openDelModal();
    });
    box.querySelector('#viewerEditBtn').addEventListener('click', function (ev) {
      ev.stopPropagation();
      openViewerEditor();
    });
    // 鼠标进入预览框/元信息区：取消延迟关闭，允许操作按钮与选中文字
    // 鼠标离开：启动延迟关闭（220ms 后关闭，留出从缩略图移向大图的时间）
    function bindHover(el) {
      el.addEventListener('mouseenter', cancelViewerClose);
      el.addEventListener('mouseleave', function () { if (viewerOpen) scheduleViewerClose(); });
    }
    bindHover(box.querySelector('.frame'));
    bindHover(box.querySelector('#viewerMeta'));
    return { box: box };
  }

  // 删除确认弹窗 / 查看器内编辑表单等「带选择」弹窗打开时，查看器不应自动关闭
  function viewerModalOpen() {
    var d = $('delModal');
    if (d && !d.classList.contains('hidden')) return true;
    var meta = $('viewerMeta');
    if (meta && meta.querySelector('.ve-form')) return true;
    return false;
  }

  function scheduleViewerClose() {
    if (viewerModalOpen()) return;   // 弹窗打开时不排程自动关闭
    cancelViewerClose();
    viewerCloseTimer = setTimeout(function () {
      viewerCloseTimer = null;
      if (viewerOpen && !viewerModalOpen()) closeViewer();
    }, VIEWER_HOVER_DELAY);
  }
  function cancelViewerClose() {
    if (viewerCloseTimer) { clearTimeout(viewerCloseTimer); viewerCloseTimer = null; }
  }

  function dismissHandler(e) {
    // 删除确认 / 编辑表单等弹窗打开时，点击不应关闭查看器（否则弹窗被连带关闭）
    if (viewerModalOpen()) return;
    // 点击编辑/删除按钮不关闭
    if (e.target && e.target.closest && e.target.closest('#viewerDelBtn,#viewerEditBtn')) return;
    // 点击照片标记本身不关闭
    if (viewerOwnerEl && e.target && e.target.closest && e.target.closest('.pm') === viewerOwnerEl) return;
    // 点击预览框（图片/按钮）或元信息区不关闭，允许选中文字与操作按钮
    if (e.target && e.target.closest && e.target.closest('.frame,#viewerMeta')) return;
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
    viewerPhoto = p;   // 保存引用用于删除
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
    cancelViewerClose();
    viewerOpen = false;
    viewerOwnerEl = null;
    viewerPhoto = null;   // 清空引用
    hideDelModal();       // 关闭可能残留的确认框
    unbindDismiss();
    hide(viewerDom.box);
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  }

  /* 删除确认框与逻辑 */
  function openDelModal() {
    cancelViewerClose();   // 取消可能已排程的悬停关闭，防止本弹窗被查看器连带关闭
    show($('delModal'));
  }
  function hideDelModal() {
    hide($('delModal'));
  }

  /* 查看器内编辑：仅文件名/路径可改，其他只读 */
  function openViewerEditor() {
    var p = viewerPhoto;
    if (!p) return;
    cancelViewerClose();   // 同删除弹窗：编辑期间查看器不得被悬停关闭
    var meta = $('viewerMeta');
    meta.innerHTML =
      '<div class="ve-form">' +
        '<div class="ve-row"><label>文件名</label><input id="veName" type="text" value="' + escapeAttr(p.name || '') + '"></div>' +
        '<div class="ve-row"><label>照片路径</label><input id="vePath" type="text" value="' + escapeAttr(p.path || '') + '"></div>' +
        '<div class="ve-row"><label>经纬度</label><input class="ro" type="text" value="' + (p.lat != null ? Number(p.lat).toFixed(6) + ', ' + Number(p.lng).toFixed(6) : '') + '" readonly></div>' +
        '<div class="ve-row"><label>拍摄时间</label><input class="ro" type="text" value="' + escapeAttr(fmtTime(p.takenTs) || '') + '" readonly></div>' +
        '<div class="ve-row"><label>尺寸</label><input class="ro" type="text" value="' + (p.width || '') + '×' + (p.height || '') + (p.size ? ' · ' + fmtSize(p.size) : '') + '" readonly></div>' +
        '<div class="ve-actions">' +
          '<button class="ve-cancel" id="veCancel">取消</button>' +
          '<button class="ve-save" id="veSave">保存</button>' +
        '</div>' +
      '</div>';
    $('veCancel').addEventListener('click', function (ev) {
      ev.stopPropagation();
      renderViewerMeta(p);
    });
    $('veSave').addEventListener('click', function (ev) {
      ev.stopPropagation();
      saveViewerEdit(p);
    });
    var nameInput = $('veName');
    nameInput.focus();
    nameInput.select();
  }

  function saveViewerEdit(p) {
    var newName = $('veName').value.trim();
    var newPath = $('vePath').value.trim();
    if (!newName) { toast('文件名不能为空'); return; }
    if (newName === (p.name || '') && newPath === (p.path || '')) {
      renderViewerMeta(p);
      toast('无修改');
      return;
    }
    if (!db) { toast('数据库未加载，无法保存'); return; }
    try {
      db.run('UPDATE photos SET name=?, path=? WHERE hash=?', [newName, newPath, p.hash]);
    } catch (e) {
      toast('保存失败：' + (e.message || e), 5000);
      return;
    }
    p.name = newName;
    p.path = newPath;
    dbDirty = true;
    // 同步内存 photos 对应项（viewerPhoto 就是 photos 中的引用，已原地更新）
    if (p.el) {
      // 若缩略图标记的 title 依赖 name，刷新一下
      var titleEl = p.el.querySelector('.pm-title');
      if (titleEl) titleEl.textContent = newName;
    }
    saveData();
    renderViewerMeta(p);
    toast('已保存修改');
  }

  /* 用照片数据重新渲染 viewerMeta（取消编辑或保存后恢复显示）*/
  function renderViewerMeta(p) {
    var meta = $('viewerMeta');
    var warn = p.file ? '' : '<div class="warn">原图不在本机 · 缩略图已放大 ' + FALLBACK_UPSCALE + ' 倍显示</div>';
    meta.innerHTML =
      '<div class="n">' + escapeHtml(p.name) + '</div>' +
      '<div class="s">' + (p.approxTime ? '≈ ' : '') + fmtTime(p.takenTs) +
      '　' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) +
      (p.size ? '　' + fmtSize(p.size) : '') + '</div>' +
      (p.path && p.path !== p.name ? '<div class="s">' + escapeHtml(p.path) + '</div>' : '') +
      warn;
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function deleteCurrentPhoto() {
    if (!viewerPhoto || !db) return;
    var p = viewerPhoto;

    // 1. 从数据库删除
    try {
      db.run('DELETE FROM photos WHERE hash = ?', [p.hash]);
    } catch (e) {
      console.warn('删除数据库记录失败', e);
      toast('删除失败：' + (e.message || e), 3000);
      return;
    }

    // 2. 从地图图层移除 marker
    if (p.marker) {
      if (map.hasLayer(thumbLayer)) thumbLayer.removeLayer(p.marker);
      if (p.marker && map.hasLayer(p.marker)) map.removeLayer(p.marker);
    }
    if (p.dot && map.hasLayer(dotLayer)) dotLayer.removeLayer(p.dot);

    // 3. 从内存数据结构移除
    var idx = photos.indexOf(p);
    if (idx >= 0) photos.splice(idx, 1);
    if (hashSet[p.hash]) delete hashSet[p.hash];

    // 4. 如果正在播放且删除的是当前照片
    if (player.running && player.list[player.idx] === p) {
      stopPlay(false);
    } else if (player.running) {
      // 如果删除的是播放列表中的其他照片，从列表中移除并更新索引
      var pIdxInList = player.list.indexOf(p);
      if (pIdxInList >= 0) {
        player.list.splice(pIdxInList, 1);
        if (pIdxInList < player.idx) player.idx--;
        if (player.listSet) delete player.listSet[p.hash];   // 同步清理播放集合
      }
    }

    // 5. 关闭 viewer 并刷新
    closeViewer();
    updateStat();
    scheduleRender();

    // 6. 立即保存到文件
    saveData();

    toast('已删除', 2000);
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
    // 优先使用上次缓存的播放区间，无缓存则用全范围（隐私模式 localStorage 可能抛异常，静默降级）
    var cachedS = null, cachedE = null;
    try {
      cachedS = localStorage.getItem('pw_playStart');
      cachedE = localStorage.getItem('pw_playEnd');
    } catch (err) { /* 忽略 */ }
    if (cachedS) $('playStart').value = cachedS;
    else $('playStart').value = toLocalInput(tr.min);
    if (cachedE) $('playEnd').value = cachedE;
    else $('playEnd').value = toLocalInput(tr.max + 60000);
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

    // 缓存本次播放时间区间，下次打开自动带入
    try {
      localStorage.setItem('pw_playStart', s);
      localStorage.setItem('pw_playEnd', e);
    } catch (err) { /* 隐私模式可能禁用 localStorage，忽略 */ }

    hide($('playModal'));
    closeViewer();
    player.running = true;
    player.paused = false;
    player.idx = 0;
    player.list = list;
    // 构建 hash 集合用于播放/非播放点位区分
    player.listSet = Object.create(null);
    for (var i = 0; i < list.length; i++) player.listSet[list[i].hash] = true;
    player.speed = speed;
    applyPlayStyles();   // 非播放点位降级显示
    show($('playHud'));
    setHudIcon(true);
    // 初始化 HUD 控件状态
    $('hudSpeed').value = String(speed);
    $('hudSeek').value = 0;
    tickPlay();
  }

  function interval() { return Math.max(140, 1300 / player.speed); }

  function tickPlay() {
    if (!player.running) return;
    if (player.idx >= player.list.length) { stopPlay(true); return; }

    var p = player.list[player.idx];
    // 上一张恢复原比例
    var prev = player.list[player.idx - 1];
    if (player.activeEl && prev && prev.el) {
      prev.el.classList.remove('active', 'shake');
      prev.el.style.setProperty('--s', currentScale());
    }
    if (player.activeMk && player.activeMk !== playerThumb) {
      player.activeMk.setZIndexOffset(0);
    }
    // 释放 dot 模式下上一张的临时缩略图
    if (prev) releasePlayerMarker(prev);

    // 当前：确保有 marker（thumb 模式视口外被裁剪 / dot 模式无 el 时会自动创建），再高亮
    ensurePlayerMarker(p);
    if (p.el) {
      player.activeEl = p.el;
      player.activeMk = p.marker;
      p.el.classList.add('active');
      p.el.style.setProperty('--s', currentScale() * 2);
      if (p.marker) p.marker.setZIndexOffset(2000);
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
    // 同步进度条手柄位置（程序化设置 value 不触发 input 事件，安全）
    $('hudSeek').value = Math.round(player.idx / Math.max(1, player.list.length - 1) * 100);

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
    var total = player.list.length;   // 先记录，下面要清空
    var cur = (player.idx < player.list.length) ? player.list[player.idx] : null;
    if (player.activeEl && cur && cur.el) {
      cur.el.classList.remove('active', 'shake');
    }
    if (player.activeMk && player.activeMk !== playerThumb) {
      player.activeMk.setZIndexOffset(0);
    }
    clearPlayerThumb();   // 清理 dot 模式下的临时缩略图
    player.activeEl = null;
    player.activeMk = null;
    player.list = [];
    player.listSet = null;   // 清空播放集合，恢复所有点位为蓝色
    clearPlayStyles();       // 恢复所有点位为默认蓝色
    updateAllScales();
    hide($('playHud'));
    if (finished) toast('播放结束，共 ' + total + ' 个点位');
  }

  /* 播放起止时批量更新点位样式：本次播放保持蓝色，非本次降为橙色 */
  function applyPlayStyles() {
    if (!player.listSet) return;
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      var inPlay = !!player.listSet[p.hash];
      if (p.dot) {
        p.dot.setStyle({ fillColor: inPlay ? '#2b6cff' : '#ff9500' });
      }
      if (p.el) {
        if (inPlay) p.el.classList.remove('pm-out');
        else p.el.classList.add('pm-out');
      }
    }
  }
  function clearPlayStyles() {
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      if (p.dot) p.dot.setStyle({ fillColor: '#2b6cff' });
      if (p.el) p.el.classList.remove('pm-out');
    }
  }

  /* ============================================================
   * 八、数据库直接管理（预览 / 行内编辑 / 导入 CSV / 导出 CSV）
   * ============================================================ */
  var dbMgr = {
    mode: 'memory',        // 'memory' = 当前主 db；'file' = 外部 db 文件
    fileDb: null,           // file 模式下的 SQL.Database
    fileHandle: null,       // file 模式下的 FileSystemFileHandle
    fileName: '',           // file 模式文件名
    rows: [],               // 当前展示行（全量，未过滤）{hash,name,path,...,_edit:{name,path}}
    filtered: [],           // 筛选后的行
    selHash: null,          // 选中行 hash
    dirty: false,           // 是否有未保存编辑
    page: 0,                // 当前页（0-based）
    pageSize: 10,           // 每页条数（PC 10 / 手机 5）
    filterFrom: null,       // 筛选起始时间戳
    filterTo: null          // 筛选结束时间戳
  };
  var DB_COLUMNS = ['hash','name','path','taken_at','taken_ts','lat','lng','alt','width','height','size','thumb','thumb_w','thumb_h','imported_at'];

  function openDbManage() {
    dbMgr.mode = 'memory';
    dbMgr.readonly = true;   // 内存模式只读，不能编辑当前正在加载的主库
    dbMgr.fileDb = null;
    dbMgr.fileHandle = null;
    dbMgr.fileName = '';
    dbMgr.selHash = null;
    dbMgr.dirty = false;
    dbMgr.page = 0;
    dbMgr.pageSize = window.innerWidth <= 760 ? 5 : 10;
    hide($('dbResult'));
    ensureDb().then(function () {
      dbMgr.rows = queryDbRows(db);
      initDbFilterRange();   // 默认筛选范围 = 所选库拍摄时间的最小/最大
      applyFilter();
      updateFilterInfo();
      $('dbManageSource').textContent = '数据来源：当前内存数据库（只读预览，' + dbMgr.rows.length + ' 行，如需编辑请选择其他 db 文件）';
      renderDbTable();
      hide($('dbDetail'));
      updateDbManageWriteButtons();
      show($('dbManageModal'));
    }).catch(function (e) {
      toast('数据库引擎不可用：' + (e.message || e), 5000);
    });
  }

  /* 只读模式下禁用写操作按钮（保存修改、CSV 覆盖导入） */
  function updateDbManageWriteButtons() {
    var ro = dbMgr.readonly;
    var btns = [$('dbSaveEdit'), $('dbImportCsv')];
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = ro;
      btns[i].style.opacity = ro ? '.45' : '';
      btns[i].style.cursor = ro ? 'not-allowed' : '';
    }
  }

  /* 校验文件句柄是否为当前正在加载的数据库文件 */
  function isCurrentLoadedDb(handle) {
    // 目录模式：当前主库是 saveDirHandle/photos.db
    if (saveDirHandle && handle.name === 'photos.db') {
      return saveDirHandle.resolve(handle).then(function (path) {
        return path !== null;
      }).catch(function () { return false; });
    }
    // 文件模式：当前主库是 dbHandle
    if (dbHandle && handle.name === dbHandle.name) {
      return Promise.all([handle.getFile(), dbHandle.getFile()]).then(function (files) {
        return files[0].size === files[1].size && files[0].lastModified === files[1].lastModified;
      }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function queryDbRows(target) {
    var res = target.exec('SELECT hash,name,path,taken_at,taken_ts,lat,lng,alt,width,height,size,thumb,thumb_w,thumb_h,imported_at FROM photos');
    var rows = [];
    if (res && res[0]) {
      var vals = res[0].values;
      for (var i = 0; i < vals.length; i++) {
        var r = vals[i];
        rows.push({
          hash: r[0], name: r[1], path: r[2], taken_at: r[3], taken_ts: r[4],
          lat: r[5], lng: r[6], alt: r[7], width: r[8], height: r[9], size: r[10],
          thumb: r[11], thumb_w: r[12], thumb_h: r[13], imported_at: r[14],
          _edit: {}
        });
      }
    }
    return rows;
  }

  /* 将日期筛选默认值设为当前库数据的拍摄时间最小/最大（对应所选择库的范围）*/
  function initDbFilterRange() {
    var min = null, max = null;
    for (var i = 0; i < dbMgr.rows.length; i++) {
      var t = dbMgr.rows[i].taken_ts;
      if (t == null) continue;
      if (min == null || t < min) min = t;
      if (max == null || t > max) max = t;
    }
    if (min != null) {
      var md = new Date(min); md.setHours(0, 0, 0, 0);          // 当天 0 点
      var xd = new Date(max); xd.setHours(23, 59, 59, 999);      // 当天 23:59:59.999
      dbMgr.filterFrom = md.getTime();
      dbMgr.filterTo = xd.getTime();
      $('dbFilterFrom').value = fmtDate(min);
      $('dbFilterTo').value = fmtDate(max);
    } else {
      dbMgr.filterFrom = null;
      dbMgr.filterTo = null;
      $('dbFilterFrom').value = '';
      $('dbFilterTo').value = '';
    }
  }

  function applyFilter() {
    var rows = dbMgr.rows;
    if (dbMgr.filterFrom != null || dbMgr.filterTo != null) {
      rows = rows.filter(function (r) {
        if (r.taken_ts == null) return false;
        if (dbMgr.filterFrom != null && r.taken_ts < dbMgr.filterFrom) return false;
        if (dbMgr.filterTo != null && r.taken_ts > dbMgr.filterTo) return false;
        return true;
      });
    }
    dbMgr.filtered = rows;
    var totalPages = Math.max(1, Math.ceil(dbMgr.filtered.length / dbMgr.pageSize));
    if (dbMgr.page >= totalPages) dbMgr.page = totalPages - 1;
    if (dbMgr.page < 0) dbMgr.page = 0;
  }

  function updateFilterInfo() {
    var info = $('dbFilterInfo');
    if (dbMgr.filterFrom == null && dbMgr.filterTo == null) {
      info.textContent = '全部（' + dbMgr.filtered.length + ' 条）';
    } else {
      var from = dbMgr.filterFrom != null ? fmtDate(dbMgr.filterFrom) : '最小';
      var to = dbMgr.filterTo != null ? fmtDate(dbMgr.filterTo) : '最大';
      info.textContent = from + ' ~ ' + to + '（' + dbMgr.filtered.length + ' 条）';
    }
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function renderDbTable() {
    var scroll = $('dbScroll');
    if (!dbMgr.filtered.length) {
      scroll.innerHTML = '<div class="db-empty">' + (dbMgr.rows.length ? '筛选后无数据' : '暂无数据') + '</div>';
      hide($('dbPageRow'));
      hide($('dbDetail'));
      dbMgr.selHash = null;
      return;
    }
    var totalPages = Math.max(1, Math.ceil(dbMgr.filtered.length / dbMgr.pageSize));
    var start = dbMgr.page * dbMgr.pageSize;
    var end = Math.min(start + dbMgr.pageSize, dbMgr.filtered.length);
    var pageRows = dbMgr.filtered.slice(start, end);

    var html = '<table><colgroup>' +
      '<col class="col-thumb"><col class="col-hash"><col class="col-name"><col class="col-path">' +
      '<col class="col-time"><col class="col-lat"><col class="col-lng"><col class="col-alt">' +
      '<col class="col-w"><col class="col-h"><col class="col-size"><col class="col-ts"><col class="col-import">' +
      '</colgroup><thead><tr>' +
      '<th></th><th>哈希</th><th>文件名</th><th>照片路径</th><th>拍摄时间</th>' +
      '<th>纬度</th><th>经度</th><th>海拔</th><th>宽</th><th>高</th>' +
      '<th>大小</th><th>缩略图</th><th>导入时间</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < pageRows.length; i++) {
      var r = pageRows[i];
      var sel = r.hash === dbMgr.selHash ? ' sel' : '';
      var nameVal = r._edit.name != null ? r._edit.name : (r.name || '');
      var pathVal = r._edit.path != null ? r._edit.path : (r.path || '');
      html += '<tr data-hash="' + escapeHtml(r.hash) + '" class="' + sel.trim() + '">' +
        '<td title="' + escapeHtml(r.name || '') + '">' + (r.thumb ? '<img class="thumb-cell" alt="" src="' + r.thumb + '">' : '') + '</td>' +
        '<td class="hash-cell" title="' + escapeHtml(r.hash) + '">' + escapeHtml(r.hash) + '</td>' +
        '<td class="cell-name"><span class="cell-text" title="' + escapeHtml(nameVal) + '">' + escapeHtml(nameVal) + '</span></td>' +
        '<td class="cell-path"><span class="cell-text" title="' + escapeHtml(pathVal) + '">' + escapeHtml(pathVal) + '</span></td>' +
        '<td title="' + escapeHtml(r.taken_at || '') + '">' + escapeHtml(r.taken_at || '') + '</td>' +
        '<td>' + (r.lat != null ? Number(r.lat).toFixed(6) : '') + '</td>' +
        '<td>' + (r.lng != null ? Number(r.lng).toFixed(6) : '') + '</td>' +
        '<td>' + (r.alt != null ? Number(r.alt).toFixed(1) : '') + '</td>' +
        '<td>' + (r.width || '') + '</td>' +
        '<td>' + (r.height || '') + '</td>' +
        '<td>' + fmtSize(r.size) + '</td>' +
        '<td>' + (r.thumb_w || '') + '×' + (r.thumb_h || '') + '</td>' +
        '<td title="' + escapeHtml(r.imported_at || '') + '">' + escapeHtml(r.imported_at || '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    scroll.innerHTML = html;

    var trs = scroll.querySelectorAll('tbody tr');
    for (var t = 0; t < trs.length; t++) {
      (function (tr) {
        tr.addEventListener('click', function () {
          var prev = scroll.querySelector('tbody tr.sel');
          if (prev && prev !== tr) prev.classList.remove('sel');
          tr.classList.add('sel');
          dbMgr.selHash = tr.getAttribute('data-hash');
          renderDbDetail();
        });
        tr.querySelector('.cell-name').addEventListener('dblclick', function (e) {
          e.stopPropagation();
          if (dbMgr.readonly) return;
          startEditCell(tr, 'name');
        });
        tr.querySelector('.cell-path').addEventListener('dblclick', function (e) {
          e.stopPropagation();
          if (dbMgr.readonly) return;
          startEditCell(tr, 'path');
        });
      })(trs[t]);
    }

    renderPageRow(totalPages);
  }

  function renderPageRow(totalPages) {
    var row = $('dbPageRow');
    show(row);
    if (totalPages <= 1) { hide(row); return; }
    var cur = dbMgr.page + 1;
    var html = '<button class="mini" id="dbPagePrev"' + (dbMgr.page <= 0 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span>第 <span class="cur">' + cur + '</span> / ' + totalPages + ' 页</span>' +
      '<span style="margin-left:6px">共 ' + dbMgr.filtered.length + ' 条</span>' +
      '<button class="mini" id="dbPageNext"' + (dbMgr.page >= totalPages - 1 ? ' disabled' : '') + '>下一页 ›</button>';
    row.innerHTML = html;
    $('dbPagePrev').addEventListener('click', function () {
      if (dbMgr.page > 0) { dbMgr.page--; renderDbTable(); }
    });
    $('dbPageNext').addEventListener('click', function () {
      if (dbMgr.page < totalPages - 1) { dbMgr.page++; renderDbTable(); }
    });
  }

  function startEditCell(tr, field) {
    var hash = tr.getAttribute('data-hash');
    var r = null;
    for (var i = 0; i < dbMgr.rows.length; i++) {
      if (dbMgr.rows[i].hash === hash) { r = dbMgr.rows[i]; break; }
    }
    if (!r) return;
    var cell = tr.querySelector('.cell-' + field);
    var cur = r._edit[field] != null ? r._edit[field] : (r[field] || '');
    var input = document.createElement('input');
    input.className = 'cell-edit';
    input.value = cur;
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();
    input.addEventListener('blur', function () {
      r._edit[field] = input.value;
      dbMgr.dirty = true;
      renderDbTable();
      renderDbDetail();
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { renderDbTable(); }
    });
  }

  function renderDbDetail() {
    if (!dbMgr.selHash) { hide($('dbDetail')); return; }
    var r = null;
    for (var i = 0; i < dbMgr.rows.length; i++) {
      if (dbMgr.rows[i].hash === dbMgr.selHash) { r = dbMgr.rows[i]; break; }
    }
    if (!r) { hide($('dbDetail')); return; }
    show($('dbDetail'));
    var nameVal = r._edit.name != null ? r._edit.name : r.name;
    var pathVal = r._edit.path != null ? r._edit.path : r.path;
    $('dbDetail').innerHTML =
      (r.thumb ? '<img alt="" src="' + r.thumb + '">' : '<div></div>') +
      '<div class="hash-cell" title="' + escapeAttr(r.hash) + '"><b>哈希</b>' + escapeHtml(r.hash) + '</div>' +
      '<div title="' + escapeAttr(nameVal || '') + '"><b>文件名</b>' + escapeHtml(nameVal || '') + '</div>' +
      '<div title="' + escapeAttr(pathVal || '') + '"><b>路径</b>' + escapeHtml(pathVal || '') + '</div>' +
      '<div><b>拍摄时间</b>' + escapeHtml(r.taken_at || '') + (r.taken_ts ? ' (ts ' + r.taken_ts + ')' : '') + '</div>' +
      '<div><b>坐标</b>lat ' + (r.lat != null ? Number(r.lat).toFixed(6) : '') + ' / lng ' + (r.lng != null ? Number(r.lng).toFixed(6) : '') + ' / alt ' + (r.alt != null ? Number(r.alt).toFixed(1) : '') + '</div>' +
      '<div><b>尺寸</b>' + (r.width || '') + '×' + (r.height || '') + ' · ' + fmtSize(r.size) + '</div>' +
      '<div><b>缩略图</b>' + (r.thumb_w || '') + '×' + (r.thumb_h || '') + '</div>' +
      '<div title="' + escapeAttr(r.imported_at || '') + '"><b>导入时间</b>' + escapeHtml(r.imported_at || '') + '</div>';
  }

  /* CSV 转义（RFC 4180）*/
  function csvEscape(v) {
    if (v == null) return '';
    var s = String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportDbCsv() {
    if (!dbMgr.rows.length) { toast('没有数据可导出'); return; }
    var lines = [DB_COLUMNS.join(',')];
    for (var i = 0; i < dbMgr.rows.length; i++) {
      var r = dbMgr.rows[i];
      var line = [];
      for (var j = 0; j < DB_COLUMNS.length; j++) {
        var key = DB_COLUMNS[j];
        var val = (key === 'name' && r._edit.name != null) ? r._edit.name :
                  (key === 'path' && r._edit.path != null) ? r._edit.path :
                  r[key];
        line.push(csvEscape(val));
      }
      lines.push(line.join(','));
    }
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (dbMgr.mode === 'file' ? dbMgr.fileName.replace(/\.db$/i, '') : 'photos') + '_' + tsName() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('已导出 ' + dbMgr.rows.length + ' 行 CSV');
  }

  /* CSV 解析（处理引号转义与 \r\n / \n / \r）*/
  function parseCsv(text) {
    text = text.replace(/^\ufeff/, '');
    var rows = [];
    var row = [];
    var field = '';
    var inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') {
          row.push(field); field = '';
          rows.push(row); row = [];
          if (text[i + 1] === '\n') i++;
        } else if (c === '\n') {
          row.push(field); field = '';
          rows.push(row); row = [];
        } else field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function importDbCsv(file) {
    if (dbMgr.readonly) { toast('只读模式，不可导入，请选择其他 db 文件'); return; }
    readBuffer(file).then(function (buf) {
      var text = new TextDecoder('utf-8').decode(buf);
      var rows = parseCsv(text);
      if (!rows.length) { toast('CSV 为空'); return; }
      var header = rows[0];
      var idx = {};
      for (var k = 0; k < header.length; k++) idx[String(header[k]).trim()] = k;
      if (idx.hash == null) { toast('CSV 缺少 hash 列，无法覆盖'); return; }
      var csvData = [];
      for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        if (!row.length || (row.length === 1 && !row[0])) continue;
        var obj = {};
        for (var c = 0; c < DB_COLUMNS.length; c++) {
          var key = DB_COLUMNS[c];
          if (idx[key] != null && row[idx[key]] != null) obj[key] = row[idx[key]];
        }
        if (!obj.hash) continue;
        ['taken_ts','width','height','size','thumb_w','thumb_h'].forEach(function (cc) {
          if (obj[cc] != null && obj[cc] !== '') obj[cc] = parseInt(obj[cc], 10) || null;
        });
        ['lat','lng','alt'].forEach(function (cc) {
          if (obj[cc] != null && obj[cc] !== '') obj[cc] = parseFloat(obj[cc]);
          else obj[cc] = null;
        });
        csvData.push(obj);
      }
      if (!csvData.length) { toast('CSV 无有效数据行'); return; }
      if (!window.confirm('将用 CSV 全量覆盖当前数据库（按哈希增/改/删），不可撤销，是否继续？')) return;
      applyCsvOverwrite(csvData);
    }).catch(function (e) { toast('读取 CSV 失败：' + (e.message || e), 5000); });
  }

  function applyCsvOverwrite(csvData) {
    var target = dbMgr.mode === 'memory' ? db : dbMgr.fileDb;
    if (!target) { toast('目标数据库未初始化'); return; }
    var existing = queryDbRows(target);
    var existMap = Object.create(null);
    existing.forEach(function (r) { existMap[r.hash] = r; });
    var csvMap = Object.create(null);
    csvData.forEach(function (r) { csvMap[r.hash] = r; });

    var toAdd = [], toUpdate = [], toDelete = [];
    csvData.forEach(function (r) { if (existMap[r.hash]) toUpdate.push(r); else toAdd.push(r); });
    existing.forEach(function (r) { if (!csvMap[r.hash]) toDelete.push(r.hash); });

    try {
      target.run('BEGIN');
      for (var d = 0; d < toDelete.length; d++) {
        target.run('DELETE FROM photos WHERE hash = ?', [toDelete[d]]);
      }
      for (var a = 0; a < toAdd.length; a++) {
        var r = toAdd[a];
        target.run(
          'INSERT INTO photos(hash,name,path,taken_at,taken_ts,lat,lng,alt,width,height,size,thumb,thumb_w,thumb_h,imported_at)' +
          ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [r.hash, r.name || null, r.path || null, r.taken_at || null,
           (r.taken_ts != null ? r.taken_ts : null),
           (r.lat != null ? r.lat : null), (r.lng != null ? r.lng : null), (r.alt != null ? r.alt : null),
           r.width || null, r.height || null, r.size || null, r.thumb || null,
           r.thumb_w || null, r.thumb_h || null, r.imported_at || new Date().toISOString()]
        );
      }
      for (var u = 0; u < toUpdate.length; u++) {
        var ru = toUpdate[u];
        target.run(
          'UPDATE photos SET name=?,path=?,taken_at=?,taken_ts=?,lat=?,lng=?,alt=?,width=?,height=?,size=?,thumb=?,thumb_w=?,thumb_h=?,imported_at=? WHERE hash=?',
          [ru.name || null, ru.path || null, ru.taken_at || null,
           (ru.taken_ts != null ? ru.taken_ts : null),
           (ru.lat != null ? ru.lat : null), (ru.lng != null ? ru.lng : null), (ru.alt != null ? ru.alt : null),
           ru.width || null, ru.height || null, ru.size || null, ru.thumb || null,
           ru.thumb_w || null, ru.thumb_h || null, ru.imported_at || new Date().toISOString(), ru.hash]
        );
      }
      target.run('COMMIT');
    } catch (e) {
      try { target.run('ROLLBACK'); } catch (e2) {}
      toast('导入失败：' + (e.message || e), 5000);
      return;
    }

    if (dbMgr.mode === 'memory') {
      dbDirty = true;
      if (player.running) stopPlay(false);
      closeViewer();
      rebuildPhotosFromDb();
      saveData();
    } else {
      persistFileDb();
    }
    dbMgr.rows = queryDbRows(target);
    dbMgr.dirty = false;
    dbMgr.selHash = null;
    initDbFilterRange();   // 导入后按新数据集重置默认筛选范围
    if (dbMgr.mode === 'file') {
      $('dbManageSource').textContent = '数据来源：' + dbMgr.fileName + '（' + dbMgr.rows.length + ' 行，编辑保存后写回该文件）';
    } else {
      $('dbManageSource').textContent = '数据来源：当前内存数据库（' + dbMgr.rows.length + ' 行，编辑保存后写回项目目录）';
    }
    applyFilter();
    updateFilterInfo();
    renderDbTable();
    hide($('dbDetail'));
    showDbCsvResult(csvData.length, toAdd.length, toUpdate.length, toDelete.length);
  }

  function showDbCsvResult(total, added, updated, deleted) {
    var el = $('dbResult');
    el.className = 'db-result';
    el.innerHTML =
      '<b>CSV 导入结果：</b>共 ' + total + ' 条 → ' +
      '<span class="cnt-add">新增 ' + added + '</span>' +
      '<span class="cnt-upd">· 更新 ' + updated + '</span>' +
      '<span class="cnt-del">· 删除 ' + deleted + '</span>' +
      '<button class="close" title="关闭">✕</button>';
    show(el);
    el.querySelector('.close').addEventListener('click', function () { hide(el); });
  }

  /* CSV 覆盖后从主 db 全量重建内存 photos 与地图标记 */
  function rebuildPhotosFromDb() {
    if (thumbLayer) thumbLayer.clearLayers();
    if (dotLayer) dotLayer.clearLayers();
    photos.length = 0;
    hashSet = Object.create(null);
    playerThumb = null;
    if (!db) { updateStat(); return; }
    var res = db.exec('SELECT hash,name,path,taken_at,taken_ts,lat,lng,alt,width,height,size,thumb,thumb_w,thumb_h FROM photos');
    var rows = (res && res[0]) ? res[0].values : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var p = {
        hash: r[0], name: r[1], path: r[2], takenStr: r[3], takenTs: r[4],
        lat: r[5], lng: r[6], alt: r[7], width: r[8], height: r[9], size: r[10],
        thumb: r[11], tw: r[12] || THUMB_MAX, th: r[13] || THUMB_MAX,
        file: null, fromDb: true
      };
      if (p.lat == null || p.lng == null) continue;
      hashSet[p.hash] = true;
      preparePhoto(p);
      photos.push(p);
    }
    updateStat();
    scheduleRender();
  }

  function saveDbEdits() {
    if (dbMgr.readonly) { toast('只读模式，不可编辑，请选择其他 db 文件'); return; }
    if (!dbMgr.dirty) { toast('没有需要保存的修改'); return; }
    var target = dbMgr.mode === 'memory' ? db : dbMgr.fileDb;
    if (!target) { toast('数据库未初始化'); return; }
    var cnt = 0;
    try {
      target.run('BEGIN');
      for (var i = 0; i < dbMgr.rows.length; i++) {
        var r = dbMgr.rows[i];
        if (r._edit.name != null && r._edit.name !== r.name) {
          target.run('UPDATE photos SET name=? WHERE hash=?', [r._edit.name, r.hash]);
          r.name = r._edit.name; cnt++;
        }
        if (r._edit.path != null && r._edit.path !== r.path) {
          target.run('UPDATE photos SET path=? WHERE hash=?', [r._edit.path, r.hash]);
          r.path = r._edit.path; cnt++;
        }
        r._edit = {};
      }
      target.run('COMMIT');
    } catch (e) {
      try { target.run('ROLLBACK'); } catch (e2) {}
      toast('保存失败：' + (e.message || e), 5000);
      return;
    }
    dbMgr.dirty = false;
    if (dbMgr.mode === 'memory') {
      dbDirty = true;
      var editMap = Object.create(null);
      for (var m = 0; m < dbMgr.rows.length; m++) editMap[dbMgr.rows[m].hash] = dbMgr.rows[m];
      for (var j = 0; j < photos.length; j++) {
        var row = editMap[photos[j].hash];
        if (row) { photos[j].name = row.name; photos[j].path = row.path; }
      }
      saveData();
    } else {
      persistFileDb();
    }
    applyFilter();
    updateFilterInfo();
    renderDbTable();
    renderDbDetail();
    toast('已保存 ' + cnt + ' 处修改');
  }

  function persistFileDb() {
    if (!dbMgr.fileDb || !dbMgr.fileHandle) { toast('无文件句柄，无法保存'); return; }
    var bytes = dbMgr.fileDb.export();
    dbMgr.fileHandle.createWritable().then(function (w) {
      return w.write(bytes).then(function () { return w.close(); });
    }).then(function () {
      toast('已写回 ' + dbMgr.fileName);
    }).catch(function (e) {
      toast('写回失败：' + (e.message || e), 5000);
    });
  }

  function pickDbFileForManage() {
    if (dbMgr.dirty && !window.confirm('当前有未保存的编辑，切换文件将丢失，是否继续？')) return;
    if (!window.showOpenFilePicker) { toast('当前浏览器不支持文件选择，请用 Chrome / Edge'); return; }
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
      // 校验是否为当前正在加载的数据库文件
      return isCurrentLoadedDb(handle).then(function (isCurrent) {
        return { handle: handle, isCurrent: isCurrent };
      });
    }).then(function (result) {
      if (!result || !result.handle) return null;
      dbMgr.fileHandle = result.handle;
      dbMgr.fileName = result.handle.name;
      var isCurrent = result.isCurrent;
      return result.handle.getFile().then(function (file) { return file.arrayBuffer(); }).then(function (buf) {
        return loadSqlJs().then(function () {
          if (dbMgr.fileDb) { try { dbMgr.fileDb.close(); } catch (e) {} }
          dbMgr.fileDb = new SQL.Database(new Uint8Array(buf));
          dbMgr.mode = 'file';
          dbMgr.readonly = isCurrent;   // 当前正在加载的文件只读，其他文件可编辑
          dbMgr.rows = queryDbRows(dbMgr.fileDb);
          dbMgr.dirty = false;
          dbMgr.selHash = null;
          dbMgr.page = 0;
          initDbFilterRange();   // 切换库后默认筛选范围 = 新库拍摄时间的最小/最大
          applyFilter();
          updateFilterInfo();
          if (isCurrent) {
            $('dbManageSource').textContent = '数据来源：' + dbMgr.fileName + '（只读预览，当前正在加载的数据库）';
          } else {
            $('dbManageSource').textContent = '数据来源：' + dbMgr.fileName + '（' + dbMgr.rows.length + ' 行，编辑保存后写回该文件）';
          }
          renderDbTable();
          hide($('dbDetail'));
          updateDbManageWriteButtons();
        });
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      toast('打开文件失败：' + (e.message || e), 5000);
    });
  }

  function closeDbManage() {
    if (dbMgr.dirty && !window.confirm('有未保存的编辑，关闭将丢失，是否继续？')) return;
    hide($('dbManageModal'));
    if (dbMgr.fileDb) { try { dbMgr.fileDb.close(); } catch (e) {} dbMgr.fileDb = null; }
    dbMgr.fileHandle = null;
    dbMgr.fileName = '';
    dbMgr.mode = 'memory';
    dbMgr.readonly = true;
    dbMgr.rows = [];
    dbMgr.filtered = [];
    dbMgr.dirty = false;
    dbMgr.selHash = null;
    dbMgr.page = 0;
    dbMgr.filterFrom = null;
    dbMgr.filterTo = null;
    hide($('dbResult'));
  }

  /* ============================================================
   * 九、手动补录（长按地图为无 GPS 照片补坐标）
   * ============================================================ */
  var manualMode = false;
  var manualPending = null;   // {hash,thumb,tw,th,width,height,size,takenTs,takenStr,hasExifTime,name,path,file}
  var manualLatLng = null;    // 长按位置（GCJ02 地图坐标）

  /* GCJ02 → WGS84 逆转换（迭代逼近，海外天然恒等）*/
  function gcj02ToWgs84(lng, lat) {
    var wgsLng = lng, wgsLat = lat;
    for (var i = 0; i < 5; i++) {
      var g = ExifLite.wgs84ToGcj02(wgsLng, wgsLat);
      wgsLng += lng - g[0];
      wgsLat += lat - g[1];
    }
    return [wgsLng, wgsLat];
  }

  function toggleManualMode() {
    if (!manualMode && (!db || !hasPersistenceTarget())) {
      toast('请先加载数据库文件再补录（补录需写入数据库并按哈希判重）', 5000);
      return;
    }
    manualMode = !manualMode;
    $('btnManual').classList.toggle('on', manualMode);
    document.body.classList.toggle('manual-mode', manualMode);
    if (manualMode) {
      map.on('contextmenu', onMapLongPress);
      toast('已进入补录模式：长按地图位置选点（播放中需先暂停）', 5000);
    } else {
      map.off('contextmenu', onMapLongPress);
      hide($('manualModal'));
      toast('已退出补录模式');
    }
  }

  function onMapLongPress(e) {
    if (player.running && !player.paused) {
      toast('播放中不能补录，请先暂停播放', 3000);
      return;
    }
    manualLatLng = e.latlng;
    openManualModal();
  }

  function openManualModal() {
    var wgs = gcj02ToWgs84(manualLatLng.lng, manualLatLng.lat);
    $('manualLat').value = Number(wgs[1]).toFixed(6);
    $('manualLng').value = Number(wgs[0]).toFixed(6);
    $('manualTime').value = toLocalInput(Date.now());
    $('manualTime').disabled = false;
    resetManualFile();
    show($('manualModal'));
  }

  function resetManualFile() {
    manualPending = null;
    $('manualFileName').textContent = '点击选择照片';
    $('manualFilePick').classList.remove('has');
    $('manualTime').disabled = false;
    $('manualHint').innerHTML = '提示：拍摄时间以照片 EXIF 为准（若存在），否则使用上方填写的时间。哈希重复的照片禁止保存。';
  }

  function onManualPhotoChange(file) {
    if (!file) return;
    resetManualFile();
    $('manualFileName').textContent = file.name;
    $('manualFilePick').classList.add('has');
    progress('正在解析照片', 0, 1, file.name);
    processFile(file).then(function (p) {
      progressDone();
      if (p.dup) {
        toast('该照片已存在（哈希重复），无法补录', 5000);
        $('manualFileName').textContent = '哈希重复，请更换照片';
        $('manualFilePick').classList.remove('has');
        manualPending = null;
        return;
      }
      manualPending = {
        hash: p.hash, thumb: p.thumb, tw: p.tw, th: p.th,
        width: p.width, height: p.height, size: p.size,
        takenTs: p.takenTs, takenStr: p.takenStr,
        hasExifTime: !p.approxTime,
        name: p.name, path: p.path, file: file
      };
      if (manualPending.hasExifTime) {
        $('manualTime').value = toLocalInput(p.takenTs);
        $('manualTime').disabled = true;
        $('manualHint').innerHTML = '已检测到照片 EXIF 拍摄时间，<b>以照片时间为准</b>。';
      } else {
        $('manualHint').innerHTML = '照片无 EXIF 时间，请<b>手动填写拍摄时间</b>。';
      }
    }).catch(function (e) {
      progressDone();
      toast('解析照片失败：' + (e.message || e), 5000);
      resetManualFile();
    });
  }

  function saveManualPhoto() {
    if (!manualPending) { toast('请先选择照片'); return; }
    if (hashSet[manualPending.hash]) { toast('该照片哈希已存在，禁止保存', 5000); return; }
    var lat = parseFloat($('manualLat').value);
    var lng = parseFloat($('manualLng').value);
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) { toast('经纬度无效'); return; }
    var takenTs, approxTime, takenStr;
    if (manualPending.hasExifTime) {
      takenTs = manualPending.takenTs;
      approxTime = false;
      takenStr = manualPending.takenStr;
    } else {
      var t = $('manualTime').value;
      if (!t) { toast('请填写拍摄时间'); return; }
      takenTs = new Date(t).getTime();
      approxTime = true;
      takenStr = fmtTime(takenTs);
    }
    var p = {
      hash: manualPending.hash,
      name: manualPending.name,
      path: manualPending.path,
      takenTs: takenTs,
      takenStr: takenStr,
      approxTime: approxTime,
      lat: lat, lng: lng, alt: null,
      width: manualPending.width, height: manualPending.height,
      size: manualPending.size,
      thumb: manualPending.thumb, tw: manualPending.tw, th: manualPending.th,
      file: manualPending.file, fromDb: false
    };
    ensureDb().then(function () {
      insertPhoto(p);
      hashSet[p.hash] = true;
      preparePhoto(p);
      photos.push(p);
      updateStat();
      scheduleRender();
      return saveData();
    }).then(function () {
      toast('已补录点位：' + p.name, 3000);
      hide($('manualModal'));
      resetManualFile();
    }).catch(function (e) {
      toast('保存失败：' + (e.message || e), 5000);
    });
  }

  /* ============================================================
   * 十、事件绑定
   * ============================================================ */
  function bindUI() {
    var menu = $('importMenu');

    var importBtn = $('btnImport');
    importBtn.onclick = function (e) {
      e.stopPropagation();
      if (!db || !hasPersistenceTarget()) {
        if (initGuard) return;
        initGuard = true;
        toast('请先加载数据库文件再导入（导入需写入数据库并按哈希判重）', 3000);
        setTimeout(function () {
          toast('检测到未初始化，正在引导您选择初始空间...', 3000);
          setTimeout(function () { loadDbFromDir(true).then(function () { initGuard = false; }); }, 1500);
        }, 2500);
        return;
      }
      if (isMobile) { $('fileInput').click(); return; }
      menu.classList.toggle('hidden');
    };
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
      if (this.files && this.files.length) {
        if (!db || !hasPersistenceTarget()) { this.value = ''; return; }
        handleFiles(this.files);
      }
      this.value = '';
    });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files.length) {
        if (!db || !hasPersistenceTarget()) { this.value = ''; return; }
        handleFiles(this.files);
      }
      this.value = '';
    });

    var loadMenu = $('loadMenu');
    $('btnLoad').addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.showOpenFilePicker || window.showDirectoryPicker) {
        loadMenu.classList.toggle('hidden');
      } else {
        $('dbInput').click();
      }
    });
    document.addEventListener('click', function () { hide(loadMenu); });
    loadMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      var btn = e.target.closest('.menu-item');
      if (!btn) return;
      hide(loadMenu);
      if (btn.dataset.act === 'file') pickDbFile();
      else loadDbFromDir();
    });
    $('dbInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      progress('正在读取数据库', 0, 1, f.name);
      readBuffer(f).then(loadDbBytes).then(reportLoad).catch(function (e) {
        progressDone();
        toast('加载失败：' + (e.message || e), 5000);
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
        toast('加载失败：' + (e.message || e), 5000);
      });
    }

    // 增量加载：每次都让用户选择源目录，读取其 photos.db；不存在则自动创建空库
    // 返回 Promise<boolean>：true 表示加载成功，false 表示取消或失败
    // skipHint=true 时跳过内部提示（用于引导调用，外部已给了提示）
    function loadDbFromDir(skipHint) {
      if (!window.showDirectoryPicker) { $('dbInput').click(); return Promise.resolve(false); }
      if (!skipHint) toast('请选择要加载数据库的目录', 5000);
      return window.showDirectoryPicker({ id: 'pw_load_source', mode: 'readwrite' }).then(function (dirH) {
        // 首次使用时，将源目录同时设为工作目录
        if (!saveDirHandle) {
          saveDirHandle = dirH;
          try {
            localStorage.setItem('pw_last_dir_name', dirH.name);
            localStorage.setItem('pw_last_dir_time', String(Date.now()));
          } catch (e) {}
        }
        // 尝试读取目录下的 photos.db
        return dirH.getFileHandle('photos.db').then(function (fh) {
          return fh.getFile().then(function (file) {
            progress('正在读取数据库', 0, 1, file.name);
            return file.arrayBuffer();
          }).then(function (buf) {
            return { buf: buf, created: false };
          });
        }).catch(function () {
          // 目录下不存在 photos.db，自动创建空库（独立实例，不干扰当前 db）
          progress('正在创建空数据库', 0, 1, 'photos.db');
          return loadSqlJs().then(function () {
            var emptyDb = new SQL.Database();
            emptyDb.run(SCHEMA);
            var bytes = emptyDb.export();
            emptyDb.close();
            return dirH.getFileHandle('photos.db', { create: true }).then(function (fh) {
              return fh.createWritable().then(function (w) {
                return w.write(bytes).then(function () { return w.close(); });
              });
            }).then(function () {
              return { buf: bytes, created: true };
            });
          });
        });
      }).then(function (result) {
        if (!result) return false;
        return loadDbBytes(result.buf).then(function (r) {
          return { stat: r, created: result.created };
        });
      }).then(function (result) {
        if (!result) return false;
        if (result.created) {
          // 空库创建：手动收尾，提示创建信息（跳过 reportLoad 的"共加载 0 张"）
          progressDone();
          updateStat();
          scheduleRender();
          toast('目录下不存在初始库文件，已自动创建', 5000);
        } else {
          reportLoad(result.stat);
        }
        return true; // 成功
      }).catch(function (e) {
        progressDone();
        if (e && e.name === 'AbortError') return false; // 用户取消
        toast('加载失败：' + (e.message || e), 5000);
        return false; // 失败
      });
    }

    $('btnSave').addEventListener('click', function () { backupDb(); });

    // 数据库直接管理
    $('btnDbManage').addEventListener('click', function (e) {
      e.stopPropagation();
      openDbManage();
    });
    $('dbManageClose').addEventListener('click', closeDbManage);
    $('dbPickFile').addEventListener('click', pickDbFileForManage);
    $('dbExportCsv').addEventListener('click', exportDbCsv);
    $('dbImportCsv').addEventListener('click', function () { $('csvInput').click(); });
    $('csvInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) importDbCsv(f);
    });
    $('dbSaveEdit').addEventListener('click', saveDbEdits);

    // 筛选与分页
    function onFilterChange() {
      var fromVal = $('dbFilterFrom').value;
      var toVal = $('dbFilterTo').value;
      dbMgr.filterFrom = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : null;
      dbMgr.filterTo = toVal ? new Date(toVal + 'T23:59:59.999').getTime() : null;
      dbMgr.page = 0;
      applyFilter();
      updateFilterInfo();
      renderDbTable();
    }
    $('dbFilterFrom').addEventListener('change', onFilterChange);
    $('dbFilterTo').addEventListener('change', onFilterChange);
    $('dbFilterReset').addEventListener('click', function () {
      dbMgr.page = 0;
      initDbFilterRange();   // 重置为所选库拍摄时间的最小/最大（即全部数据范围）
      applyFilter();
      updateFilterInfo();
      renderDbTable();
    });

    // 手动补录
    $('btnManual').addEventListener('click', function (e) {
      e.stopPropagation();
      if (!db || !hasPersistenceTarget()) {
        if (initGuard) return;
        initGuard = true;
        toast('请先加载数据库文件再补录（补录需写入数据库并按哈希判重）', 3000);
        setTimeout(function () {
          toast('检测到未初始化，正在引导您选择初始空间...', 3000);
          setTimeout(function () { loadDbFromDir(true).then(function () { initGuard = false; }); }, 1500);
        }, 2500);
        return;
      }
      toggleManualMode();
    });
    $('manualCancel').addEventListener('click', function () { hide($('manualModal')); resetManualFile(); });
    $('manualModal').addEventListener('click', function (e) {
      if (e.target === this) { hide($('manualModal')); resetManualFile(); }
    });
    $('manualSave').addEventListener('click', saveManualPhoto);
    $('manualFilePick').addEventListener('click', function () { $('manualPhotoInput').click(); });
    $('manualPhotoInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) onManualPhotoChange(f);
    });

    $('btnPlay').addEventListener('click', openPlayModal);
    $('playCancel').addEventListener('click', function () { hide($('playModal')); });
    $('playConfirm').addEventListener('click', startPlay);
    $('playStart').addEventListener('input', updatePlayHint);
    $('playEnd').addEventListener('input', updatePlayHint);
    $('playModal').addEventListener('click', function (e) {
      if (e.target === this) hide(this);
    });

    // 删除确认框绑定
    $('delCancel').addEventListener('click', function () {
      hideDelModal();
    });
    $('delConfirm').addEventListener('click', function () {
      hideDelModal();
      deleteCurrentPhoto();
    });
    $('delModal').addEventListener('click', function (e) {
      if (e.target === this) hideDelModal();
    });

    $('hudStop').addEventListener('click', function () { stopPlay(false); });
    $('hudToggle').addEventListener('click', pausePlay);

    // 播放速度实时调整：下次 tick 自动用新速度，当前等待的 tick 也按新速度重排
    $('hudSpeed').addEventListener('change', function () {
      player.speed = parseFloat(this.value) || 1;
      if (player.running && !player.paused) {
        clearTimeout(player.timer);
        player.timer = setTimeout(function () {
          if (!player.running || player.paused) return;
          player.idx++;
          tickPlay();
        }, interval());
      }
    });

    // 进度条拖动：input 期间实时预览目标位置信息并暂停自动前进；change 跳转到目标
    $('hudSeek').addEventListener('input', function () {
      if (!player.running) return;
      clearTimeout(player.timer);   // 拖动期间暂停自动前进，避免覆盖用户操作
      var max = player.list.length - 1;
      var idx = Math.round(parseInt(this.value, 10) / 100 * max);
      var p = player.list[idx];
      if (p) {
        $('hudName').textContent = p.name;
        $('hudTime').textContent = (p.approxTime ? '≈ ' : '') + fmtTime(p.takenTs) +
          '　·　' + (idx + 1) + ' / ' + player.list.length;
        $('hudBar').style.width = ((idx + 1) / player.list.length * 100) + '%';
      }
    });
    $('hudSeek').addEventListener('change', function () {
      if (!player.running) return;
      var max = player.list.length - 1;
      var idx = Math.max(0, Math.min(Math.round(parseInt(this.value, 10) / 100 * max), max));
      // 清理当前高亮
      var cur = player.list[player.idx];
      if (player.activeEl && cur && cur.el) cur.el.classList.remove('active', 'shake');
      if (player.activeMk && player.activeMk !== playerThumb) player.activeMk.setZIndexOffset(0);
      if (cur) releasePlayerMarker(cur);
      player.idx = idx;
      tickPlay();   // 重新高亮目标位置并按当前速度/暂停状态调度
    });

    // 【离线下载已禁用】以下 UI 接线注释保留，代码不启用
    // $('btnOffline').addEventListener('click', openOfflineModal);
    // $('offCancel').addEventListener('click', function () { hide($('offlineModal')); });
    // $('offlineModal').addEventListener('click', function (e) { if (e.target === this) hide(this); });
    // $('offStart').addEventListener('click', startOfflineDownload);
    // ['offZmin', 'offZmax', 'offMargin', 'offStd', 'offSat'].forEach(function (id) {
    //   $(id).addEventListener('change', updateOfflineEstimate);
    // });
    // $('progCancel').addEventListener('click', function () { tileCancel = true; });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        // 数据库直接管理弹窗刻意不响应 ESC（防误关丢失编辑），仅关闭查看器/播放弹窗
        closeViewer(); hide($('playModal')); if (player.running) stopPlay(false);
      }
      // 空格暂停：输入控件内打字时不劫持
      if (e.key === ' ' && player.running) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        e.preventDefault(); pausePlay();
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (dbDirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ===【已禁用】离线瓦片下载功能（代码保留备用）===
  // 重新启用步骤：① 取消本段及 bindUI/HTML 中相关注释 ② 把 OVER_CFG 的 std 换成支持
  //   CORS 的源（如 CARTO Voyager），否则 fetch 下载会被 CORS 拦截
  //   ③ 取消 initMap 中 offlineReady = localStorage... 一行的注释
  /* --- 以下离线下载代码已禁用，保留备用 ---
  function lon2tileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function lat2tileY(lat, z) {
    var l = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function tileRemoteUrl(cfg, z, x, y) {
    var url = cfg.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    if (cfg.sub && cfg.sub.length) url = url.replace('{s}', cfg.sub[(x + y) % cfg.sub.length]);
    return url;
  }

  // 计算覆盖所有海外照片点位的瓦片清单（含边距），返回 [{layer,z,x,y}]
  function computeOverseasTiles(zMin, zMax, margin, layerIds) {
    var set = Object.create(null);
    var pts = photos.filter(function (p) {
      return p.lat != null && p.lng != null && !inChina(p.lat, p.lng);
    });
    for (var z = zMin; z <= zMax; z++) {
      var maxIdx = Math.pow(2, z);
      for (var pi = 0; pi < pts.length; pi++) {
        var p = pts[pi];
        var cx = lon2tileX(p.lng, z), cy = lat2tileY(p.lat, z);
        for (var dx = -margin; dx <= margin; dx++) {
          for (var dy = -margin; dy <= margin; dy++) {
            var x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= maxIdx || y >= maxIdx) continue;
            for (var li = 0; li < layerIds.length; li++) {
              set[layerIds[li] + '|' + z + '|' + x + '|' + y] = 1;
            }
          }
        }
      }
    }
    return Object.keys(set).map(function (k) {
      var a = k.split('|'); return { layer: a[0], z: +a[1], x: +a[2], y: +a[3] };
    });
  }

  var tileCancel = false;
  var dirCache = Object.create(null);
  async function getTileDir(tilesDir, layer, z, x) {
    var key = layer + '/' + z + '/' + x;
    if (dirCache[key]) return dirCache[key];
    var d = tilesDir;
    d = await d.getDirectoryHandle(layer, { create: true });
    d = await d.getDirectoryHandle(String(z), { create: true });
    d = await d.getDirectoryHandle(String(x), { create: true });
    dirCache[key] = d;
    return d;
  }

  async function downloadOfflineTiles(items) {
    if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持本地目录写入，请用 Chrome / Edge 打开本页面');
    var dirH = await ensureProjectDir();
    if (!dirH) throw new Error('未授权项目目录');
    var tilesDir = await dirH.getDirectoryHandle('tiles', { create: true });
    var CONC = 6, idx = 0, ok = 0, skip = 0, fail = 0, done = 0, total = items.length;
    async function worker() {
      while (idx < total) {
        if (tileCancel) return;
        var it = items[idx++];
        var cfg = null;
        for (var i = 0; i < OVER_CFG.length; i++) if (OVER_CFG[i].id === it.layer) { cfg = OVER_CFG[i]; break; }
        if (!cfg) { fail++; done++; continue; }
        try {
          var zDir = await getTileDir(tilesDir, it.layer, it.z, it.x);
          var fname = it.y + '.' + cfg.ext;
          var exists = true;
          try { await zDir.getFileHandle(fname); } catch (e) { exists = false; }
          if (exists) { skip++; done++; continue; }
          var resp = await fetch(tileRemoteUrl(cfg, it.z, it.x, it.y));
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var blob = await resp.blob();
          if (!blob || blob.size < 100) throw new Error('空瓦片');
          var fh = await zDir.getFileHandle(fname, { create: true });
          var w = await fh.createWritable();
          await w.write(blob);
          await w.close();
          ok++;
        } catch (e) { fail++; }
        done++;
        if (done % 4 === 0 || done === total) {
          progress('下载离线瓦片', done, total, '成功 ' + ok + ' · 跳过 ' + skip + ' · 失败 ' + fail + (tileCancel ? ' · 已取消' : ''));
          await sleep(0);
        }
      }
    }
    var ws = [];
    for (var i = 0; i < CONC; i++) ws.push(worker());
    await Promise.all(ws);
    for (var k in dirCache) delete dirCache[k];
    return { ok: ok, skip: skip, fail: fail, total: total };
  }

  function openOfflineModal() {
    if (!photos.length) { toast('请先导入或加载照片，再下载离线瓦片', 3000); return; }
    var overseas = photos.filter(function (p) { return p.lat != null && p.lng != null && !inChina(p.lat, p.lng); }).length;
    if (!overseas) { toast('当前没有海外照片点位，无需下载离线瓦片', 3000); return; }
    $('offHint').textContent = '当前海外照片 ' + overseas + ' 张。下载后瓦片存入应用目录 tiles/，地图将优先读取本地。';
    show($('offlineModal'));
    updateOfflineEstimate();
  }
  function updateOfflineEstimate() {
    var zMin = +$('offZmin').value, zMax = +$('offZmax').value, margin = +$('offMargin').value;
    var ids = [];
    if ($('offStd').checked) ids.push('std');
    if ($('offSat').checked) { ids.push('sat'); ids.push('label'); }
    if (!ids.length) { $('offEst').textContent = '请至少选择一个图层'; return; }
    if (zMin > zMax) { $('offEst').textContent = '起始层级不能大于结束层级'; return; }
    var items = computeOverseasTiles(zMin, zMax, margin, ids);
    $('offEst').textContent = '预计下载 ' + items.length + ' 块瓦片（层级 ' + zMin + '–' + zMax + '，边距 ' + margin + '；已存在的会自动跳过，失败可重跑补齐）';
  }
  async function startOfflineDownload() {
    var zMin = +$('offZmin').value, zMax = +$('offZmax').value, margin = +$('offMargin').value;
    if (zMin > zMax) { toast('起始层级不能大于结束层级', 4000); return; }
    var ids = [];
    if ($('offStd').checked) ids.push('std');
    if ($('offSat').checked) { ids.push('sat'); ids.push('label'); }
    if (!ids.length) { toast('请至少选择一个图层', 4000); return; }
    var items = computeOverseasTiles(zMin, zMax, margin, ids);
    if (!items.length) { toast('没有需要下载的瓦片', 4000); return; }
    hide($('offlineModal'));
    tileCancel = false;
    var b = $('progCancel'); if (b) b.classList.remove('hidden');
    progress('下载离线瓦片', 0, items.length, '准备下载…');
    try {
      var r = await downloadOfflineTiles(items);
      if (!tileCancel) { offlineReady = true; localStorage.setItem('pw_offline', '1'); }
      toast('下载完成：成功 ' + r.ok + ' · 跳过 ' + r.skip + ' · 失败 ' + r.fail + (tileCancel ? ' · 已取消' : ''), 5000);
      if (offlineReady) {   // 刷新当前海外图层，让本地副本生效
        Object.keys(overLayers).forEach(function (k) {
          var l = overLayers[k];
          if (l && map.hasLayer(l)) l.redraw();
        });
      }
    } catch (e) {
      toast('下载失败：' + (e.message || e), 5000);
    } finally {
      var b2 = $('progCancel'); if (b2) b2.classList.add('hidden');
      progressDone();
    }
  }
  */

  /* ============================================================
   * 十一、启动
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
          scheduleRender();   // 显式触发渲染
          toast('已自动加载同目录 photos.db：' + r.added + ' 张照片', 5000);
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
        toast('当前是双击打开（file:// 模式）：功能可用，但无法自动读取同目录 photos.db。建议用「启动-Mac.command / 启动-Windows.bat」打开，体验完整。', 3000);
      }, 1200);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
