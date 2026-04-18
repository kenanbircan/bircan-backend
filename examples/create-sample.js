const path = require('path');
const { generateAssessmentPdf } = require('../src/generateAssessmentPdf');

async function main() {
  const outputPath = path.join(__dirname, 'sample-preliminary-assessment.pdf');

  await generateAssessmentPdf({
    outputPath,
    assessment: {
      date: '2026-04-18',
      preliminaryOutcome: 'Potentially eligible',
      submissionId: 'sub_1776495304219_2379cfdc',
      fullName: 'John Smith',
      email: 'kenanbircan@gmail.com',
      dob: '1990-05-14',
      citizenship: 'United Kingdom',
      location: 'Outside Australia',
      stream: 'Subclass 482 | Core Skills stream',
      occupation: 'Software Engineer',
      employerName: 'Tech Solutions Pty Ltd',
      nominationStatus: 'Lodged and pending',
      occupationList: 'Core Skills Occupation List',
      highestQualification: 'Bachelor Degree',
      fieldOfStudy: 'Computer Science',
      qualificationRelevant: 'Yes',
      skillsAssessment: 'Completed successfully',
      skillsAssessmentRef: 'ACS123456',
      workYears: '5 years',
      oneYearRecentExperience: 'Yes',
      englishStatus: 'Test completed',
      englishScore: 'IELTS 7.0 overall with at least 6.0 in each band',
      hasSponsor: 'Yes',
      includePartner: 'Yes',
      docsReady: 'Passport, CV, Employment references, Qualification documents, English test result, Skills assessment',
      passportReady: 'Yes',
      cvReady: 'Yes',
      employmentRefs: 'Yes',
      qualificationDocs: 'Yes',
      genuinePosition: 'Yes',
      healthInsurance: 'Will arrange before grant',
      matter: 'Subclass 482 preliminary assessment',
      extraNotes: 'This sample file demonstrates the upgraded legal-format PDF engine and controlled pagination logic.'
    }
  });

  console.log(`Created: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
