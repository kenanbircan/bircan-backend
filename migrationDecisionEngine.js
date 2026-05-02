/**
 * migrationDecisionEngine.js
 * Bircan Migration — 10/10 Enterprise Migration Decision Engine
 * 
 * SINGLE-FILE, DEPENDENCY-FREE, RENDER-SAFE.
 *
 * Upload this file beside server.js.
 *
 * Exports used by server.js:
 *   - runDecisionEngine(assessment)
 *   - buildLegalEngineBundle(decision, assessment)
 *
 * Optional exports:
 *   - validateAdviceBundle(bundle)
 *   - SUPPORTED_SUBCLASSES
 *
 * Design:
 * Form answers + uploaded/evidence metadata
 *   -> normalised facts
 *   -> subclass legal profile
 *   -> evidence verification
 *   -> points/stream/validity checks
 *   -> strict legal outcome
 *   -> GPT-safe advice bundle
 *
 * GPT must only draft wording from this bundle. It must not change legal outcome.
 */

const ENGINE_VERSION = "10.0.0-single-file-enterprise";
const ENGINE_NAME = "Bircan Migration Enterprise Decision Engine";

// -----------------------------------------------------------------------------
// Embedded training manifest from uploaded knowledgebase, Migration Act,
// Migration Regulations, Procedure Advice Manuals and Code of Conduct.
// This is deterministic rule-encoding, not OpenAI fine-tuning.
// -----------------------------------------------------------------------------
const TRAINING_SOURCES = Object.freeze({
  knowledgebaseZip: "KNOWLEDGEBASE(3).zip",
  migrationActZip: "Migration Act 1958-current(1).zip",
  migrationRegulationsZip: "Migration Regulations 1994-current(1).zip",
  codeOfConduct: "Migration (Migration Agents Code of Conduct) Regulations 2021 - current from 1 March 2022",
  procedureAdviceManuals: "Subclass procedural instruction files in KNOWLEDGEBASE(3).zip"
});

const CODE_OF_CONDUCT_SAFEGUARDS = Object.freeze([
  "Act professionally, ethically and in accordance with migration law.",
  "Do not provide futile immigration assistance where prospects are poor or not legally available.",
  "Do not make or rely on false or misleading statements or documents.",
  "Know the client, verify identity, authority and relevant facts before final advice.",
  "Identify and disclose conflicts of interest.",
  "Maintain confidentiality and secure handling of client documents.",
  "Provide Consumer Guide and service agreement/fee disclosures where required before further immigration assistance.",
  "Keep the client informed and keep records of advice and communications.",
  "Treat automated output as preliminary until reviewed by a registered migration agent."
]);

