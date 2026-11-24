"use strict";
// Gukora raporo za Word (memo interne + raporo + amafoto) mu miterere y'amasample ya Cyuve.
const fs = require("node:fs");
const path = require("node:path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun, Footer,
  AlignmentType, WidthType, BorderStyle, ShadingType, PageOrientation, VerticalAlign, HeightRule,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType, TextWrappingSide, TabStopType
} = require("docx");

const emblem = Buffer.from(require("./emblem-data"), "base64");

// Imihigo iva muri data.js (ni yo ikoreshwa na form), kugira ngo tubone izina ry'umuhigo n'icyiciro.
const goalsByRef = (() => {
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "data.js"), "utf8");
    const json = source.replace(/^\s*window\.REPORT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
    const goals = JSON.parse(json).goals || [];
    return new Map(goals.map((goal) => [String(goal.refNo), goal]));
  } catch {
    return new Map();
  }
})();

const TYPES = {
  Monitoring: {
    fileLabel: "Monitoring",
    reason: "Raporo y’ubugenzuzi (Monitoring)",
    reportTitle: "RAPORO Y’UBUGENZUZI (MONITORING)",
    partI: "I. ICYICIRO N’UMUHIGO WAGENZUWE",
    goalHeader: "UMUHIGO WAGENZUWE",
    whoHeader: "ABAGENZUWE",
    whereHeader: "AHO UBUGENZUZI BWAKOREWE",
    partII: "II. AMAKURU KU MUHIGO WAGENZUWE",
    photos: "III. AMAFOTO Y’UBUGENZUZI",
    widths: [400, 1000, 1400, 1600, 2600, 2600, 1700, 2000, 920],
    headers: ["SN", "Umuhigo", "Icyari giteganyijwe", "Icyakozwe", "Ireme ry’igikorwa na Findings",
      "Itandukaniro n’impamvu", "Ingaruka", "Ingamba zo gukosora", "IFOTO"]
  },
  Mobilization: {
    fileLabel: "Mobilization",
    reason: "Raporo y’ubukangurambaga",
    reportTitle: "RAPORO Y’UBUKANGURAMBAGA",
    partI: "I. ICYICIRO N’IMIHIGO YAKOREWE UBUKANGURAMBAGA",
    goalHeader: "UMUHIGO WAKOREWE UBUKANGURAMBAGA",
    whoHeader: "ABAGEZWEHO N’UBUKANGURAMBAGA",
    whereHeader: "AHO UBUKANGURAMBAGA BWAKOREWE",
    partII: "II. AMAKURU KU MIHIGO WAKOREWE UBUKANGURAMBAGA",
    photos: "III. AMAFOTO Y’UBUKANGURAMBAGA",
    widths: [465, 1750, 1351, 2681, 1530, 1620, 1440, 1890, 1493],
    headers: ["SN", "Umuhigo", "Ubumenyi basanzwe bafite ku gikorwa", "Ubutumwa/Ibikorwa by’ubukangurambaga",
      "Uko bakiriye ubutumwa n’ubushake bwo kwitabira", "Ibyo basabwa gukora kugira ngo bitabire",
      "Impamvu zishobora gutuma batitabira", "Ibyemeranyijweho nyuma ya mobilization", "IFOTO"]
  },
  "Follow-up": {
    fileLabel: "Followup",
    reason: "Raporo yo gusubira gusura (Follow-up)",
    reportTitle: "RAPORO YO GUSUBIRA GUSURA (FOLLOW-UP)",
    partI: "I. ICYICIRO N’UMUHIGO WASUBIWEMO GUSURA",
    goalHeader: "UMUHIGO WAKURIKIRANWE",
    whoHeader: "ABASURWE",
    whereHeader: "AHO UBUSURA BWAKOREWE",
    partII: "II. AMAKURU KU MUHIGO WAKURIKIRANWE",
    photos: "III. AMAFOTO Y’UBUSURA",
    widths: [400, 1100, 1500, 2100, 1300, 2400, 2400, 1900, 1120],
    headers: ["SN", "Umuhigo", "Raporo y’ubushize", "Inama yatanzwe ubushize", "Yashyizwe mu bikorwa?",
      "Impamvu niba itarakozwe", "Ibyemeranyijweho (igikorwa gishya)", "Ushinzwe na Deadline", "IFOTO"]
  }
};

