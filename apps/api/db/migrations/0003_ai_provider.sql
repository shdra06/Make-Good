-- 0003: say which model provider read a document. Gemini joins Claude.
alter table evidence_extractions drop constraint evidence_extractions_method_check;
alter table evidence_extractions add constraint evidence_extractions_method_check
  check (method in ('claude', 'gemini', 'pattern_rules'));
alter table evidence_extractions drop constraint evidence_extractions_check;
alter table evidence_extractions add constraint evidence_extractions_check
  check (method = 'pattern_rules' or model is not null);
