-- 10/10 advice-engine compliance: controlled RMA review and audit tables
CREATE TABLE IF NOT EXISTS advice_outputs (
  id bigserial PRIMARY KEY,
  assessment_id text NOT NULL,
  client_advice_object jsonb DEFAULT '{}'::jsonb,
  recommendation text,
  pdf_url text,
  fallback_used boolean DEFAULT false,
  version_metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS advice_audits (
  id bigserial PRIMARY KEY,
  assessment_id text NOT NULL,
  internal_audit_object jsonb DEFAULT '{}'::jsonb,
  criteria_assessed jsonb DEFAULT '[]'::jsonb,
  answer_to_criteria_map jsonb DEFAULT '[]'::jsonb,
  sources_used jsonb DEFAULT '[]'::jsonb,
  warnings jsonb DEFAULT '[]'::jsonb,
  quality_gate_result jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_reviews (
  id bigserial PRIMARY KEY,
  assessment_id text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz DEFAULT now(),
  decision text NOT NULL,
  comments text,
  edited_sections jsonb DEFAULT '{}'::jsonb,
  approval_version text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_requests (
  id bigserial PRIMARY KEY,
  assessment_id text NOT NULL,
  client_email text,
  requested_by text,
  request_details jsonb DEFAULT '{}'::jsonb,
  status text DEFAULT 'open',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advice_outputs_assessment_id ON advice_outputs(assessment_id);
CREATE INDEX IF NOT EXISTS idx_advice_audits_assessment_id ON advice_audits(assessment_id);
CREATE INDEX IF NOT EXISTS idx_agent_reviews_assessment_id ON agent_reviews(assessment_id);
CREATE INDEX IF NOT EXISTS idx_document_requests_assessment_id ON document_requests(assessment_id);