const SERIF = "Times New Roman";
const SANS = "Arial";
const border = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 50, bottom: 50, left: 80, right: 80 };

const clean = (value) => (typeof value === "string" ? value.trim() : "");
const noEnd = (value) => clean(value).replace(/[\s.;,:]+$/, "");
const fieldsOf = (report) => report.fields || {};

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(value));
  return match ? match[3] + "/" + match[2] + "/" + match[1] : clean(value);
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function joinList(values) {
  if (values.length <= 1) return values.join("");
  return values.slice(0, -1).join(", ") + " na " + values[values.length - 1];
}

function goalOf(report) {
  const fields = fieldsOf(report);
  const known = goalsByRef.get(String(fields.goal));
  const activity = (report.selectedActivities || []).find((item) => item.goal);
  return {
    title: (known && known.title) || (activity && activity.goal) || clean(fields.goal),
    category: clean(fields.goalCategory) || (known && known.category) || ""
  };
}

function run(text, options = {}) {
  return new TextRun({ text, font: options.font || SERIF, size: options.size || 24, bold: options.bold, underline: options.underline ? {} : undefined, italics: options.italics });
}

function para(children, options = {}) {
  const runs = typeof children === "string" ? [run(children, options)] : children;
  return new Paragraph({ children: runs, alignment: options.alignment, spacing: { before: options.before || 0, after: options.after === undefined ? 120 : options.after, line: options.line }, keepNext: options.keepNext });
}

// Ikirango kiri ibumoso (floating), amagambo ari iruhande yacyo — nk'uko biri mu samples.
function header(imageWidth, imageHeight) {
  const line = (text, underline) => new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 0 },
    children: [run(text, { underline })]
  });
  return [
    new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 0 },
      children: [new ImageRun({
        type: "jpg",
        data: emblem,
        transformation: { width: imageWidth, height: imageHeight },
        altText: { title: "emblemrwenvois", description: "emblemrwenvois", name: "emblem" },
        floating: {
          horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, offset: -133350 },
          verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, offset: 88900 },
          wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.BOTH_SIDES },
          margins: { left: 114300, right: 114300, bottom: 114300 },
          allowOverlap: true
        }
      })]
    }),
    line("Repubulika y’u Rwanda", true),
    line("Intara y’Amajyaruguru"),
    line("Akarere ka Musanze"),
    line("Umurenge wa Cyuve")
  ];
}

const blank = (count = 1) => Array.from({ length: count }, () => new Paragraph({ spacing: { after: 0 }, children: [run("")] }));

function footer() {
  const part = (text) => new TextRun({ text, font: "Cambria", size: 16, bold: true, italics: true });
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 24, space: 1, color: "auto" } },
        tabStops: [{ type: TabStopType.CENTER, position: 4680 }, { type: TabStopType.RIGHT, position: 9360 }],
        children: [part("Email: cyuve@musanze.gov.rw"), new TextRun({ text: "\t", size: 16 }), part("Phone contact: 0782468519"), new TextRun({ text: "\t", size: 16 }), part("Po. Box: 03 Musanze")]
      })
    ]
  });
}

// Igice cya "Authority" kiri mu memo (nk'uko kiri muri sample).
function authorityBlock() {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: none, bottom: none, left: none, right: none };
  const b = (text, options = {}) => new Paragraph({
    alignment: options.alignment,
    spacing: { after: options.after || 0, line: options.line },
    children: [new TextRun({ text, font: SERIF, size: 24, bold: true, underline: options.underline ? {} : undefined })]
  });
  const dots = "…………………………………………………";
  return new Table({
    width: { size: 9026, type: WidthType.DXA },
    columnWidths: [4513, 4513],
    rows: [new TableRow({
      cantSplit: true,
      children: [
        new TableCell({ width: { size: 4513, type: WidthType.DXA }, borders: noBorders, children: [b("Authority Comments:", { after: 60 }), b(dots, { line: 360 }), b(dots, { line: 360 }), b(dots, { line: 360 })] }),
        new TableCell({ width: { size: 4513, type: WidthType.DXA }, borders: noBorders, children: [b("Authority Names, Signature and Stump", { alignment: AlignmentType.CENTER, underline: true, after: 360 }), b("NDAYAMBAJE KARIMA Augustin", { alignment: AlignmentType.CENTER }), b("Executive Secretary/Cyuve Sector", { alignment: AlignmentType.CENTER })] })
      ]
    })]
  });
}

