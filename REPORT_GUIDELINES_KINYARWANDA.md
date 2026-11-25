# ICYITEGEREREZO CY'INGERO ZA RAPORO Z'IMIHIGO (Performance Contract Report Guidelines)

Source: «IMIHIGO IVUGURUYE.xlsx» — system report writing guide, NOT completed work record.
Language: Kinyarwanda.
Note: These guidelines are for system design/reference. They must NOT be shown directly to employees as-is.

## Aggregates
- Targets with Mobilization/Monitoring: 100
- Report templates generated: 300
- Mobilization targets/categories: 59
- Monitoring targets/categories: 62
- Follow-up: not included in these templates

## Rule
- Targets with only Mobilization or Monitoring require all 4 report types under that category; no Follow-up reports.
- Sheet2 rule: Repeated works remain on Sheet2; if none repeated, target name is used as completion example.
- Visibility rule: Only include metrics/targets/beneficiaries/dates/names visible in source; mark others as not visible or template-based.

## Structure per goal (UMUHIGO)
Each goal has Ref No, Category, Title, Visit types (Mobilization/Monitoring), and Sections (H; I; J etc.).

Each goal produces RAPORO 1, RAPORO 2, RAPORO 3 with:
- Igikorwa fatizo (activity purpose)
- Abagomba kukigiramo uruhare (who must be informed/reached)
- Ubumenyi basanzwe bafite ku gikorwa (prior knowledge of participants)
- Ubutumwa / Ibikorwa by'ubukangurambaga (message/activities for Mobilization)
- Uko bakiriye ubutumwa (how message was received)
- Ubushake bwo kwitabira (1-5) (understanding score)
- Ibyo basabwa gukora kugira ngo bitabire (what they were told to do)
- Impamvu zishobora gutuma batitabira (barriers)
- Ibyo bemeranyijweho nyuma ya mobilization (agreements after mobilization)
- [Monitoring only] Ireme ry'igikorwa, Findings (Ibyagaragaye), Itandukaniro n'impamvu, Ingaruka, Ingamba zo gukosora (na deadline n'ushinzwe), Ibipimo / ibimenyetso byihariye

## Goals covered (from data.js)
- UBUKUNGU: 39 goals (Ref 1-39)
- IMIBEREHO MYIZA: 47 goals (Ref 40-86)
- IMIYOBERERE MYIZA: 17 goals (Ref 88-103)

Note: Ref 87 and 100-101 appear in IMIYOBERERE MYIZA with Follow-up only.

## Implementation status
- data.js: 103 goals loaded with visitTypes, sections, category
- docx-report.js: Word report generator supporting Mobilization, Monitoring, Follow-up with per-type tables
- server.js: /api/reports/import (max 500), /api/reports CRUD, /api/reports/docx
- Sample reports imported: 121 (59 Mobilization + 62 Monitoring), all Draft status, editable by employees
