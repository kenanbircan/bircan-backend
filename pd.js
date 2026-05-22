'use strict';

// Compatibility alias for older test routes. The production-grade premium
// renderer now lives in ./pdf.js so both pdf.js and pd.js produce the same
// client-facing advice-letter output.
module.exports = require('./pdf');