const KB_SUBCLASS_MATRIX = Object.freeze({
  "101": {
    "title": "[Sch2Visa101] Subclass 101 Child visa",
    "latestLegendVersion": "04 April 2025",
    "documentId": "VM-3068",
    "contact": "Family Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 101.docx",
    "criteriaHeadings": [
      "04 April 2025",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Child Safeguarding Considerations",
      "3.1.1. How to refer",
      "3.2. About the Child visa",
      "3.3. Schedule 1 requirements - Visa Application Validity Requirements",
      "3.3.1. The Application Form",
      "3.3.2. Visa application charge (VAC)",
      "3.3.3. Where and how the application must be made",
      "3.3.4. Where the applicant must be",
      "3.3.5. Combined applications",
      "3.3.6. Ineligibility",
      "3.3.7. A child who is incapacitated for work – subclause 101.211(2)",
      "3.3.8. Bridging visas",
      "3.4. Priority Processing Direction",
      "3.5. Schedule 2 – Primary criteria",
      "3.5.1. Criteria to be satisfied at time of application",
      "3.6. Surrogacy",
      "3.6.1. Citizenship by descent",
      "3.6.2. Surrogacy – Subclass 101 Child visa requirements",
      "3.7. Step-children",
      "3.7.1. Definition",
      "3.7.2. Relationship requirements",
      "3.7.3. Effect of the relationship requirement",
      "3.7.4. Evidence of step-relationship",
      "3.8. Adoption cases",
      "3.8.1. Eligibility – overview",
      "3.8.2. Evidence of adoption",
      "3.8.3. Adoption Age limits",
      "3.9. Dependency",
      "3.9.1. Time of application upper age limit (under 25 years)",
      "3.9.2. A child who is incapacitated for work",
      "3.9.3. Children over 18 - Additional requirements"
    ]
  },
  "103": {
    "title": "[Sch2] Sch2 Parent visas",
    "latestLegendVersion": "01 August 2025",
    "documentId": "VM-3058",
    "contact": "Family and Permanent Resident Visa Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 103.docx",
    "criteriaHeadings": [
      "01 August 2025",
      "1. Purpose",
      "2. Scope",
      "2.1 In Scope",
      "2.2 Out of Scope",
      "3. Procedural Instruction",
      "3.1 Parent visa overview",
      "3.1.1 Priority Processing Direction",
      "3.2 Schedule 1 - Validity Requirements",
      "3.2.1 The application form",
      "3.2.2 Visa application charge (VAC)",
      "3.2.3 Where and how the application must be made",
      "3.2.4 Where the applicant must be",
      "3.2.5 No other Parent visa applications",
      "3.2.6 Aged Parent visa applications",
      "3.2.7 Switching visa applications",
      "3.2.8 Combined applications",
      "3.2.9 Contributory Parent newborn children",
      "3.2.10 Bridging visas",
      "3.2.11 Applications by holders of a substituted Subclass 600 visa",
      "3.2.12 Bars on applying",
      "3.3 Schedule 2 – Primary Criteria – Time of Application",
      "3.3.1 Parent definition",
      "3.3.2 Applications by holders/previous holders of a Subclass 771 (Transit) visa",
      "3.3.3 Balance of Family Test",
      "3.3.4 The Retirement Pathway",
      "3.3.5 Sponsorship requirements at time of application",
      "3.3.6 Schedule 3 criterion (3002)",
      "3.4 Schedule 2 – Primary Criteria – Time of Decision",
      "3.4.1 Continued eligibility",
      "3.4.2 Public Interest and Special Return criteria",
      "3.4.3 Assurance of Support (AoS)",
      "3.5 Schedule 2 – Secondary Criteria",
      "3.6 Family Violence Provisions",
      "3.6.1 Relationship to primary applicant"
    ]
  },
  "115": {
    "title": "[Sch2Visa115] Sch2Visa115 - Remaining Relative",
    "latestLegendVersion": "13 November 2021",
    "documentId": "VM-3069",
    "contact": "Family Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 115.docx",
    "criteriaHeadings": [
      "Div1.4 – Form 40 sponsors and sponsorship",
      "Div1.4B - Limitation on certain sponsorships under Division 1.4 - Remaining relative visas",
      "Sch4 – Public interest criteria",
      "8502 - Not to arrive before person specified in visa",
      "8515 - Must not marry or enter into de facto relationship",
      "13 November 2021",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1 Policy statement",
      "3.2 Legislative changes",
      "3.3 About the BO 115 visa",
      "3.3.1 Purpose",
      "3.3.2 Interview requirements",
      "3.3.3 Capping and queuing",
      "3.4 The BO-115 primary applicant",
      "3.4.1 Eligibility",
      "3.4.1.1 Remaining relative of an Australian relative",
      "3.4.1.2 Continued eligibility",
      "3.4.2 Sponsorship requirements",
      "3.4.2.1 Sponsorship",
      "3.4.2.2 Who can sponsor",
      "3.4.2.3 Change of sponsor",
      "3.4.2.4 The ‘settled’ requirement",
      "3.4.2.5 The ‘usually resident’ requirement",
      "3.4.2.6 Sponsorship limitations",
      "3.4.3 Generic Criteria",
      "3.4.3.1 Public interest criteria (PICs)",
      "3.4.3.2 Special return criteria",
      "3.4.3.3 Assurance of support",
      "3.4.3.4 “One fails, all fail” criteria",
      "3.5 BU-115 family unit members",
      "3.5.1 Eligibility",
      "3.5.1.1 Relationship",
      "3.5.1.2 Combined application"
    ]
  },
  "116": {
    "title": "Carer visas (subclass 116 and subclass 836)",
    "latestLegendVersion": "03 October 2025",
    "documentId": "VM-7144",
    "contact": "Family and Permanent Resident Visa Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 116.docx",
    "criteriaHeadings": [
      "03 October 2025",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. The Carer visa",
      "3.2. Applicable visa classes and subclasses",
      "3.3. Schedule 1 validity requirements",
      "3.3.1. Application form",
      "3.3.2. Visa application charge - first instalment",
      "3.3.3. Where and how the application must be made",
      "3.3.4. Where the visa applicant must be",
      "3.3.5. Satisfactory evidence",
      "3.3.6. Combined applications and members of the family unit",
      "3.3.7. Bridging visa eligibility",
      "3.4. Schedule 2 – Time of application primary criteria",
      "3.4.1. Immigration Status – Subclass 836 only",
      "3.4.2. Carer requirements",
      "3.4.3. Sponsorship requirements",
      "3.4.4. Eligibility",
      "3.5 Schedule 2 - Time of decision primary criteria",
      "3.5.1 Assessment of the carer under Regulation 1.15AA",
      "3.5.2 Carer-specific requirements - summary",
      "3.5.3 Must be a relative",
      "3.5.4 Assessing ‘usual residence’ of the person with the medical condition",
      "3.5.5 MoFU of the Australian relative may be the one who has the medical condition.",
      "3.5.6 Nature of the impairment",
      "3.5.7 The Bupa medical assessment process",
      "3.5.8 Assistance needs",
      "3.5.9 Other Australian relatives",
      "3.5.10 Assistance cannot be reasonably obtained from welfare, hospital, nursing or community services",
      "3.5.11 Willingness and ability of the visa applicant",
      "3.5.12 Public interest criteria (PICs)",
      "3.5.13 Sponsorship",
      "3.6 Cognitive impairment",
      "3.7 Secondary criteria"
    ]
  },
  "173": {
    "title": "[Sch2] Sch2 Parent visas",
    "latestLegendVersion": "01 August 2025",
    "documentId": "VM-3058",
    "contact": "Family and Permanent Resident Visa Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 173.docx",
    "criteriaHeadings": [
      "01 August 2025",
      "1. Purpose",
      "2. Scope",
      "2.1 In Scope",
      "2.2 Out of Scope",
      "3. Procedural Instruction",
      "3.1 Parent visa overview",
      "3.1.1 Priority Processing Direction",
      "3.2 Schedule 1 - Validity Requirements",
      "3.2.1 The application form",
      "3.2.2 Visa application charge (VAC)",
      "3.2.3 Where and how the application must be made",
      "3.2.4 Where the applicant must be",
      "3.2.5 No other Parent visa applications",
      "3.2.6 Aged Parent visa applications",
      "3.2.7 Switching visa applications",
      "3.2.8 Combined applications",
      "3.2.9 Contributory Parent newborn children",
      "3.2.10 Bridging visas",
      "3.2.11 Applications by holders of a substituted Subclass 600 visa",
      "3.2.12 Bars on applying",
      "3.3 Schedule 2 – Primary Criteria – Time of Application",
      "3.3.1 Parent definition",
      "3.3.2 Applications by holders/previous holders of a Subclass 771 (Transit) visa",
      "3.3.3 Balance of Family Test",
      "3.3.4 The Retirement Pathway",
      "3.3.5 Sponsorship requirements at time of application",
      "3.3.6 Schedule 3 criterion (3002)",
      "3.4 Schedule 2 – Primary Criteria – Time of Decision",
      "3.4.1 Continued eligibility",
      "3.4.2 Public Interest and Special Return criteria",
      "3.4.3 Assurance of Support (AoS)",
      "3.5 Schedule 2 – Secondary Criteria",
      "3.6 Family Violence Provisions",
      "3.6.1 Relationship to primary applicant"
    ]
  },
  "186": {
    "title": "Permanent Employer Sponsored Entry – Subclass 186 (ENS) Visa – Visa Applications",
    "latestLegendVersion": "07 February 2025",
    "documentId": "VM-6275",
    "contact": "Employer Sponsored Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 186.docx",
    "criteriaHeadings": [
      "Permanent Employer Sponsored Entry – Subclass 186 (ENS) Visa – Visa Applications",
      "07 February 2025",
      "Employer Sponsored Program Management",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. Procedural Instruction",
      "3.1. Overview of the PESE program",
      "3.1.1. Employer Nominated Scheme",
      "3.1.2. Streams",
      "3.2. Subclass 186 Visa Requirements",
      "3.2.1. Schedule 1 validity requirements",
      "3.2.2. The application form",
      "3.2.3. The visa application charge",
      "3.2.4. Declaration regarding payment for visas conduct",
      "3.2.5. Location of applicant at time of application",
      "3.2.6. What visa must be held if applicant onshore",
      "3.2.7. Declaration required regarding the nomination",
      "3.2.8. Combined and separate applications",
      "3.2.9. Subsequent application",
      "3.3. Primary criteria – common to all streams",
      "3.3.1. Mandatory registration, licensing or similar",
      "3.3.2. The position must provide the employment indicated in the nomination",
      "3.3.3. No payment for visas conduct",
      "3.3.4. Public interest and other criteria",
      "3.4. Primary Criteria for Temporary Residence Transition stream",
      "3.4.1. Overview",
      "3.4.2. The applicant’s age",
      "3.4.3. The English requirement",
      "3.4.4. Previous substantive visa is or was a Subclass 491 or 494 visa",
      "3.4.5. Position must be that nominated under the nomination provisions",
      "3.4.6. Nomination must be approved",
      "3.4.7. Adverse information",
      "3.4.8. Position must still be available"
    ]
  },
  "187": {
    "title": "Permanent Employer Sponsored Entry Subclass 187 (RSMS) Visa Applications",
    "latestLegendVersion": "07 February 2025",
    "documentId": "VM-7186",
    "contact": "Employer Sponsored Program Management Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 187.docx",
    "criteriaHeadings": [
      "Permanent Employer Sponsored Entry Subclass 187 (RSMS) Visa Applications",
      "Migration Regulations - Divisions > Permanent Employer Sponsored Entry Subclass 187 (RSMS) Visa Applications",
      "07 February 2025",
      "Employer Sponsored Program Management Section",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. Procedural Instruction",
      "3.1. Overview of the PESE program",
      "3.1.1. Regional Sponsored Migration Scheme",
      "3.2. TRT Stream",
      "3.3. Time of application requirements",
      "3.3.1. Schedule 1 validity requirements (item 1114C)",
      "3.3.2. The application form",
      "3.3.3. The visa application charge",
      "3.3.4. Declaration regarding payment for visas conduct",
      "3.3.5. Location of applicant at time of application",
      "3.3.6. What visa must be held if applicant onshore",
      "3.3.7. Declaration required regarding the nomination",
      "3.3.8. Combined and separate applications",
      "3.3.9. Subsequent application",
      "3.4. Time of decision requirements in Schedule 2 - Temporary Residence Transition Stream",
      "3.4.1. Position must be that nominated under the nomination provisions",
      "3.4.2. Position must be that for which the visa application was made",
      "3.4.3. Time limit on making an application",
      "3.4.4. The position must provide the employment indicated in the nomination",
      "3.4.5. Mandatory registration, licensing or similar",
      "3.4.6. Nomination must be approved and not since withdrawn",
      "3.4.7. Adverse information",
      "3.4.8. Position must still be available",
      "3.4.9. The applicant's age",
      "3.4.10. English language requirement",
      "3.4.11. Skills",
      "3.5. Exemption categories and assessment criteria – primary applicants"
    ]
  },
  "188": {
    "title": "​​​​​​​​​​​​Subclass 188 – Business Innovation and ​​Investment (Provisional) Visa",
    "latestLegendVersion": "",
    "documentId": "VM-3113",
    "contact": "Business Innovation and Investment Visa Program (BIIP)Independent Skills and Innovation Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 188.docx",
    "criteriaHeadings": [
      "06 March 2026",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Strategic context",
      "3.2. Objectives of the program",
      "3.3. About the Class EB Visa",
      "3.4. Permanent visa option",
      "3.5. Business Terms",
      "3.6. Schedule 1 validity requirements",
      "3.6.1. Schedule 1 general requirements",
      "3.6.2. Schedule 1 Stream specific requirements",
      "3.7. Schedule 2 primary criteria",
      "3.8. Subclass 188 Common criteria",
      "3.8.1. The applicant’s business history",
      "3.8.2. Nomination as a Schedule 1 requirement",
      "3.8.3. Nomination must remain in force",
      "3.8.4. Declaration",
      "3.8.5. “One fails, all fail” Public Interest Criteria",
      "3.8.6. Special return criteria",
      "3.9. Business Innovation stream",
      "3.9.1. Invitation",
      "3.9.2. Age requirement",
      "3.9.3. Exceptional economic benefit provision (age limits)",
      "3.9.4. Points test",
      "3.9.5. Demonstrated need to be in Australia",
      "3.9.6. Successful business career",
      "3.9.7. Business credentials - Main business turnover",
      "3.9.8. Service-based businesses",
      "3.9.9. Net business and personal assets",
      "3.9.10. Additional assets for settlement",
      "3.9.11. Asset transferability",
      "3.9.12. Business intentions",
      "3.9.13. Public interest criterion 4005",
      "3.10. Investor stream"
    ]
  },
  "189": {
    "title": "Subclass 189 (Skilled – Independent) visa",
    "latestLegendVersion": "1 July 2021",
    "documentId": "VM-3105",
    "contact": "GSM.Program.Support@homeaffairs.gov.au",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 189.docx",
    "criteriaHeadings": [
      "This PI is for the use of processing staff for the Subclass 189 and addresses both Schedule 1 requirements and Schedule 2 criteria.",
      "Public Interest Criterion 4020 – The Integrity PIC",
      "Schedule 6D general points test for General Skilled Migration visas mentioned in subregulation 2.26AC(1)",
      "Sch4/4005-4007 - The Health Requirement",
      "8504 - \"(First) Entry date\" condition",
      "Div5.3/reg5.17 - Prescribed evidence of English language proficiency",
      "Div2.6 - Prescribed qualifications -Application of points system",
      "English proficiency and assessment",
      "1 July 2021",
      "1. Purpose",
      "2. Scope",
      "3. Policy intent",
      "3.1. Strategic Context",
      "3.2. Objectives of the program",
      "3.2.1 Points-tested stream",
      "3.2.2 New Zealand stream",
      "4. Procedural Instruction",
      "4.1. About Subclass 189",
      "4.2. Subclass 189 legislation",
      "4.2.1 Schedule 2 Part 189 structure",
      "4.3. Subclass 189 – section 499 directions",
      "4.4. Section 48 statutory bar on applying in Australia",
      "5. Schedule 1 requirements",
      "5.1. Legislative requirements",
      "5.2. If Schedule 1 requirements are not met",
      "5.3. If primary application is invalid, all ‘combined’ applications invalid",
      "6. Schedule 1 requirements",
      "6.1. About Item 1137 of Schedule 1",
      "6.1.1 – Subclass and streams",
      "6.1.2 Application form",
      "6.1.3 Visa application charge",
      "6.1.4 Where Subclass 189 visa applicants must be",
      "6.1.5 Qualifying visas",
      "6.1.6 No further application conditions – waiver provisions",
      "6.1.7 Primary applicant"
    ]
  },
  "190": {
    "title": "Subclass 190 (Skilled Nominated) Visa",
    "latestLegendVersion": "1 July 2021",
    "documentId": "VM-3106",
    "contact": "Skilled and Migration Program Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 190.docx",
    "criteriaHeadings": [
      "Div 2.6 - Prescribed qualifications - Application of points system",
      "Schedule 6D general points test for General Skilled Migration visas mentioned in subregulation 2.26AC(1)",
      "Sch4/4005-4007 - The Health requirement",
      "[P-Reg-Other] English proficiency and assessment",
      "[Sch4 4020] Public Interest Criterion 4020 - The Integrity PIC",
      "1 July 2021",
      "1. Purpose",
      "2. Scope",
      "3. Policy intent",
      "3.1. Objectives of the program",
      "4. Procedural Instruction",
      "4.1. About Subclass 190",
      "4.2 Subclass 190 legislation",
      "4.3 Subclass 190 – section 499 directions",
      "5. Schedule 1 Requirements",
      "5.1. Item 1138 of Schedule 1 to the Regulations",
      "5.1.1 Application form",
      "5.1.2 Visa application charge (VAC)",
      "5.1.3 Application must be made at the place and in the manner specified by the Minister",
      "5.1.4 Where Subclass 190 visa applicants must be",
      "5.1.5 Qualifying visas",
      "5.1.6 Application by a member of the family unit",
      "5.1.7 Bars on applying",
      "5.1.8 Section 48 bar on applying for certain visas in Australia",
      "5.1.9 No further application conditions – waiver provisions",
      "5.1.10 Additional requirements to be met by the primary applicant",
      "5.1.11 Invitation required",
      "5.1.12 Application must be made within the specified period",
      "5.1.13 Applicant must not have turned 45 at the time of invitation",
      "5.1.14 Applicant must nominate a skilled occupation",
      "5.1.15 Applicant must be nominated by a State or Territory government agency",
      "5.1.16 Nominated skilled occupation cannot later be changed",
      "5.2. If Schedule 1 requirements are not met",
      "5.3. If primary application is invalid, all ‘combined’ applications invalid",
      "6. Schedule 2 Primary criteria"
    ]
  },
  "300": {
    "title": "Subclass 300 (Prospective Marriage) Visa",
    "latestLegendVersion": "",
    "documentId": "VM-6211",
    "contact": "Partner Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 300.docx",
    "criteriaHeadings": [
      "28 July 2023",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. About the Subclass 300 visa",
      "3.1.1. Eligibility",
      "3.1.2. Order for considering visa applications",
      "3.1.3. If the couple marry before the Subclass 300 visa is granted",
      "3.1.4. Further subclass 300 visa onshore",
      "3.2. Schedule 1 – visa application validity requirements",
      "3.2.1. Schedule 1 Item 1215 Prospective Marriage (Temporary) (Class TO)",
      "3.3. Schedule 2 criteria – primary applicant",
      "3.3.1. Age requirements",
      "3.3.2. Couple eligibility",
      "3.3.3. Evidencing intention to marry",
      "3.3.4. Notice of intended marriage (NOIM)",
      "3.3.5. The marriage date",
      "3.4. Case Assessment",
      "3.4.1. Integrity concerns about the relationship",
      "3.4.2. Arranged marriages",
      "3.4.3. Continued intention to marry",
      "3.4.4. No impediment to marriage",
      "3.5. Other requirements",
      "3.5.1. Continued eligibility – general requirements",
      "3.5.2. Generic visa requirements",
      "3.6. Schedule 2 criteria – secondary applicants",
      "3.6.1. Eligibility",
      "3.6.2. Family applicants - Public interest criteria (PIC)",
      "3.6.3. Family applicants - Special return criteria (SRC)",
      "3.6.4. If a minor",
      "3.6.5. Primary applicant must be visaed first",
      "3.7. Eligibility as a Sponsor",
      "3.7.1. Sponsorship requirements",
      "3.7.2. Sponsorship limitations",
      "3.7.3. If the prospective spouse was a woman at risk"
    ]
  },
  "309": {
    "title": "3.1.1. Eligibility",
    "latestLegendVersion": "",
    "documentId": "VM-6212",
    "contact": "Partner Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 309.docx",
    "criteriaHeadings": [
      "3.1.1. Eligibility",
      "3.1.2. Circumstances where the applicant is ineligible for a Subclass 309 visa",
      "3.1.3. Order for considering Partner visa applications",
      "3.2.1. Schedule 1 item 1220A Partner (Provisional) (Class UF)",
      "3.2.2. The application form",
      "3.2.3. Visa application charge (VAC)",
      "3.2.4. Where and how the application must be made",
      "3.2.5. Where the applicant must be",
      "3.2.6. Application must be made at the same time and place as a Subclass 100 (Partner) visa",
      "3.2.7 Combined applications",
      "3.2.8 Sponsorship for a Partner to Migrate to Australia",
      "3.3.1. Criteria to be satisfied at time of application",
      "3.3.2. Eligibility as a Sponsor",
      "3.3.3. If applying prior to marriage",
      "3.3.4. Case Assessment",
      "3.3.5. Criteria to be satisfied at time of decision",
      "3.3.6. Relationship Cessation",
      "3.3.7. Applications remitted by AAT",
      "3.3.8. Deciding the subclass 100 application",
      "3.4.1. Primary applicant - Public interest criteria (PIC)",
      "3.4.2. Primary applicant - Special return criteria (SRC)",
      "3.4.3. \"One fails, all fail\" criteria",
      "3.5.1. Eligibility",
      "3.5.2. Combined application – adding a child to the application",
      "3.5.3. If the main applicant has already been granted a Subclass 309 visa",
      "3.5.4. Sponsorship",
      "3.5.5. Secondary applicants - PIC",
      "3.5.6. Secondary applicants - SRC",
      "3.5.7. If a minor",
      "3.5.8. Main applicant must be visaed first",
      "3.6.1. Where a Subclass 309 applicant must be to be granted their visa",
      "3.6.2. The Subclass 309 visa period",
      "3.7.1. First entry date",
      "3.7.2. Other visa conditions",
      "3.8.1. Merits review"
    ]
  },
  "407": {
    "title": "Subclass 407 (Training) visa",
    "latestLegendVersion": "11 December 2021",
    "documentId": "VM-1138",
    "contact": "Student & Graduate Visas Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 407.docx",
    "criteriaHeadings": [
      "Paying for visa sponsorship",
      "Sch4 - Public interest criteria",
      "Sch4/4005-4007 - The Health Requirement",
      "Public Interest Criterion (PIC) 4019 – The Values Statement",
      "Public Interest Criterion 4020 – The Integrity PIC",
      "Sponsorship compliance framework: Sponsorship obligations",
      "Temporary Activities Sponsorship",
      "Visa Condition 8501 - Maintain Health Insurance",
      "11 December 2021",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Latest changes",
      "3.2. Overview of the Subclass 407 visa program",
      "3.2.1. About the Subclass 407 visa program",
      "3.2.2. The Subclass 407 visa process",
      "3.3. Nomination application requirements",
      "3.3.1. Overview",
      "3.3.2. Who can nominate",
      "3.3.3. Process for nominating programs of occupational training",
      "3.3.4. Assessing a nomination",
      "3.3.5. Nomination eligibility types",
      "3.3.6. Nomination type 1 - Occupational training for registration etc",
      "3.3.7. Nomination type 2 - Occupational training to enhance skills",
      "3.3.8. Nomination type 3 - Occupational training for capacity building overseas",
      "3.3.9. Period of approval of nomination",
      "3.4. Subclass 407 – Schedule 1 application requirements",
      "3.4.1. Lodgement arrangements",
      "3.4.2. Visa application charge (VAC)",
      "3.4.3. Where and how the application must be made",
      "3.4.4. Location of the applicant when applying for the visa",
      "3.4.5. Sponsorship requirement",
      "3.4.6. Sponsoring organisation is NOT a Commonwealth agency",
      "3.4.7. Sponsoring organisation is a Commonwealth agency",
      "3.4.8. Certain non-citizens not eligible to apply"
    ]
  },
  "408": {
    "title": "Temporary Activity (Subclass 408) Visa",
    "latestLegendVersion": "07/03/2025",
    "documentId": "VM-1140",
    "contact": "Pacific, WHM and Short Stay Work Visas Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 408.docx",
    "criteriaHeadings": [
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1 About the temporary activity visa program",
      "3.1.1. The Subclass 408 (Temporary Activity) visa",
      "3.1.2. Activity types under the Subclass 408 (Temporary Activity) visa",
      "3.1.2.1. Invited Participant in an Event",
      "3.1.2.2. Sport",
      "3.1.2.3. Religious Worker",
      "3.1.2.4. Domestic Worker",
      "3.1.2.5. Superyacht Crew",
      "3.1.2.6. Research",
      "3.1.2.7. Staff Exchange",
      "3.1.2.8. Special Programs",
      "3.1.2.9. Entertainment",
      "3.1.2.10. Australian Government Endorsed Event",
      "3.2 Applying for a Temporary Activity visa (Schedule 1 item 1237)",
      "3.2.1. Via ImmiAccount",
      "3.2.2. Schedule 1 item 1237",
      "3.2.3. Application form",
      "3.2.4 Authorising an application to be made outside of ImmiAccount",
      "3.2.5 Visa application charge",
      "3.2.6. Subitem 1237(3) requirements – items in the table",
      "3.2.6.1. Place and manner of making application",
      "3.2.6.2. Location of applicant at time of application",
      "3.2.6.3. Requirement for certain applicants to be sponsored",
      "3.2.6.4. If the applicant holds a substantive visa",
      "3.2.6.5. If the applicant is in Australia and does not hold a substantive visa",
      "3.2.6.6. Declaration in relation to provision of a benefit in return for sponsorship",
      "3.2.6.7. Combined applications by families",
      "3.3 Assessing a Temporary Activity visa application",
      "3.3.1. Categorisation of Activity Types",
      "3.3.2 The sponsorship test and the support test",
      "3.3.3. Meaning of “passes the sponsorship test”",
      "3.3.4. Meaning of “passes the support test”"
    ]
  },
  "417": {
    "title": "[Sch2Visa417] Sch2 Visa 417 - Working Holiday",
    "latestLegendVersion": "1 July 2019",
    "documentId": "VM-3182",
    "contact": "",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 417.docx",
    "criteriaHeadings": [
      "Regulations Schedule 1 item 1225 Working Holiday (Temporary (Class TZ) and",
      "Regulations Schedule 2 Part 417 Working Holiday.",
      "1 July 2019",
      "Schedule 1 item 1225",
      "Other Schedule 1 valid application requirements",
      "Genuine visitor",
      "At time of decision - must continue to satisfy criteria",
      "Public interest criteria (PIC)",
      "Health requirements",
      "eVisa 417 health processing",
      "The health matrix",
      "No health examinations required",
      "If health examinations are required",
      "If the health results are clear",
      "If the health results are not clear",
      "Finalisation of the health requirement",
      "Schedule 1 item 1225 sets out the requirements for making a valid application for a Class TZ visa (of which 417 is the only subclass).",
      "At time of decision – must continue to satisfy criteria.",
      "As prescribed by 417.211(2)(b), a Working Holiday visa applicant must be between 18 and 30 (inclusive) at time of application.",
      "in regional Australia (refer to the definition in Schedule 1 item 1225(5) and the associated legislative instrument) (417.211(5)(a))",
      "ABN is genuine",
      "At time of decision – must continue to satisfy criteria",
      "Clause 417.221(2)(a) requires that applicants continue to satisfy at time of decision the following 'time of application' criteria:",
      "be a genuine visitor - refer to Genuine visitor",
      "in assessing the health requirement, note the following (but for Internet applications refer instead to eVisa 417 health processing).",
      "Refer to PAM3: Sch4/4005-4007 - The health requirement.",
      "Once the health examinations have been completed:",
      "If the health results are clear:",
      "If the health results are not clear"
    ]
  },
  "444": {
    "title": "Subclass 444 (Special Category) visa",
    "latestLegendVersion": "07 March 2025",
    "documentId": "VM-3184",
    "contact": "Border and Events Visas Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 444.docx",
    "criteriaHeadings": [
      "07 March 2025",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. About the Subclass 444 visa",
      "3.1. Subclass 444 visa for certain NZ citizens",
      "3.2. Subclass 444 visas for certain NZ citizens who formerly held Norfolk Island immigration permits",
      "3.3. Child Born in Australia to a Subclass 444 visa holder",
      "3.3.1. Section 78 of the Act – child born to a Subclass 444 visa holder on or before 30 June 2022",
      "4. Subclass 444 visa Schedule 1 requirements",
      "4.1. Application form (Subitem 1219(1))",
      "4.2. Visa application charge (VAC) (Subitem 1219(2))",
      "4.3. Application must be made at the place and in the manner specified by the Minister (Subitem 1219(3))",
      "4.4. Specified visa subclass (Subitem 1219(4))",
      "4.5. SmartGate is the authorised system (Subitem 1219 (5))",
      "4.6. If a ‘no further application’ condition applies",
      "5. Applying for a Subclass 444 visa",
      "5.1. Where the application may be made",
      "5.1.1. In immigration clearance",
      "5.1.2. After immigration clearance",
      "6. Criteria for grant of a Subclass 444 visa",
      "6.1. Special Category Visas – section 32 criteria",
      "6.2. Declared classes of NZ citizens – Regulation 5.15A criteria",
      "6.3. Behaviour concern non-citizen (BCNC)",
      "6.3.1. Assessing whether a NZ citizen is a BCNC (in immigration clearance)",
      "6.3.2. Criminal convictions in Australia",
      "6.3.3. Deportation, removal or exclusion",
      "6.3.4. Effect of revocation of a cancellation of a visa (subregulation 5.15A(3))",
      "6.4. Health concern non-citizen (HCNC)",
      "7. Processing Subclass 444 visa applications",
      "7.1. Applications made in immigration clearance",
      "7.1.1. Electronic processing at the Primary Line",
      "7.1.2. Electronic processing following a referral to a Border Clearance Officer (BCO)",
      "7.1.3. If no electronic support is available"
    ]
  },
  "461": {
    "title": "Subclass 461 (New Zealand Citizen Family Relationship (Temporary)) visa",
    "latestLegendVersion": "Reissued 29 September 2023",
    "documentId": "VM-3072",
    "contact": "Family Program Management Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 461.docx",
    "criteriaHeadings": [
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Schedule 1 validity requirements",
      "3.1.1. Application form",
      "3.1.2. Visa application charge (VAC)",
      "3.1.3. Where and how the application must be made",
      "3.1.4. Where the applicant must be when making application",
      "3.1.5. Combined application",
      "3.2. Schedule 2 criteria – time of application",
      "3.2.1. Ineligibility – New Zealand citizens",
      "3.2.2. Eligibility",
      "3.2.3. MOFU of Subclass 444 visa holder",
      "3.2.4. MOFU of prospective Subclass 444 visa holder",
      "3.2.5. No longer a MOFU of a Subclass 444 visa holder",
      "3.2.6. Subclass 403 (Temporary Work (International Relations)) visa holders are ineligible",
      "3.3. Relationship",
      "3.3.1. Overview",
      "3.3.2. If the applicant claims to be the partner of a New Zealand citizen",
      "3.3.3. Cases involving surrogacy",
      "3.4. Immigration status of the New Zealand citizen",
      "3.4.1. If the New Zealand citizen is in Australia",
      "3.4.2. If the New Zealand citizen is outside Australia",
      "3.4.3. Applicant accompanying a New Zealand citizen",
      "3.4.4. If the New Zealand citizen is also an Australian citizen",
      "3.4.5. Non-ENZC New Zealand citizen Subclass 444 visa holders and eligibility for Australian Citizenship",
      "3.5. Subclass 461 visa eligibility – If the family relationship has ended",
      "3.5.1. Location at time of application",
      "3.5.2. Must hold (or have held) a Subclass 461 visa",
      "3.5.3. Must no longer be a MOFU",
      "3.5.4. Must not have since been a MOFU of anyone else",
      "3.5.5. If a Subclass 461 visa holder becomes a MOFU of another person",
      "3.6. Offshore – eligibility if applicant was previously granted a Subclass 461 visa",
      "3.6.1. Must be outside Australia",
      "3.6.2. Must have maintained ties with Australia"
    ]
  },
  "462": {
    "title": "[Sch2Visa462] Subclass 462 visa - Work and Holiday",
    "latestLegendVersion": "1 July 2019This Procedural Instruction does not reflect legislative changes made by Migration Amendment (Working Holiday Maker) Regulations 2019, which commenced on 1 July 2019, relating to “third” Subclass 462 visas, or changes in policy relating to specified work.",
    "documentId": "VM-1813",
    "contact": "Pacific, WHM and Short Stay Work Visas Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 462.docx",
    "criteriaHeadings": [
      "PAM3: Sch4/4005-4007 - The health requirement",
      "PAM3: Act - Character and security - Penal checking handbook",
      "PAM3: Act - Character and security - s501 - The character test, visa refusal and visa cancellation",
      "PAM3:Sch8/8501 - Maintain health insurance",
      "1. Introduction",
      "1.1. About this Procedural Instruction",
      "2. Scope",
      "3. Glossary",
      "4. Procedural Instruction",
      "4.1. Policy Statement",
      "4.2. Schedule 1 and related requirements",
      "4.3. Schedule 2 eligibility criteria applicable to first and second Subclass 462 applicants",
      "Genuine visitor",
      "4.4. Schedule 2 criteria applicable to first Subclass 462 applicants only",
      "Functional English",
      "4.5. Criteria applicable to second Subclass 462 applicants only",
      "4.6. Generic visa criteria",
      "Public interest criteria (PICs)",
      "4.7. Subclass 462 Internet applications",
      "Same Schedule 2 criteria apply to all applications",
      "4.8. Subclass 462 family unit members",
      "4.9. Subclass 462 visa grant",
      "4.10. The Subclass 462 visa period",
      "4.11. Subclass 462 visa conditions",
      "4.12. Records management",
      "5. Accountability and responsibilities",
      "6. What happens if this Procedural Instruction is not followed?",
      "7. Related Framework documents",
      "8. References and legislation",
      "9. Consultation",
      "9.1. Internal consultation",
      "9.2. External consultation",
      "1.  Introduction",
      "1.1.1 This Procedural Instruction (PI) is:",
      "2.  Scope"
    ]
  },
  "482": {
    "title": "[Sch2Visa482] Subclass 482 (Skills in Demand) visa – Visa Applications",
    "latestLegendVersion": "03 October 2025",
    "documentId": "VM-7173",
    "contact": "Employer Sponsored Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 482.docx",
    "criteriaHeadings": [
      "03 October 2025",
      "Employer Sponsored Program Management",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. Procedural Instruction",
      "3.1. Overview of the SID visa program",
      "3.1.1. About the SID visa program",
      "3.1.2. The SID visa process and streams",
      "3.2. Time of application requirements",
      "3.2.1. The application form",
      "3.2.2. The visa application charge (VAC)",
      "3.2.3. Where the application must be made",
      "3.2.4. What visa must be held if applicant is onshore",
      "3.2.5. Combined and separate applications",
      "3.2.6. Related nomination",
      "3.2.7. Mandatory skills assessments",
      "3.2.8. Bridging visas",
      "3.3. Time of decision requirements – all visa applicants",
      "3.3.1. Overview",
      "3.3.2. Substantial compliance",
      "3.3.3. Approved nomination",
      "3.3.4. Member of the family unit – secondary applicants",
      "3.3.5. Paying for visa sponsorship",
      "3.3.6. Health insurance",
      "3.3.7. Adverse information",
      "3.3.8. Public interest criteria (PICs)",
      "3.3.9. Special return criteria",
      "3.4. Additional time of decision requirements – all primary visa applicants",
      "3.4.1. Overview",
      "3.4.2. Genuine intention",
      "3.4.3. Skills, qualifications and experience",
      "3.4.4. Work experience",
      "3.4.5. English proficiency"
    ]
  },
  "485": {
    "title": "Subclass 485 (Temporary Graduate) visa",
    "latestLegendVersion": "6 Febuary 2026",
    "documentId": "VM-2196",
    "contact": "Temporary Graduate Program Management Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 485.docx",
    "criteriaHeadings": [
      "6 Febuary 2026",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Latest changes",
      "3.2. Subclass 485 visa background",
      "3.2.1. Post-Vocational Education Work stream",
      "3.2.2. Post-Higher Education Work stream",
      "3.2.3. Replacement stream",
      "3.3. Subclass 485 – Schedule 1 application requirements",
      "3.3.1. Item 1229 - Overview",
      "3.3.2. Lodgement arrangements",
      "3.3.3. Visa application charge (VAC)",
      "3.3.4. Certain applicants may be in or outside Australia when making an application",
      "3.3.5. Location of all other applicants",
      "3.3.6. Combined applications",
      "3.3.7. Applicant seeking to satisfy the primary criteria must nominate one stream only",
      "3.3.8. Requirements for applicants seeking to satisfy the primary criteria",
      "3.3.9. Qualifying visa requirement (paragraph 1229(4)(a))",
      "3.3.10. If primary applicants fails, all fail",
      "3.3.11. Subclass 485 visa streams",
      "3.3.12. Subclass 485 visa secondary applicants",
      "3.3.13. Limitations on Subclass 485 visa applications",
      "3.4. Subclass 485 criteria for visa grant",
      "3.4.1. Overview of the primary and secondary criteria",
      "3.5. Common criteria for visa grant – primary applicant",
      "3.5.1. Not previously a Subclass 476 or Subclass 485 visa holder",
      "3.5.2. English proficiency",
      "3.5.3. Character",
      "3.5.4. Adequate arrangements for health insurance",
      "3.5.5. Public Interest Criteria",
      "3.5.6. Special return criteria",
      "3.5.7. Visa capping",
      "3.6. Post-Vocational Education Work stream criteria for visa grant – primary applicant",
      "3.6.1. The Subclass 485 Study requirement"
    ]
  },
  "489": {
    "title": "[Sch2Visa489] Sch2Visa489 - Skilled - Regional (Provisional)",
    "latestLegendVersion": "Legislative change – 18 November 2017",
    "documentId": "VM-3107",
    "contact": "",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 489.docx",
    "criteriaHeadings": [
      "PAM3: Sch6D - General points test - Qualifications and points",
      "PAM3: Div2.6 - Prescribed qualifications - Application of points system",
      "1 About SP-489",
      "2 Legislative requirements",
      "3 Public interest criteria",
      "4 Special return criteria",
      "5 “One fails, all fail” criteria",
      "6 Invitation",
      "7 Suitable skills assessment",
      "8 Australian study leading to skills assessment",
      "9 English threshold",
      "10 Points test",
      "11 Nomination/sponsorship",
      "12 Nomination",
      "13 Sponsorship",
      "14 The health requirement – SP-489 First Provisional Visa stream",
      "15 Complied with visa conditions",
      "16 The health requirement – SP-489 Second Provisional Visa stream",
      "17 Member of the family unit - Eligibility",
      "18 Family member who previously held a provisional GSM visa",
      "19 Family members - PICs",
      "20 Special return criteria",
      "21 Primary applicant must be visaed first",
      "22 Payment of 2nd instalment VAC",
      "23 Where the applicant must be to be granted their SP-489 visa",
      "24 The SP-489 visa period",
      "25 SP-489 visa conditions",
      "1.1 Overview",
      "1.2 SP-489 legislation",
      "Schedule 2 Part 489 structure",
      "Regulations Schedule 2 Part 489 is structured as follows.",
      "Nomination",
      "an eligible Australian relative sponsor, living in a designated area.",
      "if the applicant is sponsored by a relative, condition 8549",
      "Points-tested SP-489 First Provisional stream"
    ]
  },
  "491": {
    "title": "Skilled Work Regional (Provisional) visa – Subclass 491",
    "latestLegendVersion": "16 November 2019",
    "documentId": "VM-6395",
    "contact": "Skilled and Migration Program Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 491.docx",
    "criteriaHeadings": [
      "PAM3: Div2.6 - Prescribed qualifications - Application of points system",
      "PAM3: English proficiency & assessment",
      "Public Interest Criterion 4020 – The Integrity PIC",
      "16 November 2019",
      "1. Purpose",
      "2. Scope",
      "3. Policy Intent",
      "3.1 Strategic Context",
      "3.2 Objectives of the program",
      "4. Procedural Instruction",
      "4.1 About Subclass 491",
      "4.2 Subclass 491 legislation",
      "4.2.1 Schedule 2 Part 491 structure",
      "4.3 Subclass 491 – section 499 directions",
      "5. Schedule 1 requirements",
      "5.1 Legislative requirements",
      "5.2 If Schedule 1 requirements are not met",
      "5.3 If primary application is invalid, all ‘combined’ applications are invalid",
      "6. Schedule 1 Requirements",
      "6.1 Item 1241 of Schedule 1",
      "6.1.1 Application form",
      "6.1.2 Visa application charge",
      "6.1.3 Where Subclass 491 visa applicants must be",
      "6.1.4 Qualifying visas",
      "6.1.5 No further application conditions – waiver provisions",
      "6.1.6 Primary applicant",
      "6.1.7 Invitation required",
      "6.1.8 Application must be made within the specified period",
      "6.1.9 Applicant must not have turned 45 at the time of invitation",
      "6.1.10 Applicant must nominate a skilled occupation",
      "6.1.11 Applicant’s nomination by a State or Territory government agency has not been withdrawn",
      "6.1.12 Applicant declares they are sponsored by an eligible relative",
      "6.1.13 Declaration regarding live work and study",
      "7. Schedule 2 Criteria",
      "7.1 Invitation"
    ]
  },
  "494": {
    "title": "Skilled Employer Sponsored Regional (Provisional) visa (Subclass 494) – visa applications",
    "latestLegendVersion": "14 October 2024",
    "documentId": "VM-6405",
    "contact": "Employer Sponsored Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 494.docx",
    "criteriaHeadings": [
      "Skilled Employer Sponsored Regional (Provisional) visa (Subclass 494) – visa applications",
      "Migration Regulations - Schedules > Skilled Employer Sponsored Regional (Provisional) visa (Subclass 494) – visa applications",
      "14 October 2024",
      "Employer Sponsored Program Management",
      "Employer.Sponsored.PM@homeaffairs.gov.au",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. Procedural Instruction",
      "3.1. Overview of the Skilled Employer Sponsored Regional (Provisional) visa program",
      "3.1.1. About the Skilled Employer Sponsored Regional (Provisional) visa program",
      "3.1.2. About the SESR visa",
      "3.1.3. The application process and streams",
      "3.2. Visa application validity requirements",
      "3.2.1. Schedule 1 Item 1242 Skilled Employer Sponsored Regional (Provisional) (Class PE)",
      "3.2.2. The application form",
      "3.2.3. The visa application charge (VAC)",
      "3.2.4. Where the application must be made",
      "3.2.5. What visa must be held if applicant onshore",
      "3.2.6. Combined and separate applications",
      "3.2.7. Related nomination",
      "3.2.8. Payment for visa sponsorship declaration",
      "3.2.9. Skill assessment declaration for Employer Sponsored stream applicants",
      "3.2.10. No further application conditions – waiver provisions",
      "3.2.11. Bridging visas",
      "3.3. Visa criteria applicable to all primary applicants",
      "3.3.1. Overview",
      "3.3.2. Approved nomination",
      "3.3.3. Genuine intention",
      "3.3.4. Adverse information",
      "3.3.5. Paying for visa sponsorship",
      "3.4. Additional visa criteria – primary applicants – Employer Sponsored stream",
      "3.4.1. Direct employer or associated entity",
      "3.4.2. The applicant’s age"
    ]
  },
  "500": {
    "title": "Subclass 500 (Student) visa",
    "latestLegendVersion": "07 November 2025",
    "documentId": "VM-3680",
    "contact": "Student Program Management Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 500.docx",
    "criteriaHeadings": [
      "07 November 2025",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Latest Changes",
      "3.2. Strategic context",
      "3.3. Objectives of the Subclass 500 visa program",
      "3.4. Stakeholder roles and responsibilities",
      "3.4.1. Role of the Department of Education",
      "3.4.2. Role of the Department of Foreign Affairs and Trade and the Department of Defence",
      "3.5. Overview to this instruction",
      "3.5.1. Simplified Student Visa Framework (SSVF)",
      "3.5.2. Country and education provider evidence framework",
      "3.6. The Subclass 500 visa",
      "3.6.1. About the Subclass 500 visa",
      "3.6.2. Study on other visas",
      "3.7. Education providers",
      "3.7.1. Definition of education provider",
      "3.7.2. CRICOS registration codes – National registration",
      "3.7.3. Monitoring education providers",
      "3.7.4. Dealing with complaints and referrals",
      "3.7.5. Provider default",
      "3.8. Subclass 500 - Schedule 1 application validity requirements",
      "3.8.1. Item 1222 - Overview",
      "3.8.2. Lodgement arrangements",
      "3.8.3. Visa application charge",
      "3.8.4. Location of applicant when making an application",
      "3.8.5. Evidence of enrolment",
      "3.8.6. Welfare of minors",
      "3.8.7. Combined applications",
      "3.8.8. Applications made in Australia – Visa status",
      "3.9. Subclass 500 - Schedule 2 criteria",
      "3.9.1. Overview of the primary and secondary criteria",
      "3.9.2. The country and provider evidence framework",
      "3.10. Primary criteria for visa grant"
    ]
  },
  "590": {
    "title": "[Sch2Visa590] Subclass 590 (Student Guardian) visa",
    "latestLegendVersion": "01 January 2024",
    "documentId": "VM-3681",
    "contact": "",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 590.docx",
    "criteriaHeadings": [
      "01 January 2024",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Latest changes",
      "3.2. Objectives of the Subclass 590 visa program",
      "3.3. Stakeholder Roles",
      "3.4. Subclass 590 - Schedule 1 application validity requirements",
      "3.4.1. Item 1222 - Overview",
      "3.4.2. Lodgement arrangements",
      "3.4.3. Visa application charge (VAC)",
      "3.4.4. Location of applicant when making an application",
      "3.4.5. Combined applications",
      "3.4.6. Applications made in Australia – Visa Status",
      "3.5. Subclass 590 - Schedule 2 criteria",
      "3.5.1. Overview of the primary and secondary criteria",
      "3.6. Primary criteria for visa grant",
      "3.6.1. Nominating student",
      "3.6.2. Student age requirements / Bilateral Benefits cases",
      "3.6.3. Residence intentions in Australia",
      "3.6.4. Family composition",
      "3.6.5. Welfare arrangements for non-accompanying dependent children",
      "3.6.6. Genuine applicant for entry and stay as a Student Guardian",
      "3.6.7. Financial capacity",
      "3.6.8. Health insurance",
      "3.6.9. Public interest criteria",
      "3.6.10. Special return criteria",
      "3.7. Secondary criteria for visa grant",
      "3.7.1. Overview - Family members",
      "3.7.2. Health insurance",
      "3.7.3. Public interest criteria",
      "3.7.4. Special return criteria",
      "3.8. Visa grant – location, visa period and conditions",
      "3.8.1. Overview – legislative provisions",
      "3.8.2. Visa grant period – policy arrangements"
    ]
  },
  "600": {
    "title": "Subclass 600 (Visitor) visa",
    "latestLegendVersion": "06 December 2024",
    "documentId": "VM-3190",
    "contact": "Visitor Visas Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 600.docx",
    "criteriaHeadings": [
      "06 December 2024",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. Background",
      "3.2. Subclass 600 Visa Streams",
      "3.3. Applying for a Subclass 600 Visa – Schedule 1 visa application validity requirements",
      "3.3.1. Item 1236 of Schedule 1",
      "3.3.2. Subclass 600 Visa Application Charge (VAC) – subitem 1236(2)",
      "3.3.2.1. Fee for priority consideration",
      "3.3.2.2 Eligibility for a nil VAC",
      "3.3.3. VAC refund considerations",
      "3.4. Assessing Subclass 600 Visa Applications",
      "3.4.1. Streamlining and risk considerations",
      "3.4.2. Biometrics",
      "3.4.3 Identity and passports",
      "3.4.4. Natural Justice and Procedural Fairness",
      "3.4.5. Privacy considerations",
      "3.4.6. Conflict of Interest",
      "3.5. Schedule 2 Visa Criteria",
      "3.5.1. Genuine intention to stay temporarily in Australia - clause 600.211",
      "3.5.1.1. Previous visa compliance – paragraph 600.211(a)",
      "3.5.1.2. Intention to comply with Subclass 600 conditions – paragraph 600.211(b)",
      "3.5.1.3. Any other relevant matter – paragraph 600.211(c)",
      "3.5.2. Adequate means of support – clause 600.212",
      "3.6. Public Interest Criteria (PIC) - clause 600.213",
      "3.6.1. Introduction",
      "3.6.2. Character and security related criteria",
      "3.6.2.1. Regulation 2.03AA",
      "3.6.2.2. PIC 4001 - Character",
      "3.6.3. PIC 4004 - Debt to the Commonwealth",
      "3.6.4. PIC 4005 - Health",
      "3.6.5. PIC 4011 - The risk factor criterion",
      "3.6.6. PIC 4013 and 4014 - Immigration history related criteria",
      "3.6.7. PIC 4020 - Integrity"
    ]
  },
  "602": {
    "title": "Subclass 602 - (Medical Treatment) visa",
    "latestLegendVersion": "19 December 2025",
    "documentId": "VM-1026",
    "contact": "Visitor Visa Program",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 602.docx",
    "criteriaHeadings": [
      "19 December 2025",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. About the Medical Treatment visa (MTV)",
      "3.2 The regulatory framework",
      "3.3 Applying for an MTV",
      "3.3.1 Applications made in Australia",
      "3.4 Assessing MTV applications",
      "3.5 Schedule 2 criteria",
      "3.6 Purpose of visit – clause 602.211",
      "3.6.1 Definition of ‘Medical treatment’",
      "3.7 Medical Treatment Visa categories – clause 602.212",
      "3.7.1 Medical treatment category - subclause 602.212(2)",
      "3.7.2 Organ donor category - subclause 602.212(3)",
      "3.7.3 Support person category - subclause 602.212(4)",
      "3.7.4 Western Province PNG residents with support from Queensland Health category – subclause 602.212(5)",
      "3.7.5 Unfit to depart category - subclause 602.212(6)",
      "3.7.6 Financial hardship category – subclause 602.212(7)",
      "3.7.7 Compelling personal reasons category - subclause 602.212(8)",
      "3.8 Immigration status – clause 602.213",
      "3.9 Australian citizens or permanent residents must not be disadvantaged - clause 602.214",
      "3.9.1 Evidence regarding services in short supply",
      "3.10 Genuine intention to stay temporarily in Australia - clause 602.215",
      "3.10.1 Previous visa compliance – paragraph 602.215(1)(a)",
      "3.10.2 Intention to comply with Subclass 602 conditions – paragraph 602.215(1)(b)",
      "3.10.3 Any other relevant matter – paragraph 602.215(1)(c)",
      "3.10.4 Requesting further evidence",
      "3.10.5 Palliative care",
      "3.10.6 Ongoing treatment",
      "3.10.7 Availability of treatment overseas",
      "3.11 Adequate means of support – clause 602.216",
      "3.11.1 Evidence in relation to adequate means of support",
      "3.12 Public Interest Criteria (PIC) - clause 602.217",
      "3.12.1 PIC 4001, 4002 and 4003 – Character- and security-related criteria"
    ]
  },
  "785": {
    "title": "The Protection Visa Processing Guidelines",
    "latestLegendVersion": "01 August 2025",
    "documentId": "VM-4825",
    "contact": "Protection Caseload and Assessment Support Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 785.docx",
    "criteriaHeadings": [
      "01 August 2025",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. Part 1 - Background",
      "3.1. Australia's protection obligations",
      "3.2. Unauthorised arrivals",
      "3.3. Application bars",
      "4. Part 2 - Application lodgement and validity",
      "4.1. PV application validity",
      "4.2. Lodging PV applications",
      "4.3. Requiring personal identifiers",
      "4.4. Prioritising protection visa applications",
      "4.5. Managing sensitive cases",
      "5. Part 3 - Criteria for PV applicants",
      "5.1. Criteria in the Migration Act",
      "5.2. Criteria in the Regulations",
      "6. Part 4 - Assessing identity, nationality or citizenship",
      "6.1. Overview to assessing identity",
      "6.2. Bogus documents",
      "6.3. Sections 91W and 91WA",
      "6.4. Determining an applicant's age",
      "7. Part 5 - Release of information and documents",
      "7.1. Release of information relating to PV applicants",
      "7.2. Releasing information to other areas of the Department or overseas posts",
      "8. Part 6 - Assistance for applicants",
      "8.1. Application assistance",
      "9. Part 7 - Members of the same family unit",
      "9.1. Inclusion of family members in PV applications and decisions",
      "9.2. Adding other family members to a PV application before a decision",
      "10. Part 8 - Research relating to the application",
      "10.1. Clarification of particulars and claims",
      "10.2. Section 5AAA responsibilities of applicants",
      "10.3. Protection in another country"
    ]
  },
  "790": {
    "title": "The Protection Visa Processing Guidelines",
    "latestLegendVersion": "01 August 2025",
    "documentId": "VM-4825",
    "contact": "Protection Caseload and Assessment Support Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 790.docx",
    "criteriaHeadings": [
      "01 August 2025",
      "1. Purpose",
      "2. Scope",
      "2.1. In Scope",
      "2.2. Out of Scope",
      "3. Part 1 - Background",
      "3.1. Australia's protection obligations",
      "3.2. Unauthorised arrivals",
      "3.3. Application bars",
      "4. Part 2 - Application lodgement and validity",
      "4.1. PV application validity",
      "4.2. Lodging PV applications",
      "4.3. Requiring personal identifiers",
      "4.4. Prioritising protection visa applications",
      "4.5. Managing sensitive cases",
      "5. Part 3 - Criteria for PV applicants",
      "5.1. Criteria in the Migration Act",
      "5.2. Criteria in the Regulations",
      "6. Part 4 - Assessing identity, nationality or citizenship",
      "6.1. Overview to assessing identity",
      "6.2. Bogus documents",
      "6.3. Sections 91W and 91WA",
      "6.4. Determining an applicant's age",
      "7. Part 5 - Release of information and documents",
      "7.1. Release of information relating to PV applicants",
      "7.2. Releasing information to other areas of the Department or overseas posts",
      "8. Part 6 - Assistance for applicants",
      "8.1. Application assistance",
      "9. Part 7 - Members of the same family unit",
      "9.1. Inclusion of family members in PV applications and decisions",
      "9.2. Adding other family members to a PV application before a decision",
      "10. Part 8 - Research relating to the application",
      "10.1. Clarification of particulars and claims",
      "10.2. Section 5AAA responsibilities of applicants",
      "10.3. Protection in another country"
    ]
  },
  "820": {
    "title": "Subclass 820 (Partner) visa",
    "latestLegendVersion": "28 July 2023",
    "documentId": "VM-6214",
    "contact": "Partner Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 820.docx",
    "criteriaHeadings": [
      "28 July 2023",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. About the Subclass 820 visa",
      "3.1.1 Eligibility",
      "3.1.2 Circumstances where the applicant is ineligible for a Subclass 820 visa",
      "3.1.3. Order for considering Partner visa applications",
      "3.2. Schedule 1 visa application validity requirements",
      "3.2.1. Schedule 1 item 1214C (Partner (Temporary) (Class UK)",
      "3.2.2. The application form",
      "3.2.3. Visa application charge (VAC)",
      "3.2.4. Where and how the application must be made",
      "3.2.5. Where the applicant must be",
      "3.2.6. Application must be made at the same time and place as a Subclass 801 (Partner) visa",
      "3.2.7. Combined applications",
      "3.2.8. Certain regional visa holders prevented from applying for a Subclass 820 visa",
      "3.2.9. Applicants subject to section 48 of the Act",
      "3.2.10. Bridging visas with nil conditions for certain Partner visa applications",
      "3.2.11. Sponsorship for a Partner to Migrate to Australia",
      "3.3 Schedule 2 criteria – Primary applicant criteria",
      "3.3.1. Criteria to be satisfied at time of application",
      "3.3.2. Eligibility as a Partner",
      "3.3.3. Eligibility as a Sponsor",
      "3.3.4. Criteria to be satisfied at time of decision",
      "3.3.5. Generic visa criteria",
      "3.4. Schedule 2 criteria – secondary applicants",
      "3.4.1. Criteria to be satisfied at time of application",
      "3.4.2. Criteria to be satisfied at time of decision",
      "3.5. Visa grant",
      "3.5.1. Where the Subclass 820 applicant must be to be granted their visa",
      "3.6. The subclass 820 visa period",
      "3.7. Subclass 820 visa conditions",
      "3.8. Visa refusal",
      "3.8.1. If the visa is refused while that applicant is in Australia - bridging visa"
    ]
  },
  "836": {
    "title": "Carer visas (subclass 116 and subclass 836)",
    "latestLegendVersion": "03 October 2025",
    "documentId": "VM-7144",
    "contact": "Family and Permanent Resident Visa Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 836.docx",
    "criteriaHeadings": [
      "03 October 2025",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. The Carer visa",
      "3.2. Applicable visa classes and subclasses",
      "3.3. Schedule 1 validity requirements",
      "3.3.1. Application form",
      "3.3.2. Visa application charge - first instalment",
      "3.3.3. Where and how the application must be made",
      "3.3.4. Where the visa applicant must be",
      "3.3.5. Satisfactory evidence",
      "3.3.6. Combined applications and members of the family unit",
      "3.3.7. Bridging visa eligibility",
      "3.4. Schedule 2 – Time of application primary criteria",
      "3.4.1. Immigration Status – Subclass 836 only",
      "3.4.2. Carer requirements",
      "3.4.3. Sponsorship requirements",
      "3.4.4. Eligibility",
      "3.5 Schedule 2 - Time of decision primary criteria",
      "3.5.1 Assessment of the carer under Regulation 1.15AA",
      "3.5.2 Carer-specific requirements - summary",
      "3.5.3 Must be a relative",
      "3.5.4 Assessing ‘usual residence’ of the person with the medical condition",
      "3.5.5 MoFU of the Australian relative may be the one who has the medical condition.",
      "3.5.6 Nature of the impairment",
      "3.5.7 The Bupa medical assessment process",
      "3.5.8 Assistance needs",
      "3.5.9 Other Australian relatives",
      "3.5.10 Assistance cannot be reasonably obtained from welfare, hospital, nursing or community services",
      "3.5.11 Willingness and ability of the visa applicant",
      "3.5.12 Public interest criteria (PICs)",
      "3.5.13 Sponsorship",
      "3.6 Cognitive impairment",
      "3.7 Secondary criteria"
    ]
  },
  "866": {
    "title": "Click to hide panel content",
    "latestLegendVersion": "02 August 2024",
    "documentId": "VM-6236",
    "contact": "Assistant Secretary, Humanitarian Program Operations Branch",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 866.docx",
    "criteriaHeadings": [
      "Regulations Schedule 1 item 1402",
      "Subclass 202 primary criteria",
      "Subclass 203 primary criteria",
      "3.14. Subclass 204 – Woman at Risk",
      "Subclass 204 primary criteria",
      "Split family provisions - primary criteria",
      "Schedule 2 requirements",
      "Proposal by APO must be in effect at time of decision",
      "Time of decision criteria",
      "Public interest and related criteria",
      "The Class XB health requirement",
      "The Class XB character requirement",
      "Other public interest criteria",
      "Departure health check (DHC)",
      "02 August 2024",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. The humanitarian program",
      "3.2. About the offshore humanitarian program",
      "3.3. The offshore humanitarian program – Planning and prioritising",
      "3.4. Class XB visa applications – Application validity",
      "3.5. Class XB application decision making – the legal framework",
      "3.6. Interviewing",
      "3.7. Identity",
      "3.8. Family relationships",
      "3.9. Assessing the Class XB subclasses",
      "3.10. Subclass 200 – Refugee",
      "3.11. Subclass 201 – In-country Special Humanitarian",
      "3.12. Subclass 202 – Global Special Humanitarian",
      "3.13. Subclass 203 – Emergency Rescue",
      "3.15. Split family cases (subclasses 200, 201, 202, 203 and 204)",
      "3.16. Locally engaged employee (LEE) visa policy",
      "3.17. The Community Support Program",
      "3.18. Class XB-specific criteria"
    ]
  },
  "870": {
    "title": "Subclass 870 (Sponsored Parent (Temporary)) visa",
    "latestLegendVersion": "06 February 2026",
    "documentId": "VM-6327",
    "contact": "Family Program Management",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 870.docx",
    "criteriaHeadings": [
      "Subclass 870 (Sponsored Parent (Temporary)) visa",
      "Migration Regulations - Schedules > Subclass 870 (Sponsored Parent (Temporary)) visa",
      "06 February 2026",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. About the SPTV",
      "3.2. Restrictions",
      "3.3. Schedule 1 requirements",
      "3.3.1. The application form",
      "3.3.2. How the application must be made",
      "3.3.3. VAC – first instalment",
      "3.3.4. Applicant does not hold a SPTV",
      "3.3.5. Aged 18 years",
      "3.3.6. Application specifies an approved parent sponsor",
      "3.3.7. Where the visa applicant must be at the time of making application",
      "3.3.8. Cumulative maximum stay",
      "3.4. Combined applications",
      "3.5. Bridging visas",
      "3.6. Schedule 2 – Primary criteria",
      "3.6.1. Sponsorship",
      "3.6.2. Sufficient funds for intended stay in Australia",
      "3.6.3. Subsequent applications and the ‘90 day rule’",
      "3.6.4. Adequate arrangements for health insurance",
      "3.6.5. Substantial compliance with previous visa conditions",
      "3.6.6. Genuine intention to stay in Australia temporarily",
      "3.6.7. Outstanding public health debt",
      "3.6.8. Public Interest Criteria (PICs)",
      "3.6.9. Special Return Criteria",
      "3.6.10. Secondary criteria",
      "3.7. Visa grant",
      "3.7.1. Where the applicant must be at time of visa grant",
      "3.7.2. Payment of the second VAC",
      "3.7.3. When the SPTV is in effect",
      "3.7.4. Adding a newborn child"
    ]
  },
  "888": {
    "title": "[Sch2Visa888] Sch2 Visa 888 - Business Innovation and Investment (Permanent)",
    "latestLegendVersion": "1 July 2020",
    "documentId": "VM-3115",
    "contact": "Skilled and Migration Program Section",
    "knowledgebaseFile": "KNOWLEDGEBASE/SUBCLASS 888.docx",
    "criteriaHeadings": [
      "Sch4 - Public interest criteria",
      "Sch2 Visa 164 - State/Territory Sponsored Senior Executive (Provisional) - PI (VM-4885)",
      "Sch2 Visa 165 - State/Territory Sponsored Investor (Provisional) - PI (VM-4886)",
      "1 July 2020",
      "1. Purpose",
      "2. Scope",
      "3. Procedural Instruction",
      "3.1. About the EC-888 visa",
      "3.2. EC-888 business terms",
      "3.3. Applying for a Business Skills (Permanent)(Class EC) visa",
      "3.3.1. Schedule 1 item 1104BA – General provisions",
      "3.3.2. Nomination",
      "3.3.3. Streams",
      "3.4. Eligibility to apply – Role swapping",
      "3.5. Business Innovation stream primary applicants",
      "3.5.1. The residence requirement",
      "3.5.2. Ownership interest in business",
      "3.5.3. Prevention of recycling of businesses",
      "3.5.4. Taxation requirements",
      "3.5.5. The “2 out of 3” business criteria",
      "3.5.6. Turnover",
      "3.5.7. Exceptional circumstances",
      "3.6. Investor stream primary applicants",
      "3.6.1. The residence requirement",
      "3.6.2. Designated investment",
      "3.7 Significant Investor stream primary applicants",
      "3.7.1. The residence requirement",
      "3.7.2. Complying significant investment and complying investment criteria",
      "3.8. Premium Investor stream primary applicants",
      "3.8.1. At the time of application",
      "3.8.2. Complying premium investment criteria",
      "3.8.3. Entrepreneur stream primary applicants",
      "3.9. EC-888 primary applicant common criteria",
      "3.9.1. Business/investment record and history",
      "3.9.2. Nomination remain in force"
    ]
  }
});


