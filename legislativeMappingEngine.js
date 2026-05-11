
'use strict';

function mapLegislativeCriteria(subclass) {
  const maps = {
    '186': [
      'Schedule 1 validity',
      'Nomination validity',
      'Skills requirements',
      'English language',
      'Age criteria'
    ],
    '482': [
      'Genuine position',
      'Skills and employment history',
      'Labour market requirements',
      'English language'
    ]
  };

  return maps[String(subclass)] || ['Legislative review required'];
}

module.exports = {
  mapLegislativeCriteria
};
