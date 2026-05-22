const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const ytSearch = require('yt-search');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YT_DLP = 'yt-dlp';

// ─── Download Manager ───────────────────────────────────────────────
const downloads = new Map();
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

function sanitizeTitle(title) {
  return (title || 'audio').replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
}

function parseYtdlProgress(line) {
  const p = line.match(/\[download\]\s+(\d+\.?\d*)%/);
  if (!p) return null;
  const progress = parseFloat(p[1]);

  const speedMatch = line.match(/at\s+([\d.]+)\s*(\w+\/s)/);
  const speed = speedMatch ? speedMatch[1] + ' ' + speedMatch[2] : null;

  const etaMatch = line.match(/ETA\s+(\d+:\d+)/);
  const eta = etaMatch ? etaMatch[1] : null;

  const sizeMatch = line.match(/of\s+~?([\d.]+)\s*(\w+)/);
  const totalSize = sizeMatch ? sizeMatch[1] + ' ' + sizeMatch[2] : null;

  return { progress, speed, eta, totalSize };
}

function startDownload(videoId, title) {
  const id = crypto.randomUUID();
  const safeTitle = sanitizeTitle(title);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(DOWNLOADS_DIR, `${safeTitle}.%(ext)s`);

  const task = {
    id,
    videoId,
    title: title || 'Unknown',
    safeTitle,
    status: 'downloading',
    progress: 0,
    speed: null,
    eta: null,
    totalSize: null,
    filename: null,
    sizeMB: null,
    error: null,
    createdAt: Date.now(),
    process: null,
  };

  const proc = spawn(YT_DLP, [
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--no-playlist',
    '--newline',
    '-o', outputPath,
    url,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  });

  task.process = proc;

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();

    for (const line of lines) {
      if (line.includes('[download]') && line.includes('%')) {
        const parsed = parseYtdlProgress(line);
        if (parsed) {
          task.progress = parsed.progress;
          task.speed = parsed.speed;
          task.eta = parsed.eta;
          if (parsed.totalSize) task.totalSize = parsed.totalSize;
          broadcast('download-progress', {
            id, progress: task.progress, speed: task.speed,
            eta: task.eta, totalSize: task.totalSize,
          });
        }
      }
    }
  });

  proc.on('close', (code) => {
    if (task.status === 'cancelled') return;

    if (code === 0) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      const mp3 = files.find(f => f.startsWith(safeTitle) && f.endsWith('.mp3'));
      if (mp3) {
        const filePath = path.join(DOWNLOADS_DIR, mp3);
        const stats = fs.statSync(filePath);
        task.status = 'completed';
        task.progress = 100;
        task.filename = mp3;
        task.sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        broadcast('download-complete', {
          id, filename: mp3, sizeMB: task.sizeMB,
        });
      } else {
        task.status = 'error';
        task.error = 'Output file not found';
        broadcast('download-error', { id, error: task.error });
      }
    } else {
      task.status = 'error';
      task.error = `yt-dlp exited with code ${code}`;
      broadcast('download-error', { id, error: task.error });
    }
  });

  proc.on('error', (err) => {
    task.status = 'error';
    task.error = err.message;
    broadcast('download-error', { id, error: task.error });
  });

  downloads.set(id, task);
  broadcast('download-start', {
    id, title: task.title, videoId,
  });

  return id;
}

// ─── API Routes ─────────────────────────────────────────────────────

app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });
    const result = await ytSearch(query);
    const videos = result.videos.slice(0, 20).map(v => ({
      id: v.videoId,
      title: v.title,
      duration: v.duration.seconds,
      durationStr: v.duration.toString(),
      author: v.author.name,
      thumbnail: v.thumbnail,
      url: v.url,
    }));
    res.json({ results: videos });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/preview-url/:videoId', async (req, res) => {
  try {
    const url = `https://www.youtube.com/watch?v=${req.params.videoId}`;
    const proc = spawn(YT_DLP, ['-f', 'bestaudio', '-g', '--no-playlist', url]);
    let stdout = '';
    proc.stdout.on('data', d => stdout += d);
    proc.on('close', (code) => {
      if (code === 0) res.json({ audioUrl: stdout.trim() });
      else res.status(500).json({ error: 'Failed to get audio stream' });
    });
    proc.on('error', () => res.status(500).json({ error: 'Failed to get audio stream' }));
  } catch (err) {
    res.status(500).json({ error: 'Preview error' });
  }
});

