'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;

// Native fetch (Node 18+)
const fetch = global.fetch;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Server running' });
});

function generatePDF(filePath) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 40, 40, { width: 100 });
    }

    doc.fontSize(16).text('Bircan Migration & Education', 160, 40);
    doc.moveDown();
    doc.fontSize(12).text('Sample PDF Output');

    doc.end();
    stream.on('finish', resolve);
  });
}

app.post('/api/assessment/submit', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'output.pdf');
    await generatePDF(filePath);
    res.json({ ok: true, message: 'PDF generated' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
