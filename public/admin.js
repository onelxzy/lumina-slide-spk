'use strict';
(function () {
  var CFG = null;
  var STATS = null;
  var dirty = false;
  var $ = function (id) { return document.getElementById(id); };

  function api(method, p, body) {
    var opt = { method: method, headers: {} };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(p, opt).then(function (r) {
      if (r.status === 401) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname);
        throw new Error('未登录');
      }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var toastT = null;
  function toast(msg, isErr) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show' + (isErr ? ' err' : '');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () { t.className = isErr ? 'err' : ''; }, 2200);
  }

  function banner(msg, isErr) {
    var b = $('banner');
    if (!b) return;
    if (!msg) { b.className = 'banner hidden'; return; }
    b.className = 'banner ' + (isErr ? 'err' : 'ok');
    b.textContent = msg;
    if (!isErr) setTimeout(function () { b.className = 'banner hidden'; }, 3000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setDirty(v) {
    dirty = !!v;
    var db = $('dirtyBadge');
    if (db) db.className = dirty ? 'dirty-badge' : 'dirty-badge hidden';
  }

  // ---------------------------------------------------- Tab 切换
  var navItems = document.querySelectorAll('.nav-item');
  for (var ni = 0; ni < navItems.length; ni++) {
    navItems[ni].onclick = function () {
      var tab = this.getAttribute('data-tab');
      for (var j = 0; j < navItems.length; j++) {
        navItems[j].className = navItems[j] === this ? 'nav-item active' : 'nav-item';
      }
      var panels = document.querySelectorAll('.tab-panel');
      for (var k = 0; k < panels.length; k++) {
        panels[k].className = panels[k].id === ('tab-' + tab) ? 'tab-panel active' : 'tab-panel';
      }
    };
  }

  // ---------------------------------------------------- 渲染状态
  function renderStats(s) {
    STATS = s;
    var box = $('stats');
    if (!box) return;
    var html = '';
    function item(k, v, cls) {
      html += '<div class="stat-item"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>';
    }
    item('已索引图片', (s.files || 0).toLocaleString(), s.files ? 'ok' : 'warn');
    item('相册数', (s.albums || 0).toLocaleString());
    item('已收藏', (s.favorites || 0).toLocaleString());
    item('黑名单', s.blacklist || 0, s.blacklist ? 'warn' : '');
    item('内存缓存', (s.cacheMem || 0) + ' 张 (' + (s.cacheMemMB || 0) + ' MB)');
    item('磁盘缓存', s.diskCacheEnabled ? ((s.cacheDiskMB || 0) + ' MB') : '已关闭');
    item('缓存命中率', (s.hitRate || 0) + '%');
    item('在线客户端', s.clients || 0);
    if (s.randomizer) {
      item('洗牌进度', s.randomizer.pos + ' / ' + s.randomizer.total);
    }
    box.innerHTML = html;
  }

  // ---------------------------------------------------- 来源
  function sourceCount(id) {
    if (!STATS || !STATS.bySource) return 0;
    for (var i = 0; i < STATS.bySource.length; i++) {
      if (STATS.bySource[i].source_id === id) return STATS.bySource[i].c;
    }
    return 0;
  }

  function renderSources(sources) {
    var box = $('sources');
    if (!box) return;
    box.innerHTML = '';
    if (!sources.length) {
      box.innerHTML = '<div class="hint">暂无数据来源，请点击下方按钮添加本地目录或 WebDAV。</div>';
      return;
    }
    sources.forEach(function (s, i) {
      var d = document.createElement('div');
      d.className = 'source-item';
      d.dataset.idx = i;
      var isDav = s.type === 'webdav';
      var cnt = sourceCount(s.id);

      var h = '<div class="source-head">' +
        '<label class="inline" style="margin:0"><input type="checkbox" class="src-enabled" ' +
        (s.enabled !== false ? 'checked' : '') + '></label>' +
        '<span class="src-id">' + esc(s.id) + '</span>' +
        '<span class="type-badge ' + (isDav ? 'webdav' : '') + '">' + (isDav ? 'WebDAV' : '本地') + '</span>' +
        '<span class="count-badge">' + cnt.toLocaleString() + ' 张</span>' +
        '<span class="src-actions">' +
        '<button class="btn btn-small src-test" type="button">测试</button>' +
        '<button class="btn btn-small btn-danger src-del" type="button">删除</button>' +
        '</span></div>';

      h += '<div class="grid2">';
      h += '<label>ID<input type="text" class="f-id" value="' + esc(s.id) + '"></label>';
      h += '<label>根路径<input type="text" class="f-root" value="' + esc(s.root) + '" placeholder="' + (isDav ? '/photos' : '/volume1/photos') + '"></label>';
      h += '</div>';

      if (isDav) {
        h += '<div class="grid2">';
        h += '<label>WebDAV 地址<input type="text" class="f-url" value="' + esc(s.url || '') + '" placeholder="http://127.0.0.1:5005/dav"></label>';
        h += '<label>用户名<input type="text" class="f-user" value="' + esc(s.username || '') + '"></label>';
        h += '</div>';
        h += '<label>密码<input type="password" class="f-pass" value="' + esc(s.password || '') + '"></label>';
      }

      h += '<div class="src-result hint"></div>';
      d.innerHTML = h;

      d.querySelector('.src-del').onclick = function () {
        if (!confirm('确认删除该数据来源？')) return;
        d.remove();
        collectAndSave(true);
      };

      d.querySelector('.src-test').onclick = function () {
        var src = readSource(d);
        var out = d.querySelector('.src-result');
        out.textContent = '测试中…';
        api('POST', '/api/sources/test', { source: src }).then(function (r) {
          if (r.ok) {
            out.innerHTML = '✅ 连接成功，耗时 ' + r.ms + 'ms，目录下共 ' + r.count + ' 项：' +
              esc(r.sample.map(function (x) { return x.name + (x.isDir ? '/' : ''); }).join(', ').slice(0, 160));
          } else {
            out.innerHTML = '❌ 连接失败：' + esc(r.error);
          }
        }).catch(function (e) { out.innerHTML = '❌ ' + esc(e.message); });
      };

      box.appendChild(d);
    });
  }

  function readSource(el) {
    var o = {
      id: el.querySelector('.f-id').value.trim() || ('src-' + Date.now()),
      type: el.querySelector('.type-badge').classList.contains('webdav') ? 'webdav' : 'local',
      enabled: el.querySelector('.src-enabled').checked,
      root: el.querySelector('.f-root').value.trim(),
    };
    if (o.type === 'webdav') {
      o.url = el.querySelector('.f-url').value.trim();
      o.username = el.querySelector('.f-user').value.trim();
      o.password = el.querySelector('.f-pass').value;
    }
    return o;
  }

  function collectSources() {
    var out = [];
    var items = document.querySelectorAll('.source-item');
    for (var i = 0; i < items.length; i++) out.push(readSource(items[i]));
    return out;
  }

  function makeSource(type) {
    var item = {
      id: type + '-' + Date.now().toString().slice(-5),
      type: type, enabled: true,
      root: type === 'local' ? '/volume1/photos' : '/photos',
    };
    if (type === 'webdav') { item.url = 'http://127.0.0.1:5005/dav'; item.username = ''; item.password = ''; }
    var cur = collectSources();
    cur.push(item);
    renderSources(cur);
    setDirty(true);
  }

  $('addLocal').onclick = function () { makeSource('local'); };
  $('addWebdav').onclick = function () { makeSource('webdav'); };

  // ---------------------------------------------------- 表单读写
  function fillForm(c) {
    var i = c.image, p = c.play, sc = c.scan, ca = c.cache;
    $('imgW').value = i.maxWidth;
    $('imgH').value = i.maxHeight;
    $('imgFormat').value = i.format;
    $('imgQuality').value = i.format === 'jpeg' ? 92 : i.quality;
    $('qualityVal').textContent = $('imgQuality').value;
    $('imgScaler').value = i.scaler;
    $('imgConcurrency').value = i.concurrency;
    $('allowUpscale').checked = !!i.allowUpscale;

    $('playInterval').value = p.interval;
    $('playMode').value = p.mode;
    $('playRestart').value = p.onRestart;
    $('playFairness').value = p.fairness;
    $('playTransition').value = p.transition;
    $('playPrefetch').value = p.prefetch;
    $('playShowInfo').checked = !!p.showInfo;
    $('playAmbientBg').checked = p.ambientBg !== false;

    $('scanCommit').value = sc.commitEvery;
    $('scanPauseEvery').value = sc.pauseEveryDirs;
    $('scanPauseMs').value = sc.pauseMs;
    $('scanMinSize').value = sc.minSize;
    $('scanIncremental').checked = !!sc.incremental;
    $('scanSkipHidden').checked = !!sc.skipHidden;

    var sv = c.server || {};
    $('httpPort').value = sv.port || 18666;

    var au = c.auth || {};
    $('authEnabled').checked = !!au.enabled;
    $('authUsername').value = au.username || 'admin';
    $('authNewPassword').value = '';
    var btnLogout = $('btnLogout');
    if (btnLogout) btnLogout.className = au.enabled ? 'btn btn-ghost' : 'btn btn-ghost hidden';
    var warnEl = $('authWarnTip');
    if (warnEl) {
      if (au.enabled && au.isDefaultCredentials) {
        warnEl.innerHTML = '⚠ 当前仍在使用默认账号密码（<code>admin</code> / <code>admin</code>），内网可忽略，公网部署建议修改密码。';
        warnEl.className = 'hint tip-box';
      } else {
        warnEl.className = 'hint tip-box hidden';
      }
    }

    $('cacheMemItems').value = ca.memoryItems;
    $('cacheMemMaxMB').value = ca.memoryMaxMB || 64;
    $('cacheDiskEnabled').checked = !!ca.diskEnabled;
    $('cacheDiskMB').value = ca.diskMaxMB;
    $('cacheDiskMB').disabled = !ca.diskEnabled;

    renderSources(c.sources || []);
    renderScanSourceSel(c.sources || []);
    setDirty(false);
  }

  function renderScanSourceSel(sources) {
    var sel = $('scanSourceSel');
    if (!sel) return;
    sel.innerHTML = '<option value="">全部来源</option>';
    sources.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.id;
      sel.appendChild(o);
    });
  }

  function buildPatch() {
    var c = CFG ? JSON.parse(JSON.stringify(CFG)) : {};
    var fmt = $('imgFormat').value;
    var q = parseInt($('imgQuality').value, 10);

    c.image = c.image || {};
    c.image.maxWidth = parseInt($('imgW').value, 10) || 1920;
    c.image.maxHeight = parseInt($('imgH').value, 10) || 1080;
    c.image.format = fmt;
    if (fmt === 'jpeg') c.image.jpegQuality = Math.max(1, Math.round(31 - (q - 60) * 0.3 * 0.99));
    else c.image.quality = q;
    c.image.scaler = $('imgScaler').value;
    c.image.concurrency = parseInt($('imgConcurrency').value, 10) || 2;
    c.image.allowUpscale = $('allowUpscale').checked;

    c.play = c.play || {};
    c.play.interval = parseInt($('playInterval').value, 10) || 8;
    c.play.mode = $('playMode').value;
    c.play.onRestart = $('playRestart').value;
    c.play.fairness = $('playFairness').value;
    c.play.transition = $('playTransition').value;
    c.play.prefetch = parseInt($('playPrefetch').value, 10) || 2;
    c.play.showInfo = $('playShowInfo').checked;
    c.play.ambientBg = $('playAmbientBg').checked;

    c.scan = c.scan || {};
    c.scan.commitEvery = parseInt($('scanCommit').value, 10) || 500;
    c.scan.pauseEveryDirs = parseInt($('scanPauseEvery').value, 10) || 0;
    c.scan.pauseMs = parseInt($('scanPauseMs').value, 10) || 0;
    c.scan.minSize = parseInt($('scanMinSize').value, 10) || 0;
    c.scan.incremental = $('scanIncremental').checked;
    c.scan.skipHidden = $('scanSkipHidden').checked;

    c.server = c.server || {};
    c.server.port = parseInt($('httpPort').value, 10) || 18666;

    c.auth = {
      enabled: $('authEnabled').checked,
      username: $('authUsername').value.trim() || 'admin',
      newPassword: $('authNewPassword').value,
    };

    c.cache = c.cache || {};
    c.cache.memoryItems = parseInt($('cacheMemItems').value, 10) || 200;
    c.cache.memoryMaxMB = parseInt($('cacheMemMaxMB').value, 10) || 64;
    c.cache.diskEnabled = $('cacheDiskEnabled').checked;
    c.cache.diskMaxMB = parseInt($('cacheDiskMB').value, 10) || 4096;

    c.sources = collectSources();
    return c;
  }

  var saving = false;
  function collectAndSave(silent) {
    if (saving) return;
    saving = true;
    var cfg = buildPatch();
    api('POST', '/api/config', { config: cfg }).then(function (r) {
      CFG = r.config;
      if (r.stats) renderStats(r.stats);
      fillForm(r.config);
      if (!silent) toast('已保存并生效');
      refreshPreview();
    }).catch(function (e) {
      toast('保存失败: ' + e.message, true);
    }).then(function () { saving = false; });
  }

  $('save').onclick = function () { collectAndSave(false); };

  var btnLogout = $('btnLogout');
  if (btnLogout) {
    btnLogout.onclick = function () {
      api('POST', '/api/auth/logout').then(function () {
        location.href = '/login';
      }).catch(function () {});
    };
  }

  var mainEl = document.querySelector('main');
  if (mainEl) {
    mainEl.addEventListener('input', function () { setDirty(true); });
    mainEl.addEventListener('change', function () { setDirty(true); });
  }
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      collectAndSave(false);
    }
  });

  // ---------------------------------------------------- 预览
  function refreshPreview() {
    var img = $('previewImg');
    var empty = $('previewEmpty');
    var meta = $('previewMeta');
    if (!CFG || !img || !meta) return;
    if (!STATS || !STATS.files) {
      img.className = 'hidden';
      if (empty) { empty.className = 'preview-empty'; empty.textContent = '暂无预览图像，请先完成图库扫描'; }
      meta.textContent = '';
      return;
    }
    meta.textContent = '生成中…';
    img.src = '/api/preview?t=' + Date.now();
    img.onload = function () {
      img.className = '';
      if (empty) empty.className = 'preview-empty hidden';
      fetch('/api/preview', { method: 'HEAD' }).then(function (r) {
        var len = parseInt(r.headers.get('Content-Length') || '0', 10);
        var kb = len ? (' · ' + (len / 1024).toFixed(1) + ' KB') : '';
        meta.textContent = '输出尺寸: ' + img.naturalWidth + '×' + img.naturalHeight + kb;
      }).catch(function () {
        meta.textContent = '输出尺寸: ' + img.naturalWidth + '×' + img.naturalHeight;
      });
    };
    img.onerror = function () {
      img.className = 'hidden';
      if (empty) { empty.className = 'preview-empty'; empty.textContent = '暂无预览图像，请先完成图库扫描'; }
      meta.textContent = '';
    };
  }
  $('btnPreview').onclick = refreshPreview;

  document.querySelectorAll('.presets .btn').forEach(function (b) {
    b.onclick = function () {
      $('imgW').value = b.dataset.w;
      $('imgH').value = b.dataset.h;
      collectAndSave(true);
    };
  });

  $('imgQuality').oninput = function () { $('qualityVal').textContent = this.value; };
  $('imgFormat').onchange = function () { $('qualityVal').textContent = $('imgQuality').value; };

  $('btnReshuffle').onclick = function () {
    api('POST', '/api/reshuffle').then(function (r) {
      toast('已重洗，共 ' + r.progress.total + ' 张');
      loadAll();
    }).catch(function (e) { toast(e.message, true); });
  };

  function clearCache() {
    api('POST', '/api/cache/clear').then(function () { toast('缓存已清空'); loadAll(); })
      .catch(function (e) { toast(e.message, true); });
  }
  $('btnClearCache').onclick = clearCache;
  $('btnClearCacheQuick').onclick = clearCache;

  $('btnClearBlack').onclick = function () {
    api('DELETE', '/api/blacklist').then(function () { toast('黑名单已清空'); loadAll(); })
      .catch(function (e) { toast(e.message, true); });
  };

  // ---------------------------------------------------- 黑名单
  function renderBlacklist(r) {
    var box = $('blacklist');
    if (!box) return;
    if (!r.items || !r.items.length) {
      box.innerHTML = '<div class="hint">暂无失败记录</div>';
      return;
    }
    box.innerHTML = '';
    r.items.forEach(function (b) {
      var row = document.createElement('div');
      row.className = 'black-item';
      row.innerHTML = '<div><div>' + esc(b.path) + '</div>' +
        '<span class="reason">' + esc(b.source_id) + ' · ' + esc(b.reason) + '</span></div>' +
        '<button class="btn btn-small" type="button">移除</button>';
      row.querySelector('button').onclick = function () {
        api('POST', '/api/blacklist/remove', { source_id: b.source_id, path: b.path })
          .then(function () { toast('已从黑名单移除'); loadAll(); })
          .catch(function (e) { toast(e.message, true); });
      };
      box.appendChild(row);
    });
  }

  // ---------------------------------------------------- 扫描
  var scanPoll = null;
  function updateScanUI(s) {
    var running = s.running;
    var bar = $('scanBar');
    if (bar) {
      if (s.phase === 'scanning') { bar.className = 'indet'; bar.style.width = ''; }
      else { bar.className = ''; bar.style.width = s.phase === 'idle' ? '0%' : '100%'; }
    }
    var txt = '';
    if (s.phase === 'idle') txt = '尚未扫描';
    else if (s.phase === 'scanning') txt = '扫描中… 目录 ' + s.dirsScanned + '，入库 ' + s.filesAdded + '，跳过 ' + s.dirsSkipped + '，清理 ' + (s.filesRemoved || 0) + '，错误 ' + s.errors;
    else if (s.phase === 'done') txt = '✅ 扫描完成：目录 ' + s.dirsScanned + '，入库 ' + s.filesAdded + '，跳过 ' + s.dirsSkipped + '，清理 ' + (s.filesRemoved || 0) + '，错误 ' + s.errors + '，耗时 ' + Math.round(s.elapsedMs / 1000) + 's';
    else if (s.phase === 'cancelled') txt = '已取消';
    else if (s.phase === 'error') txt = '❌ 扫描出错：' + s.message;

    $('scanInfo').textContent = txt;
    $('scanPath').textContent = s.currentPath || '';
    $('btnScanInc').disabled = running;
    $('btnScanFull').disabled = running;
    $('btnScanCancel').disabled = !running;
  }

  function startScan(full) {
    var body = { full: !!full };
    if ($('scanOne').checked && $('scanSourceSel').value) body.sourceId = $('scanSourceSel').value;
    api('POST', '/api/scan', body).then(function () {
      toast(full ? '全量扫描已启动' : '增量扫描已启动');
      if (!scanPoll) scanPoll = setInterval(pollScan, 1500);
    }).catch(function (e) { toast(e.message, true); });
  }
  $('btnScanInc').onclick = function () { startScan(false); };
  $('btnScanFull').onclick = function () {
    if (!confirm('全量重建会重新遍历所有目录，耗时较长。确定继续？')) return;
    startScan(true);
  };
  $('btnScanCancel').onclick = function () {
    api('POST', '/api/scan/cancel').then(function () { toast('已请求取消'); }).catch(function () {});
  };
  $('scanOne').onchange = function () { $('scanSourceSel').disabled = !this.checked; };

  function pollScan() {
    api('GET', '/api/scan/status').then(function (s) {
      updateScanUI(s);
      if (!s.running) {
        clearInterval(scanPoll); scanPoll = null;
        loadAll();
      }
    }).catch(function () {});
  }

  var _cd = $('cacheDiskEnabled');
  if (_cd) _cd.onchange = function () { $('cacheDiskMB').disabled = !this.checked; };

  // ---------------------------------------------------- WebSocket
  function connectWS() {
    if (typeof WebSocket === 'undefined') return;
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws = new WebSocket(proto + '//' + location.host);
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.type === 'scan' && m.status) {
            updateScanUI(m.status);
            if (!m.status.running) loadAll();
          }
        } catch (e) {}
      };
      ws.onclose = function () { setTimeout(connectWS, 5000); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    } catch (e) {}
  }

  // ---------------------------------------------------- 载入
  function loadAll() {
    return api('GET', '/api/config').then(function (r) {
      CFG = r.config;
      renderStats(r.stats);
      fillForm(r.config);
      banner(null);
      return api('GET', '/api/blacklist').then(renderBlacklist).catch(function () {});
    }).catch(function (e) {
      banner('载入配置失败: ' + e.message, true);
    });
  }

  loadAll().then(function () {
    connectWS();
    api('GET', '/api/scan/status').then(function (s) {
      updateScanUI(s);
      if (s.running) scanPoll = setInterval(pollScan, 1500);
    }).catch(function () {});
    setTimeout(refreshPreview, 400);
    setInterval(function () {
      api('GET', '/api/stats').then(renderStats).catch(function () {});
    }, 5000);
  });
})();
