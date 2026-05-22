let currentPreview = null;
let selectedUsb = null;
let dlPanelOpen = false;

// ─── Init ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSearch();
  initLibrary();
  initUsb();
  initPreviewModal();
  connectDlStream();
  loadLibrary();
});

// ─── Tabs ───────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'library') loadLibrary();
      if (btn.dataset.tab === 'usb') listUsbDevices();
    });
  });
}

// ─── Toast ──────────────────────────────────────────────────────────

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.add('show');
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── Search ─────────────────────────────────────────────────────────

function initSearch() {
  const input = document.getElementById('searchInput');
  const btn = document.getElementById('searchBtn');

  function doSearch() {
    const q = input.value.trim();
    if (!q) return;
    btn.classList.add('loading');
    btn.disabled = true;
    document.getElementById('results').innerHTML = '<div class="empty-state"><div class="spinner"></div><p>Araniyor...</p></div>';

    fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    })
      .then(r => r.json())
      .then(data => renderResults(data.results))
      .catch(() => showToast('Arama hatasi', 'error'))
      .finally(() => {
        btn.classList.remove('loading');
        btn.disabled = false;
      });
  }

  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}

function renderResults(results) {
  const container = document.getElementById('results');
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>Sonuc bulunamadi</p></div>';
    return;
  }

  container.innerHTML = results.map(v => `
    <div class="result-card">
      <img src="${v.thumbnail}" alt="" loading="lazy">
      <div class="result-info">
        <h3>${esc(v.title)}</h3>
        <p>${esc(v.author)} - ${v.durationStr}</p>
      </div>
      <div class="result-actions">
        <button class="btn-icon btn-preview" onclick="openPreview('${v.id}','${esc(v.title)}','${esc(v.author)}')">Dinle</button>
        <button class="btn-icon btn-download" onclick="startDownload('${v.id}','${esc(v.title)}',this)">Indir</button>
      </div>
    </div>
  `).join('');
}

// ─── Preview ────────────────────────────────────────────────────────

function openPreview(videoId, title, author) {
  currentPreview = { videoId, title, author };
  const modal = document.getElementById('previewModal');
  document.getElementById('previewInfo').innerHTML = `<h3>${esc(title)}</h3><p>${esc(author)}</p>`;
  document.getElementById('previewAudio').src = '';
  document.getElementById('previewProgress').classList.remove('active');
  document.getElementById('downloadFromPreview').onclick = () => startDownload(videoId, title, document.getElementById('downloadFromPreview'));
  document.getElementById('downloadFromPreview').style.display = 'block';
  document.getElementById('downloadFromPreview').disabled = false;
  document.getElementById('downloadFromPreview').textContent = 'Indir';
  modal.classList.add('show');

  fetch(`/api/preview-url/${videoId}`)
    .then(r => r.json())
    .then(data => {
      if (data.audioUrl) {
        document.getElementById('previewAudio').src = data.audioUrl;
        document.getElementById('previewAudio').play().catch(() => {});
      }
    })
    .catch(() => showToast('Preview alinamadi', 'error'));
}

function initPreviewModal() {
  const modal = document.getElementById('previewModal');
  modal.querySelector('.close-btn').addEventListener('click', closePreview);
  modal.addEventListener('click', e => { if (e.target === modal) closePreview(); });
}

function closePreview() {
  document.getElementById('previewModal').classList.remove('show');
  document.getElementById('previewAudio').pause();
}

// ─── Download Manager ───────────────────────────────────────────────

const dlState = new Map();

function startDownload(videoId, title, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '...';
  }
  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, title }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.downloadId) {
        showToast('Indirme basladi', 'success');
      } else {
        showToast('Indirme baslatilamadi', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Indir'; }
      }
    })
    .catch(() => {
      showToast('Indirme hatasi', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Indir'; }
    });
}