const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  UNKNOWN: "UNKNOWN",
  RISK: "RISK"
});

const SEVERITY = Object.freeze({
  BLOCKER: "BLOCKER",
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW"
});

const EFFECT = Object.freeze({
  INVALID: "INVALID_APPLICATION",
  REFUSAL: "REFUSAL_LIKELY",
  DISCRETIONARY: "DISCRETIONARY_RISK",
  EVIDENCE: "EVIDENCE_GAP",
  INFO: "INFORMATIONAL"
});

const SUPPORTED_SUBCLASSES = Object.freeze([
  "101","103","115","116","173",
  "186","187","188","189","190",
  "300","309","407","408","417",
  "444","461","462","482","485",
  "489","491","494","500","590",
  "600","602","785","790","820",
  "836","866","870","888"
]);

/**
 * High-level regulation references.
 * These are deliberately conservative labels. For production, update each legalSource
 * against current legislation / instruments and maintain version/date stamps.
 */
const LEGAL_SOURCES = Object.freeze({
  COMMON_VALIDITY: "Migration Act 1958; Migration Regulations 1994 Schedule 1 validity requirements and Schedule 2 grant criteria as applicable",
  HEALTH: "Migration Regulations 1994 - public interest health criteria as applicable",
  CHARACTER: "Migration Act 1958 s501 and Migration Regulations 1994 character/public interest criteria as applicable",
  PIC4020: "Migration Regulations 1994 - Public Interest Criterion 4020 where applicable",
  SKILLED: "Migration Regulations 1994, Schedule 1/2 skilled criteria; SkillSelect invitation; Schedule 6D points test where applicable; relevant PAM subclass instruction",
  EMPLOYER: "Migration Regulations 1994 employer sponsored sponsorship, nomination and visa criteria; relevant PAM employer sponsored instruction",
  PARTNER: "Migration Regulations 1994 - partner/prospective marriage/family relationship criteria as applicable",
  STUDENT: "Migration Regulations 1994 - student/guardian criteria including enrolment, genuine student/temporary stay and financial capacity as applicable",
  VISITOR: "Migration Regulations 1994 - visitor temporary stay, genuine visitor and financial capacity criteria as applicable",
  PROTECTION: "Migration Act 1958 and Migration Regulations 1994 - protection/refugee/complementary protection criteria as applicable",
  TRAINING_WORKING: "Migration Regulations 1994 - training, temporary activity, working holiday and work stream criteria as applicable",
  FAMILY_PARENT: "Migration Regulations 1994 - family/parent/carer/remaining relative criteria as applicable",
  BUSINESS: "Migration Regulations 1994 - business innovation/investment criteria as applicable"
});

