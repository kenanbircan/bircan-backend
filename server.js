import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { saveAssessment } from './storage.js';
import { generatePDF } from './pdf.js';
import { sendEmail } from './mailer.js';

dotenv.config();

const app = express();

// 🔷 Middleware
app.use(cors());
app.use(express.json());

// 🔷 Health check
app.get('/', (req, res) => {
  res.send('Bircan Migration Backend Running');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 🔷 Submit Assessment
app.post('/api/assessment', async (req, res) => {
  try {
    const data = req.body;

    // Save to storage
    const record = await saveAssessment(data);

    // Generate PDF
    const pdfPath = await generatePDF(data);

    // Send Email (optional if SMTP configured)
    if (process.env.SMTP_USER) {
      await sendEmail({
        to: data.email,
        subject: 'Your Migration Assessment',
        text: 'Please find your assessment attached.',
        attachment: pdfPath,
      });
    }

    res.json({
      success: true,
      message: 'Assessment submitted successfully',
      id: record?.id || null,
    });
  } catch (error) {
    console.error('Assessment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// 🔷 Example payment endpoint (placeholder)
app.post('/api/payment', async (req, res) => {
  try {
    // You will connect Stripe here later
    res.json({
      success: true,
      message: 'Payment endpoint ready',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// 🔷 Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