function connectDlStream() {
  const es = new EventSource('/api/downloads/stream');

  es.addEventListener('init', e => {
    const list = JSON.parse(e.data);
    for (const dl of list) {
      dlState.set(dl.id, dl);
    }
    updateDlUI();
  });

  es.addEventListener('download-start', e => {
    const dl = JSON.parse(e.data);
    dl.progress = 0;
    dl.speed = null;
    dl.eta = null;
    dl.totalSize = null;
    dl.status = 'downloading';
    dlState.set(dl.id, dl);
    updateDlUI();
    openDlPanel();
  });

  es.addEventListener('download-progress', e => {
    const data = JSON.parse(e.data);
    const dl = dlState.get(data.id);
    if (dl) {
      dl.progress = data.progress;
      dl.speed = data.speed;
      dl.eta = data.eta;
      dl.totalSize = data.totalSize;
      updateDlUI();
    }
  });

  es.addEventListener('download-complete', e => {
    const data = JSON.parse(e.data);
    const dl = dlState.get(data.id);
    if (dl) {
      dl.status = 'completed';
      dl.progress = 100;
      dl.filename = data.filename;
      dl.sizeMB = data.sizeMB;
      updateDlUI();
      showToast(`${data.filename} indirildi (${data.sizeMB} MB)`, 'success');
    }
  });

  es.addEventListener('download-error', e => {
    const data = JSON.parse(e.data);
    const dl = dlState.get(data.id);
    if (dl) {
      dl.status = 'error';
      dl.error = data.error;
      updateDlUI();
      showToast(`Hata: ${data.error}`, 'error');
    }
  });

  es.addEventListener('download-cancelled', e => {
    const data = JSON.parse(e.data);
    const dl = dlState.get(data.id);
    if (dl) {
      dl.status = 'cancelled';
      updateDlUI();
    }
  });

  es.onerror = () => {
    setTimeout(connectDlStream, 2000);
  };
}

