const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = 3000;

// ── Static files ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Multer: save uploaded slices to /uploads ──────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    // preserve original filename
    cb(null, file.originalname);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase())
            && allowed.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Only image files are allowed'));
  },
});

// ── API: upload one or multiple slices ───────────────────────────────────
app.post('/api/upload', upload.array('slices', 50), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const urls = req.files.map(f => `/uploads/${f.filename}`);
  res.json({ success: true, files: urls, count: urls.length });
});

// ── API: list slices from /assets (pre-loaded CT data) ───────────────────
app.get('/api/slices', (req, res) => {
  const assetsDir = path.join(__dirname, 'assets');
  const uploadsDir = path.join(__dirname, 'uploads');

  const readImages = (dir, prefix) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f))
      .sort((a, b) => {
        // sort by numeric layer index if present (Layer_1, Layer_2, ...)
        const na = parseInt(a.match(/\d+/)?.[0] ?? '0');
        const nb = parseInt(b.match(/\d+/)?.[0] ?? '0');
        return na - nb;
      })
      .map(f => `${prefix}/${f}`);
  };

  const assetSlices  = readImages(assetsDir,  '/assets');
  const uploadSlices = readImages(uploadsDir, '/uploads');

  // uploads take priority; merge deduplicating by filename
  const seen = new Set();
  const all  = [...uploadSlices, ...assetSlices].filter(url => {
    const name = path.basename(url);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  res.json({ slices: all, count: all.length });
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`CT Scan viewer running at http://localhost:${PORT}`);
  console.log(`  Place CT slice images in the /assets folder`);
  console.log(`  Or upload via POST /api/upload`);
});
app.get('/api/data', (req, res) => res.sendFile(__dirname + '/nsduh_results.json'));