function cell(lines, width, options = {}) {
  const items = (Array.isArray(lines) ? lines : [lines]).flatMap((line) => String(line === undefined || line === null ? "" : line).split("\n"));
  const paragraphs = items.length ? items.map((text) => new Paragraph({
    alignment: options.alignment,
    spacing: { after: 40 },
    children: [new TextRun({ text, font: SANS, size: options.size || 18, bold: options.bold })]
  })) : [new Paragraph({ children: [] })];
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    margins: cellMargins,
    verticalAlign: options.verticalAlign || VerticalAlign.TOP,
    columnSpan: options.columnSpan,
    rowSpan: options.rowSpan,
    shading: options.shaded ? { type: ShadingType.CLEAR, color: "auto", fill: "D9D9D9" } : undefined,
    children: paragraphs
  });
}

const dash = (value) => (clean(value) ? clean(value) : "-");
const labelled = (label, value) => (clean(value) ? label + ": " + clean(value) : "");
const compact = (lines) => lines.filter(Boolean);

function actionLines(actions) {
  return (actions || [])
    .filter((item) => item && (item.action || item.owner || item.deadline))
    .map((item, index) => (index + 1) + ") " + dash(item.action) +
      (item.owner || item.deadline ? " — " + [item.owner && "ushinzwe: " + item.owner, item.deadline && "deadline: " + formatDate(item.deadline)].filter(Boolean).join("; ") : ""));
}

function photoCell(report) {
  const fields = fieldsOf(report);
  const codes = clean(fields.photoCodes);
  const count = parseInt(fields.photoCount, 10);
  if (codes) return codes;
  return count > 0 ? "Reba igice III" : "";
}

const MONITORING_EXTRA = [
  ["inseminationDate", "Itariki y’intanga", true], ["semenType", "Ubwoko bw’intanga"], ["inspectionDate", "Itariki y’isuzuma", true],
  ["inspectionResult", "Ibyavuye mu isuzuma"], ["birthDate", "Itariki yo kubyara", true], ["animalNumber", "Nomero y’itungo/inyana"],
  ["calfRegistered", "Inyana yamenyekanishijwe"], ["vaccinations", "Inkingo"], ["records", "Ububiko bw’amakuru"],
  ["water", "Amazi"], ["shelter", "Ikiraro"], ["hygiene", "Isuku"]
];

function detailRows(type, reports, widths) {
  const rows = [];
  let serial = 0;
  reports.forEach((report) => {
    const f = fieldsOf(report);
    const goal = goalOf(report).title;
    const photo = photoCell(report);
    const agreed = actionLines(report.actions);
    if (type === "Monitoring") {
      const extra = MONITORING_EXTRA.filter(([key]) => clean(f[key]))
        .map(([key, label, isDate]) => label + ": " + (isDate ? formatDate(f[key]) : clean(f[key])));
      const values = [
        String(++serial), goal, dash(f.expected), dash(f.performed),
        compact([labelled("Ireme", f.quality), labelled("Findings", f.findings), ...extra]).join("\n") || "-",
        compact([labelled("Itandukaniro", f.discrepancy), labelled("Impamvu", f.monitoringCause)]).join("\n") || "-",
        dash(f.impact),
        compact([clean(f.correctiveAction), ...agreed]).join("\n") || "-",
        photo
      ];
      rows.push(new TableRow({ children: values.map((value, index) => cell(value, widths[index])) }));
    } else if (type === "Mobilization") {
      const reception = compact([clean(f.messageReception), clean(f.motivation) ? "Ubushake: " + clean(f.motivation) + "/5" : ""]).join("\n");
      const values = [
        String(++serial), goal, dash(f.priorKnowledge), dash(f.messageGiven), dash(reception),
        dash(f.expectedActions), dash(f.participationBarriers),
        compact([clean(f.mobilizationAgreement), ...agreed]).join("\n") || "-",
        photo
      ];
      rows.push(new TableRow({ children: values.map((value, index) => cell(value, widths[index])) }));
    } else {
      const followups = (report.followups || []).filter((item) => item && (item.recommendation || item.status || item.reason || item.newAction || item.owner || item.deadline));
      const legacyActions = (report.actions || []).filter((item) => item && (item.action || item.owner || item.deadline));
      const count = Math.max(followups.length, legacyActions.length, 1);
      for (let i = 0; i < count; i++) {
        const followup = followups[i] || {};
        const legacyAction = legacyActions[i] || {};
        const previous = compact([clean(f.previousReport), labelled("Uruzinduko rwa nyuma", formatDate(f.lastVisitDate))]).join("\n");
        const newAction = followup.newAction || legacyAction.action;
        const owner = followup.owner || legacyAction.owner;
        const deadline = followup.deadline || legacyAction.deadline;
        const values = [
          String(++serial), goal, dash(previous), dash(followup.recommendation), dash(followup.status), dash(followup.reason),
          dash(newAction), compact([clean(owner), deadline ? formatDate(deadline) : ""]).join("; ") || "-",
          i === 0 ? photo : ""
        ];
        rows.push(new TableRow({ children: values.map((value, index) => cell(value, widths[index])) }));
      }
    }
  });
  return rows;
}