const PROFILE = Object.freeze({
  "189": { group: "skilled", title: "Skilled Independent", extra: ["invitation","skills","occupation","english","points","age"] },
  "190": { group: "skilled", title: "Skilled Nominated", extra: ["invitation","nomination","skills","occupation","english","points","age"] },
  "491": { group: "skilled", title: "Skilled Work Regional", extra: ["invitation","regional_nomination_or_sponsor","skills","occupation","english","points","age"] },
  "489": { group: "skilled", title: "Skilled Regional (legacy)", extra: ["legacy","sponsorship_or_nomination","skills","occupation","points"] },
  "482": { group: "employer", title: "Skills in Demand / Temporary Skill Shortage", extra: ["sponsor","nomination","occupation","genuine_position","salary","experience","english","lmt"] },
  "186": { group: "employer", title: "Employer Nomination Scheme", extra: ["sponsor","nomination","stream","skills_or_trt","occupation","salary","english"] },
  "187": { group: "employer", title: "Regional Sponsored Migration Scheme (legacy)", extra: ["legacy","regional","nomination","stream","occupation"] },
  "494": { group: "employer", title: "Skilled Employer Sponsored Regional", extra: ["regional","sponsor","nomination","occupation","genuine_position","salary","experience","english"] },
  "407": { group: "training_activity", title: "Training visa", extra: ["sponsor","nomination","training_plan","genuine_temporary_stay","english","financial_capacity"] },
  "408": { group: "training_activity", title: "Temporary Activity visa", extra: ["activity","sponsor_or_support","genuine_temporary_stay","financial_capacity"] },
  "417": { group: "working_holiday", title: "Working Holiday", extra: ["eligible_passport","age","previous_visa","funds","health_character"] },
  "462": { group: "working_holiday", title: "Work and Holiday", extra: ["eligible_passport","age","education","english","government_support_if_required","funds"] },
  "485": { group: "graduate", title: "Temporary Graduate", extra: ["age","recent_study","qualification","skills_if_required","english","health_insurance"] },
  "500": { group: "student", title: "Student", extra: ["coe","genuine_student","financial_capacity","english_if_required","oshc"] },
  "590": { group: "student_guardian", title: "Student Guardian", extra: ["student_link","welfare","financial_capacity","genuine_temporary_stay","health_insurance"] },
  "600": { group: "visitor", title: "Visitor", extra: ["genuine_visitor","purpose","funds","incentive_to_return"] },
  "602": { group: "medical", title: "Medical Treatment", extra: ["medical_treatment","financial_capacity","temporary_stay"] },
  "820": { group: "partner", title: "Partner onshore", extra: ["eligible_sponsor","relationship","onshore","schedule3_if_relevant"] },
  "309": { group: "partner", title: "Partner offshore", extra: ["eligible_sponsor","relationship","offshore"] },
  "300": { group: "partner", title: "Prospective Marriage", extra: ["eligible_sponsor","intention_to_marry","met_in_person","relationship"] },
  "101": { group: "family_child", title: "Child visa", extra: ["child_relationship","sponsor","dependency","custody"] },
  "103": { group: "family_parent", title: "Parent visa", extra: ["parent_relationship","sponsor","balance_of_family","assurance_of_support"] },
  "173": { group: "family_parent", title: "Contributory Parent temporary", extra: ["parent_relationship","sponsor","balance_of_family","assurance_of_support"] },
  "870": { group: "family_parent", title: "Sponsored Parent temporary", extra: ["approved_parent_sponsor","parent_relationship","temporary_stay","health_insurance"] },
  "115": { group: "family_other", title: "Remaining Relative", extra: ["remaining_relative","eligible_sponsor","usually_resident_outside_au"] },
  "116": { group: "family_other", title: "Carer", extra: ["carer_need","eligible_sponsor","medical_assessment"] },
  "836": { group: "family_other", title: "Carer onshore", extra: ["carer_need","eligible_sponsor","medical_assessment","onshore"] },
  "461": { group: "family_other", title: "New Zealand Citizen Family Relationship", extra: ["nz_citizen_relationship","eligible_nz_citizen","family_unit"] },
  "444": { group: "nz_special", title: "Special Category visa", extra: ["nz_passport","arrival_clearance","health_character"] },
  "866": { group: "protection", title: "Protection visa", extra: ["onshore","protection_claims","identity","credibility","exclusion"] },
  "785": { group: "protection", title: "Temporary Protection visa", extra: ["protection_claims","identity","temporary_protection_cohort"] },
  "790": { group: "protection", title: "Safe Haven Enterprise visa", extra: ["protection_claims","identity","safe_haven_cohort"] },
  "188": { group: "business", title: "Business Innovation and Investment provisional", extra: ["invitation","nomination","stream","business_assets","turnover","points_if_relevant"] },
  "888": { group: "business", title: "Business Innovation and Investment permanent", extra: ["held_188","nomination","business_residence","investment_or_business_compliance"] }
});