function updateDlUI() {
  const active = [];
  const completed = [];
  for (const [id, dl] of dlState) {
    if (dl.status === 'downloading') active.push(dl);
    else completed.push(dl);
  }

  const total = active.length + completed.length;
  document.getElementById('dlBadge').textContent = active.length || '';

  const list = document.getElementById('dlList');
  if (total === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:20px"><p style="font-size:0.8rem">Aktif indirme yok</p></div>';
    document.getElementById('dlPanelCount').textContent = '0';
    return;
  }

  document.getElementById('dlPanelCount').textContent = `${active.length} aktif, ${completed.length} tamam`;

  const items = [...active, ...completed];
  list.innerHTML = items.map(dl => {
    const pct = Math.round(dl.progress || 0);
    const statusText = dl.status === 'downloading' ? `${pct}%` :
      dl.status === 'completed' ? 'Tamamlandi' :
      dl.status === 'cancelled' ? 'Iptal edildi' :
      dl.status === 'error' ? `Hata: ${dl.error || 'Bilinmiyor'}` : dl.status;

    const metaParts = [];
    if (dl.speed) metaParts.push(dl.speed);
    if (dl.eta) metaParts.push(`kalan: ${dl.eta}`);
    if (dl.sizeMB) metaParts.push(`${dl.sizeMB} MB`);
    if (dl.totalSize && !dl.sizeMB) metaParts.push(dl.totalSize);
    const meta = metaParts.join(' | ');

    const fillClass = dl.status === 'downloading' ? 'downloading' :
      dl.status === 'completed' ? 'completed' : 'error';

    const showCancel = dl.status === 'downloading';

    return `
      <div class="dl-item">
        <div class="dl-item-title">${esc(dl.title || dl.filename || 'Bilinmiyor')}</div>
        <div class="dl-item-progress">
          <div class="dl-item-progress-fill ${fillClass}" style="width:${pct}%"></div>
        </div>
        <div class="dl-item-footer">
          <div>
            <div class="dl-item-status">${statusText}</div>
            <div class="dl-item-meta">${meta}</div>
          </div>
          <div class="dl-item-actions">
            ${showCancel ? `<button class="dl-cancel-btn" onclick="cancelDownload('${dl.id}')">Durdur</button>` : ''}
            ${dl.status !== 'downloading' ? `<button class="dl-dismiss-btn" onclick="dismissDownload('${dl.id}')">×</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function cancelDownload(id) {
  fetch(`/api/download-cancel/${id}`, { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.success) showToast('Indirme durduruldu', '');
    })
    .catch(() => showToast('Durdurma hatasi', 'error'));
}

function dismissDownload(id) {
  fetch(`/api/downloads/${id}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        dlState.delete(id);
        updateDlUI();
      }
    })
    .catch(() => showToast('Silme hatasi', 'error'));
}

function toggleDlPanel() {
  if (dlPanelOpen) closeDlPanel();
  else openDlPanel();
}

function openDlPanel() {
  dlPanelOpen = true;
  document.getElementById('dlPanel').classList.add('open');
}

function closeDlPanel() {
  dlPanelOpen = false;
  document.getElementById('dlPanel').classList.remove('open');
}

// ─── Library ────────────────────────────────────────────────────────

function initLibrary() {
  document.getElementById('refreshLibBtn').addEventListener('click', loadLibrary);
}

function loadLibrary() {
  const container = document.getElementById('songList');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>Yukleniyor...</p></div>';

  fetch('/api/songs')
    .then(r => r.json())
    .then(data => {
      if (!data.songs || data.songs.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>Henuz sarki indirilmemis</p></div>';
        return;
      }
      container.innerHTML = data.songs.map(s => `
        <div class="song-item">
          <span class="song-name">${esc(s.filename.replace('.mp3', ''))}</span>
          <span class="song-meta">${s.sizeMB} MB</span>
          <div class="song-actions">
            <button class="btn-listen" onclick="listenLibSong('${esc(s.filename)}')">Dinle</button>
            <button class="btn-delete" onclick="deleteSong('${esc(s.filename)}')">Sil</button>
          </div>
        </div>
      `).join('');
    })
    .catch(() => {
      container.innerHTML = '<div class="empty-state"><p>Kutuphane yuklenemedi</p></div>';
    });
}

function listenLibSong(filename) {
  const modal = document.getElementById('previewModal');
  document.getElementById('previewInfo').innerHTML = `<h3>${esc(filename.replace('.mp3', ''))}</h3>`;
  document.getElementById('previewAudio').src = '/api/preview/' + encodeURIComponent(filename);
  document.getElementById('previewAudio').play().catch(() => {});
  document.getElementById('downloadFromPreview').style.display = 'none';
  modal.classList.add('show');
}

function deleteSong(filename) {
  if (!confirm(`${filename} silinsin mi?`)) return;
  fetch('/api/songs/' + encodeURIComponent(filename), { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        showToast(`${filename} silindi`, 'success');
        loadLibrary();
      }
    })
    .catch(() => showToast('Silme hatasi', 'error'));
}

// ─── USB ────────────────────────────────────────────────────────────

function initUsb() {
  listUsbDevices();
  document.getElementById('copyToUsbBtn').addEventListener('click', copyToUsb);
}

function listUsbDevices() {
  const container = document.getElementById('usbDevices');
  container.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>USB aygitlari taranıyor...</p></div>';

  fetch('/api/usb-devices')
    .then(r => r.json())
    .then(data => {
      if (!data.devices || data.devices.length === 0) {
        container.innerHTML = "<div class=\"empty-state\"><p>USB aygit bulunamadi. USB'nizi takin ve sayfayi yenileyin.</p></div>";
        document.getElementById('copyToUsbBtn').disabled = true;
        return;
      }
      container.innerHTML = data.devices.map((d, i) => `
        <label class="usb-device-item ${i === 0 ? 'selected' : ''}">
          <input type="radio" name="usbDevice" value="${d.mountPoint}" ${i === 0 ? 'checked' : ''}>
          <div>
            <strong>${d.label || 'USB Disk'}</strong><br>
            <small>${d.device} - ${d.size} - ${d.mountPoint}</small>
          </div>
        </label>
      `).join('');

      selectedUsb = data.devices[0]?.mountPoint || null;
      document.getElementById('copyToUsbBtn').disabled = !selectedUsb;

      container.querySelectorAll('input[name="usbDevice"]').forEach(radio => {
        radio.addEventListener('change', () => {
          container.querySelectorAll('.usb-device-item').forEach(el => el.classList.remove('selected'));
          radio.closest('.usb-device-item').classList.add('selected');
          selectedUsb = radio.value;
          document.getElementById('copyToUsbBtn').disabled = false;
        });
      });
    })
    .catch(() => {
      container.innerHTML = '<div class="empty-state"><p>USB aygitlari taranamadi</p></div>';
    });
}

function copyToUsb() {
  if (!selectedUsb) {
    showToast('Lutfen bir USB aygit secin', 'error');
    return;
  }

  const btn = document.getElementById('copyToUsbBtn');
  const status = document.getElementById('copyStatus');
  btn.disabled = true;
  btn.textContent = 'Kopyalaniyor...';
  status.className = 'info';
  status.textContent = 'Dosyalar kopyalaniyor...';
  status.style.display = 'block';

  fetch('/api/copy-to-usb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mountPoint: selectedUsb }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        status.className = 'success';
        status.textContent = `${data.copied}/${data.total} dosya kopyalandi! USB'nizi guvenle cikarabilirsiniz.`;
        if (data.errors) status.textContent += ' Hatalar: ' + data.errors.join(', ');
        showToast(`${data.copied} dosya kopyalandi`, 'success');
      } else {
        status.className = 'error';
        status.textContent = 'Hata: ' + (data.error || 'Bilinmiyor');
      }
    })
    .catch(() => {
      status.className = 'error';
      status.textContent = 'Kopyalama hatasi';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = "Secili USB'ye Kopyala";
    });
}

// ─── Helpers ────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/'/g, "\\'");
}
