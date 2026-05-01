'use strict';

const { ageAt, numberOrNull, lower } = require('./190.utils');

function calculateAgePoints(input) {
  const age = ageAt(input.applicant.dateOfBirth, input.skillselect.invitationDate);
  if (age === null) return { points: null, reason: 'Age at invitation cannot be calculated without date of birth and invitation date.' };
  if (age < 18 || age >= 45) return { points: 0, age, reason: 'Age is outside points-tested age range.' };
  if (age <= 24) return { points: 25, age };
  if (age <= 32) return { points: 30, age };
  if (age <= 39) return { points: 25, age };
  return { points: 15, age };
}

function calculateEnglishPoints(input) {
  const level = lower(input.english.claimedLevel);
  if (level === 'superior') return { points: 20 };
  if (level === 'proficient') return { points: 10 };
  if (level === 'competent' || level === 'passport') return { points: 0 };
  return { points: null, reason: 'English level is unknown or unsupported.' };
}

function calculate190Points(input) {
  const b = input.points.breakdown || {};
  const age = calculateAgePoints(input);
  const english = calculateEnglishPoints(input);
  const nominationPoints = numberOrNull(b.nomination) ?? 5;

  const parts = {
    age: age.points,
    english: english.points,
    employmentOverseas: numberOrNull(b.employmentOverseas) ?? 0,
    employmentAustralia: numberOrNull(b.employmentAustralia) ?? 0,
    qualifications: numberOrNull(b.qualifications) ?? 0,
    australianStudy: numberOrNull(b.australianStudy) ?? 0,
    specialistEducation: numberOrNull(b.specialistEducation) ?? 0,
    regionalStudy: numberOrNull(b.regionalStudy) ?? 0,
    communityLanguage: numberOrNull(b.communityLanguage) ?? 0,
    professionalYear: numberOrNull(b.professionalYear) ?? 0,
    partner: numberOrNull(b.partner) ?? 0,
    nomination: nominationPoints
  };

  const hasUnknown = Object.values(parts).some(v => v === null);
  const total = hasUnknown ? null : Object.values(parts).reduce((a, v) => a + v, 0);

  return {
    total,
    claimedTotal: input.points.claimedTotal,
    breakdown: parts,
    notes: [age.reason, english.reason].filter(Boolean)
  };
}

module.exports = { calculate190Points, calculateAgePoints, calculateEnglishPoints };