// ---------------------
// Basic utilities
// ---------------------
function str(v) { return v === undefined || v === null ? "" : String(v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = str(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function date(v) {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function bool(v) {
  if (typeof v === "boolean") return v;
  const s = lower(v);
  if (!s) return null;
  if (["yes","y","true","1","valid","current","approved","positive","held","met","satisfied","pass","passed","eligible"].includes(s)) return true;
  if (["no","n","false","0","invalid","expired","withdrawn","refused","not held","not met","not satisfied","fail","failed","ineligible"].includes(s)) return false;
  return null;
}
function flatten(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function pick(flat, keys) {
  const entries = Object.entries(flat || {});
  const exact = new Map(entries.map(([k,v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const v = flat[key];
    if (v !== undefined && v !== null && str(v) !== "") return v;
    const ev = exact.get(String(key).toLowerCase());
    if (ev !== undefined && ev !== null && str(ev) !== "") return ev;
  }
  const cleaned = entries.map(([k,v]) => [k.toLowerCase().replace(/[\s_\-./]/g, ""), v]);
  for (const key of keys) {
    const want = String(key).toLowerCase().replace(/[\s_\-./]/g, "");
    for (const [ck, v] of cleaned) {
      if (ck.includes(want) && v !== undefined && v !== null && str(v) !== "") return v;
    }
  }
  return null;
}
function has(flat, keys) { return pick(flat, keys) !== null; }
function yes(flat, keys) { return bool(pick(flat, keys)) === true; }
function no(flat, keys) { return bool(pick(flat, keys)) === false; }
function unique(arr) { return Array.from(new Set((arr || []).filter(Boolean).map(String))); }
function ageAt(dob, at) {
  const b = date(dob);
  const a = date(at) || new Date();
  if (!b) return null;
  let age = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < b.getDate())) age -= 1;
  return age;
}
function normaliseAssessment(assessment) {
  const payload = assessment?.form_payload || {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const subclass = str(assessment?.visa_type || pick(flat, ["visaType","visa_type","subclass","visaSubclass"])).replace(/\D/g, "") || "unknown";
  const profile = PROFILE[subclass] || { group: "generic", title: `Subclass ${subclass}`, extra: [] };
  const dob = pick(flat, ["dateOfBirth","dob","birthDate","applicant.dateOfBirth"]);
  const invitationDate = pick(flat, ["invitationDate","skillSelectInvitationDate","eoiInvitationDate"]);
  return {
    assessment, payload, answers, flat, subclass, profile,
    dob, invitationDate,
    age: num(pick(flat, ["age"])) ?? ageAt(dob, invitationDate || new Date()),
    applicantName: str(assessment?.applicant_name || pick(flat, ["applicantName","fullName","name"])),
    evidenceIndex: buildEvidenceIndex(assessment, payload, flat)
  };
}

// ---------------------
// Evidence verification layer
// ---------------------
function buildEvidenceIndex(assessment, payload, flat) {
  const possible = [];
  if (Array.isArray(payload.evidence)) possible.push(...payload.evidence);
  if (Array.isArray(payload.documents)) possible.push(...payload.documents);
  if (Array.isArray(payload.uploads)) possible.push(...payload.uploads);
  if (Array.isArray(assessment?.documents)) possible.push(...assessment.documents);
  if (Array.isArray(assessment?.evidence)) possible.push(...assessment.evidence);

  const docs = possible.map((d, i) => ({
    id: d.id || d.documentId || d.filename || `doc_${i}`,
    type: lower(d.type || d.category || d.label || d.name || d.filename),
    name: str(d.name || d.filename || d.label || d.type || `Document ${i+1}`),
    issueDate: date(d.issueDate || d.issued || d.date),
    expiryDate: date(d.expiryDate || d.expires || d.validUntil),
    verified: bool(d.verified ?? d.isVerified ?? d.accepted),
    raw: d
  }));

  return {
    docs,
    hasDoc(types) {
      const wants = types.map(t => lower(t).replace(/[\s_\-]/g, ""));
      return docs.find(d => wants.some(w => (d.type + " " + lower(d.name)).replace(/[\s_\-]/g, "").includes(w))) || null;
    },
    status(types, answerKeys = []) {
      const doc = this.hasDoc(types);
      const answerYes = answerKeys.length ? yes(flat, answerKeys) : false;
      const answerNo = answerKeys.length ? no(flat, answerKeys) : false;
      const today = new Date();

      if (doc) {
        if (doc.expiryDate && doc.expiryDate < today) return { status: STATUS.FAIL, doc, reason: "document expired" };
        if (doc.verified === false) return { status: STATUS.RISK, doc, reason: "document uploaded but not verified" };
        return { status: STATUS.PASS, doc, reason: "document available" };
      }
      if (answerNo) return { status: STATUS.FAIL, doc: null, reason: "negative questionnaire answer" };
      if (answerYes) return { status: STATUS.UNKNOWN, doc: null, reason: "positive answer but no document verified" };
      return { status: STATUS.UNKNOWN, doc: null, reason: "no verified evidence" };
    }
  };
}

function criterion({ id, criterion, evidenceTypes = [], answerKeys = [], severity, effect, legalSource, missing = [], consequence, recommendation, forceStatus = null, facts = [] }, ctx) {
  const ev = ctx.evidenceIndex.status(evidenceTypes, answerKeys);
  const status = forceStatus || ev.status;
  const considered = [];
  if (ev.doc) considered.push(`Document: ${ev.doc.name}`);
  const ans = pick(ctx.flat, answerKeys);
  if (ans !== null) considered.push(`Questionnaire: ${str(ans)}`);
  considered.push(...facts.filter(Boolean));
  return {
    id,
    criterion,
    status,
    severity,
    legalEffect: effect,
    legalSource,
    evidenceConsidered: unique(considered),
    evidenceMissing: status === STATUS.PASS ? [] : unique(missing),
    evidenceReason: ev.reason,
    finding: findingText(status),
    legalConsequence: consequence || consequenceText(effect),
    evidenceGap: status === STATUS.PASS ? "" : unique(missing).join("; "),
    recommendation: recommendation || recommendationText(status, effect)
  };
}
function findingText(status) {
  if (status === STATUS.PASS) return "Satisfied on the current evidence position, subject to final professional review.";
  if (status === STATUS.FAIL) return "Not satisfied on the current information or evidence.";
  if (status === STATUS.RISK) return "Adverse issue or elevated risk identified.";
  return "Unable to determine because required evidence has not been verified.";
}
function consequenceText(effect) {
  if (effect === EFFECT.INVALID) return "Validity or not-lodgeable issue. The application should not proceed until this is resolved.";
  if (effect === EFFECT.REFUSAL) return "Primary criteria refusal risk if not resolved or evidenced.";
  if (effect === EFFECT.DISCRETIONARY) return "Adverse discretionary, public interest or character/health risk requiring legal review.";
  if (effect === EFFECT.EVIDENCE) return "Evidence gap requiring verification before final advice.";
  return "No adverse consequence identified.";
}
function recommendationText(status, effect) {
  if (status === STATUS.PASS) return "Retain verified evidence on file.";
  if (effect === EFFECT.INVALID) return "Do not lodge until this validity issue is resolved and verified.";
  if (effect === EFFECT.REFUSAL) return "Obtain evidence or address the criterion before lodgement.";
  if (effect === EFFECT.DISCRETIONARY) return "Conduct detailed legal review and prepare submissions if proceeding.";
  return "Request supporting evidence before final advice.";
}

// ---------------------
// Points calculator
// ---------------------
function calculateSkilledPoints(ctx) {
  const f = ctx.flat;
  let points = 0;
  const breakdown = [];

  const add = (factor, pts) => { points += pts; breakdown.push({ factor, points: pts }); };

  const age = ctx.age;
  if (age !== null) {
    if (age >= 18 && age <= 24) add("age", 25);
    else if (age >= 25 && age <= 32) add("age", 30);
    else if (age >= 33 && age <= 39) add("age", 25);
    else if (age >= 40 && age <= 44) add("age", 15);
    else add("age", 0);
  }

  const english = lower(pick(f, ["englishLevel","english","claimedEnglish","englishRequirement"]));
  if (english.includes("superior")) add("English", 20);
  else if (english.includes("proficient")) add("English", 10);
  else add("English", 0);

  const overseas = num(pick(f, ["overseasExperienceYears","overseasWorkExperience","experienceOverseas"]));
  if (overseas !== null) add("overseas skilled employment", overseas >= 8 ? 15 : overseas >= 5 ? 10 : overseas >= 3 ? 5 : 0);

  const aus = num(pick(f, ["australianExperienceYears","australianWorkExperience","experienceAustralia"]));
  if (aus !== null) add("Australian skilled employment", aus >= 8 ? 20 : aus >= 5 ? 15 : aus >= 3 ? 10 : aus >= 1 ? 5 : 0);

  const qual = lower(pick(f, ["qualification","highestQualification","degree"]));
  if (qual.includes("doctor") || qual.includes("phd")) add("qualification", 20);
  else if (qual.includes("bachelor") || qual.includes("master")) add("qualification", 15);
  else if (qual.includes("diploma") || qual.includes("trade")) add("qualification", 10);
  else add("qualification", 0);

  if (yes(f, ["australianStudy","australianStudyRequirement"])) add("Australian study", 5);
  if (yes(f, ["specialistEducation","specialistEducationQualification"])) add("specialist education", 10);
  if (yes(f, ["credentialledCommunityLanguage","naati","communityLanguage"])) add("credentialled community language", 5);
  if (yes(f, ["professionalYear"])) add("professional year", 5);
  if (yes(f, ["regionalStudy"])) add("regional study", 5);
  if (yes(f, ["partnerSkills","skilledPartner"])) add("partner skills", 10);
  if (ctx.subclass === "190") add("state/territory nomination", 5);
  if (ctx.subclass === "491") add("regional nomination/family sponsorship", 15);

  const claimed = num(pick(f, ["claimedPoints","points","totalPoints","eoiPoints"]));
  return { calculated: points, claimed, breakdown };
}

// ---------------------
// Common checks
// ---------------------
function commonChecks(ctx) {
  return [
    criterion({
      id: "HEALTH",
      criterion: "Health requirement",
      evidenceTypes: ["health", "medical"],
      answerKeys: ["healthIssue","medicalIssue","healthConcern","healthMet"],
      severity: SEVERITY.HIGH,
      effect: EFFECT.DISCRETIONARY,
      legalSource: LEGAL_SOURCES.HEALTH,
      missing: ["health examinations", "medical reports if relevant"],
      consequence: "Health issues may affect grant and require further assessment or waiver analysis where available."
    }, ctx),
    criterion({
      id: "CHARACTER",
      criterion: "Character requirement",
      evidenceTypes: ["police", "character", "court"],
      answerKeys: ["characterIssue","criminalHistory","conviction","characterMet"],
      severity: SEVERITY.HIGH,
      effect: EFFECT.DISCRETIONARY,
      legalSource: LEGAL_SOURCES.CHARACTER,
      missing: ["police certificates", "court documents if relevant"],
      consequence: "Character issues may affect grant and must be assessed before any application strategy is recommended."
    }, ctx),
    criterion({
      id: "PIC4020",
      criterion: "Integrity / PIC 4020 risk",
      evidenceTypes: ["prior visa", "department correspondence", "pic4020"],
      answerKeys: ["pic4020","falseDocument","misleadingInformation","integrityIssue"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PIC4020,
      missing: ["prior visa/application records", "Department correspondence", "documents previously submitted"],
      consequence: "Integrity concerns may create serious visa risk and must be resolved before lodgement action."
    }, ctx)
  ];
}
function onshoreValidity(ctx) {
  const f = ctx.flat;
  const adverse = yes(f, ["section48","section48Bar","noFurtherStay","condition8503","condition8534","condition8535"]);
  const clear = no(f, ["section48","section48Bar","noFurtherStay","condition8503","condition8534","condition8535"]);
  const forceStatus = adverse ? STATUS.FAIL : clear ? STATUS.PASS : null;
  return criterion({
    id: "ONSHORE_VALIDITY",
    criterion: "Section 48 / No Further Stay / onshore validity restrictions",
    evidenceTypes: ["vevo", "visa grant", "waiver", "refusal", "cancellation"],
    answerKeys: ["section48","section48Bar","noFurtherStay","condition8503","condition8534","condition8535"],
    severity: SEVERITY.BLOCKER,
    effect: EFFECT.INVALID,
    legalSource: LEGAL_SOURCES.COMMON_VALIDITY,
    missing: ["current visa grant notice", "VEVO", "refusal/cancellation notices", "waiver decision if relevant"],
    forceStatus,
    consequence: "If an onshore bar or No Further Stay condition applies, lodgement may be invalid unless a lawful pathway or waiver applies."
  }, ctx);
}

// ---------------------
// Engines by group
// ---------------------
function runSkilled(ctx) {
  const points = calculateSkilledPoints(ctx);
  const pointStatus = (points.claimed !== null ? points.claimed >= 65 : points.calculated >= 65) ? STATUS.PASS : STATUS.UNKNOWN;
  const findings = [
    criterion({
      id: "SKILLED_INVITATION",
      criterion: "Valid SkillSelect invitation",
      evidenceTypes: ["invitation", "skillselect"],
      answerKeys: ["invitation","skillSelectInvitation","hasInvitation","invitationReceived","invitationDate","skillSelectInvitationDate"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["SkillSelect invitation letter showing invitation date, nominated occupation and points score"]
    }, ctx),
    criterion({
      id: "SKILLED_SKILLS",
      criterion: "Suitable skills assessment",
      evidenceTypes: ["skills assessment", "assessing authority"],
      answerKeys: ["skillsAssessment","positiveSkillsAssessment","hasSkillsAssessment","skillsAssessmentDate","assessingAuthority"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["skills assessment outcome letter", "assessing authority details", "assessment date and reference number"]
    }, ctx),
    criterion({
      id: "SKILLED_OCCUPATION",
      criterion: "Nominated occupation eligibility",
      evidenceTypes: ["anzsco", "occupation list", "occupation"],
      answerKeys: ["occupation","nominatedOccupation","anzsco"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["ANZSCO/nominated occupation evidence", "occupation list evidence at the relevant time"]
    }, ctx),
    criterion({
      id: "SKILLED_ENGLISH",
      criterion: "English language requirement",
      evidenceTypes: ["english", "ielts", "pte", "passport"],
      answerKeys: ["competentEnglish","englishMet","englishRequirement","englishTest","englishLevel","passportCountry"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["English test result or eligible passport evidence"]
    }, ctx),
    criterion({
      id: "SKILLED_POINTS",
      criterion: "Points test threshold and evidence",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["full points calculation", "evidence for each points claim"],
      facts: [`engine calculated points scaffold: ${points.calculated}`, points.claimed !== null ? `claimed points: ${points.claimed}` : ""],
      forceStatus: pointStatus,
      consequence: "The points score must meet the applicable pass mark and be supported by evidence."
    }, ctx),
    criterion({
      id: "SKILLED_AGE",
      criterion: "Age requirement at invitation",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["passport biodata page", "SkillSelect invitation letter"],
      facts: [ctx.age !== null ? `calculated age: ${ctx.age}` : ""],
      forceStatus: ctx.age === null ? STATUS.UNKNOWN : (ctx.age >= 18 && ctx.age < 45 ? STATUS.PASS : STATUS.FAIL)
    }, ctx),
    onshoreValidity(ctx)
  ];

  if (ctx.subclass === "190") {
    findings.push(criterion({
      id: "190_NOMINATION",
      criterion: "Current state or territory nomination",
      evidenceTypes: ["nomination", "state nomination", "territory nomination"],
      answerKeys: ["nomination","stateNomination","territoryNomination","nominationApproved","nominationDate"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["state or territory nomination approval letter", "evidence nomination is current and matches the nominated occupation"]
    }, ctx));
  }
  if (ctx.subclass === "491" || ctx.subclass === "489") {
    findings.push(criterion({
      id: "REGIONAL_NOMINATION_OR_SPONSOR",
      criterion: "Regional nomination or eligible family sponsorship",
      evidenceTypes: ["regional nomination", "family sponsor", "sponsorship"],
      answerKeys: ["regionalNomination","stateNomination","familySponsor","eligibleFamilySponsor","sponsorship"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["regional nomination approval or eligible family sponsorship evidence"]
    }, ctx));
  }
  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings, { points });
}

function runEmployer(ctx) {
  const f = ctx.flat;
  const stream = lower(pick(f, ["stream","visaStream","applicationStream"]));
  const salary = num(pick(f, ["salary","annualSalary","guaranteedAnnualEarnings","marketSalary"]));
  const exp = num(pick(f, ["workExperienceYears","relevantExperienceYears","experience"]));
  const findings = [
    criterion({
      id: "EMP_SPONSOR",
      criterion: "Approved sponsor / sponsoring employer",
      evidenceTypes: ["sponsor approval", "standard business sponsor", "approved sponsor"],
      answerKeys: ["sponsorApproved","approvedSponsor","standardBusinessSponsor","sponsor"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["sponsor approval evidence", "sponsor details"]
    }, ctx),
    criterion({
      id: "EMP_NOMINATION",
      criterion: "Approved nomination / nominated position",
      evidenceTypes: ["nomination approval", "nomination"],
      answerKeys: ["nominationApproved","approvedNomination","employerNomination","nomination"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["nomination approval", "nomination application details"]
    }, ctx),
    criterion({
      id: "EMP_OCCUPATION",
      criterion: "Occupation eligibility and alignment",
      evidenceTypes: ["anzsco", "occupation", "occupation list"],
      answerKeys: ["occupation","nominatedOccupation","anzsco"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["ANZSCO/nominated occupation", "occupation list or labour agreement authority if relevant"]
    }, ctx),
    criterion({
      id: "EMP_GENUINE_POSITION",
      criterion: "Genuine position",
      evidenceTypes: ["position description", "organisation chart", "genuine position"],
      answerKeys: ["genuinePosition","genuineRole","positionGenuine"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["position description", "organisation chart", "business need evidence", "financial/operational evidence"]
    }, ctx),
    criterion({
      id: "EMP_SALARY",
      criterion: "Salary / market salary / income threshold",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["salary evidence", "market salary evidence", "employment contract"],
      facts: [salary !== null ? `salary recorded: ${salary}` : ""],
      forceStatus: salary !== null && salary > 0 ? STATUS.PASS : STATUS.UNKNOWN
    }, ctx),
    criterion({
      id: "EMP_EXPERIENCE",
      criterion: "Relevant work experience / skills for role",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["employment references", "CV", "payslips/tax records", "skills evidence"],
      facts: [exp !== null ? `experience recorded: ${exp} years` : ""],
      forceStatus: exp === null ? STATUS.UNKNOWN : exp >= (ctx.subclass === "482" ? 1 : 2) ? STATUS.PASS : STATUS.FAIL
    }, ctx),
    criterion({
      id: "EMP_ENGLISH",
      criterion: "English language requirement",
      evidenceTypes: ["english", "ielts", "pte", "passport"],
      answerKeys: ["englishMet","englishRequirement","competentEnglish","englishTest","englishLevel"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["English test result or exemption evidence"]
    }, ctx)
  ];

  if (ctx.subclass === "186") {
    findings.push(criterion({
      id: "186_STREAM",
      criterion: "ENS stream selection",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["TRT / Direct Entry / Labour Agreement stream confirmation"],
      facts: [stream ? `stream: ${stream}` : ""],
      forceStatus: stream ? STATUS.PASS : STATUS.UNKNOWN
    }, ctx));
    if (stream.includes("direct")) {
      findings.push(criterion({
        id: "186_DIRECT_ENTRY_SKILLS",
        criterion: "Direct Entry skills assessment / experience",
        evidenceTypes: ["skills assessment", "employment reference"],
        answerKeys: ["skillsAssessment","positiveSkillsAssessment","workExperienceYears"],
        severity: SEVERITY.CRITICAL,
        effect: EFFECT.REFUSAL,
        legalSource: LEGAL_SOURCES.EMPLOYER,
        missing: ["skills assessment if required", "three years experience evidence unless exempt"]
      }, ctx));
    }
    if (stream.includes("trt") || stream.includes("temporary")) {
      findings.push(criterion({
        id: "186_TRT_EMPLOYMENT",
        criterion: "TRT qualifying employment",
        severity: SEVERITY.CRITICAL,
        effect: EFFECT.REFUSAL,
        legalSource: LEGAL_SOURCES.EMPLOYER,
        missing: ["temporary skilled visa history", "employment period evidence", "same employer/occupation evidence"],
        facts: [exp !== null ? `experience recorded: ${exp} years` : ""],
        forceStatus: exp === null ? STATUS.UNKNOWN : exp >= 2 ? STATUS.PASS : STATUS.FAIL
      }, ctx));
    }
  }

  if (ctx.subclass === "187") {
    findings.push(criterion({
      id: "187_LEGACY",
      criterion: "RSMS legacy / transitional eligibility",
      evidenceTypes: ["legacy", "transitional", "regional"],
      answerKeys: ["legacy","transitional","regionalEmployer","187Eligibility"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["legacy/transitional eligibility evidence", "prior visa history", "regional nomination evidence"]
    }, ctx));
  }

  if (ctx.subclass === "494") {
    findings.push(criterion({
      id: "494_REGIONAL",
      criterion: "Regional employer and designated regional position",
      evidenceTypes: ["regional", "regional employer"],
      answerKeys: ["regional","regionalEmployer","designatedRegionalArea"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["regional location evidence", "employer location evidence"]
    }, ctx));
  }

  if (ctx.subclass === "482") {
    findings.push(criterion({
      id: "482_LMT",
      criterion: "Labour market testing or exemption",
      evidenceTypes: ["labour market testing", "lmt", "advertising"],
      answerKeys: ["labourMarketTesting","lmt","advertisingCompleted","lmtExemption"],
      severity: SEVERITY.HIGH,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["LMT advertisements", "exemption basis if relied on"]
    }, ctx));
  }

  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings, { stream });
}

function runPartnerFamily(ctx) {
  const isPartner = ["820","309","300"].includes(ctx.subclass);
  const isParent = ["103","173","870"].includes(ctx.subclass);
  const isChild = ctx.subclass === "101";
  const findings = [];

  if (isPartner) {
    findings.push(criterion({
      id: "PARTNER_RELATIONSHIP",
      criterion: ctx.subclass === "300" ? "Genuine intention to marry / relationship history" : "Genuine spouse or de facto relationship",
      evidenceTypes: ["relationship", "marriage", "de facto", "statement"],
      answerKeys: ["genuineRelationship","relationshipEvidence","spouse","deFacto","partnerRelationship","intentionToMarry","weddingDate"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PARTNER,
      missing: ["relationship statements", "financial evidence", "social evidence", "household evidence", "commitment evidence"]
    }, ctx));
    findings.push(criterion({
      id: "PARTNER_SPONSOR",
      criterion: "Eligible sponsor",
      evidenceTypes: ["sponsor", "citizenship", "permanent residence"],
      answerKeys: ["sponsorEligible","australianSponsor","sponsorCitizenPR","eligibleSponsor"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.PARTNER,
      missing: ["sponsor citizenship/permanent residence evidence", "sponsor limitation checks"]
    }, ctx));
  }

  if (isParent) {
    findings.push(criterion({
      id: "PARENT_RELATIONSHIP",
      criterion: "Parent relationship and sponsorship",
      evidenceTypes: ["birth certificate", "parent", "sponsor"],
      answerKeys: ["parentRelationship","sponsorEligible","approvedParentSponsor"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["birth certificates", "sponsor evidence", "parent-child relationship evidence"]
    }, ctx));
    findings.push(criterion({
      id: "BALANCE_OF_FAMILY",
      criterion: "Balance of family / family composition requirement where applicable",
      evidenceTypes: ["family composition", "balance of family"],
      answerKeys: ["balanceOfFamily","familyComposition"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["family composition evidence", "children residence/citizenship evidence"]
    }, ctx));
  }

  if (isChild) {
    findings.push(criterion({
      id: "CHILD_RELATIONSHIP",
      criterion: "Child relationship, dependency and custody",
      evidenceTypes: ["birth certificate", "custody", "dependency"],
      answerKeys: ["childRelationship","dependency","custody"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["birth certificate", "custody evidence", "dependency evidence"]
    }, ctx));
  }

  if (["115","116","836","461"].includes(ctx.subclass)) {
    findings.push(criterion({
      id: "FAMILY_SPECIFIC",
      criterion: "Subclass-specific family relationship criterion",
      evidenceTypes: ["relationship", "medical", "care", "nz citizen"],
      answerKeys: ["relationshipEvidence","carerNeed","remainingRelative","eligibleSponsor","nzCitizenRelationship"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["subclass-specific family relationship evidence", "sponsor eligibility evidence"]
    }, ctx));
  }

  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runTemporaryStudentVisitor(ctx) {
  const group = ctx.profile.group;
  const isStudent = ["500","590"].includes(ctx.subclass);
  const findings = [
    criterion({
      id: "GENUINE_TEMPORARY_STAY",
      criterion: isStudent ? "Genuine student / genuine temporary stay" : "Genuine temporary stay / genuine visitor",
      evidenceTypes: ["statement", "genuine", "purpose"],
      answerKeys: ["genuineTemporaryEntrant","genuineStudent","genuineVisitor","genuineStay","purpose"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: isStudent ? LEGAL_SOURCES.STUDENT : LEGAL_SOURCES.VISITOR,
      missing: ["statement of purpose", "home ties evidence", "immigration history", "travel/study rationale"]
    }, ctx),
    criterion({
      id: "FINANCIAL_CAPACITY",
      criterion: "Financial capacity",
      evidenceTypes: ["bank", "financial", "income", "funds"],
      answerKeys: ["financialCapacity","funds","sufficientFunds","bankBalance","income"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: isStudent ? LEGAL_SOURCES.STUDENT : LEGAL_SOURCES.VISITOR,
      missing: ["bank statements", "income evidence", "sponsor support evidence"]
    }, ctx)
  ];

  if (ctx.subclass === "500") {
    findings.push(criterion({
      id: "500_COE",
      criterion: "Confirmation of Enrolment",
      evidenceTypes: ["coe", "confirmation of enrolment"],
      answerKeys: ["coe","confirmationOfEnrolment","course"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.STUDENT,
      missing: ["Confirmation of Enrolment"]
    }, ctx));
  }

  if (["407","408","417","462","485","602"].includes(ctx.subclass)) {
    findings.push(criterion({
      id: "TEMP_ACTIVITY_SPECIFIC",
      criterion: "Subclass-specific temporary activity/work/graduate/medical criterion",
      evidenceTypes: ["activity", "training", "passport", "education", "medical", "qualification"],
      answerKeys: ["activity","trainingPlan","eligiblePassport","education","medicalTreatment","qualification","recentStudy"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.TRAINING_WORKING,
      missing: ["subclass-specific eligibility evidence"]
    }, ctx));
  }

  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runProtection(ctx) {
  const findings = [
    criterion({
      id: "PROTECTION_ONSHORE_OR_COHORT",
      criterion: "Protection pathway location/cohort eligibility",
      evidenceTypes: ["visa status", "arrival", "immigration status"],
      answerKeys: ["inAustralia","onshore","temporaryProtectionCohort","safeHavenCohort"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.PROTECTION,
      missing: ["current location/status evidence", "arrival and visa history evidence"]
    }, ctx),
    criterion({
      id: "PROTECTION_CLAIMS",
      criterion: "Protection claims / fear of harm",
      evidenceTypes: ["protection claim", "country information", "statement"],
      answerKeys: ["protectionClaim","fearOfHarm","refugeeClaim","complementaryProtection","persecution"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PROTECTION,
      missing: ["detailed protection statement", "country information", "harm/threat evidence"]
    }, ctx),
    criterion({
      id: "PROTECTION_IDENTITY",
      criterion: "Identity, nationality and credibility",
      evidenceTypes: ["passport", "identity", "birth certificate", "national id"],
      answerKeys: ["passport","identityDocument","nationalId","birthCertificate"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PROTECTION,
      missing: ["passport", "identity documents", "explanation for missing identity evidence"]
    }, ctx)
  ];
  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runBusiness(ctx) {
  const findings = [
    criterion({
      id: "BUSINESS_NOMINATION_INVITATION",
      criterion: "Nomination / invitation / stream eligibility",
      evidenceTypes: ["invitation", "nomination", "state nomination"],
      answerKeys: ["invitation","nomination","stateNomination","stream"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.BUSINESS,
      missing: ["invitation/nomination evidence", "stream confirmation"]
    }, ctx),
    criterion({
      id: "BUSINESS_ASSETS_COMPLIANCE",
      criterion: "Business/investment assets, turnover or compliance",
      evidenceTypes: ["business", "investment", "assets", "turnover", "financial"],
      answerKeys: ["businessAssets","investment","turnover","businessCompliance","held188"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.BUSINESS,
      missing: ["business financial evidence", "investment evidence", "ownership/management evidence"]
    }, ctx)
  ];
  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runGeneric(ctx) {
  const findings = [
    criterion({
      id: "GENERIC_SUBCLASS_CRITERIA",
      criterion: `Subclass ${ctx.subclass} grant criteria`,
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.EVIDENCE,
      legalSource: LEGAL_SOURCES.COMMON_VALIDITY,
      missing: ["subclass-specific knowledgebase criteria and evidence"],
      forceStatus: STATUS.UNKNOWN,
      consequence: "The engine does not have enough subclass-specific criteria to safely produce a final automated assessment."
    }, ctx)
  ];
  return finalise(ctx, findings);
}

// ---------------------
// Outcome, bundle and validation
// ---------------------
function classify(findings) {
  const blockerFail = findings.find(f => f.severity === SEVERITY.BLOCKER && f.status === STATUS.FAIL);
  const blockerUnknown = findings.find(f => f.severity === SEVERITY.BLOCKER && f.status === STATUS.UNKNOWN);
  const criticalFail = findings.find(f => f.severity === SEVERITY.CRITICAL && f.status === STATUS.FAIL);
  const risk = findings.find(f => f.status === STATUS.RISK);
  const unknown = findings.find(f => f.status === STATUS.UNKNOWN);

  if (blockerFail) return { decisionStatus: "INVALID_OR_NOT_LODGEABLE", lodgementPosition: "NOT_LODGEABLE", riskLevel: "CRITICAL", legalStatus: EFFECT.INVALID, primaryReason: blockerFail.criterion };
  if (blockerUnknown) return { decisionStatus: "VALIDITY_NOT_CONFIRMED", lodgementPosition: "NOT_LODGEABLE_PENDING_EVIDENCE", riskLevel: "CRITICAL", legalStatus: EFFECT.INVALID, primaryReason: blockerUnknown.criterion };
  if (criticalFail) return { decisionStatus: "PRIMARY_CRITERIA_NOT_MET", lodgementPosition: "LODGEABLE_HIGH_RISK", riskLevel: "HIGH", legalStatus: EFFECT.REFUSAL, primaryReason: criticalFail.criterion };
  if (risk) return { decisionStatus: "ADVERSE_RISK_IDENTIFIED", lodgementPosition: "LEGAL_REVIEW_REQUIRED", riskLevel: "HIGH", legalStatus: risk.legalEffect || EFFECT.DISCRETIONARY, primaryReason: risk.criterion };
  if (unknown) return { decisionStatus: "EVIDENCE_REQUIRED", lodgementPosition: "EVIDENCE_REQUIRED_BEFORE_LODGEMENT", riskLevel: "MEDIUM", legalStatus: EFFECT.EVIDENCE, primaryReason: unknown.criterion };
  return { decisionStatus: "POTENTIALLY_LODGEABLE", lodgementPosition: "POTENTIALLY_LODGEABLE", riskLevel: "LOW", legalStatus: "LIKELY_ELIGIBLE_SUBJECT_TO_REVIEW", primaryReason: "No blocker detected" };
}
function finalise(ctx, findings, extras = {}) {
  const outcome = classify(findings);
  const evidenceRequired = unique(findings.flatMap(f => f.evidenceMissing || []));
  const blockers = findings.filter(f => f.severity === SEVERITY.BLOCKER && f.status !== STATUS.PASS);
  const critical = findings.filter(f => f.severity === SEVERITY.CRITICAL && f.status !== STATUS.PASS);
  return {
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    subclass: ctx.subclass,
    subclassTitle: ctx.profile.title,
    group: ctx.profile.group,
    applicantName: ctx.applicantName,
    ...outcome,
    findings,
    blockers,
    criticalFindings: critical,
    evidenceRequired,
    nextSteps: buildNextSteps(outcome, evidenceRequired),
    qualityFlags: buildQualityFlags(ctx, findings),
    extras
  };
}
function buildNextSteps(outcome, evidenceRequired) {
  const steps = [];
  if (outcome.lodgementPosition.includes("NOT_LODGEABLE")) steps.push("Do not proceed to lodgement until all validity blockers are resolved and verified.");
  if (outcome.riskLevel === "HIGH" || outcome.riskLevel === "CRITICAL") steps.push("Conduct registered migration agent legal review before any application action.");
  if (evidenceRequired.length) steps.push("Collect, verify and retain the listed evidence before final advice.");
  steps.push("Regenerate the advice only after the evidence position changes.");
  return unique(steps);
}
function buildQualityFlags(ctx, findings) {
  const flags = [];
  if (!SUPPORTED_SUBCLASSES.includes(ctx.subclass)) flags.push("Subclass is not in the current engine support list.");
  if (findings.some(f => f.status === STATUS.UNKNOWN)) flags.push("One or more criteria are undetermined due to missing verified evidence.");
  if (findings.some(f => f.status === STATUS.RISK)) flags.push("One or more adverse risk issues require legal review.");
  if (findings.some(f => f.severity === SEVERITY.BLOCKER && f.status !== STATUS.PASS)) flags.push("Validity or not-lodgeable issue detected.");
  if (findings.some(f => !f.legalSource)) flags.push("One or more findings require legal source mapping.");
  return unique(flags);
}
function nice(v) { return str(v).replace(/_/g, " "); }

function runDecisionEngine(assessment) {
  const ctx = normaliseAssessment(assessment || {});
  const group = ctx.profile.group;
  if (["skilled"].includes(group)) return runSkilled(ctx);
  if (["employer"].includes(group)) return runEmployer(ctx);
  if (["partner","family_child","family_parent","family_other","nz_special"].includes(group)) return runPartnerFamily(ctx);
  if (["student","student_guardian","visitor","medical","training_activity","working_holiday","graduate"].includes(group)) return runTemporaryStudentVisitor(ctx);
  if (["protection"].includes(group)) return runProtection(ctx);
  if (["business"].includes(group)) return runBusiness(ctx);
  return runGeneric(ctx);
}


function supportedDelegateSimulatorSubclasses() {
  return SUPPORTED_SUBCLASSES.slice();
}

function getKnowledgeProfileForSubclass(subclass) {
  return KB_SUBCLASS_MATRIX[String(subclass)] || null;
}

function buildCodeOfConductCompliance(decision) {
  const manualReviewRequired = !isAutoIssueAllowed(decision);
  return {
    source: TRAINING_SOURCES.codeOfConduct,
    safeguards: CODE_OF_CONDUCT_SAFEGUARDS.slice(),
    manualReviewRequired,
    consumerGuideAndServiceAgreementRequiredBeforeFurtherAssistance: true,
    identityAndDocumentVerificationRequired: true,
    conflictCheckRequired: true,
    futileAssistanceWarning: (decision && ["CRITICAL", "HIGH"].includes(decision.riskLevel)) || false,
    clientDocumentSecurityRequired: true,
    recordKeepingRequired: true
  };
}

function buildLegalEngineBundle(decision, assessment) {
  const summary = [
    `The ${decision.engine} assessed Subclass ${decision.subclass} (${decision.subclassTitle}) as ${decision.decisionStatus}.`,
    `Risk level: ${decision.riskLevel}.`,
    `Lodgement position: ${nice(decision.lodgementPosition)}.`,
    `Legal classification: ${nice(decision.legalStatus)}.`,
    `Primary reason: ${decision.primaryReason}.`
  ].join(" ");

  const bundle = {
    source: "enterprise_10_10_migration_decision_engine",
    engineVersion: decision.engineVersion,
    title: `Subclass ${decision.subclass} preliminary migration advice`,
    subclass: decision.subclass,
    subclassTitle: decision.subclassTitle,
    riskLevel: decision.riskLevel,
    lodgementPosition: nice(decision.lodgementPosition),
    legalStatus: decision.legalStatus,
    decisionStatus: decision.decisionStatus,
    primaryReason: decision.primaryReason,
    summary,
    executiveSummary: summary,
    applicationValidity: {
      result: nice(decision.lodgementPosition),
      legalStatus: decision.legalStatus,
      blockers: (decision.blockers || []).map(f => f.criterion)
    },
    criterionFindings: (decision.findings || []).map(f => ({
      criterion: f.criterion,
      status: f.status,
      finding: f.finding,
      evidenceConsidered: (f.evidenceConsidered || []).join("; "),
      legalConsequence: f.legalConsequence,
      evidenceGap: f.evidenceGap,
      recommendation: f.recommendation,
      legalEffect: f.legalEffect,
      severity: f.severity,
      legalSource: f.legalSource,
      evidenceReason: f.evidenceReason
    })),
    evidenceRequired: decision.evidenceRequired || [],
    nextSteps: decision.nextSteps || [],
    qualityFlags: decision.qualityFlags || [],
    gptBoundary: {
      role: "drafting_only",
      cannotChange: ["riskLevel","lodgementPosition","legalStatus","decisionStatus","criterionFindings","evidenceRequired"],
      instruction: "GPT may only improve wording. It must not invent evidence, upgrade prospects, remove blockers, or change legal classification."
    },
    autoIssueAllowed: isAutoIssueAllowed(decision),
    manualReviewRequired: !isAutoIssueAllowed(decision),
    knowledgeSource: {
      trainingSources: TRAINING_SOURCES,
      subclassProfile: getKnowledgeProfileForSubclass(decision.subclass),
      coverage: "Migration Act + Migration Regulations + subclass PAM knowledgebase + Code of Conduct safeguards"
    },
    codeOfConductCompliance: buildCodeOfConductCompliance(decision),
    rawDecision: decision
  };

  bundle.qualityFlags = Array.from(new Set([...(bundle.qualityFlags || []), ...(bundle.codeOfConductCompliance.futileAssistanceWarning ? ["Code of Conduct safeguard: high-risk/futile-assistance review required before further assistance."] : []), "Code of Conduct safeguard: preliminary advice only until identity, conflicts, service terms and documents are verified."]));

  bundle.validation = validateAdviceBundle(bundle);
  return bundle;
}

function isAutoIssueAllowed(decision) {
  if (!decision) return false;
  if (decision.riskLevel !== "LOW") return false;
  if (decision.lodgementPosition !== "POTENTIALLY_LODGEABLE") return false;
  if ((decision.qualityFlags || []).length) return false;
  if ((decision.findings || []).some(f => f.status !== STATUS.PASS)) return false;
  return true;
}

function validateAdviceBundle(bundle) {
  const errors = [];
  if (!bundle) errors.push("Missing bundle.");
  if (!bundle?.riskLevel) errors.push("Missing riskLevel.");
  if (!bundle?.lodgementPosition) errors.push("Missing lodgementPosition.");
  if (!bundle?.legalStatus) errors.push("Missing legalStatus.");
  if (!Array.isArray(bundle?.criterionFindings) || !bundle.criterionFindings.length) errors.push("Missing criterionFindings.");
  if ((bundle?.criterionFindings || []).some(f => !f.criterion || !f.status || !f.legalConsequence)) errors.push("One or more findings are incomplete.");
  if ((bundle?.criterionFindings || []).some(f => !f.legalSource)) errors.push("One or more findings are missing legalSource mapping.");
  return { ok: errors.length === 0, errors };
}


/**
 * Compatibility wrapper for existing server.js / pdf.js integrations.
 * Some earlier server builds call buildDelegateSimulatorPdfInputs().
 * This function returns a PDF-safe object while preserving the 10/10 engine output.
 */
function buildDelegateSimulatorPdfInputs(assessment) {
  const decision = runDecisionEngine(assessment || {});
  const adviceBundle = buildLegalEngineBundle(decision, assessment || {});
  return {
    decision,
    assessmentForPdf: assessment || {},
    adviceBundle,
    bundle: adviceBundle,
    pdfInputs: adviceBundle,
    riskLevel: adviceBundle.riskLevel,
    lodgementPosition: adviceBundle.lodgementPosition,
    legalStatus: adviceBundle.legalStatus,
    criterionFindings: adviceBundle.criterionFindings,
    evidenceRequired: adviceBundle.evidenceRequired,
    nextSteps: adviceBundle.nextSteps,
    qualityFlags: adviceBundle.qualityFlags,
    knowledgeSource: adviceBundle.knowledgeSource,
    codeOfConductCompliance: adviceBundle.codeOfConductCompliance
  };
}


module.exports = {
  runDecisionEngine,
  buildDelegateSimulatorPdfInputs,
  buildLegalEngineBundle,
  validateAdviceBundle,
  supportedDelegateSimulatorSubclasses,
  getKnowledgeProfileForSubclass,
  SUPPORTED_SUBCLASSES,
  TRAINING_SOURCES,
  CODE_OF_CONDUCT_SAFEGUARDS,
  ENGINE_VERSION
};