function locationTable(config, reports) {
  const widths = [700, 1820, 4140, 2520, 2020, 3020];
  const head = (text, width, options = {}) => cell(text, width, { bold: true, shaded: true, alignment: AlignmentType.CENTER, ...options });
  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        head("SN", widths[0], { rowSpan: 2 }), head("ICYICIRO", widths[1], { rowSpan: 2 }),
        head(config.goalHeader, widths[2], { rowSpan: 2 }), head(config.whoHeader, widths[3], { rowSpan: 2 }),
        head(config.whereHeader, widths[4] + widths[5], { columnSpan: 2 })
      ]
    }),
    new TableRow({ tableHeader: true, children: [head("AKAGARI", widths[4]), head("UMUDUGUDU", widths[5])] })
  ];
  reports.forEach((report, index) => {
    const f = fieldsOf(report);
    const goal = goalOf(report);
    rows.push(new TableRow({
      children: [
        cell(String(index + 1), widths[0]), cell(goal.category, widths[1]), cell(goal.title, widths[2]),
        cell(dash(f.beneficiaryName), widths[3]), cell(clean(f.cell).toUpperCase(), widths[4]), cell(clean(f.village).toUpperCase(), widths[5])
      ]
    }));
  });
  return new Table({ width: { size: 14220, type: WidthType.DXA }, columnWidths: widths, rows });
}

function memoSummary(type, reports) {
  if (type === "Follow-up") {
    const rows = reports.flatMap((report) => report.followups || []).filter((item) => item && (item.recommendation || item.status));
    if (!rows.length) return "";
    const count = (status) => rows.filter((item) => item.status === status).length;
    const uncompleted = rows.filter((item) => item.status === "Igice" || item.status === "Oya").length;
    return "Mu nama " + rows.length + " zakurikiranywe, " + count("Yego") + " zarashyizwe mu bikorwa, " +
      count("Igice") + " zishyirwa mu bikorwa igice, naho " + count("Oya") + " ntizishyirwa mu bikorwa. " +
      (uncompleted ? "Ibitararangira byahawe ibikorwa bishya, ababishinzwe n’igihe ntarengwa muri raporo." : "Inama zose zakurikiranywe zashyizwe mu bikorwa.");
  }
  if (type === "Monitoring") {
    const parts = reports.map((report) => {
      const f = fieldsOf(report);
      return compact([labelled("Icyari giteganyijwe", noEnd(f.expected)), labelled("icyakozwe", noEnd(f.performed)), labelled("ireme ry’igikorwa", noEnd(f.quality))]).join("; ");
    }).filter(Boolean);
    return parts.length ? "Muri ubu bugenzuzi: " + parts.join(" | ") + "." : "";
  }
  const messages = unique(reports.map((report) => noEnd(fieldsOf(report).messageGiven)));
  const reception = unique(reports.map((report) => noEnd(fieldsOf(report).messageReception)));
  const agreements = unique(reports.map((report) => noEnd(fieldsOf(report).mobilizationAgreement)));
  return compact([
    messages.length ? "Ubutumwa bwibanze bwatanzwe: " + messages.join(" | ") + "." : "",
    reception.length ? "Abagezweho babwakiriye batya: " + reception.join(" | ") + "." : "",
    agreements.length ? "Ibyemeranyijweho: " + agreements.join(" | ") + "." : ""
  ]).join(" ");
}

