'use strict';
/**
 * 拾光轮播 (LuminaSlide) — 播放端
 *
 * 关键设计（都是踩过坑换来的）：
 *   1. 绝不写「同步 while 等待异步结果」的循环 —— 会让浏览器主线程 100% 死锁
 *   2. 预取用 inflight 计数 + 回调驱动，不用轮询
 *   3. 连续失败有上限（MAX_ERR），不会无限重试
 *   4. 画中画用 Document PiP API；不支持时优雅降级
 *   5. 保持对旧 WebView 的兼容：不用 ?. 和 ??
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var picA = $('pic');
  var picB = $('pic2');
  var ambientEl = $('ambient');
  var infoEl = $('info');
  var filterBadge = $('filterBadge');
  var timelineFill = $('timelineFill');
  var emptyEl = $('empty');
  var hintEl = $('hint');
  var toastEl = $('toast');
  var lblInterval = $('lblInterval');
  var ivlMenu = $('ivlMenu');
  var drawer = $('drawer');
  var helpModal = $('helpModal');

  var S = {
    playing: true,
    interval: 8,
    transition: 'fade',
    showInfo: true,
    ambientBg: true,
    prefetch: 2,
    total: 0,
    poolTotal: 0,
    booted: false,
    infoHiddenManual: false,
    filter: { sourceId: '', album: '', onlyFavorites: false },
    currentMeta: null,

    timer: null,
    watchdog: null,
    tickTimer: null,
    loading: false,
    buffer: [],
    inflight: 0,
    errCount: 0,

    front: picA,
    back: picB,
    startedAt: 0,
    pipWin: null,
    pipArea: 480 * 360,
    _pipSyncAt: 0,
    _pipToggling: false
  };

  try {
    var savedArea = parseInt(localStorage.getItem('lumina_pip_area') || '0', 10);
    if (savedArea >= 160 * 160 && savedArea <= 1600 * 1200) S.pipArea = savedArea;
  } catch (e) {}

  var MAX_ERR = 8;
  var uiTimer = null;
  var kbTimer = null;

  // ---------- 工具 ----------
  function api(method, path, body) {
    var opt = { method: method, headers: {} };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (r) {
      if (r.status === 401) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname);
        throw new Error('未登录');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function toast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'show';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.className = ''; }, ms || 1400);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function syncBodyClasses() {
    var cls = [];
    if (S._uiVisible) cls.push('show-ui');
    if (S.infoHiddenManual) cls.push('info-hidden');
    if (drawer && drawer.className.indexOf('hidden') < 0) cls.push('drawer-open');
    if (helpModal && helpModal.className.indexOf('hidden') < 0) cls.push('help-open');
    document.body.className = cls.join(' ');
  }

  // ---------- UI 显隐 ----------
  function showUI() {
    S._uiVisible = true;
    syncBodyClasses();
    if (infoEl && S.showInfo && !S.infoHiddenManual) infoEl.className = 'show';
    clearTimeout(uiTimer);
    uiTimer = setTimeout(hideUI, 3400);
  }
  function hideUI() {
    S._uiVisible = false;
    syncBodyClasses();
    if (infoEl) infoEl.className = '';
    if (ivlMenu) ivlMenu.className = 'popover hidden';
  }

  // ---------- 预取（回调驱动，无循环） ----------
  function fillBuffer() {
    if (!S.booted) return;
    if (S.buffer.length + S.inflight >= S.prefetch) return;
    if (S.errCount >= MAX_ERR) return;

    S.inflight++;
    api('GET', '/api/next')
      .then(function (d) {
        S.inflight--;
        if (!d || d.empty) {
          if (!S.poolTotal && !S.total) showEmpty(d);
          return;
        }
        var im = new Image();
        im.onload = function () {
          S.buffer.push({ meta: d, image: im });
          S.errCount = 0;
        };
        im.onerror = function () { S.errCount++; };
        im.src = d.img;
      })
      .catch(function () {
        S.inflight--;
        S.errCount++;
      });
  }

  function keepFilling() {
    fillBuffer();
    setTimeout(keepFilling, 1000);
  }

  // ---------- 信息与状态 ----------
  function updateFavBtn(isFav) {
    var btn = $('btnFav');
    if (btn) btn.className = isFav ? 'cbtn fav-on' : 'cbtn';
  }

  function updateFilterBadge() {
    if (!filterBadge) return;
    var parts = [];
    if (S.filter.onlyFavorites) parts.push('仅收藏');
    if (S.filter.sourceId) parts.push(S.filter.sourceId);
    if (S.filter.album) parts.push(S.filter.album);
    if (parts.length) {
      filterBadge.textContent = parts.join(' · ');
      filterBadge.className = 'filter-badge';
    } else {
      filterBadge.className = 'filter-badge hidden';
    }
  }

  function setInfo(item) {
    S.currentMeta = item;
    updateFavBtn(!!item.isFavorite);
    updateFilterBadge();

    if (!S.showInfo || !infoEl) return;
    var album = infoEl.querySelector('.album');
    var src = infoEl.querySelector('.src');
    var pos = infoEl.querySelector('.pos');
    if (album) album.textContent = item.album || item.name || item.relDir || '';
    if (src) src.textContent = (item.source || '') + (item.name ? ' · ' + item.name : '');
    if (pos && item.progress) {
      pos.textContent = item.progress.mode === 'shuffle'
        ? (item.progress.pos + ' / ' + item.progress.total + ' (' + item.progress.percent + '%)')
        : (item.progress.mode === 'random' ? '随机' : '去重');
    }
  }

  function showItem(item) {
    if (!item || !item.img) return;
    if (emptyEl) emptyEl.className = 'hidden';
    clearTimeout(kbTimer);

    var front = S.front;
    var back = S.back;
    var settled = false;

    function settle(ok) {
      if (settled) return;
      settled = true;
      front.onload = null; front.onerror = null;
      back.onload = null; back.onerror = null;

      if (!ok) {
        S.errCount++;
        if (S.errCount < MAX_ERR) { setTimeout(next, 400); }
        else { toast('连续加载失败，已暂停'); setPlaying(false); }
        return;
      }

      S.front = back;
      S.back = front;
      S.errCount = 0;
      S.startedAt = Date.now();
      setInfo(item);
      if (ambientEl) {
        if (S.ambientBg) {
          ambientEl.style.backgroundImage = 'url("' + item.img + '")';
          ambientEl.className = 'on';
        } else {
          ambientEl.className = '';
        }
      }
      if (S.playing) {
        startTimeline();
        scheduleNext();
        startWatchdog();
      }
      syncVideoPip(S.front);
      syncMediaSessionMeta(item);
      fillBuffer();
    }

    back.style.zIndex = '3';
    back.style.opacity = '0';
    back.className = '';

    back.onload = function () {
      if (settled) return;
      if (S.transition === 'none') {
        front.style.opacity = '0';
        back.style.opacity = '1';
        settle(true);
        return;
      }
      void back.offsetWidth;
      back.style.opacity = '1';
      front.style.opacity = '0';

      if (S.transition === 'kenburns') {
        back.className = 'kb kb-on';
        kbTimer = setTimeout(function () {
          if (S.front) S.front.className = 'kb kb-on';
          if (S.back) S.back.className = '';
        }, 750);
      }

      var t0 = Date.now();
      (function waitFade() {
        if (settled) return;
        if (Date.now() - t0 >= 720) { settle(true); return; }
        setTimeout(waitFade, 60);
      })();
    };

    back.onerror = function () {
      back.style.opacity = '0';
      settle(false);
    };

    back.src = item.img;
  }

  function showEmpty(d) {
    stopTimeline();
    clearTimeout(S.timer);
    stopWatchdog();
    if (timelineFill) timelineFill.style.width = '0%';
    if (!emptyEl) return;
    emptyEl.className = '';
    var hasFilter = S.filter.sourceId || S.filter.album || S.filter.onlyFavorites;
    var title = $('emptyTitle');
    var desc = $('emptyDesc');
    var clearBtn = $('btnClearFilterEmpty');
    if (hasFilter) {
      if (title) title.textContent = '当前过滤条件下没有图片';
      if (desc) desc.textContent = '可以清除过滤条件以恢复全部图库播放';
      if (clearBtn) clearBtn.className = 'btn-go btn-go-ghost';
    } else {
      if (title) title.textContent = '还没有图片';
      if (desc) desc.textContent = '请先到配置页添加来源并开始扫描';
      if (clearBtn) clearBtn.className = 'btn-go btn-go-ghost hidden';
    }
    if (d && typeof d.total === 'number') S.total = d.total;
  }

  // ---------- 进度条 ----------
  function startTimeline() {
    clearInterval(S.tickTimer);
    if (!timelineFill) return;
    timelineFill.style.width = '0%';
    var total = S.interval * 1000;
    S.tickTimer = setInterval(function () {
      if (!S.playing) return;
      var p = Math.min(100, (Date.now() - S.startedAt) / total * 100);
      timelineFill.style.width = p + '%';
    }, 120);
  }
  function stopTimeline() {
    clearInterval(S.tickTimer);
    S.tickTimer = null;
  }

  // ---------- 调度 ----------
  function takeBuffered() {
    return S.buffer.length ? S.buffer.shift() : null;
  }

  function next() {
    clearTimeout(S.timer);
    if (!S.booted) return;
    if (S.loading) return;
    S.loading = true;

    var ready = takeBuffered();
    if (ready) {
      S.loading = false;
      showItem(ready.meta);
      fillBuffer();
      scheduleNext();
      return;
    }

    api('GET', '/api/next')
      .then(function (d) {
        S.loading = false;
        if (!d || d.empty) { showEmpty(d); return; }
        showItem(d);
        fillBuffer();
        scheduleNext();
      })
      .catch(function () {
        S.loading = false;
        S.errCount++;
        if (S.errCount < MAX_ERR) {
          setTimeout(next, 1200);
        } else {
          toast('网络异常，已暂停');
          setPlaying(false);
        }
      });
  }

  function startWatchdog() {
    if (S.watchdog) return;
    S.watchdog = setInterval(function () {
      if (!S.playing || S.loading) return;
      var elapsed = Date.now() - S.startedAt;
      if (elapsed > S.interval * 1000 * 1.15) {
        next();
      }
    }, 1000);
  }
  function stopWatchdog() {
    if (S.watchdog) { clearInterval(S.watchdog); S.watchdog = null; }
  }
  function scheduleNext() {
    clearTimeout(S.timer);
    if (!S.playing) return;
    S.timer = setTimeout(next, S.interval * 1000);
  }

  function prev() {
    clearTimeout(S.timer);
    api('GET', '/api/prev')
      .then(function (d) {
        if (d && !d.empty) showItem(d);
        scheduleNext();
      })
      .catch(function () { scheduleNext(); });
  }

  // ---------- 控制 ----------
  function updatePlayBtn(v) {
    var btn = $('btnPlay');
    if (btn) {
      var ip = btn.querySelector('.ic-pause');
      var il = btn.querySelector('.ic-play');
      if (ip) ip.style.display = v ? '' : 'none';
      if (il) il.style.display = v ? 'none' : '';
    }
  }

  function setPlaying(v, silentApi) {
    S.playing = v;
    updatePlayBtn(v);
    syncMediaSessionMeta(S.currentMeta);
    if (S.videoPip) {
      S._pipToggling = true;
      try {
        if (v && S.videoPip.paused) S.videoPip.play().catch(function () {});
        else if (!v && !S.videoPip.paused) S.videoPip.pause();
      } catch (e) {}
      setTimeout(function () { S._pipToggling = false; }, 120);
    }
    if (!silentApi) {
      api('POST', '/api/control', { action: v ? 'play' : 'pause' }).catch(function () {});
    }
    if (v && S.booted && S.currentMeta) {
      S.errCount = 0;
      S.startedAt = Date.now();
      startTimeline();
      scheduleNext();
      startWatchdog();
    } else if (!v) {
      stopTimeline();
      clearTimeout(S.timer);
      stopWatchdog();
    }
    if (!silentApi) toast(v ? '播放' : '暂停', 900);
  }

  function setInterval2(v, silentApi) {
    v = Math.max(2, Math.min(600, v));
    S.interval = v;
    if (lblInterval) lblInterval.textContent = v + 's';
    if (!silentApi) {
      api('POST', '/api/control', { action: 'interval', value: v }).catch(function () {});
    }
    if (S.playing) { S.startedAt = Date.now(); scheduleNext(); }
  }

  function toggleFavorite() {
    if (!S.currentMeta || !S.currentMeta.id) return;
    api('POST', '/api/favorite', { id: S.currentMeta.id })
      .then(function (r) {
        S.currentMeta.isFavorite = !!r.isFavorite;
        updateFavBtn(!!r.isFavorite);
        toast(r.isFavorite ? '♥ 已收藏' : '已取消收藏', 1000);
      })
      .catch(function () {});
  }

  // ---------- 过滤与相册抽屉 ----------
  function loadAlbums() {
    var srcSel = $('fltSource');
    var qEl = $('fltSearch');
    var listEl = $('albumList');
    if (!listEl) return;

    var sourceId = srcSel ? srcSel.value : '';
    var q = qEl ? qEl.value.trim() : '';

    api('GET', '/api/albums?sourceId=' + encodeURIComponent(sourceId) + '&q=' + encodeURIComponent(q) + '&limit=150')
      .then(function (r) {
        if (srcSel && srcSel.options.length <= 1 && r.sources) {
          r.sources.forEach(function (s) {
            var o = document.createElement('option');
            o.value = s.id; o.textContent = s.id + ' (' + s.type + ')';
            srcSel.appendChild(o);
          });
          srcSel.value = S.filter.sourceId || '';
        }

        var html = '<button class="album-item ' + (!S.filter.album ? 'active' : '') + '" data-album="" data-src="' + esc(sourceId) + '">' +
          '<span class="aname">全部相册</span><span class="acnt">不限</span></button>';
        (r.albums || []).forEach(function (a) {
          var isAct = S.filter.album === a.album && (!S.filter.sourceId || S.filter.sourceId === a.source_id);
          html += '<button class="album-item ' + (isAct ? 'active' : '') + '" data-album="' + esc(a.album) + '" data-src="' + esc(a.source_id) + '">' +
            '<span class="aname">' + esc(a.album || '(根目录)') + '</span>' +
            '<span class="acnt">' + esc(a.c) + '</span></button>';
        });
        listEl.innerHTML = html;

        var items = listEl.querySelectorAll('.album-item');
        for (var i = 0; i < items.length; i++) {
          items[i].onclick = function () {
            applyFilter({
              sourceId: this.getAttribute('data-src') || (srcSel ? srcSel.value : ''),
              album: this.getAttribute('data-album') || '',
              onlyFavorites: S.filter.onlyFavorites
            });
          };
        }
      })
      .catch(function () {});
  }

  function applyFilter(flt) {
    api('POST', '/api/filter', flt)
      .then(function (r) {
        S.filter = r.filter || flt;
        S.poolTotal = r.poolTotal || 0;
        S.buffer = [];
        updateFilterBadge();
        var fltAll = $('fltAll'), fltFav = $('fltFav');
        if (fltAll) fltAll.className = S.filter.onlyFavorites ? 'chip' : 'chip active';
        if (fltFav) fltFav.className = S.filter.onlyFavorites ? 'chip active' : 'chip';
        closeDrawer();
        if (!S.poolTotal) {
          showEmpty({ total: S.total });
        } else {
          S.booted = true;
          next();
        }
        toast('已切换播放范围 (' + S.poolTotal + ' 张)', 1400);
      })
      .catch(function (e) { toast('过滤失败: ' + e.message, 2000); });
  }

  function openDrawer() {
    if (!drawer) return;
    drawer.className = 'drawer';
    var fltAll = $('fltAll'), fltFav = $('fltFav');
    if (fltAll) fltAll.className = S.filter.onlyFavorites ? 'chip' : 'chip active';
    if (fltFav) fltFav.className = S.filter.onlyFavorites ? 'chip active' : 'chip';
    syncBodyClasses();
    loadAlbums();
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.className = 'drawer hidden';
    syncBodyClasses();
  }

  // ---------- 画中画 ----------
  function isPipActive() {
    return !!(S.videoPip && document.pictureInPictureElement);
  }

  function togglePip() {
    if (isPipActive()) { closePip(); return; }
    openPip();
  }

  function syncMediaSessionMeta(item) {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
      if (typeof MediaMetadata !== 'undefined' && item) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: item.album || item.name || '拾光轮播',
          artist: item.source || 'LuminaSlide'
        });
      }
      navigator.mediaSession.playbackState = S.playing ? 'playing' : 'paused';
    } catch (e) {}
  }

  function bindMediaSession() {
    try {
      if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
      navigator.mediaSession.setActionHandler('previoustrack', function () { prev(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { next(); });
      navigator.mediaSession.setActionHandler('play', function () { setPlaying(true); });
      navigator.mediaSession.setActionHandler('pause', function () { setPlaying(false); });
      if (S.currentMeta) syncMediaSessionMeta(S.currentMeta);
    } catch (e) {}
  }

  function openPip() {
    tryVideoPip();
  }

  function calcBalancedSize(nw, nh) {
    var ratio = (nw && nh) ? (nw / nh) : 1;
    // 以用户拖出的窗口面积为基准，并做 2x 超采样（最低不低于 960x720 面积），避免小窗视频压缩发糊
    var dpr = Math.max(2, (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 2);
    var baseArea = S.pipArea || (480 * 360);
    var renderArea = Math.max(baseArea * dpr * dpr, 960 * 720);
    var w = Math.round(Math.sqrt(renderArea * ratio));
    var h = Math.round(Math.sqrt(renderArea / ratio));
    w = Math.max(320, Math.min(1600, w - (w % 2)));
    h = Math.max(320, Math.min(1600, h - (h % 2)));
    return { w: w, h: h };
  }

  function tryVideoPip() {
    try {
      if (!document.pictureInPictureEnabled ||
          typeof HTMLVideoElement === 'undefined' ||
          !HTMLVideoElement.prototype.requestPictureInPicture) {
        toast('当前浏览器不支持画中画', 3000);
        return;
      }

      var imgEl = S.front;
      if (!imgEl || !imgEl.src || !imgEl.complete || !imgEl.naturalWidth) {
        toast('请等待当前图片加载完成', 1600);
        return;
      }

      var sz = calcBalancedSize(imgEl.naturalWidth, imgEl.naturalHeight);
      var canvas = document.createElement('canvas');
      canvas.width = sz.w; canvas.height = sz.h;
      canvas.style.display = 'none';
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(imgEl, 0, 0, sz.w, sz.h);
      document.body.appendChild(canvas);

      var stream = canvas.captureStream(15);
      var video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.style.display = 'none';
      document.body.appendChild(video);

      // 双向同步小窗原生播放/暂停按钮
      video.addEventListener('pause', function () {
        if (S._pipToggling || !isPipActive()) return;
        if (S.playing) setPlaying(false);
      });
      video.addEventListener('play', function () {
        if (S._pipToggling || !isPipActive()) return;
        if (!S.playing) setPlaying(true);
      });

      video.addEventListener('leavepictureinpicture', function () {
        try { video.remove(); } catch (x) {}
        try { canvas.remove(); } catch (x) {}
        if (S.videoPip === video) {
          S.videoPip = null;
          S.videoPipCanvas = null;
          S.videoPipCtx = null;
          S.pipWin = null;
        }
        var btn = $('btnPip');
        if (btn) btn.className = 'cbtn';
      });

      bindMediaSession();
      video.play().then(function () {
        return video.requestPictureInPicture();
      }).then(function (pipWin) {
        S.videoPip = video;
        S.videoPipCanvas = canvas;
        S.videoPipCtx = ctx;
        S.pipWin = pipWin || null;
        if (pipWin && pipWin.addEventListener) {
          pipWin.addEventListener('resize', function () {
            // 忽略程序切图主动改 canvas 尺寸引发的 resize，只记录用户手动拖拽的尺寸
            if (Date.now() - S._pipSyncAt < 450) return;
            if (pipWin.width > 0 && pipWin.height > 0) {
              var a = Math.round(pipWin.width * pipWin.height);
              if (a >= 160 * 160 && a <= 1600 * 1200) {
                S.pipArea = a;
                try { localStorage.setItem('lumina_pip_area', String(a)); } catch (e) {}
              }
            }
          });
        }
        var btn = $('btnPip');
        if (btn) btn.className = 'cbtn on';
        startWatchdog();
        toast('已开启画中画', 1400);
      }).catch(function (e) {
        try { video.remove(); canvas.remove(); } catch (x) {}
        toast('画中画启动失败：' + ((e && e.message) || '请重试'), 2600);
      });
    } catch (e) {
      toast('画中画不可用：' + (e.message || '未知'), 3000);
    }
  }

  function syncVideoPip(imgEl) {
    if (!S.videoPip || !S.videoPipCanvas || !imgEl || !imgEl.complete || !imgEl.naturalWidth) return;
    var c = S.videoPipCanvas;
    var nw = imgEl.naturalWidth || 1080;
    var nh = imgEl.naturalHeight || 1080;
    var sz = calcBalancedSize(nw, nh);
    if (c.width !== sz.w || c.height !== sz.h) {
      S._pipSyncAt = Date.now();
      try { c.width = sz.w; c.height = sz.h; } catch (e) {}
    }
    var ctx = c.getContext('2d');
    S.videoPipCtx = ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    var s = Math.min(c.width / nw, c.height / nh);
    var dw = nw * s, dh = nh * s;
    ctx.drawImage(imgEl, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  }

  function closePip() {
    if (S.videoPip) {
      try { document.exitPictureInPicture && document.exitPictureInPicture(); } catch (x) {}
      try { S.videoPip.remove(); } catch (x) {}
      try { S.videoPipCanvas && S.videoPipCanvas.remove(); } catch (x) {}
      S.videoPip = null; S.videoPipCanvas = null; S.videoPipCtx = null;
    }
    var btn = $('btnPip');
    if (btn) btn.className = 'cbtn';
    syncBodyClasses();
    toast('已关闭画中画', 1200);
  }

  // ---------- WebSocket 实时同步 ----------
  function connectWS() {
    if (typeof WebSocket === 'undefined') return;
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws = new WebSocket(proto + '//' + location.host);
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.type === 'config') {
            if (m.interval) setInterval2(m.interval, true);
            if (m.transition) S.transition = m.transition;
            if (typeof m.showInfo === 'boolean') S.showInfo = m.showInfo;
            if (typeof m.ambientBg === 'boolean') {
              S.ambientBg = m.ambientBg;
              if (ambientEl && !S.ambientBg) ambientEl.className = '';
            }
            if (m.prefetch) S.prefetch = m.prefetch;
          } else if (m.type === 'favorite' && S.currentMeta && S.currentMeta.id === m.id) {
            S.currentMeta.isFavorite = !!m.isFavorite;
            updateFavBtn(!!m.isFavorite);
          } else if (m.type === 'filter' && m.filter) {
            S.filter = m.filter;
            S.poolTotal = m.poolTotal || 0;
            S.buffer = [];
            updateFilterBadge();
          }
        } catch (e) {}
      };
      ws.onclose = function () { setTimeout(connectWS, 5000); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    } catch (e) {}
  }

  // ---------- 事件绑定 ----------
  document.addEventListener('mousemove', showUI);
  document.addEventListener('touchstart', showUI, { passive: true });

  // 触屏左右滑动切换
  var touchX = 0, touchY = 0;
  var stageEl = $('stage');
  if (stageEl) {
    stageEl.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches.length === 1) {
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
      }
    }, { passive: true });
    stageEl.addEventListener('touchend', function (e) {
      if (!e.changedTouches || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - touchX;
      var dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) next();
        else prev();
      }
    }, { passive: true });
  }

  var bind = function (id, fn) {
    var el = $(id);
    if (el) el.onclick = fn;
  };

  bind('btnPlay', function () { setPlaying(!S.playing); });
  bind('btnNext', function () { next(); });
  bind('btnPrev', prev);
  bind('btnFaster', function () { setInterval2(S.interval - 2); });
  bind('btnSlower', function () { setInterval2(S.interval + 2); });
  bind('btnFav', toggleFavorite);
  bind('btnFilter', openDrawer);
  bind('btnCloseDrawer', closeDrawer);
  bind('btnInfoToggle', function () {
    S.infoHiddenManual = !S.infoHiddenManual;
    var bi = $('btnInfoToggle');
    if (bi) bi.className = S.infoHiddenManual ? 'cbtn' : 'cbtn on';
    syncBodyClasses();
    showUI();
  });
  bind('btnPip', togglePip);
  bind('btnAdmin', function () { location.href = '/admin'; });
  bind('btnHelp', function () {
    if (!helpModal) return;
    helpModal.className = helpModal.className.indexOf('hidden') >= 0 ? 'modal' : 'modal hidden';
    syncBodyClasses();
  });
  bind('btnCloseHelp', function () {
    if (helpModal) helpModal.className = 'modal hidden';
    syncBodyClasses();
  });

  bind('lblInterval', function () {
    if (!ivlMenu) return;
    var isHidden = ivlMenu.className.indexOf('hidden') >= 0;
    ivlMenu.className = isHidden ? 'popover' : 'popover hidden';
    var items = ivlMenu.querySelectorAll('.pop-item');
    for (var i = 0; i < items.length; i++) {
      var val = parseInt(items[i].getAttribute('data-ivl'), 10);
      items[i].className = val === S.interval ? 'pop-item active' : 'pop-item';
      items[i].onclick = function () {
        setInterval2(parseInt(this.getAttribute('data-ivl'), 10));
        ivlMenu.className = 'popover hidden';
      };
    }
  });

  bind('fltAll', function () {
    applyFilter({ sourceId: S.filter.sourceId, album: S.filter.album, onlyFavorites: false });
  });
  bind('fltFav', function () {
    applyFilter({ sourceId: S.filter.sourceId, album: S.filter.album, onlyFavorites: true });
  });
  bind('btnClearFilterEmpty', function () {
    applyFilter({ sourceId: '', album: '', onlyFavorites: false });
  });

  var fltSrc = $('fltSource');
  if (fltSrc) fltSrc.onchange = function () { loadAlbums(); };
  var fltSearch = $('fltSearch');
  if (fltSearch) {
    var searchT = null;
    fltSearch.oninput = function () {
      clearTimeout(searchT);
      searchT = setTimeout(loadAlbums, 220);
    };
  }

  bind('btnFull', function () {
    if (!document.fullscreenElement) {
      var d = document.documentElement;
      var fn = d.requestFullscreen || d.webkitRequestFullscreen || d.mozRequestFullScreen;
      if (fn) fn.call(d);
    } else {
      var ef = document.exitFullscreen || document.webkitExitFullscreen;
      if (ef) ef.call(document);
    }
  });

  // 键盘 / 遥控器
  document.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    var k = e.key, code = e.keyCode;
    if (k === ' ' || k === 'Spacebar' || code === 32 || code === 13) {
      setPlaying(!S.playing); e.preventDefault();
    } else if (k === 'ArrowRight' || code === 39) { next(); e.preventDefault(); }
    else if (k === 'ArrowLeft' || code === 37) { prev(); e.preventDefault(); }
    else if (k === 'ArrowUp' || code === 38) { setInterval2(S.interval - 2); e.preventDefault(); }
    else if (k === 'ArrowDown' || code === 40) { setInterval2(S.interval + 2); e.preventDefault(); }
    else if (k === 'p' || k === 'P') { togglePip(); e.preventDefault(); }
    else if (k === 'l' || k === 'L') { toggleFavorite(); e.preventDefault(); }
    else if (k === 'g' || k === 'G') { openDrawer(); e.preventDefault(); }
    else if (k === 'i' || k === 'I') { var bi = $('btnInfoToggle'); if (bi) bi.onclick(); e.preventDefault(); }
    else if (k === '?' || k === 'h' || k === 'H') { var bh = $('btnHelp'); if (bh) bh.onclick(); e.preventDefault(); }
    else if (k === 'f' || k === 'F') { var bf = $('btnFull'); if (bf) bf.onclick(); }
    else if (k === 'Escape') {
      if (helpModal && helpModal.className.indexOf('hidden') < 0) {
        helpModal.className = 'modal hidden'; syncBodyClasses();
      } else if (drawer && drawer.className.indexOf('hidden') < 0) {
        closeDrawer();
      } else {
        location.href = '/admin';
      }
    }
    showUI();
  });

  document.addEventListener('visibilitychange', function () {
    if (S.playing) {
      S.startedAt = Date.now();
      scheduleNext();
      startWatchdog();
    }
  });

  // ---------- 启动 ----------
  var hintShown = false;

  api('GET', '/api/state')
    .then(function (s) {
      S.playing = s.playing !== false;
      S.interval = s.interval || 8;
      S.transition = s.transition || 'fade';
      S.showInfo = s.showInfo !== false;
      S.ambientBg = s.ambientBg !== false;
      S.prefetch = Math.max(1, Math.min(4, s.prefetch || 2));
      S.total = s.total || 0;
      S.poolTotal = s.poolTotal || 0;
      if (s.filter) S.filter = s.filter;

      if (lblInterval) lblInterval.textContent = S.interval + 's';
      var bi = $('btnInfoToggle');
      if (bi) bi.className = S.infoHiddenManual ? 'cbtn' : 'cbtn on';
      updateFilterBadge();
      updatePlayBtn(S.playing);
      connectWS();

      if (!S.poolTotal) { showEmpty(s); return; }

      S.booted = true;
      keepFilling();
      if (s.current && s.current.img) {
        showItem(s.current);
      } else {
        next();
      }

      if (hintEl && !hintShown) {
        hintShown = true;
        setTimeout(function () {
          hintEl.className = 'show';
          setTimeout(function () { hintEl.className = ''; }, 5000);
        }, 1400);
      }
    })
    .catch(function (e) {
      if (emptyEl) {
        emptyEl.className = '';
        emptyEl.innerHTML =
          '<div class="empty-icon">⚠</div>' +
          '<h2>连接失败</h2>' +
          '<p>' + esc(e.message) + '</p>' +
          '<a class="btn-go" href="/">重试</a>';
      }
    });
})();