app.post('/api/download', (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId is required' });
  const id = startDownload(videoId, title);
  res.json({ downloadId: id });
});

app.get('/api/downloads', (req, res) => {
  const list = [];
  for (const [id, task] of downloads) {
    list.push({
      id, title: task.title, status: task.status,
      progress: task.progress, speed: task.speed,
      eta: task.eta, totalSize: task.totalSize,
      filename: task.filename, sizeMB: task.sizeMB,
      error: task.error, createdAt: task.createdAt,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json({ downloads: list });
});

app.post('/api/download-cancel/:id', (req, res) => {
  const task = downloads.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Download not found' });
  if (task.status !== 'downloading') return res.status(400).json({ error: 'Download is not active' });
  task.status = 'cancelled';
  if (task.process) task.process.kill('SIGTERM');
  broadcast('download-cancelled', { id: task.id });
  res.json({ success: true });
});

app.delete('/api/downloads/:id', (req, res) => {
  const task = downloads.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Download not found' });
  if (task.status === 'downloading') {
    if (task.process) task.process.kill('SIGTERM');
    task.status = 'cancelled';
  }
  downloads.delete(req.params.id);
  res.json({ success: true });
});

app.get('/api/downloads/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send existing downloads as initial state
  const list = [];
  for (const [id, task] of downloads) {
    list.push({
      id, title: task.title, status: task.status,
      progress: task.progress, speed: task.speed,
      eta: task.eta, totalSize: task.totalSize,
      filename: task.filename, sizeMB: task.sizeMB,
      error: task.error, createdAt: task.createdAt,
    });
  }
  res.write(`event: init\ndata: ${JSON.stringify(list)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/songs', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.endsWith('.mp3'))
      .map(f => {
        const filePath = path.join(DOWNLOADS_DIR, f);
        const stats = fs.statSync(filePath);
        return {
          filename: f,
          size: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          modifiedAt: stats.mtime,
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    res.json({ songs: files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list songs' });
  }
});

app.delete('/api/songs/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

app.post('/api/copy-to-usb', (req, res) => {
  try {
    const { mountPoint } = req.body;
    if (!mountPoint) return res.status(400).json({ error: 'mountPoint required' });
    const mp3Files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.mp3'));
    if (mp3Files.length === 0) return res.status(400).json({ error: 'No MP3 files to copy' });
    if (!fs.existsSync(mountPoint)) return res.status(400).json({ error: 'USB mount point does not exist' });

    let copied = 0;
    const errors = [];
    for (const file of mp3Files) {
      try {
        fs.copyFileSync(path.join(DOWNLOADS_DIR, file), path.join(mountPoint, file));
        copied++;
      } catch (e) {
        errors.push(`${file}: ${e.message}`);
      }
    }
    res.json({ success: true, copied, total: mp3Files.length, errors: errors.length > 0 ? errors : undefined });
  } catch (err) {
    res.status(500).json({ error: 'Failed to copy to USB' });
  }
});

app.get('/api/usb-devices', (req, res) => {
  try {
    const output = execSync('lsblk -o NAME,MOUNTPOINT,SIZE,TYPE,LABEL -n -l 2>/dev/null', { encoding: 'utf8' });
    const devices = output.split('\n')
      .filter(line => line.includes('part') && line.trim())
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return { device: parts[0], size: parts[2], mountPoint: parts[1] || '', label: parts[4] || '' };
      })
      .filter(d => d.mountPoint && d.mountPoint.startsWith('/'));
    res.json({ devices });
  } catch {
    res.json({ devices: [] });
  }
});

app.get('/api/preview/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Music USB Creator running at http://localhost:${PORT}`);
});