function memoBody(type, reports, context) {
  const { goals, who, cells, villages, visitDate } = context;
  const place = "mu kagari ka " + joinList(cells.map((value) => value.toUpperCase())) +
    (villages.length ? " Umudugudu wa " + joinList(villages.map((value) => value.toUpperCase())) : "");
  const what = { Monitoring: "raporo y’ubugenzuzi (monitoring) ku muhigo wa ", Mobilization: "raporo y’ubukangurambaga ku muhigo wa ", "Follow-up": "raporo yo gusubira gusura (follow-up) ku muhigo wa " }[type];
  const verb = type === "Follow-up" ? "yakozwe" : "bwakozwe";
  const intro = "Nejejwe no kubandikira iyi memo interne ngira ngo mbagezeho ku mugereka wayo " + what + joinList(goals) +
    " " + verb + " kuwa " + visitDate + " ku " + who + " " + place + ".";
  const closing = type === "Monitoring"
    ? "Ibindi bijyanye n’icyari giteganyijwe, icyakozwe, findings, itandukaniro n’impamvu zaryo, ingaruka n’ingamba zo gukosora, murabisanga muri raporo iri ku mugereka. Mbasabye kudushyigikira mu gukurikirana ko izo ngamba zishyirwa mu bikorwa."
    : type === "Mobilization"
      ? "Ibindi bijyanye n’ubumenyi abagezweho bari basanganywe, uko bakiriye ubutumwa, imbogamizi n’ibyemeranyijweho, murabisanga muri raporo iri ku mugereka. Mbasabye kudushyigikira mu gukurikirana ishyirwa mu bikorwa ry’ibyemeranyijweho."
      : "Ibindi bijyanye n’inama zatanzwe ubushize, uko zashyizwe mu bikorwa, impamvu z’ibitarakozwe n’ibyemeranyijweho bishya, murabisanga muri raporo iri ku mugereka. Mbasabye kudushyigikira mu gukurikirana ibyemeranyijweho bishya.";
  return compact([intro, memoSummary(type, reports), closing]);
}

function photoSection(config, reports, signature) {
  const entries = [];
  reports.forEach((report) => {
    const f = fieldsOf(report);
    const count = Math.min(Math.max(parseInt(f.photoCount, 10) || 0, 0), 12);
    const codes = clean(f.photoCodes).split(/[\n,;]+/).map(clean).filter(Boolean);
    const total = Math.max(count, codes.length);
    for (let i = 0; i < total; i++) {
      entries.push("Ifoto " + (entries.length + 1) + (codes[i] ? " — " + codes[i] : "") + (reports.length > 1 ? " (" + dash(f.beneficiaryName) + ")" : ""));
    }
  });
  const children = [para([run(config.photos, { font: SANS, size: 26, bold: true, underline: true }), run(" (labeled photos)", { font: SANS, size: 22, italics: true, bold: true })], { after: 160, keepNext: true })];
  if (!entries.length) {
    children.push(para("Nta mafoto yashyizweho muri raporo.", { font: SANS, size: 22 }));
    return children;
  }
  const half = 7110;
  const rows = [];
  for (let i = 0; i < entries.length; i += 2) {
    const make = (label) => label
      ? new TableCell({
        width: { size: half, type: WidthType.DXA }, borders, margins: cellMargins,
        children: [new Paragraph({ children: [new TextRun({ text: "[Shyiramo ifoto hano]", font: SANS, size: 18, italics: true, color: "808080" })], spacing: { after: 1800 } }),
          new Paragraph({ children: [new TextRun({ text: label, font: SANS, size: 18, bold: true })] })]
      })
      : new TableCell({ width: { size: half, type: WidthType.DXA }, borders, margins: cellMargins, children: [new Paragraph({ children: [] })] });
    rows.push(new TableRow({ cantSplit: true, height: { value: 3200, rule: HeightRule.ATLEAST }, children: [make(entries[i]), make(entries[i + 1])] }));
  }
  children.push(new Table({ width: { size: 14220, type: WidthType.DXA }, columnWidths: [half, half], rows }));
  return children;
}

