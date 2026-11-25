# Changelog

## 25/11/2026: ibyitegererezo by'amaraporo ku mihigo (Mobilization / Monitoring)

- Umukozi iyo ahisemo umuhigo, Group III imwereka icyitegererezo kuri buri gice (Igikorwa fatizo, Abagomba kukigiramo uruhare, Ubumenyi basanzwe bafite, Ubutumwa, n'ibindi) gifite buto «Emeza uko kuri» (kibika icyitegererezo uko kiri) na «Hindura» (kigishyira mu kazu ko guhindura).
- Ibyitegererezo 300 byakuwe muri «Raporo_z_imihigo_Mobilization_Monitoring.docx», bibitswe muri `samples.js` (imihigo 100; imihigo 87, 100 na 101 ni Follow-up gusa, nta cyitegererezo ifite).
- Iyo umuhigo ufite ibyitegererezo birenze kimwe, umukozi ahitamo «Icyitegererezo 1/2/3».
- «Ubushake bwo kwitabira» na «Ireme ry'igikorwa» ubu bihitwamo n'utubuto (1 · Buke cyane … 5 · Bwinshi cyane).
- Ibyabitswe bikomeza kuba muri `details` y'umuhigo (+ `baseActivity`, `involvedParties`, `specificIndicators`, `sampleIndex`), bityo Word na memo bikora nk'ibisanzwe.
- Seriveri itanga `/samples.js`; test yongeweho.
- Gukosora: `index.html` yarimo `color: var(--ink)` itari mu magambo (syntax error) yatumaga login itagaragara.
## 25/11/2026: imihigo y’ibizakorwa, ibikorwa ku mihigo yose, memo, konti

- Imihigo 103 yanditse mu nshinga y’ibizakorwa (urugero «Gutera inka intanga.») hakurikijwe Sheet1; amazina y’indwara BQ na LSD yahuje na Sheet1.
- Ibikorwa byashyizwe ku mihigo yose 103 (889 muri rusange; 716 bishya bifite inkomoko «Byongeweho»).
- Memo: «IMPAMVU» ubu ni umutwe wa raporo + «YO KU WA» + itariki y’uruzinduko (Word n’ibigaragara kuri ecran); interuro ikoresha «ku muhigo wo …».
- Urupapuro rwo gusaba konti: hongewe «Icyo ushinzwe mu mpine» munsi y’icyo ushinzwe (function); ibikwa muri `duties` kuri `account_requests` na `users` (kolone ishyirwaho yonyine iyo server itangiye).

## Repeatable multi-target visit reports

- Replaced the old single-target visit workflow with a repeatable Group I: category, target, multiple beneficiaries/partners, and target-specific location.
- Added repeatable Group II staff participants with name, responsibility, telephone, and signature.
- Added Group III target selector so users first enter all targets, then complete each target's report details individually.
- Added report-type-specific fields for Sensitization, Monitoring, and Follow-up, including target-specific purpose and evidence fields.
- Updated Word report generation to expand each visit into target rows and include the staff participant table.
- Kept compatibility with previously saved single-target reports.
