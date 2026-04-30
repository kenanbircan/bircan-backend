'use strict';

function normaliseDashboardPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return payload;
}

module.exports = { normaliseDashboardPayload };
