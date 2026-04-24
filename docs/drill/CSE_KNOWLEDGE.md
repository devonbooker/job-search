# Cloud Security Engineer — Interview Knowledge Layer

**Status:** STUB. This file is the moat per design doc premise 2. Without real content here, the drill is ChatGPT-with-a-UI.

**How it's loaded:** `src/drill/prompts.ts` `buildCompanyAppendix(jobDescription)` scans the JD for known company names and injects the matching section(s) into `DRILL_SYSTEM` as a company-specific appendix. No match → no appendix (generic drill).

**How to fill:** each section below lists 5-15 concrete things that company's CSE interview loop actually tests, at the level a real interviewer would ask at. Cite specific AWS/GCP API fields, specific MITRE technique IDs, specific Terraform resource attributes, specific detection-rule patterns, specific IMDSv2 failure modes. If you can't name it specifically, it doesn't belong here yet.

Format for each bullet:
- **Topic** (L1 / L2 / staff): concrete question an interviewer would ask; what a solid answer contains (verbatim-level specificity); a common wrong-direction a candidate might take.

---

## Wiz

**Role context:** Cloud Security Engineer, detection/response leaning. Interviews test depth on multi-cloud CSPM, runtime container security, and the ability to reason about attack paths rather than individual misconfigurations.

- **(TODO: add 5-10 specific items. Candidate starter list:)**
  - Graph-based attack path reasoning (Wiz's differentiator — they will test this)
  - IMDSv2 + IAM role chaining: specific API call sequences that signal credential theft
  - Kubernetes RBAC in a multi-tenant shared-cluster context
  - CSPM rule tuning: when to suppress vs. when to escalate
  - Runtime detection: Falco vs. eBPF-native tooling tradeoffs

---

## CrowdStrike

**Role context:** Detection Engineer. Tests depth on Falcon API, detection rule authoring, MITRE ATT&CK mapping at technique + sub-technique level.

- **(TODO: add 5-10 specific items. Candidate starter list:)**
  - Falcon Streaming API: event format, rate limits, backfill semantics
  - Writing a custom IOA (Indicator of Attack): specific field matchers, suppression criteria
  - T1003.001 LSASS credential dumping — what telemetry surfaces it, what doesn't
  - Detection-as-code: Falcon Fusion workflow vs. custom RTR script
  - Handling FP rate in prod: tuning methodology, rollout strategy

---

## Snowflake

**Role context:** Cloud Security Architect, data-platform leaning. Tests depth on row-level security, privileged access, cross-account data sharing threat models.

- **(TODO: add 5-10 specific items.)**

---

## Datadog

**Role context:** Security engineer on the observability side — specific overlap with SIEM/SOAR but distinct from CSPM.

- **(TODO: add 5-10 specific items.)**

---

## Generic Series-B startup (AWS-native, no specific company match)

**Role context:** When the JD doesn't match a known company, drill the fundamentals at a depth a staff+ engineer would expect.

- **AWS KMS cross-account grants:** what does `kms:ViaService` actually enforce? How would you design a CMK that can be decrypted by a Lambda in account B but only when invoked via API Gateway in account A?
- **VPC flow logs at scale:** what's the cost model? What fields are NOT in v2 that are in v5? How would you query for lateral movement in Athena?
- **Terraform state management:** describe the blast radius if the S3 backend is compromised. What controls mitigate it? What does `terraform state rm` actually do to subsequent plans?
- **IAM policy design:** `Principal: *` with a Condition is not the same as scoped Principal. When would you legitimately use the former? What's the audit story?
- **(TODO: add 6-10 more.)**

---

## Anti-patterns to avoid (for every section)

- Don't write bullets that would apply to any cloud security role. If a ChatGPT prompt could generate it, it doesn't belong here.
- Don't repeat the same technique across sections — each company has a specific angle. Wiz tests attack paths; CrowdStrike tests detection rules; Snowflake tests data plane. Preserve the distinction.
- Don't describe tools when you should be describing decisions. "Use Falco" is generic. "Tune the default Falco rule `Write below etc` for base images that legitimately write to /etc on first boot, by scoping to the container image tag" is specific.
