# Changelog

## 26/11/2026: amafoto abikwa kuri Cloudflare R2

- Iyo `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` na `R2_BUCKET` bishyizweho, ifoto ijya muri bucket ya R2 (private); SQLite ibika amakuru make gusa (id, ingano, raporo), bityo snapshot ya GitHub ntiyiyongera.
- Amafoto yari asanzwe muri SQLite yimurirwa kuri R2 yonyine seriveri itangiye (`R2_MIGRATE_ON_START=false` irabihagarika).
- Gusiba ifoto kuri raporo, gusiba raporo, no gusukura amafoto adafite raporo (amasaha 24) bisiba na object muri R2.
- Igipimo cy'ububiko: `R2_MAX_TOTAL_MB` (8000 ku buryo busanzwe, munsi ya 10 GB za free plan).
- Nta paki nshya ikenewe (`src/r2.js` ikoresha S3 API na AWS Signature V4). Test nshya: `test/r2.test.js`.

## 26/11/2026: amafoto (camera / gallery)

- Muri Group III, buri muhigo ufite «📷 Fata ifoto» (camera) na «🖼️ Hitamo muri gallery» (ushobora guhitamo menshi icyarimwe), ibisobanuro kuri buri foto, no kuyikuraho. Hafi amafoto 12 kuri buri muhigo.
- Ifoto isigwa mu browser (≤1280 px, JPEG, ~100–350 KB) mbere yo koherezwa; seriveri igenzura ko ari JPEG nyayo.
- Amafoto abikwa muri SQLite (ameza `photos`) akahuzwa na raporo iyo ibitswe; ayo utabitse asibwa nyuma y'amasaha 24; ayavanywe muri raporo asibwa iyo ibitswe; asibwa na raporo iyo isibwe. Abakozi bose binjiye barayabona, nk'uko babona raporo.
- Word: igice «IV. AMAFOTO» ubu gishyiramo amafoto nyayo n'ibisobanuro byayo.
- Ububiko bw'amafoto bufite igipimo (`PHOTO_MAX_TOTAL_MB`, 25 MB ku buryo busanzwe) kugira ngo snapshot ya GitHub itaba nini cyane.
- APK: uburenganzira bwa camera bwongewe muri `AndroidManifest.xml` na `mobile/scripts/apply-android.js`.
- CSP: `img-src` yemeye `blob:`.

## 26/11/2026: app kuri phone (PWA + APK)

- PWA: `manifest.webmanifest`, `sw.js` n'amashusho (`icons/`); buto «📲 Shyira kuri phone» igaragara iyo Chrome yemeye kwinjiza app.
- APK ya Android: umushinga wa Capacitor muri `mobile/` (ufungura app iri kuri Render muri WebView), n'uburyo bwo kuyibakira kuri GitHub (`.github/workflows/build-apk.yml`). Reba `MOBILE_APK.md`.
- Kuri APK, «Pakura Word» ikoresha «Share» ya Android (WebView ntishobora kumanura blob).
- Seriveri itanga `/manifest.webmanifest`, `/sw.js` na `/icons/*.png`; test yongeweho.

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