async function buildReportDocx(reports, options = {}) {
  if (!Array.isArray(reports) || !reports.length) throw new Error("Nta raporo zahiswemo.");
  const type = fieldsOf(reports[0]).visitType;
  const config = TYPES[type];
  if (!config) throw new Error("Ubwoko bw’uruzinduko ntibuzwi: " + (type || "ntabwo bwahiswemo") + ".");
  if (reports.some((report) => fieldsOf(report).visitType !== type)) {
    throw new Error("Raporo zihujwe zigomba kuba zifite ubwoko bumwe bw’uruzinduko.");
  }

  const first = fieldsOf(reports[0]);
  const today = new Date().toISOString().slice(0, 10);
  const reportDate = formatDate(options.reportDate || first.pageDate || today);
  const visitDates = unique(reports.map((report) => formatDate(fieldsOf(report).visitDate)));
  const context = {
    goals: unique(reports.map((report) => goalOf(report).title)),
    who: joinList(unique(reports.map((report) => fieldsOf(report).beneficiaryName))) || "aborozi",
    cells: unique(reports.map((report) => fieldsOf(report).cell)),
    villages: unique(reports.map((report) => fieldsOf(report).village)),
    visitDate: joinList(visitDates) || reportDate
  };
  const staffName = clean(first.staffName) || clean(options.staffName);
  const role = clean(first.staffRole) || "Umukozi ushinzwe Ubworozi";
  const roleLine = /murenge/i.test(role) ? role : role + " mu Murenge wa CYUVE";

  const bold = (text) => run(text, { bold: true });
  const jp = (children, options = {}) => new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 0, line: options.line }, children });
  const memo = [
    ...header(84, 79),
    ...blank(2),
    jp([run("MEMO INTERNE No ………..", { underline: true })]),
    jp([run("REF: SARO")]),
    ...blank(2),
    jp([bold("KUVA KURI: "), run(roleLine)], { line: 276 }),
    jp([bold("KUJYA KURI: "), run("Bwana Umunyamabanga Nshingwabikorwa w’Umurenge wa CYUVE")], { line: 276 }),
    jp([bold("ITARIKI: "), run(reportDate)], { line: 276 }),
    ...blank(1),
    jp([run("IMPAMVU:", { bold: true, underline: true }), bold(" " + config.reason + " ku " + context.who)]),
    ...blank(1),
    jp([run("Bwana Muyobozi,")]),
    ...blank(1),
    ...memoBody(type, reports, context).flatMap((text) => [jp([run(text)], { line: 276 }), ...blank(1)]),
    jp([run("Mugire amahoro.")]),
    ...blank(4),
    jp([bold(staffName)]),
    jp([bold(roleLine)]),
    ...blank(1),
    authorityBlock()
  ];

  const report = [
    ...header(69, 58),
    para([run(config.reportTitle, { font: SANS, size: 26, bold: true, underline: true })], { alignment: AlignmentType.CENTER, after: 200 }),
    para([run(config.partI, { font: SANS, size: 22, bold: true })], { after: 120, keepNext: true }),
    locationTable(config, reports),
    para("", { after: 160 }),
    para([run(config.partII, { font: SANS, size: 22, bold: true })], { after: 120, keepNext: true }),
    new Table({
      width: { size: 14220, type: WidthType.DXA },
      columnWidths: config.widths,
      rows: [
        new TableRow({ tableHeader: true, children: config.headers.map((text, index) => cell(text, config.widths[index], { bold: true, shaded: true, alignment: AlignmentType.CENTER, size: 16 })) }),
        ...detailRows(type, reports, config.widths).map((row) => row)
      ]
    }),
    para([run("Bikorewe Cyuve kuwa " + reportDate)], { alignment: AlignmentType.CENTER, before: 160, after: 120 }),
    ...blank(4),
    new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 0 }, children: [run(staffName, { bold: true })] }),
    new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 0 }, children: [run(roleLine, { bold: true })] })
  ];

  const landscape = {
    page: {
      size: { width: 12240, height: 15840, orientation: PageOrientation.LANDSCAPE },
      margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 708, footer: 500 }
    }
  };
  const doc = new Document({
    creator: staffName || "MoniMobi",
    title: config.reportTitle,
    styles: { default: { document: { run: { font: SERIF, size: 24 } } } },
    sections: [
      { properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 } } }, footers: { default: footer() }, children: memo },
      { properties: landscape, footers: { default: footer() }, children: report },
      { properties: landscape, footers: { default: footer() }, children: photoSection(config, reports) }
    ]
  });
  return Packer.toBuffer(doc);
}

function docxFileName(reports) {
  const first = fieldsOf(reports[0]);
  const config = TYPES[first.visitType] || { fileLabel: "Raporo" };
  const date = clean(first.visitDate) || new Date().toISOString().slice(0, 10);
  return "Raporo_Imihigo_" + config.fileLabel + "_" + date + ".docx";
}

module.exports = { buildReportDocx, docxFileName };
