'use strict';

// Add near the top of server.js:
// const { assessSubclass190 } = require('./engines/190');

// Add this route after app.use(express.json(...)) and auth middleware setup.
function mountSubclass190DecisionEngine(app, requireLogin) {
  const { assessSubclass190 } = require('./engines/190');

  app.post('/api/assessment/190/decision-engine', requireLogin, async (req, res) => {
    try {
      const result = assessSubclass190(req.body, {
        intendedLodgementDate: req.body.intendedLodgementDate || new Date()
      });
      return res.json(result);
    } catch (err) {
      console.error('Subclass 190 decision engine failed:', err);
      return res.status(500).json({ ok: false, error: 'Subclass 190 decision engine failed.' });
    }
  });
}

module.exports = { mountSubclass190DecisionEngine };
